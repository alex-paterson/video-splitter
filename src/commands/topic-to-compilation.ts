#!/usr/bin/env tsx
/**
 * topic-to-compilation — Given a .topic.json (topic + derived story), filter
 * the referenced transcript line-by-line and save the kept passages as a
 * .compilation.json plan (no rendering).
 *
 * Usage: tsx src/commands/topic-to-compilation.ts [options] <topic>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  loadTranscript,
  loadTopic,
  Transcript,
  TranscriptSegment,
  CompilationClip,
  saveCompilation,
} from "../../lib/transcript.js";
import { z } from "zod";

const program = new Command();

program
  .name("topic-to-compilation")
  .description(
    "Filter a transcript by a topic story and save the kept passages as a .compilation.json"
  )
  .argument("<topic>", "Path to .topic.json (from transcript-to-topic)")
  .option("--transcript <path>", "Override transcript path (default: read from topic file)")
  .option("--source <path>", "Source video path to record in compilation (default: derive from transcript filename)")
  .option("--output <path>", "Output .compilation.json path")
  .option(
    "--merge-gap <s>",
    "Merge adjacent kept segments closer than this many seconds",
    "0.5"
  )
  .option("--max-seconds <n>", "Maximum allowed total clip duration; discard plan if exceeded")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  transcript?: string;
  source?: string;
  output?: string;
  mergeGap: string;
  maxSeconds?: string;
  model: string;
}>();

const [topicArg] = program.args;

function buildTranscriptText(segments: TranscriptSegment[], maxChars = 200_000): string {
  const lines: string[] = [];
  let total = 0;
  for (const seg of segments) {
    const line = `[${seg.start_s.toFixed(2)}s → ${seg.end_s.toFixed(2)}s] ${seg.speaker}: ${seg.text}`;
    if (total + line.length > maxChars) {
      lines.push("[...transcript truncated for context window...]");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

const ClipArraySchema = z.array(
  z.object({
    start_s: z.number(),
    end_s: z.number(),
    summary: z.string().optional(),
  })
);

async function filterByStory(
  transcript: Transcript,
  topic: string,
  story: string,
  model: string,
  client: Anthropic,
  maxSeconds?: number
): Promise<CompilationClip[]> {
  const transcriptText = buildTranscriptText(transcript.segments);
  const maxLine = maxSeconds !== undefined
    ? `\n\nHARD CEILING: the sum of kept clip durations MUST NOT EXCEED ${maxSeconds} seconds total. Cut aggressively. If you can't fit under the ceiling, keep only the most essential beats.`
    : "";
  const prompt = `You are a video editor making an aggressive cut of a transcript to tell a specific story.

Topic: "${topic}"${maxLine}

STORY TO TELL:
${story}

Go through the transcript below line by line. For each line, decide if it is ESSENTIAL to telling this story. Be aggressive — cut anything that:
- Is off-topic chatter or tangent
- Is redundant (same point already made)
- Is filler ("yeah", "okay", "mm", "right", "alright" used as filler — unless it's a meaningful reaction)
- Doesn't advance the narrative or add something the viewer needs

Return ONLY the lines that should be KEPT as a JSON array. Use the EXACT start_s and end_s values from the transcript. Each entry can optionally include a short "summary" of what it contributes to the story.

TRANSCRIPT:
${transcriptText}

Return ONLY a JSON array (no other text):
[
  { "start_s": <exact number from transcript>, "end_s": <exact number from transcript>, "summary": "<optional: what this contributes>" },
  ...
]`;

  const response = await client.messages.create({
    model,
    max_tokens: 8096,
    messages: [{ role: "user", content: prompt }],
  });
  const responseText = response.content[0].type === "text" ? response.content[0].text : "";

  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Could not extract JSON from filter response:\n${responseText}`);
  }

  const clips = ClipArraySchema.parse(JSON.parse(jsonMatch[0]));

  return clips.map((clip) => ({
    ...clip,
    start_s: snapToSegmentStart(transcript, clip.start_s),
    end_s: snapToSegmentEnd(transcript, clip.end_s),
  }));
}

function snapToSegmentStart(transcript: Transcript, target: number): number {
  let best = transcript.segments[0].start_s;
  let bestDist = Math.abs(target - best);
  for (const seg of transcript.segments) {
    const dist = Math.abs(seg.start_s - target);
    if (dist < bestDist) { bestDist = dist; best = seg.start_s; }
  }
  return best;
}

function snapToSegmentEnd(transcript: Transcript, target: number): number {
  let best = transcript.segments[transcript.segments.length - 1].end_s;
  let bestDist = Math.abs(target - best);
  for (const seg of transcript.segments) {
    const dist = Math.abs(seg.end_s - target);
    if (dist < bestDist) { bestDist = dist; best = seg.end_s; }
  }
  return best;
}

function mergeClips(clips: CompilationClip[], gapSecs: number): CompilationClip[] {
  if (clips.length === 0) return [];
  const sorted = [...clips].sort((a, b) => a.start_s - b.start_s);
  const merged: CompilationClip[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start_s - last.end_s <= gapSecs) {
      last.end_s = Math.max(last.end_s, curr.end_s);
      if (curr.summary && last.summary) {
        last.summary = `${last.summary} / ${curr.summary}`;
      }
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

async function main() {
  if (!fs.existsSync(topicArg)) {
    console.error(`Error: topic file not found: ${topicArg}`);
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const topic = loadTopic(path.resolve(topicArg));
  const transcriptPath = path.resolve(opts.transcript ?? topic.transcript);
  if (!fs.existsSync(transcriptPath)) {
    console.error(`Error: transcript not found: ${transcriptPath}`);
    process.exit(1);
  }
  const transcript = loadTranscript(transcriptPath);
  const mergeGap = parseFloat(opts.mergeGap);

  const sourcePath = opts.source
    ? path.resolve(opts.source)
    : transcriptPath.replace(/\.transcript\.json$/, ".mkv");

  process.stderr.write(`Topic: "${topic.topic}"\n`);
  process.stderr.write(`Transcript: ${transcriptPath} (${transcript.segments.length} segments)\n`);
  process.stderr.write(`Filtering by story with ${opts.model}…\n`);

  const client = new Anthropic({ apiKey });
  const maxSeconds = opts.maxSeconds !== undefined ? parseFloat(opts.maxSeconds) : undefined;
  const rawClips = await filterByStory(transcript, topic.topic, topic.story, opts.model, client, maxSeconds);

  const clips = mergeClips(rawClips, mergeGap);
  const totalDuration = clips.reduce((s, c) => s + c.end_s - c.start_s, 0);

  process.stderr.write(
    `\nFound ${rawClips.length} passage(s) → ${clips.length} clip(s) after merging (${totalDuration.toFixed(1)}s total)\n`
  );

  for (const clip of clips) {
    const dur = clip.end_s - clip.start_s;
    process.stderr.write(
      `  ${clip.start_s.toFixed(1)}s → ${clip.end_s.toFixed(1)}s  (${dur.toFixed(1)}s)` +
        (clip.summary ? `  — ${clip.summary}` : "") + "\n"
    );
    const lines = transcript.segments.filter(
      (s) => s.end_s > clip.start_s && s.start_s < clip.end_s
    );
    for (const line of lines) {
      const t = (line.start_s - clip.start_s).toFixed(1).padStart(6);
      process.stderr.write(`    [${t}s] ${line.speaker}: ${line.text}\n`);
    }
  }

  const topicBase = path.basename(topicArg).replace(/\.topic\.json$/, "");
  const outDir = path.dirname(path.resolve(topicArg));
  const compilationPath = path.resolve(
    opts.output ?? path.join(outDir, `${topicBase}.compilation.json`)
  );

  if (maxSeconds !== undefined && totalDuration > maxSeconds) {
    const rejectedPath = compilationPath.replace(/\.compilation\.json$/, ".rejected.json");
    fs.writeFileSync(
      rejectedPath,
      JSON.stringify(
        { reason: "too_long", duration_s: totalDuration, max_seconds: maxSeconds },
        null,
        2
      )
    );
    process.stderr.write(
      `DISCARDED: too long (${totalDuration.toFixed(1)}s > ${maxSeconds}s)\n`
    );
    process.stderr.write(`Wrote rejection: ${rejectedPath}\n`);
    process.exit(2);
  }

  saveCompilation(compilationPath, {
    source: sourcePath,
    topic: topic.topic,
    story: topic.story,
    clips: clips.map((clip) => ({
      ...clip,
      transcript: transcript.segments.filter(
        (s) => s.end_s > clip.start_s && s.start_s < clip.end_s
      ),
    })),
  });
  process.stderr.write(`\nSaved: ${compilationPath}\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
