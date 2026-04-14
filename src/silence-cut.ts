#!/usr/bin/env tsx
/**
 * silence-cut — Remove silent intervals from a video file.
 *
 * Usage: tsx src/silence-cut.ts [options] <input> [output]
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import {
  ffprobe,
  detectSilence,
  writeConcatFile,
  runFfmpeg,
  registerTmp,
  SilenceInterval,
} from "../lib/ffmpeg.js";
import { ProgressReporter } from "../lib/progress.js";

const program = new Command();

program
  .name("silence-cut")
  .description("Remove silent intervals from a video file")
  .argument("<input>", "Input video file (MKV or any ffmpeg-supported format)")
  .argument("[output]", "Output file path")
  .option("--noise-db <dB>", "Silence threshold in dBFS", "-35")
  .option("--min-silence <s>", "Minimum silence duration to cut (seconds)", "0.5")
  .option("--pad <s>", "Seconds of silence padding to keep at each boundary", "0.1")
  .option("--preview", "Print detected silence intervals without writing output")
  .option("--format <ext>", "Output container format", "mkv")
  .option("--threads <n>", "ffmpeg thread count (0 = auto)", "0")
  .parse();

const opts = program.opts<{
  noiseDb: string;
  minSilence: string;
  pad: string;
  preview: boolean;
  format: string;
  threads: string;
}>();

const [inputArg, outputArg] = program.args;

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: input file not found: ${inputArg}`);
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const noiseDb = parseFloat(opts.noiseDb);
  const minSilence = parseFloat(opts.minSilence);
  const pad = parseFloat(opts.pad);

  const progress = new ProgressReporter();

  // Probe the source file
  process.stderr.write("Probing source file…\n");
  const probe = await ffprobe(inputPath);
  const duration = parseFloat(probe.format.duration);
  const sizeMB = (parseInt(probe.format.size) / 1e6).toFixed(0);
  process.stderr.write(
    `  ${path.basename(inputPath)}  ${duration.toFixed(1)}s  ${sizeMB} MB\n`
  );

  // Detect silence
  process.stderr.write(`Detecting silence (threshold: ${noiseDb}dB, min: ${minSilence}s)…\n`);
  const silenceIntervals = await detectSilence(
    inputPath,
    noiseDb,
    minSilence,
    duration,
    (frac) => progress.update(frac, "detecting")
  );
  progress.done(`found ${silenceIntervals.length} silent interval(s)`);

  if (opts.preview) {
    if (silenceIntervals.length === 0) {
      console.log("No silence detected.");
    } else {
      console.log(`\nSilent intervals (${silenceIntervals.length}):`);
      let totalSilence = 0;
      for (const iv of silenceIntervals) {
        const dur = iv.end - iv.start;
        totalSilence += dur;
        console.log(`  ${iv.start.toFixed(3)}s → ${iv.end.toFixed(3)}s  (${dur.toFixed(3)}s)`);
      }
      console.log(
        `\nTotal silence: ${totalSilence.toFixed(1)}s / ${duration.toFixed(1)}s  ` +
          `(${((totalSilence / duration) * 100).toFixed(1)}%)`
      );
    }
    return;
  }

  // Compute keep intervals (inverse of silence)
  const keepIntervals = invertIntervals(silenceIntervals, duration, pad);

  if (keepIntervals.length === 0) {
    console.error("Error: nothing to keep — entire file is silence.");
    process.exit(1);
  }

  const totalKept = keepIntervals.reduce((s, iv) => s + iv.end - iv.start, 0);
  process.stderr.write(
    `Keeping ${keepIntervals.length} interval(s), ${totalKept.toFixed(1)}s total\n`
  );

  // Determine output path
  const ext = opts.format.startsWith(".") ? opts.format : `.${opts.format}`;
  const defaultOutput = deriveOutputPath(inputPath, ".cut", ext);
  const outputPath = path.resolve(outputArg ?? defaultOutput);

  // Write concat demuxer file
  const concatFile = writeConcatFile(inputPath, keepIntervals);
  registerTmp(concatFile);

  // Run ffmpeg concat
  process.stderr.write(`Writing output: ${outputPath}\n`);
  const ffmpegArgs = [
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
    "-c", "copy",
    "-threads", opts.threads,
    "-y",
    outputPath,
  ];

  await runFfmpeg(
    ffmpegArgs,
    new ProgressReporter().ffmpegHandler(totalKept, "encoding")
  );

  const outSize = (fs.statSync(outputPath).size / 1e6).toFixed(0);
  process.stderr.write(
    `Done. Output: ${outputPath}  (${outSize} MB, ${totalKept.toFixed(1)}s)\n`
  );
}

function invertIntervals(
  silence: SilenceInterval[],
  totalDuration: number,
  pad: number
): Array<{ start: number; end: number }> {
  const sorted = [...silence].sort((a, b) => a.start - b.start);
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  for (const iv of sorted) {
    // The keep interval ends where silence begins (minus pad)
    const keepEnd = Math.max(cursor, iv.start + pad);
    if (keepEnd > cursor + 0.01) {
      keep.push({ start: cursor, end: keepEnd });
    }
    // Next keep interval starts where silence ends (minus pad)
    cursor = Math.max(cursor, iv.end - pad);
  }

  // Final segment after last silence
  if (cursor < totalDuration - 0.01) {
    keep.push({ start: cursor, end: totalDuration });
  }

  return keep;
}

function deriveOutputPath(inputPath: string, suffix: string, ext: string): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}${suffix}${ext}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
