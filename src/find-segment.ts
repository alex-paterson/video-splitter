#!/usr/bin/env tsx
/**
 * find-segment — Use Claude to identify a coherent, standalone video segment
 * from a diarized transcript.
 *
 * Usage: tsx src/find-segment.ts [options] <transcript>
 * Output: .segment.json to --output or stdout
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadTranscript, Transcript, TranscriptSegment, SegmentSchema } from "../lib/transcript.js";
import { z } from "zod";

const program = new Command();

program
  .name("find-segment")
  .description("Use an LLM to find a coherent standalone video segment in a transcript")
  .argument("<transcript>", "Path to .transcript.json file")
  .option("--duration <s>", "Target segment duration in seconds", "60")
  .option("--tolerance <s>", "Acceptable duration deviation in seconds", "30")
  .option("--topic <text>", "Optional topic/theme hint")
  .option("--speaker <id>", "Restrict to segments dominated by this speaker")
  .option("--min-speakers <n>", "Minimum number of speakers that must appear", "1")
  .option("--count <n>", "Number of candidate segments to return", "1")
  .option("--output <path>", "Write .segment.json to this path (default: stdout)")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6")
  .parse();

const opts = program.opts<{
  duration: string;
  tolerance: string;
  topic?: string;
  speaker?: string;
  minSpeakers: string;
  count: string;
  output?: string;
  model: string;
}>();

const [transcriptArg] = program.args;

// ─── Prompt builder ───────────────────────────────────────────────────────────

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

function buildPrompt(transcript: Transcript, opts: {
  targetDuration: number;
  tolerance: number;
  topic?: string;
  speaker?: string;
  minSpeakers: number;
  count: number;
}): string {
  const transcriptText = buildTranscriptText(transcript.segments);
  const topicLine = opts.topic ? `\nFocus topic/theme: "${opts.topic}"` : "";
  const speakerLine = opts.speaker ? `\nPrefer segments dominated by: ${opts.speaker}` : "";
  const minSpeakerLine = opts.minSpeakers > 1
    ? `\nAt least ${opts.minSpeakers} speakers must appear.`
    : "";

  return `You are a video editor analyzing a speaker-diarized transcript. Your task is to identify ${opts.count > 1 ? `${opts.count} candidate segments` : "one segment"} that would make excellent standalone video clips.

Target duration: ${opts.targetDuration}s ± ${opts.tolerance}s (acceptable range: ${opts.targetDuration - opts.tolerance}s – ${opts.targetDuration + opts.tolerance}s)${topicLine}${speakerLine}${minSpeakerLine}

SELECTION CRITERIA (in order of importance):
1. The segment must be self-contained — a viewer with no prior context should understand it fully.
2. It must start at a natural sentence or thought beginning — NOT mid-sentence, NOT with a pronoun referring to something unseen ("that thing", "as I mentioned", "so anyway").
3. It must end at a natural conclusion — a completed thought, punchline, or summarizing statement.
4. Prefer segments with a single clear topic or narrative arc.
5. Avoid segments that are entirely Q&A unless the question is also included.
6. The start_s and end_s you return MUST exactly match segment boundaries from the transcript below (no mid-word cuts).

TRANSCRIPT (format: [start → end] SPEAKER: text):
${transcriptText}

Return a JSON object matching this schema exactly. Do not include any text outside the JSON:
${opts.count === 1
  ? `{
  "source": "<copy from transcript metadata>",
  "start_s": <number — must match a segment start_s>,
  "end_s": <number — must match a segment end_s>,
  "title": "<concise title for the clip>",
  "rationale": "<one sentence explaining why this segment is self-contained>",
  "speakers": ["<list of speaker IDs that appear in this segment>"]
}`
  : `[
  {
    "source": "<copy from transcript metadata>",
    "start_s": <number>,
    "end_s": <number>,
    "title": "<concise title>",
    "rationale": "<one sentence>",
    "speakers": ["<speaker IDs>"]
  }
  // ... ${opts.count} total, ordered by coherence (best first), non-overlapping
]`}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateSegment(
  seg: z.infer<typeof SegmentSchema>,
  transcript: Transcript,
  targetDuration: number,
  tolerance: number
): string[] {
  const errors: string[] = [];
  const actualDuration = seg.end_s - seg.start_s;

  if (seg.start_s < 0 || seg.end_s > transcript.duration_s) {
    errors.push(
      `Segment [${seg.start_s}s, ${seg.end_s}s] is outside transcript duration ${transcript.duration_s}s`
    );
  }

  if (actualDuration < targetDuration - tolerance || actualDuration > targetDuration + tolerance) {
    errors.push(
      `Duration ${actualDuration.toFixed(1)}s is outside target ${targetDuration}s ± ${tolerance}s`
    );
  }

  // Verify timestamps exist in transcript
  const startMatch = transcript.segments.find((s) => Math.abs(s.start_s - seg.start_s) < 0.5);
  const endMatch = transcript.segments.find((s) => Math.abs(s.end_s - seg.end_s) < 0.5);

  if (!startMatch) {
    errors.push(`start_s ${seg.start_s} does not match any transcript segment boundary`);
  }
  if (!endMatch) {
    errors.push(`end_s ${seg.end_s} does not match any transcript segment boundary`);
  }

  return errors;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(transcriptArg)) {
    console.error(`Error: transcript file not found: ${transcriptArg}`);
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable not set");
    process.exit(1);
  }

  const transcript = loadTranscript(transcriptArg);
  const targetDuration = parseFloat(opts.duration);
  const tolerance = parseFloat(opts.tolerance);
  const count = parseInt(opts.count);

  process.stderr.write(
    `Analyzing transcript: ${transcript.segments.length} segments, ` +
      `${transcript.duration_s.toFixed(1)}s, speakers: ${transcript.speakers.join(", ")}\n`
  );
  process.stderr.write(`Target: ${targetDuration}s ± ${tolerance}s`);
  if (opts.topic) process.stderr.write(`, topic: "${opts.topic}"`);
  process.stderr.write("\n");

  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(transcript, {
    targetDuration,
    tolerance,
    topic: opts.topic,
    speaker: opts.speaker,
    minSpeakers: parseInt(opts.minSpeakers),
    count,
  });

  process.stderr.write(`Calling ${opts.model}…\n`);

  let responseText = "";
  let attempts = 0;

  while (attempts < 3) {
    try {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      responseText =
        response.content[0].type === "text" ? response.content[0].text : "";
      break;
    } catch (e: unknown) {
      attempts++;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempts >= 3) throw new Error(`Claude API failed after 3 attempts: ${msg}`);
      process.stderr.write(`  API error (attempt ${attempts}): ${msg} — retrying…\n`);
      await new Promise((r) => setTimeout(r, 1000 * attempts * 2));
    }
  }

  // Parse JSON from response
  const jsonMatch = responseText.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error("Error: could not extract JSON from Claude response");
    console.error("Raw response:", responseText);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[1]);
  } catch (e) {
    console.error(`Error: JSON parse failed: ${e}`);
    console.error("Raw JSON:", jsonMatch[1]);
    process.exit(1);
  }

  // Normalise to array
  const candidates = Array.isArray(parsed) ? parsed : [parsed];

  // Validate and snap timestamps to nearest segment boundaries
  const validated = [];
  for (const candidate of candidates) {
    // Fill in source if missing
    // Always use the real transcript source (Claude returns a placeholder)
    candidate.source = transcript.source;

    // Snap to nearest segment boundary
    candidate.start_s = snapToSegmentStart(transcript, candidate.start_s as number);
    candidate.end_s = snapToSegmentEnd(transcript, candidate.end_s as number);

    const seg = SegmentSchema.parse(candidate);
    const errors = validateSegment(seg, transcript, targetDuration, tolerance);

    if (errors.length > 0) {
      process.stderr.write(`Warning: segment validation issues:\n`);
      errors.forEach((e) => process.stderr.write(`  - ${e}\n`));
    }

    validated.push(seg);
  }

  const result = count === 1 ? validated[0] : validated;
  const json = JSON.stringify(result, null, 2);

  if (opts.output) {
    fs.writeFileSync(opts.output, json);
    process.stderr.write(`Segment written: ${opts.output}\n`);
  } else {
    process.stdout.write(json + "\n");
  }

  // Print dialog for each result to stderr, with timestamps zeroed to segment start
  const results = Array.isArray(result) ? result : [result];
  for (const seg of results) {
    process.stderr.write(`\n─── "${seg.title}"  ${seg.start_s.toFixed(1)}s → ${seg.end_s.toFixed(1)}s  (${(seg.end_s - seg.start_s).toFixed(1)}s) ───\n`);
    const lines = transcript.segments.filter(
      (s) => s.end_s > seg.start_s && s.start_s < seg.end_s
    );
    for (const line of lines) {
      const t = (line.start_s - seg.start_s).toFixed(1).padStart(6);
      process.stderr.write(`  [${t}s] ${line.speaker}: ${line.text}\n`);
    }
  }
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

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
