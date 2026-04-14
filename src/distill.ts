#!/usr/bin/env tsx
/**
 * distill — Analyze a full transcript with Claude to find the overarching
 * narrative, then produce a condensed video by keeping only the relevant
 * segments and removing empty space and off-topic banter.
 *
 * Usage: tsx src/distill.ts [options] <transcript> [output]
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadTranscript, Transcript, TranscriptSegment } from "../lib/transcript.js";
import { writeConcatFile, runFfmpeg, registerTmp } from "../lib/ffmpeg.js";
import { ProgressReporter } from "../lib/progress.js";

const program = new Command();

program
  .name("distill")
  .description("Condense a video by keeping only the narrative core, removing filler and off-topic banter")
  .argument("<transcript>", "Path to .transcript.json")
  .argument("[output]", "Output video path (default: <source-stem>.distilled.mp4)")
  .option("--target-minutes <n>", "Rough target output duration in minutes (hint, not enforced)")
  .option("--focus <text>", "What to focus on or preserve (e.g. 'bug discoveries', 'funny moments')")
  .option("--pad <s>", "Seconds of padding to add around each kept segment", "0.3")
  .option("--preview", "Print the distill plan without encoding")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  targetMinutes?: string;
  focus?: string;
  pad: string;
  preview: boolean;
  model: string;
}>();

const [transcriptArg, outputArg] = program.args;

// ─── Schemas ──────────────────────────────────────────────────────────────────

const KeepSegmentSchema = z.object({
  start_s: z.number(),
  end_s: z.number(),
  reason: z.string(),
});

const DistillPlanSchema = z.object({
  narrative: z.string(),
  keep: z.array(KeepSegmentSchema),
});

type DistillPlan = z.infer<typeof DistillPlanSchema>;
type KeepSegment = z.infer<typeof KeepSegmentSchema>;

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(transcript: Transcript, opts: {
  targetMinutes?: number;
  focus?: string;
}): string {
  // Build a compact transcript representation — just timestamps + speaker + text
  const lines = transcript.segments.map((s) =>
    `[${s.start_s.toFixed(1)}s] ${s.speaker}: ${s.text}`
  );

  const targetLine = opts.targetMinutes
    ? `\nTarget output duration: ~${opts.targetMinutes} minutes.`
    : "";
  const focusLine = opts.focus
    ? `\nFocus / preserve: "${opts.focus}"`
    : "";

  return `You are a video editor analyzing a full session recording transcript. Your job is to condense it down to its narrative core by identifying what to keep and what to cut.

Source duration: ${(transcript.duration_s / 60).toFixed(1)} minutes${targetLine}${focusLine}

TASK:
1. Read the full transcript and identify the overarching narrative or the most interesting through-line.
2. Select the segments to KEEP — meaningful content, key moments, discoveries, funny exchanges, important decisions.
3. REMOVE: silence, filler ("um", "uh", "wait", "hold on" with nothing following), repeated attempts at the same thing with no new information, off-topic side conversations that don't serve the narrative, long pauses between action.
4. The kept segments can be non-contiguous — they will be stitched together in order.
5. Each kept segment's start_s and end_s MUST exactly match a boundary from the transcript below (no mid-sentence cuts).
6. Adjacent segments less than 3 seconds apart should be merged into one.

TRANSCRIPT:
${lines.join("\n")}

Return a JSON object — no text outside the JSON:
{
  "narrative": "<2-3 sentence summary of the overarching story or most interesting thread>",
  "keep": [
    {
      "start_s": <number matching a transcript segment start_s>,
      "end_s": <number matching a transcript segment end_s>,
      "reason": "<one short phrase: why this is kept>"
    }
  ]
}`;
}

// ─── Timestamp snapping ───────────────────────────────────────────────────────

function snapStart(transcript: Transcript, target: number): number {
  let best = transcript.segments[0].start_s;
  let bestDist = Math.abs(target - best);
  for (const s of transcript.segments) {
    const d = Math.abs(s.start_s - target);
    if (d < bestDist) { bestDist = d; best = s.start_s; }
  }
  return best;
}

function snapEnd(transcript: Transcript, target: number): number {
  let best = transcript.segments[transcript.segments.length - 1].end_s;
  let bestDist = Math.abs(target - best);
  for (const s of transcript.segments) {
    const d = Math.abs(s.end_s - target);
    if (d < bestDist) { bestDist = d; best = s.end_s; }
  }
  return best;
}

// ─── Merge adjacent segments ──────────────────────────────────────────────────

function mergeClose(segments: KeepSegment[], gapThreshold: number): KeepSegment[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start_s - b.start_s);
  const merged: KeepSegment[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start_s - last.end_s <= gapThreshold) {
      last.end_s = Math.max(last.end_s, cur.end_s);
      last.reason += ` + ${cur.reason}`;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

// ─── Print dialog for a segment ───────────────────────────────────────────────

function printDialog(transcript: Transcript, seg: KeepSegment, offset: number): void {
  const lines = transcript.segments.filter(
    (s) => s.end_s > seg.start_s && s.start_s < seg.end_s
  );
  for (const line of lines) {
    const t = (line.start_s - seg.start_s + offset).toFixed(1).padStart(6);
    process.stderr.write(`  [${t}s] ${line.speaker}: ${line.text}\n`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(transcriptArg)) {
    console.error(`Error: transcript not found: ${transcriptArg}`);
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const transcript = loadTranscript(transcriptArg);
  const pad = parseFloat(opts.pad);

  process.stderr.write(
    `Transcript: ${transcript.segments.length} segments, ` +
    `${(transcript.duration_s / 60).toFixed(1)}min, ` +
    `speakers: ${transcript.speakers.join(", ")}\n`
  );

  // ── Call Claude ────────────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(transcript, {
    targetMinutes: opts.targetMinutes ? parseFloat(opts.targetMinutes) : undefined,
    focus: opts.focus,
  });

  process.stderr.write(`Analyzing with ${opts.model}…\n`);

  let responseText = "";
  let attempts = 0;
  while (attempts < 3) {
    try {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      responseText = response.content[0].type === "text" ? response.content[0].text : "";
      break;
    } catch (e: unknown) {
      attempts++;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempts >= 3) throw new Error(`Claude API failed: ${msg}`);
      process.stderr.write(`  API error (attempt ${attempts}): ${msg} — retrying…\n`);
      await new Promise((r) => setTimeout(r, 1000 * attempts * 2));
    }
  }

  // ── Parse response ─────────────────────────────────────────────────────────
  const jsonMatch = responseText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error("Error: no JSON in Claude response\n", responseText);
    process.exit(1);
  }

  let plan: DistillPlan;
  try {
    plan = DistillPlanSchema.parse(JSON.parse(jsonMatch[1]));
  } catch (e) {
    console.error(`Error: invalid plan JSON: ${e}\n`, jsonMatch[1]);
    process.exit(1);
  }

  // ── Snap timestamps + apply padding ───────────────────────────────────────
  const snapped: KeepSegment[] = plan.keep.map((seg) => ({
    start_s: Math.max(0, snapStart(transcript, seg.start_s) - pad),
    end_s: Math.min(transcript.duration_s, snapEnd(transcript, seg.end_s) + pad),
    reason: seg.reason,
  }));

  // Merge segments with gaps under 3s
  const merged = mergeClose(snapped, 3.0);

  const keptDuration = merged.reduce((s, seg) => s + seg.end_s - seg.start_s, 0);
  const reductionPct = ((1 - keptDuration / transcript.duration_s) * 100).toFixed(0);

  // ── Print plan ─────────────────────────────────────────────────────────────
  process.stderr.write(`\nNarrative: ${plan.narrative}\n`);
  process.stderr.write(
    `\nKeeping ${merged.length} segment(s) — ` +
    `${(keptDuration / 60).toFixed(1)}min of ${(transcript.duration_s / 60).toFixed(1)}min ` +
    `(${reductionPct}% cut)\n\n`
  );

  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];
    const dur = seg.end_s - seg.start_s;
    process.stderr.write(
      `  [${String(i + 1).padStart(2)}] ${seg.start_s.toFixed(1)}s → ${seg.end_s.toFixed(1)}s  ` +
      `(${dur.toFixed(1)}s)  — ${seg.reason}\n`
    );
    printDialog(transcript, seg, cursor);
    cursor += dur;
    process.stderr.write("\n");
  }

  if (opts.preview) return;

  // ── Encode ────────────────────────────────────────────────────────────────
  const sourcePath = transcript.source;
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: source video not found: ${sourcePath}`);
    process.exit(1);
  }

  const ext = ".mp4";
  const defaultOutput = path.join(
    path.dirname(sourcePath),
    path.basename(sourcePath, path.extname(sourcePath)) + ".distilled" + ext
  );
  const outputPath = path.resolve(outputArg ?? defaultOutput);

  const concatFile = writeConcatFile(sourcePath, merged.map((s) => ({ start: s.start_s, end: s.end_s })));
  registerTmp(concatFile);

  process.stderr.write(`Encoding: ${outputPath}\n`);
  const progress = new ProgressReporter();

  await runFfmpeg(
    [
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ],
    progress.ffmpegHandler(keptDuration, "encoding")
  );

  progress.done();
  const outMB = (fs.statSync(outputPath).size / 1e6).toFixed(0);
  process.stderr.write(
    `Done: ${outputPath}  (${outMB} MB, ${(keptDuration / 60).toFixed(1)}min, ${reductionPct}% shorter)\n`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
