#!/usr/bin/env tsx
/**
 * transcript-to-distillation-plan — Analyze a transcript with Claude to find the
 * overarching narrative and save a .distillation.json plan (keep intervals).
 *
 * Usage: tsx src/commands/transcript-to-distillation-plan.ts [options] <transcript>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  loadTranscript,
  Transcript,
  DistillationKeep,
  saveDistillation,
} from "../../lib/transcript.js";

const program = new Command();

program
  .name("transcript-to-distillation-plan")
  .description("Produce a .distillation.json plan (narrative + keep intervals) from a transcript")
  .argument("<transcript>", "Path to .transcript.json")
  .option("--target-minutes <n>", "Rough target output duration in minutes (hint, not enforced)")
  .option("--focus <text>", "What to focus on or preserve (e.g. 'bug discoveries')")
  .option("--pad <s>", "Seconds of padding to add around each kept segment", "0.3")
  .option("--merge-gap <s>", "Merge adjacent kept segments closer than this many seconds", "3.0")
  .option("--output <path>", "Output .distillation.json path")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  targetMinutes?: string;
  focus?: string;
  pad: string;
  mergeGap: string;
  output?: string;
  model: string;
}>();

const [transcriptArg] = program.args;

const RawKeepSchema = z.object({
  start_s: z.number(),
  end_s: z.number(),
  reason: z.string(),
});
const RawPlanSchema = z.object({
  narrative: z.string(),
  keep: z.array(RawKeepSchema),
});

function buildPrompt(transcript: Transcript, o: { targetMinutes?: number; focus?: string }): string {
  const lines = transcript.segments.map((s) =>
    `[${s.start_s.toFixed(1)}s] ${s.speaker}: ${s.text}`
  );
  const targetLine = o.targetMinutes ? `\nTarget output duration: ~${o.targetMinutes} minutes.` : "";
  const focusLine = o.focus ? `\nFocus / preserve: "${o.focus}"` : "";

  return `You are a video editor analyzing a full session recording transcript. Your job is to condense it down to its narrative core by identifying what to keep and what to cut.

Source duration: ${(transcript.duration_s / 60).toFixed(1)} minutes${targetLine}${focusLine}

TASK:
1. Read the full transcript and identify the overarching narrative or the most interesting through-line.
2. Select the segments to KEEP — meaningful content, key moments, discoveries, funny exchanges, important decisions.
3. REMOVE: silence, filler, repeated attempts with no new information, off-topic side conversations, long pauses.
4. The kept segments can be non-contiguous — they will be stitched together in order.
5. Each kept segment's start_s and end_s MUST exactly match a boundary from the transcript below (no mid-sentence cuts).
6. Adjacent segments less than 3 seconds apart should be merged into one.

TRANSCRIPT:
${lines.join("\n")}

Return a JSON object — no text outside the JSON:
{
  "narrative": "<2-3 sentence summary of the overarching story or most interesting thread>",
  "keep": [
    { "start_s": <number>, "end_s": <number>, "reason": "<one short phrase>" }
  ]
}`;
}

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

function mergeClose(segments: DistillationKeep[], gapThreshold: number): DistillationKeep[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start_s - b.start_s);
  const merged: DistillationKeep[] = [{ ...sorted[0] }];
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

  const transcriptPath = path.resolve(transcriptArg);
  const transcript = loadTranscript(transcriptPath);
  const pad = parseFloat(opts.pad);
  const mergeGap = parseFloat(opts.mergeGap);

  process.stderr.write(
    `Transcript: ${transcript.segments.length} segments, ` +
    `${(transcript.duration_s / 60).toFixed(1)}min\n`
  );
  process.stderr.write(`Analyzing with ${opts.model}…\n`);

  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(transcript, {
    targetMinutes: opts.targetMinutes ? parseFloat(opts.targetMinutes) : undefined,
    focus: opts.focus,
  });

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

  const jsonMatch = responseText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error("Error: no JSON in Claude response\n", responseText);
    process.exit(1);
  }
  const raw = RawPlanSchema.parse(JSON.parse(jsonMatch[1]));

  const snapped: DistillationKeep[] = raw.keep.map((seg) => ({
    start_s: Math.max(0, snapStart(transcript, seg.start_s) - pad),
    end_s: Math.min(transcript.duration_s, snapEnd(transcript, seg.end_s) + pad),
    reason: seg.reason,
  }));
  const merged = mergeClose(snapped, mergeGap);

  const keptDuration = merged.reduce((s, seg) => s + seg.end_s - seg.start_s, 0);
  const reductionPct = ((1 - keptDuration / transcript.duration_s) * 100).toFixed(0);

  process.stderr.write(`\nNarrative: ${raw.narrative}\n`);
  process.stderr.write(
    `\nKeeping ${merged.length} segment(s) — ` +
    `${(keptDuration / 60).toFixed(1)}min of ${(transcript.duration_s / 60).toFixed(1)}min ` +
    `(${reductionPct}% cut)\n\n`
  );
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];
    const dur = seg.end_s - seg.start_s;
    process.stderr.write(
      `  [${String(i + 1).padStart(2)}] ${seg.start_s.toFixed(1)}s → ${seg.end_s.toFixed(1)}s  ` +
      `(${dur.toFixed(1)}s)  — ${seg.reason}\n`
    );
  }

  const base = path.basename(transcriptPath).replace(/\.transcript\.json$/, "");
  const outDir = path.dirname(transcriptPath);
  const outputPath = path.resolve(
    opts.output ?? path.join(outDir, `${base}.distillation.json`)
  );

  saveDistillation(outputPath, {
    source: transcript.source,
    narrative: raw.narrative,
    focus: opts.focus,
    keep: merged,
  });
  process.stderr.write(`\nSaved: ${outputPath}\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
