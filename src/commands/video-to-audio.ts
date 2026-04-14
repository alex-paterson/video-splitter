#!/usr/bin/env tsx
/**
 * video-to-audio — Extract the audio track from a video to a 16kHz mono MP3.
 *
 * Usage: tsx src/commands/video-to-audio.ts [options] <input> [output]
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { ffprobe } from "../../lib/ffmpeg.js";
import { ProgressReporter } from "../../lib/progress.js";

const program = new Command();

program
  .name("video-to-audio")
  .description("Extract a video's audio to a 16kHz mono MP3")
  .argument("<input>", "Input video file")
  .argument("[output]", "Output .audio.mp3 path")
  .option("--bitrate <br>", "Audio bitrate", "64k")
  .option("--sample-rate <hz>", "Audio sample rate (Hz)", "16000");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  bitrate: string;
  sampleRate: string;
}>();

const [inputArg, outputArg] = program.args;

function extractAudio(
  inputPath: string,
  outPath: string,
  sampleRate: string,
  bitrate: string,
  onProgress?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-i", inputPath,
      "-vn",
      "-ar", sampleRate,
      "-ac", "1",
      "-b:a", bitrate,
      "-f", "mp3",
      "-y",
      outPath,
    ];
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      if (onProgress) text.split("\n").forEach((l) => l.trim() && onProgress(l));
    });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg audio extract failed: ${stderr.slice(-1000)}`));
      else resolve();
    });
    proc.on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: input file not found: ${inputArg}`);
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const defaultOutput = path.join(
    path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)) + ".audio.mp3"
  );
  const outputPath = path.resolve(outputArg ?? defaultOutput);

  process.stderr.write("Probing source…\n");
  const probe = await ffprobe(inputPath);
  const duration = parseFloat(probe.format.duration);
  const sizeMB = (parseInt(probe.format.size) / 1e6).toFixed(0);
  process.stderr.write(`  Duration: ${duration.toFixed(1)}s  Size: ${sizeMB} MB\n`);

  const progress = new ProgressReporter();
  process.stderr.write(`Extracting → ${outputPath}\n`);
  await extractAudio(
    inputPath,
    outputPath,
    opts.sampleRate,
    opts.bitrate,
    progress.ffmpegHandler(duration, "extracting")
  );
  progress.done();

  const audioMB = (fs.statSync(outputPath).size / 1e6).toFixed(1);
  process.stderr.write(`Done: ${outputPath}  (${audioMB} MB)\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
