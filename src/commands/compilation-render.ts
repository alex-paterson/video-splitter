#!/usr/bin/env tsx
/**
 * compilation-render — Render a .compilation.json plan to a single video,
 * concatenating all kept passages with cover-fill cropping to a target aspect.
 *
 * Usage: tsx src/commands/compilation-render.ts [options] <compilation>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import {
  ffprobe,
  getVideoStream,
  runFfmpeg,
} from "../../lib/ffmpeg.js";
import { loadCompilation } from "../../lib/transcript.js";
import { ProgressReporter } from "../../lib/progress.js";

const ASPECT_PRESETS: Record<string, [number, number]> = {
  portrait: [9, 16],
  square: [1, 1],
  landscape: [16, 9],
  cinema: [21, 9],
};

const program = new Command();

program
  .name("compilation-render")
  .description("Render a .compilation.json plan to a concatenated video")
  .argument("<compilation>", "Path to .compilation.json")
  .option("--source <path>", "Override source video path (default: read from compilation file)")
  .option("--aspect <ratio>", "Target aspect ratio W:H or preset", "9:16")
  .option("--resolution <WxH>", "Output resolution (overrides aspect-derived default)")
  .option("--output <path>", "Output video file path")
  .option("--crf <n>", "Output CRF quality", "18")
  .option("--preset <preset>", "ffmpeg encoding preset", "medium")
  .option("--threads <n>", "ffmpeg thread count (0 = auto)", "0")
  .option("--banner <png>", "Optional PNG overlaid centered on the video (fit inside 60% W × 40% H)");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  source?: string;
  aspect: string;
  resolution?: string;
  output?: string;
  crf: string;
  preset: string;
  threads: string;
  banner?: string;
}>();

const [compilationArg] = program.args;

function parseAspect(aspect: string): [number, number] {
  if (ASPECT_PRESETS[aspect]) return ASPECT_PRESETS[aspect];
  const parts = aspect.split(":").map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) {
    throw new Error(`Invalid aspect ratio: "${aspect}"`);
  }
  return [parts[0], parts[1]];
}

function coverFillCrop(srcW: number, srcH: number, targetW: number, targetH: number) {
  const srcRatio = srcW / srcH;
  const tgtRatio = targetW / targetH;
  let cropW: number, cropH: number;
  if (srcRatio > tgtRatio) {
    cropH = srcH;
    cropW = Math.round(srcH * tgtRatio);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / tgtRatio);
  }
  cropW = cropW % 2 === 0 ? cropW : cropW - 1;
  cropH = cropH % 2 === 0 ? cropH : cropH - 1;
  return {
    cropW,
    cropH,
    x: Math.floor((srcW - cropW) / 2),
    y: Math.floor((srcH - cropH) / 2),
  };
}

function deriveOutputResolution(targetAspectW: number, targetAspectH: number): [number, number] {
  const LONG_EDGE = 1920;
  if (targetAspectW >= targetAspectH) {
    const outW = LONG_EDGE;
    const outH = Math.round((LONG_EDGE / targetAspectW) * targetAspectH);
    return [outW % 2 === 0 ? outW : outW - 1, outH % 2 === 0 ? outH : outH - 1];
  } else {
    const outH = LONG_EDGE;
    const outW = Math.round((LONG_EDGE / targetAspectH) * targetAspectW);
    return [outW % 2 === 0 ? outW : outW - 1, outH % 2 === 0 ? outH : outH - 1];
  }
}

async function main() {
  if (!fs.existsSync(compilationArg)) {
    console.error(`Error: compilation not found: ${compilationArg}`);
    process.exit(1);
  }

  const compilationPath = path.resolve(compilationArg);
  const compilation = loadCompilation(compilationPath);
  const sourcePath = path.resolve(opts.source ?? compilation.source);
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: source video not found: ${sourcePath}`);
    process.exit(1);
  }

  const clips = compilation.clips;
  const LAST_CLIP_TAIL_PAD_S = 0.5;
  const totalDuration =
    clips.reduce((s, c) => s + c.end_s - c.start_s, 0) +
    (clips.length > 0 ? LAST_CLIP_TAIL_PAD_S : 0);

  process.stderr.write(`Topic: "${compilation.topic}"\n`);
  process.stderr.write(`Source: ${sourcePath}\n`);
  process.stderr.write(`Clips: ${clips.length} (${totalDuration.toFixed(1)}s total)\n`);

  process.stderr.write("Probing source…\n");
  const probe = await ffprobe(sourcePath);
  const video = getVideoStream(probe);
  const srcW = video.width!;
  const srcH = video.height!;
  process.stderr.write(`  Source: ${srcW}×${srcH}\n`);

  const [targetAspectW, targetAspectH] = parseAspect(opts.aspect);
  let outW: number, outH: number;
  if (opts.resolution) {
    [outW, outH] = opts.resolution.split("x").map(Number);
  } else {
    [outW, outH] = deriveOutputResolution(targetAspectW, targetAspectH);
  }
  process.stderr.write(`  Output: ${outW}×${outH} (${targetAspectW}:${targetAspectH})\n`);

  const crop = coverFillCrop(srcW, srcH, targetAspectW, targetAspectH);
  const spatialFilter =
    `crop=${crop.cropW}:${crop.cropH}:${crop.x}:${crop.y},scale=${outW}:${outH},setsar=1`;

  const filterParts: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const { start_s, end_s } = clips[i];
    const endAdj = i === clips.length - 1 ? end_s + LAST_CLIP_TAIL_PAD_S : end_s;
    filterParts.push(
      `[0:v]trim=start=${start_s.toFixed(6)}:end=${endAdj.toFixed(6)},setpts=PTS-STARTPTS,${spatialFilter}[v${i}]`
    );
    filterParts.push(
      `[0:a]atrim=start=${start_s.toFixed(6)}:end=${endAdj.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`
    );
  }
  const concatInputs = clips.map((_, i) => `[v${i}][a${i}]`).join("");
  const vconcat = opts.banner ? "vcat" : "vout";
  filterParts.push(
    `${concatInputs}concat=n=${clips.length}:v=1:a=1[${vconcat}][aout]`
  );
  if (opts.banner) {
    // Fit banner inside 60% width × 40% height of frame, keep aspect, center it.
    const maxW = Math.round(outW * 0.6);
    const maxH = Math.round(outH * 0.4);
    filterParts.push(
      `[1:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease[bnr]`
    );
    filterParts.push(`[vcat][bnr]overlay=20:20:format=auto[vout]`);
  }

  const compBase = path.basename(compilationPath).replace(/\.compilation\.json$/, "");
  const outDir = path.dirname(compilationPath);
  const outputPath = path.resolve(
    opts.output ?? path.join(outDir, `${compBase}.compilation.mp4`)
  );

  const progress = new ProgressReporter();
  process.stderr.write(`Rendering: ${outputPath}\n`);
  process.stderr.write(`Banner: ${opts.banner ? path.resolve(opts.banner) : "(none)"}\n`);
  if (opts.banner && !fs.existsSync(path.resolve(opts.banner))) {
    console.error(`Error: banner PNG not found: ${path.resolve(opts.banner)}`);
    process.exit(1);
  }

  const bannerArgs = opts.banner ? ["-i", path.resolve(opts.banner)] : [];
  await runFfmpeg(
    [
      "-i", sourcePath,
      ...bannerArgs,
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
    ],
    progress.ffmpegHandler(totalDuration, "rendering")
  );

  const outSize = (fs.statSync(outputPath).size / 1e6).toFixed(1);
  progress.done();
  process.stderr.write(
    `Done: ${outputPath}  (${outSize} MB, ${totalDuration.toFixed(1)}s, ${outW}×${outH})\n`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
