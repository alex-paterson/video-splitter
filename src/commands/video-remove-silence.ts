#!/usr/bin/env tsx
/**
 * video-remove-silence — Remove silent intervals from a video file.
 *
 * Usage: tsx src/commands/video-remove-silence.ts [options] <input> [output]
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
} from "../../lib/ffmpeg.js";
import { ProgressReporter } from "../../lib/progress.js";

const program = new Command();

program
  .name("video-remove-silence")
  .description("Remove silent intervals from a video file")
  .argument("<input>", "Input video file (MKV or any ffmpeg-supported format)")
  .argument("[output]", "Output file path")
  .option("--noise-db <dB>", "Silence threshold in dBFS", "-35")
  .option("--min-silence <s>", "Minimum silence duration to cut (seconds)", "0.5")
  .option("--pad <s>", "Seconds of silence padding to keep at each boundary", "0.1")
  .option("--preview", "Print detected silence intervals without writing output")
  .option("--format <ext>", "Output container format (mp4 default; pass mkv to preserve input container)", "mp4")
  .option("--threads <n>", "ffmpeg thread count (0 = auto)", "0")
  .option("--reencode", "Re-encode using filter_complex trim (frame-accurate, no audio repeats; use on already-encoded clips)")
  .option("--crf <n>", "CRF quality when --reencode is set (default: 18)", "18")
  .option("--preset <preset>", "Encoding preset when --reencode is set (default: medium)", "medium");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  noiseDb: string;
  minSilence: string;
  pad: string;
  preview: boolean;
  format: string;
  threads: string;
  reencode: boolean;
  crf: string;
  preset: string;
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

  process.stderr.write(`Writing output: ${outputPath}\n`);

  let ffmpegArgs: string[];

  if (opts.reencode) {
    // Frame-accurate re-encode via filter_complex trim.
    // The concat demuxer seeks to inpoint by decoding a few pre-roll frames,
    // which bleed into the output as audible repeats even when re-encoding.
    // filter_complex atrim/trim is sample-accurate and avoids this entirely.
    const filterParts: string[] = [];
    for (let i = 0; i < keepIntervals.length; i++) {
      const { start, end } = keepIntervals[i];
      filterParts.push(
        `[0:v]trim=start=${start.toFixed(6)}:end=${end.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`
      );
      filterParts.push(
        `[0:a]atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`
      );
    }
    const concatInputs = keepIntervals.map((_, i) => `[v${i}][a${i}]`).join("");
    filterParts.push(
      `${concatInputs}concat=n=${keepIntervals.length}:v=1:a=1[vout][aout]`
    );

    ffmpegArgs = [
      "-i", inputPath,
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
    ];
  } else {
    // Fast stream-copy via concat demuxer. Fine for large MKV distilling where
    // re-encoding would be too slow. May produce audio glitches on short clips.
    const concatFile = writeConcatFile(inputPath, keepIntervals);
    registerTmp(concatFile);
    ffmpegArgs = [
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-c", "copy",
      "-threads", opts.threads,
      "-y",
      outputPath,
    ];
  }

  await runFfmpeg(
    ffmpegArgs,
    new ProgressReporter().ffmpegHandler(totalKept, "encoding")
  );

  const outSize = (fs.statSync(outputPath).size / 1e6).toFixed(0);
  process.stderr.write(
    `Done. Output: ${outputPath}  (${outSize} MB, ${totalKept.toFixed(1)}s)\n`
  );

  // Debug dump: detected silence + kept intervals
  const silencePath = deriveOutputPath(inputPath, ".silence", ".json");
  fs.writeFileSync(
    silencePath,
    JSON.stringify(
      {
        source: inputPath,
        duration_s: duration,
        noise_db: noiseDb,
        min_silence_s: minSilence,
        pad_s: pad,
        silence: silenceIntervals.map((iv) => ({
          start_s: iv.start,
          end_s: iv.end,
          duration_s: iv.end - iv.start,
        })),
        keep: keepIntervals.map((iv) => ({
          start_s: iv.start,
          end_s: iv.end,
          duration_s: iv.end - iv.start,
        })),
      },
      null,
      2
    )
  );
  process.stderr.write(`Debug: ${silencePath}\n`);
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
