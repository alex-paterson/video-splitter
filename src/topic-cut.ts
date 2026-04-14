#!/usr/bin/env tsx
/**
 * topic-cut — Use Claude to filter a transcript to topic-relevant passages,
 * then render those passages concatenated into a single video.
 *
 * Usage: tsx src/topic-cut.ts [options] <transcript> <source>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  ffprobe,
  getVideoStream,
  parseFraction,
  runFfmpeg,
} from "../lib/ffmpeg.js";
import {
  loadTranscript,
  Transcript,
  TranscriptSegment,
  CompilationClip,
  CompilationSchema,
  saveCompilation,
} from "../lib/transcript.js";
import { ProgressReporter } from "../lib/progress.js";
import { z } from "zod";

const ASPECT_PRESETS: Record<string, [number, number]> = {
  portrait: [9, 16],
  square: [1, 1],
  landscape: [16, 9],
  cinema: [21, 9],
};

const program = new Command();

program
  .name("topic-cut")
  .description(
    "Filter a transcript to topic-relevant passages and render them as a compilation"
  )
  .argument("<transcript>", "Path to .transcript.json")
  .argument("<source>", "Source video file")
  .option("--topic <text>", "Topic to filter for (required)")
  .option("--aspect <ratio>", "Target aspect ratio W:H or preset", "9:16")
  .option("--resolution <WxH>", "Output resolution (overrides aspect-derived default)")
  .option("--output <path>", "Output video file path")
  .option(
    "--merge-gap <s>",
    "Merge adjacent kept segments closer than this many seconds",
    "0.5"
  )
  .option("--plan", "Print the plan without rendering")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6")
  .option("--crf <n>", "Output CRF quality", "18")
  .option("--preset <preset>", "ffmpeg encoding preset", "medium")
  .option("--threads <n>", "ffmpeg thread count (0 = auto)", "0");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program
  .parse();

const opts = program.opts<{
  topic?: string;
  aspect: string;
  resolution?: string;
  output?: string;
  mergeGap: string;
  plan: boolean;
  model: string;
  crf: string;
  preset: string;
  threads: string;
}>();

const [transcriptArg, sourceArg] = program.args;

// ─── Aspect ratio helpers (shared with render-segment) ────────────────────────

function parseAspect(aspect: string): [number, number] {
  if (ASPECT_PRESETS[aspect]) return ASPECT_PRESETS[aspect];
  const parts = aspect.split(":").map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) {
    throw new Error(`Invalid aspect ratio: "${aspect}"`);
  }
  return [parts[0], parts[1]];
}

function coverFillCrop(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number
): { cropW: number; cropH: number; x: number; y: number } {
  const srcRatio = srcW / srcH;
  const tgtRatio = targetW / targetH;
  let cropW: number, cropH: number;
  if (srcRatio > tgtRatio) {
    cropH = srcH;
    cropW = Math.round(srcH * tgtRatio);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / tgtRatio);
  }
  cropW = cropW % 2 === 0 ? cropW : cropW - 1;
  cropH = cropH % 2 === 0 ? cropH : cropH - 1;
  return {
    cropW,
    cropH,
    x: Math.floor((srcW - cropW) / 2),
    y: Math.floor((srcH - cropH) / 2),
  };
}

function deriveOutputResolution(
  targetAspectW: number,
  targetAspectH: number
): [number, number] {
  const LONG_EDGE = 1920;
  if (targetAspectW >= targetAspectH) {
    const outW = LONG_EDGE;
    const outH = Math.round((LONG_EDGE / targetAspectW) * targetAspectH);
    return [outW % 2 === 0 ? outW : outW - 1, outH % 2 === 0 ? outH : outH - 1];
  } else {
    const outH = LONG_EDGE;
    const outW = Math.round((LONG_EDGE / targetAspectH) * targetAspectW);
    return [outW % 2 === 0 ? outW : outW - 1, outH % 2 === 0 ? outH : outH - 1];
  }
}

// ─── Transcript text builder ──────────────────────────────────────────────────

function buildTranscriptText(
  segments: TranscriptSegment[],
  maxChars = 200_000
): string {
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

// ─── Segment merging ──────────────────────────────────────────────────────────

function mergeClips(
  clips: CompilationClip[],
  gapSecs: number
): CompilationClip[] {
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

// ─── LLM filtering ────────────────────────────────────────────────────────────

const ClipArraySchema = z.array(
  z.object({
    start_s: z.number(),
    end_s: z.number(),
    summary: z.string().optional(),
  })
);

async function llmCall(
  client: Anthropic,
  model: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  let attempts = 0;
  while (attempts < 3) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return response.content[0].type === "text" ? response.content[0].text : "";
    } catch (e: unknown) {
      attempts++;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempts >= 3) throw new Error(`Claude API failed after 3 attempts: ${msg}`);
      process.stderr.write(`  API error (attempt ${attempts}): ${msg} — retrying…\n`);
      await new Promise((r) => setTimeout(r, 1000 * attempts * 2));
    }
  }
  return "";
}

/**
 * Step 1: derive the narrative of the topic from the full transcript.
 * Returns a story document that anchors the filter pass.
 */
async function deriveStory(
  transcript: Transcript,
  topic: string,
  model: string,
  client: Anthropic
): Promise<string> {
  const transcriptText = buildTranscriptText(transcript.segments);
  const prompt = `You are analyzing a video transcript to extract the narrative of a specific topic.

Topic: "${topic}"

Read the transcript and write a concise story document (a few paragraphs) that captures:
- The narrative arc: how the topic unfolds from beginning to end
- The essential beats and turning points
- Key lines of dialogue that define the story
- What is fluff, tangent, or redundant that can be cut without losing the story

Be specific about what matters and what doesn't. This will be used to aggressively filter the transcript.

TRANSCRIPT:
${transcriptText}`;

  process.stderr.write("Step 1: deriving story…\n");
  const story = await llmCall(client, model, prompt, 1024);
  process.stderr.write(`\nStory:\n${story}\n\n`);
  return story;
}

/**
 * Step 2: filter the transcript line-by-line using the story as context.
 * Returns individual segment-level clips to keep.
 */
async function filterByStory(
  transcript: Transcript,
  topic: string,
  story: string,
  model: string,
  client: Anthropic
): Promise<CompilationClip[]> {
  const transcriptText = buildTranscriptText(transcript.segments);
  const prompt = `You are a video editor making an aggressive cut of a transcript to tell a specific story.

Topic: "${topic}"

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

  process.stderr.write("Step 2: filtering line by line…\n");
  const responseText = await llmCall(client, model, prompt, 8096);

  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Could not extract JSON from filter response:\n${responseText}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const clips = ClipArraySchema.parse(parsed);

  return clips.map((clip) => ({
    ...clip,
    start_s: snapToSegmentStart(transcript, clip.start_s),
    end_s: snapToSegmentEnd(transcript, clip.end_s),
  }));
}

async function filterTranscript(
  transcript: Transcript,
  topic: string,
  model: string,
  apiKey: string
): Promise<{ clips: CompilationClip[]; story: string }> {
  const client = new Anthropic({ apiKey });
  const story = await deriveStory(transcript, topic, model, client);
  const clips = await filterByStory(transcript, topic, story, model, client);
  return { clips, story };
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(transcriptArg)) {
    console.error(`Error: transcript not found: ${transcriptArg}`);
    process.exit(1);
  }
  if (!fs.existsSync(sourceArg)) {
    console.error(`Error: source video not found: ${sourceArg}`);
    process.exit(1);
  }
  if (!opts.topic) {
    console.error("Error: --topic is required");
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const transcript = loadTranscript(transcriptArg);
  const sourcePath = path.resolve(sourceArg);
  const mergeGap = parseFloat(opts.mergeGap);

  process.stderr.write(
    `Transcript: ${transcript.segments.length} segments, ${transcript.duration_s.toFixed(1)}s\n`
  );
  process.stderr.write(`Topic: "${opts.topic}"\n`);
  process.stderr.write(`Calling ${opts.model}…\n`);

  const { clips: rawClips, story } = await filterTranscript(
    transcript,
    opts.topic,
    opts.model,
    apiKey
  );

  const clips = mergeClips(rawClips, mergeGap);
  const totalDuration = clips.reduce((s, c) => s + c.end_s - c.start_s, 0);

  process.stderr.write(
    `\nFound ${rawClips.length} relevant passage(s) → ${clips.length} clip(s) after merging (${totalDuration.toFixed(1)}s total)\n`
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

  // Save compilation plan
  const sourceBase = path.basename(sourcePath, path.extname(sourcePath));
  const outDir = path.dirname(sourcePath);
  const compilationPath = path.join(outDir, `${sourceBase}.compilation.json`);
  saveCompilation(compilationPath, {
    source: sourcePath,
    topic: opts.topic,
    story,
    clips: clips.map((clip) => ({
      ...clip,
      transcript: transcript.segments.filter(
        (s) => s.end_s > clip.start_s && s.start_s < clip.end_s
      ),
    })),
  });
  process.stderr.write(`\nPlan saved: ${compilationPath}\n`);

  if (opts.plan) return;

  // Probe source video
  process.stderr.write("Probing source…\n");
  const probe = await ffprobe(sourcePath);
  const video = getVideoStream(probe);
  const srcW = video.width!;
  const srcH = video.height!;
  process.stderr.write(`  Source: ${srcW}×${srcH}\n`);

  // Determine output dimensions
  const [targetAspectW, targetAspectH] = parseAspect(opts.aspect);
  let outW: number, outH: number;
  if (opts.resolution) {
    [outW, outH] = opts.resolution.split("x").map(Number);
  } else {
    [outW, outH] = deriveOutputResolution(targetAspectW, targetAspectH);
  }
  process.stderr.write(`  Output: ${outW}×${outH} (${targetAspectW}:${targetAspectH})\n`);

  const crop = coverFillCrop(srcW, srcH, targetAspectW, targetAspectH);
  const spatialFilter =
    `crop=${crop.cropW}:${crop.cropH}:${crop.x}:${crop.y},scale=${outW}:${outH},setsar=1`;

  // Build filter_complex
  const filterParts: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const { start_s, end_s } = clips[i];
    filterParts.push(
      `[0:v]trim=start=${start_s.toFixed(6)}:end=${end_s.toFixed(6)},setpts=PTS-STARTPTS,${spatialFilter}[v${i}]`
    );
    filterParts.push(
      `[0:a]atrim=start=${start_s.toFixed(6)}:end=${end_s.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`
    );
  }
  const concatInputs = clips.map((_, i) => `[v${i}][a${i}]`).join("");
  filterParts.push(
    `${concatInputs}concat=n=${clips.length}:v=1:a=1[vout][aout]`
  );

  // Determine output path
  const ext = ".mp4";
  const defaultOutput = path.join(outDir, `${sourceBase}.topic-cut${ext}`);
  const outputPath = path.resolve(opts.output ?? defaultOutput);

  const progress = new ProgressReporter();
  process.stderr.write(`Rendering: ${outputPath}\n`);

  await runFfmpeg(
    [
      "-i", sourcePath,
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-crf", opts.crf,
      "-preset", opts.preset,
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-threads", opts.threads,
      "-y",
      outputPath,
    ],
    progress.ffmpegHandler(totalDuration, "rendering")
  );

  const outSize = (fs.statSync(outputPath).size / 1e6).toFixed(1);
  progress.done();
  process.stderr.write(
    `Done: ${outputPath}  (${outSize} MB, ${totalDuration.toFixed(1)}s, ${outW}×${outH})\n`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
