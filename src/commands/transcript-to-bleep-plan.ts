#!/usr/bin/env tsx
/**
 * transcript-to-bleep-plan — Scan a transcript for words to bleep (either an
 * explicit --words list or an LLM-picked --auto set) and save a .bleep.json:
 * { source, intervals: [{ start_s, end_s, reason }] }.
 *
 * Usage: tsx src/commands/transcript-to-bleep-plan.ts [options] <transcript>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadTranscript, Transcript, TranscriptSegment } from "../../lib/transcript.js";

const program = new Command();

program
  .name("transcript-to-bleep-plan")
  .description("Produce a .bleep.json of intervals to mute/beep/cut from a transcript")
  .argument("<transcript>", "Path to .transcript.json")
  .option("--words <csv>", "Comma-separated list of words to bleep (case-insensitive)")
  .option("--auto", "Let the LLM pick profanities / sensitive names to bleep")
  .option("--topic <text>", "Optional topic hint for --auto (e.g. PG cut)")
  .option("--source <path>", "Override source video path (default: transcript.source)")
  .option("--output <path>", "Output .bleep.json path")
  .option("--model <model>", "Claude model for --auto", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  words?: string;
  auto?: boolean;
  topic?: string;
  source?: string;
  output?: string;
  model: string;
}>();

const [transcriptArg] = program.args;

type Interval = { start_s: number; end_s: number; reason: string };

/**
 * Estimate the timing of each word in a segment by splitting its duration
 * proportionally across the word list. Rough but good enough.
 */
function wordIntervalsInSegment(seg: TranscriptSegment, targets: Set<string>): Interval[] {
  const words = seg.text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const dur = seg.end_s - seg.start_s;
  const per = dur / words.length;
  const out: Interval[] = [];
  for (let i = 0; i < words.length; i++) {
    const normalized = words[i].toLowerCase().replace(/[^a-z0-9']/g, "");
    if (!normalized) continue;
    if (targets.has(normalized)) {
      const start = seg.start_s + i * per;
      const end = seg.start_s + (i + 1) * per;
      out.push({ start_s: start, end_s: end, reason: `word: ${normalized}` });
    }
  }
  return out;
}

function buildWordsSet(csv: string): Set<string> {
  return new Set(
    csv
      .split(",")
      .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9']/g, ""))
      .filter((w) => w.length > 0)
  );
}

function mergeAdjacent(intervals: Interval[], gap = 0.05): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start_s - b.start_s);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start_s - last.end_s <= gap) {
      last.end_s = Math.max(last.end_s, cur.end_s);
      last.reason = `${last.reason} / ${cur.reason}`;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

async function pickWordsAuto(
  transcript: Transcript,
  topic: string | undefined,
  model: string,
  client: Anthropic
): Promise<string[]> {
  const sample = transcript.segments
    .map((s) => s.text)
    .join(" ")
    .slice(0, 40_000);
  const topicLine = topic ? `Context: ${topic}\n` : "";
  const prompt = `${topicLine}Scan the following transcript text and return a JSON array of lowercase words that should be bleeped for a PG / family-friendly cut (profanity, slurs, clearly offensive language). Do NOT include borderline terms; be conservative. Return ONLY a JSON array of strings.

TRANSCRIPT:
${sample}`;
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr)) return arr.map((x) => String(x).toLowerCase());
  } catch {
    /* ignore */
  }
  return [];
}

async function main() {
  if (!fs.existsSync(transcriptArg)) {
    console.error(`Error: transcript not found: ${transcriptArg}`);
    process.exit(1);
  }
  if (!opts.words && !opts.auto) {
    console.error("Error: must specify either --words <csv> or --auto");
    process.exit(1);
  }

  const transcriptPath = path.resolve(transcriptArg);
  const transcript = loadTranscript(transcriptPath);

  let targets: Set<string>;
  if (opts.auto) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("Error: ANTHROPIC_API_KEY not set (required for --auto)");
      process.exit(1);
    }
    const client = new Anthropic({ apiKey });
    const picked = await pickWordsAuto(transcript, opts.topic, opts.model, client);
    process.stderr.write(`Auto-picked words: ${picked.join(", ") || "(none)"}\n`);
    targets = new Set(picked.map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, "")));
    if (opts.words) for (const w of buildWordsSet(opts.words)) targets.add(w);
  } else {
    targets = buildWordsSet(opts.words!);
  }
  targets.add("gay");

  if (targets.size === 0) {
    process.stderr.write("No target words; writing empty bleep plan.\n");
  }

  const intervals: Interval[] = [];
  for (const seg of transcript.segments) {
    intervals.push(...wordIntervalsInSegment(seg, targets));
  }
  const merged = mergeAdjacent(intervals);

  const source = opts.source ?? transcript.source;
  const base = path.basename(transcriptPath).replace(/\.transcript\.json$/, "");
  const outputPath = path.resolve(
    opts.output ?? path.join(path.dirname(transcriptPath), `${base}.bleep.json`)
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify({ source, intervals: merged }, null, 2)
  );

  process.stderr.write(
    `Wrote ${merged.length} interval(s) covering ${merged
      .reduce((s, i) => s + i.end_s - i.start_s, 0)
      .toFixed(2)}s → ${outputPath}\n`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
