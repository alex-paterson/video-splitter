#!/usr/bin/env tsx
/**
 * video-apply-bleep — Apply a .bleep.json plan to an MP4 using one of three
 * modes: mute (volume=0 on intervals), beep (sine overlay), or cut (atrim+concat).
 *
 * Usage: tsx src/commands/video-apply-bleep.ts [options] <input> <plan>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import { runFfmpeg, ffprobe } from "../../lib/ffmpeg.js";

const program = new Command();

program
  .name("video-apply-bleep")
  .description("Apply a .bleep.json plan to a video and produce a .bleeped.mp4")
  .argument("<input>", "Input MP4")
  .argument("<plan>", "Path to .bleep.json")
  .option("--mode <mode>", "mute | beep | cut", "mute")
  .option("--beep-hz <n>", "Sine frequency for beep mode", "1000")
  .option("--output <path>", "Output path (default: <base>.bleeped.mp4)")
  .option("--crf <n>", "CRF quality", "18")
  .option("--preset <preset>", "ffmpeg preset", "medium")
  .option("--threads <n>", "ffmpeg thread count", "0");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  mode: string;
  beepHz: string;
  output?: string;
  crf: string;
  preset: string;
  threads: string;
}>();

const [inputArg, planArg] = program.args;

type Interval = { start_s: number; end_s: number; reason?: string };
type Plan = { source: string; intervals: Interval[] };

function deriveOutput(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}.bleeped.mp4`);
}

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: input not found: ${inputArg}`);
    process.exit(1);
  }
  if (!fs.existsSync(planArg)) {
    console.error(`Error: plan not found: ${planArg}`);
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const plan: Plan = JSON.parse(fs.readFileSync(path.resolve(planArg), "utf-8"));
  const outputPath = path.resolve(opts.output ?? deriveOutput(inputPath));

  if (!plan.intervals || plan.intervals.length === 0) {
    process.stderr.write("No intervals in plan; copying input unchanged.\n");
    fs.copyFileSync(inputPath, outputPath);
    process.stderr.write(`Done: ${outputPath}\n`);
    return;
  }

  const intervals = [...plan.intervals].sort((a, b) => a.start_s - b.start_s);
  const beepHz = parseFloat(opts.beepHz);

  let ffmpegArgs: string[];

  if (opts.mode === "mute") {
    const enables = intervals
      .map(
        (iv) =>
          `volume=enable='between(t,${iv.start_s.toFixed(6)},${iv.end_s.toFixed(6)})':volume=0`
      )
      .join(",");
    ffmpegArgs = [
      "-i", inputPath,
      "-af", enables,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-threads", opts.threads,
      "-y",
      outputPath,
    ];
  } else if (opts.mode === "beep") {
    // Mute the intervals then overlay a sine tone enabled during those intervals.
    const muteExpr = intervals
      .map(
        (iv) =>
          `volume=enable='between(t,${iv.start_s.toFixed(6)},${iv.end_s.toFixed(6)})':volume=0`
      )
      .join(",");
    const sineEnable = intervals
      .map(
        (iv) =>
          `between(t,${iv.start_s.toFixed(6)},${iv.end_s.toFixed(6)})`
      )
      .join("+");
    const filter = [
      `[0:a]${muteExpr}[muted]`,
      `sine=frequency=${beepHz}:sample_rate=48000[tone]`,
      `[tone]volume=enable='${sineEnable}':volume=1,volume=enable='not(${sineEnable})':volume=0[tonegated]`,
      `[muted][tonegated]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    ].join(";");
    ffmpegArgs = [
      "-i", inputPath,
      "-f", "lavfi", "-i", `sine=frequency=${beepHz}:sample_rate=48000`,
      "-filter_complex", filter,
      "-map", "0:v", "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      "-threads", opts.threads,
      "-y",
      outputPath,
    ];
  } else if (opts.mode === "cut") {
    // Keep the inverse intervals and concat
    const probe = await ffprobe(inputPath);
    const duration = parseFloat(probe.format.duration);
    const keep: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const iv of intervals) {
      if (iv.start_s > cursor) keep.push({ start: cursor, end: iv.start_s });
      cursor = Math.max(cursor, iv.end_s);
    }
    if (cursor < duration) keep.push({ start: cursor, end: duration });

    if (keep.length === 0) {
      console.error("Error: cut mode with no keep intervals.");
      process.exit(1);
    }

    const parts: string[] = [];
    for (let i = 0; i < keep.length; i++) {
      const { start, end } = keep[i];
      parts.push(
        `[0:v]trim=start=${start.toFixed(6)}:end=${end.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`
      );
      parts.push(
        `[0:a]atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`
      );
    }
    const inputs = keep.map((_, i) => `[v${i}][a${i}]`).join("");
    parts.push(`${inputs}concat=n=${keep.length}:v=1:a=1[vout][aout]`);
    ffmpegArgs = [
      "-i", inputPath,
      "-filter_complex", parts.join(";"),
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
    ];
  } else {
    console.error(`Error: unknown mode "${opts.mode}". Use mute|beep|cut.`);
    process.exit(1);
  }

  process.stderr.write(
    `Applying ${intervals.length} interval(s) in ${opts.mode} mode → ${outputPath}\n`
  );
  await runFfmpeg(ffmpegArgs);

  const outSize = (fs.statSync(outputPath).size / 1e6).toFixed(1);
  process.stderr.write(`Done: ${outputPath}  (${outSize} MB)\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
