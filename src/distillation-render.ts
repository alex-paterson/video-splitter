#!/usr/bin/env tsx
/**
 * distillation-render — Render a .distillation.json plan to a condensed video.
 *
 * Usage: tsx src/distillation-render.ts [options] <distillation>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import { writeConcatFile, runFfmpeg, registerTmp } from "../lib/ffmpeg.js";
import { loadDistillation } from "../lib/transcript.js";
import { ProgressReporter } from "../lib/progress.js";

const program = new Command();

program
  .name("distillation-render")
  .description("Render a .distillation.json plan to a condensed video (stream-copy concat)")
  .argument("<distillation>", "Path to .distillation.json")
  .option("--source <path>", "Override source video path (default: read from distillation file)")
  .option("--output <path>", "Output video file path");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  source?: string;
  output?: string;
}>();

const [distillationArg] = program.args;

async function main() {
  if (!fs.existsSync(distillationArg)) {
    console.error(`Error: distillation not found: ${distillationArg}`);
    process.exit(1);
  }

  const distillationPath = path.resolve(distillationArg);
  const distillation = loadDistillation(distillationPath);
  const sourcePath = path.resolve(opts.source ?? distillation.source);
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: source video not found: ${sourcePath}`);
    process.exit(1);
  }

  const keep = distillation.keep;
  const keptDuration = keep.reduce((s, seg) => s + seg.end_s - seg.start_s, 0);

  process.stderr.write(`Narrative: ${distillation.narrative}\n`);
  process.stderr.write(`Source: ${sourcePath}\n`);
  process.stderr.write(`Keeping ${keep.length} segment(s), ${(keptDuration / 60).toFixed(1)}min total\n`);

  const ext = ".mp4";
  const sourceBase = path.basename(sourcePath, path.extname(sourcePath));
  const defaultOutput = path.join(path.dirname(sourcePath), `${sourceBase}.distilled${ext}`);
  const outputPath = path.resolve(opts.output ?? defaultOutput);

  const concatFile = writeConcatFile(sourcePath, keep.map((s) => ({ start: s.start_s, end: s.end_s })));
  registerTmp(concatFile);

  const progress = new ProgressReporter();
  process.stderr.write(`Encoding: ${outputPath}\n`);

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
  process.stderr.write(`Done: ${outputPath}  (${outMB} MB, ${(keptDuration / 60).toFixed(1)}min)\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
