#!/usr/bin/env tsx
/**
 * video-bleep — End-of-pipeline profanity bleeper. Given an MP4, extracts
 * audio, runs Whisper with word-level timestamps on the clip itself (so
 * timestamps are native to the output), picks target words (either an
 * explicit --words list or --auto via Claude), and mutes/beeps them.
 *
 * Produces <base>.bleeped.mp4 and publishes it to <repo>/out/, removing the
 * pre-bleep predecessor from the publish dir.
 *
 * Usage: tsx src/commands/video-bleep.ts [options] <input-mp4>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import undici from "undici";
import Anthropic from "@anthropic-ai/sdk";
import { ffprobe, tmpPath, registerTmp, runFfmpeg } from "../../lib/ffmpeg.js";

const program = new Command();

program
  .name("video-bleep")
  .description("Transcribe an MP4 with word timestamps and mute/beep target words")
  .argument("<input>", "Input MP4")
  .option("--words <csv>", "Comma-separated list of words to bleep (case-insensitive)")
  .option("--auto", "Let Claude pick profanities from the clip's transcript")
  .option("--topic <text>", "Optional topic hint for --auto")
  .option("--mode <mode>", "mute | beep", "mute")
  .option("--beep-hz <n>", "Sine frequency for beep mode", "1000")
  .option("--output <path>", "Output path (default: <base>.bleeped.mp4)")
  .option("--model <model>", "Claude model for --auto", "claude-opus-4-6")
  .option("--whisper-model <m>", "Whisper model", "whisper-1")
  .option("--language <lang>", "ISO-639-1 language hint for Whisper")
  .option("--threads <n>", "ffmpeg thread count", "0");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  words?: string;
  auto?: boolean;
  topic?: string;
  mode: string;
  beepHz: string;
  output?: string;
  model: string;
  whisperModel: string;
  language?: string;
  threads: string;
}>();

const [inputArg] = program.args;

type WordTs = { word: string; start: number; end: number };
type Interval = { start_s: number; end_s: number; reason: string };

function deriveOutput(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}.bleeped.mp4`);
}

function extractAudio(inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-vn", "-ar", "16000", "-ac", "1", "-b:a", "64k", "-f", "mp3",
      "-y", outPath,
    ];
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg audio extract failed: ${stderr}`));
      else resolve();
    });
    proc.on("error", reject);
  });
}

async function whisperWordTimestamps(
  apiKey: string,
  audioPath: string,
  model: string,
  language?: string
): Promise<WordTs[]> {
  const audioBuffer = fs.readFileSync(audioPath);
  const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
  const form = new undici.FormData();
  form.append("file", blob, "audio.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (language) form.append("language", language);
  const res = await undici.fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const json = (await res.json()) as {
    words?: Array<{ word: string; start: number; end: number }>;
    error?: { message: string };
  };
  if (!res.ok || json.error) {
    throw new Error(`Whisper API error ${res.status}: ${json.error?.message ?? res.statusText}`);
  }
  return (json.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end }));
}

function normalize(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function buildWordsSet(csv: string): Set<string> {
  return new Set(
    csv.split(",").map((w) => normalize(w.trim())).filter((w) => w.length > 0)
  );
}

async function pickWordsAuto(
  wordsTs: WordTs[],
  topic: string | undefined,
  model: string,
  client: Anthropic
): Promise<string[]> {
  const text = wordsTs.map((w) => w.word).join(" ").slice(0, 40_000);
  const topicLine = topic ? `Context: ${topic}\n` : "";
  const prompt = `${topicLine}Scan the following transcript and return a JSON array of lowercase words that should be bleeped for a PG / family-friendly cut (profanity, slurs, clearly offensive language). Be conservative; do NOT include borderline terms. Return ONLY a JSON array of strings.

TRANSCRIPT:
${text}`;
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const txt = response.content[0].type === "text" ? response.content[0].text : "";
  const m = txt.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr)) return arr.map((x) => normalize(String(x)));
  } catch { /* ignore */ }
  return [];
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

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: input not found: ${inputArg}`);
    process.exit(1);
  }
  if (!opts.words && !opts.auto) {
    console.error("Error: must specify --words <csv> or --auto");
    process.exit(1);
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error("Error: OPENAI_API_KEY not set");
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(opts.output ?? deriveOutput(inputPath));

  process.stderr.write("Extracting audio…\n");
  const audioPath = tmpPath(".mp3");
  registerTmp(audioPath);
  await extractAudio(inputPath, audioPath);

  process.stderr.write("Transcribing (word timestamps)…\n");
  const wordsTs = await whisperWordTimestamps(openaiKey, audioPath, opts.whisperModel, opts.language);
  process.stderr.write(`  ${wordsTs.length} word token(s)\n`);

  let targets: Set<string>;
  if (opts.auto) {
    const antKey = process.env.ANTHROPIC_API_KEY;
    if (!antKey) {
      console.error("Error: ANTHROPIC_API_KEY not set (required for --auto)");
      process.exit(1);
    }
    const client = new Anthropic({ apiKey: antKey });
    const picked = await pickWordsAuto(wordsTs, opts.topic, opts.model, client);
    process.stderr.write(`Auto-picked words: ${picked.join(", ") || "(none)"}\n`);
    targets = new Set(picked.map(normalize).filter(Boolean));
    if (opts.words) for (const w of buildWordsSet(opts.words)) targets.add(w);
  } else {
    targets = buildWordsSet(opts.words!);
  }
  targets.add("gay");

  const intervals: Interval[] = [];
  for (const w of wordsTs) {
    const n = normalize(w.word);
    if (n && targets.has(n)) {
      intervals.push({ start_s: w.start, end_s: w.end, reason: `word: ${n}` });
    }
  }
  const merged = mergeAdjacent(intervals);
  process.stderr.write(`Bleeping ${merged.length} interval(s) in ${opts.mode} mode\n`);

  if (merged.length === 0) {
    process.stderr.write("No target words found; copying input unchanged.\n");
    fs.copyFileSync(inputPath, outputPath);
  } else if (opts.mode === "mute") {
    const enables = merged
      .map((iv) => `volume=enable='between(t,${iv.start_s.toFixed(6)},${iv.end_s.toFixed(6)})':volume=0`)
      .join(",");
    await runFfmpeg([
      "-i", inputPath,
      "-af", enables,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "-threads", opts.threads,
      "-y", outputPath,
    ]);
  } else if (opts.mode === "beep") {
    const beepHz = parseFloat(opts.beepHz);
    const muteExpr = merged
      .map((iv) => `volume=enable='between(t,${iv.start_s.toFixed(6)},${iv.end_s.toFixed(6)})':volume=0`)
      .join(",");
    const sineEnable = merged
      .map((iv) => `between(t,${iv.start_s.toFixed(6)},${iv.end_s.toFixed(6)})`)
      .join("+");
    const filter = [
      `[0:a]${muteExpr}[muted]`,
      `[1:a]volume=enable='${sineEnable}':volume=1,volume=enable='not(${sineEnable})':volume=0[tonegated]`,
      `[muted][tonegated]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    ].join(";");
    await runFfmpeg([
      "-i", inputPath,
      "-f", "lavfi", "-i", `sine=frequency=${beepHz}:sample_rate=48000`,
      "-filter_complex", filter,
      "-map", "0:v", "-map", "[aout]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      "-threads", opts.threads,
      "-y", outputPath,
    ]);
  } else {
    console.error(`Error: unknown mode "${opts.mode}". Use mute|beep.`);
    process.exit(1);
  }

  const outSize = (fs.statSync(outputPath).size / 1e6).toFixed(1);
  process.stderr.write(`Done: ${outputPath}  (${outSize} MB)\n`);

  // Publish bleeped result to <repo>/out/, replacing the unbleeped predecessor
  try {
    const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
    const publishDir = path.join(repoRoot, "out");
    fs.mkdirSync(publishDir, { recursive: true });
    const priorDest = path.join(publishDir, path.basename(inputPath));
    if (fs.existsSync(priorDest)) {
      fs.unlinkSync(priorDest);
      process.stderr.write(`Unpublished (pre-bleep): ${priorDest}\n`);
    }
    const dest = path.join(publishDir, path.basename(outputPath));
    fs.copyFileSync(outputPath, dest);
    process.stderr.write(`Published: ${dest}\n`);
  } catch (e) {
    process.stderr.write(`Publish skipped: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  try { fs.unlinkSync(audioPath); } catch {}
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
