#!/usr/bin/env tsx
/**
 * segment-render — Extract and render a video segment, reframed to a target
 * aspect ratio using cover-fill center cropping.
 *
 * Usage: tsx src/commands/segment-render.ts [options] <input> [segment]
 *        tsx src/commands/segment-render.ts [options] <input>  (reads segment JSON from stdin)
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import { ffprobe, getVideoStream, parseFraction, runFfmpeg } from "../../lib/ffmpeg.js";
import { loadSegment, Segment, SegmentSchema } from "../../lib/transcript.js";
import { ProgressReporter } from "../../lib/progress.js";

const ASPECT_PRESETS: Record<string, [number, number]> = {
  portrait: [9, 16],
  square: [1, 1],
  landscape: [16, 9],
  cinema: [21, 9],
};

const program = new Command();

program
  .name("segment-render")
  .description("Extract and render a video segment with cover-fill cropping")
  .argument("<input>", "Source video file")
  .argument("[segment]", "Path to .segment.json (or JSON string); reads stdin if omitted")
  .option("--aspect <ratio>", "Target aspect ratio W:H or preset name", "9:16")
  .option("--resolution <WxH>", "Output resolution, e.g. 1080x1920 (overrides aspect-derived default)")
  .option("--fit", "Fit (letterbox/pillarbox) instead of cover-fill crop")
  .option("--crf <n>", "Output CRF quality (lower = better)", "18")
  .option("--preset <preset>", "ffmpeg encoding preset", "slow")
  .option("--codec <codec>", "Video codec", "libx264")
  .option("--audio-codec <codec>", "Audio codec", "aac")
  .option("--audio-bitrate <br>", "Audio bitrate", "192k")
  .option("--format <ext>", "Output container format", "mp4")
  .option("--output <path>", "Output file path")
  .option("--threads <n>", "ffmpeg thread count (0 = auto)", "0")
  .option("--hw-accel <api>", "Hardware acceleration: nvenc | vaapi | videotoolbox");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  aspect: string;
  resolution?: string;
  fit: boolean;
  crf: string;
  preset: string;
  codec: string;
  audioCodec: string;
  audioBitrate: string;
  format: string;
  output?: string;
  threads: string;
  hwAccel?: string;
}>();

const [inputArg, segmentArg] = program.args;

// ─── Aspect ratio helpers ─────────────────────────────────────────────────────

function parseAspect(aspect: string): [number, number] {
  if (ASPECT_PRESETS[aspect]) return ASPECT_PRESETS[aspect];
  const parts = aspect.split(":").map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) {
    throw new Error(`Invalid aspect ratio: "${aspect}". Use W:H or a preset (portrait, square, landscape, cinema).`);
  }
  return [parts[0], parts[1]];
}

/**
 * Compute cover-fill crop parameters.
 *
 * Given source (srcW × srcH) and target ratio (tw:th), returns the ffmpeg
 * crop filter string that crops the source to exactly fill the target ratio,
 * centered, with no letterbox or pillarbox.
 */
function coverFillCrop(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number
): { cropW: number; cropH: number; x: number; y: number } {
  const srcRatio = srcW / srcH;
  const tgtRatio = targetW / targetH;

  let cropW: number, cropH: number;

  if (srcRatio > tgtRatio) {
    // Source is wider than target — crop width, keep full height
    cropH = srcH;
    cropW = Math.round(srcH * tgtRatio);
  } else {
    // Source is taller than target — crop height, keep full width
    cropW = srcW;
    cropH = Math.round(srcW / tgtRatio);
  }

  // Ensure even dimensions (required by most codecs)
  cropW = cropW % 2 === 0 ? cropW : cropW - 1;
  cropH = cropH % 2 === 0 ? cropH : cropH - 1;

  const x = Math.floor((srcW - cropW) / 2);
  const y = Math.floor((srcH - cropH) / 2);

  return { cropW, cropH, x, y };
}

/**
 * Compute letterbox/pillarbox (fit) parameters — scale to fit with bars.
 */
function fitScale(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): string {
  // Scale keeping aspect ratio, then pad to outW×outH
  return `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,` +
    `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`;
}

function deriveOutputResolution(
  cropW: number,
  cropH: number,
  targetAspectW: number,
  targetAspectH: number
): [number, number] {
  // Scale up/down to a sensible output size based on crop area
  // Use 1080p as the long edge reference
  const LONG_EDGE = 1920;
  if (targetAspectW >= targetAspectH) {
    // Landscape or square — width is long edge
    const outW = LONG_EDGE;
    const outH = Math.round((LONG_EDGE / targetAspectW) * targetAspectH);
    return [outW % 2 === 0 ? outW : outW - 1, outH % 2 === 0 ? outH : outH - 1];
  } else {
    // Portrait — height is long edge
    const outH = LONG_EDGE;
    const outW = Math.round((LONG_EDGE / targetAspectH) * targetAspectW);
    return [outW % 2 === 0 ? outW : outW - 1, outH % 2 === 0 ? outH : outH - 1];
  }
}

// ─── Hardware acceleration ────────────────────────────────────────────────────

function hwAccelArgs(hwAccel: string, codec: string): { inputArgs: string[]; encoderName: string } {
  switch (hwAccel) {
    case "nvenc":
      return {
        inputArgs: ["-hwaccel", "cuda"],
        encoderName: codec === "libx264" ? "h264_nvenc" : codec === "libx265" ? "hevc_nvenc" : codec,
      };
    case "vaapi":
      return {
        inputArgs: ["-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi"],
        encoderName: codec === "libx264" ? "h264_vaapi" : codec === "libx265" ? "hevc_vaapi" : codec,
      };
    case "videotoolbox":
      return {
        inputArgs: ["-hwaccel", "videotoolbox"],
        encoderName: codec === "libx264" ? "h264_videotoolbox" : codec === "libx265" ? "hevc_videotoolbox" : codec,
      };
    default:
      throw new Error(`Unknown hw-accel backend: ${hwAccel}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: input file not found: ${inputArg}`);
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);

  // Load segment from file, inline JSON string, or stdin
  let segment: Segment;
  if (segmentArg) {
    if (segmentArg.trim().startsWith("{")) {
      segment = SegmentSchema.parse(JSON.parse(segmentArg));
    } else {
      segment = loadSegment(path.resolve(segmentArg));
    }
  } else {
    process.stderr.write("Reading segment JSON from stdin…\n");
    const stdin = fs.readFileSync("/dev/stdin", "utf-8");
    // Handle both single segment and array (take first)
    const parsed = JSON.parse(stdin);
    segment = SegmentSchema.parse(Array.isArray(parsed) ? parsed[0] : parsed);
  }

  process.stderr.write(
    `Segment: "${segment.title}"  ${segment.start_s.toFixed(2)}s → ${segment.end_s.toFixed(2)}s  ` +
      `(${(segment.end_s - segment.start_s).toFixed(2)}s)\n`
  );

  // Probe source
  process.stderr.write("Probing source…\n");
  const probe = await ffprobe(inputPath);
  const video = getVideoStream(probe);
  const srcW = video.width!;
  const srcH = video.height!;
  const fps = parseFraction(video.avg_frame_rate ?? video.r_frame_rate ?? "30/1");

  process.stderr.write(`  Source: ${srcW}×${srcH} @ ${fps.toFixed(2)}fps\n`);

  // Parse target aspect ratio
  const [targetAspectW, targetAspectH] = parseAspect(opts.aspect);

  // Determine output resolution
  let outW: number, outH: number;
  if (opts.resolution) {
    const [rw, rh] = opts.resolution.split("x").map(Number);
    outW = rw;
    outH = rh;
  } else {
    const crop = coverFillCrop(srcW, srcH, targetAspectW, targetAspectH);
    [outW, outH] = deriveOutputResolution(crop.cropW, crop.cropH, targetAspectW, targetAspectH);
  }

  process.stderr.write(`  Output: ${outW}×${outH} (${targetAspectW}:${targetAspectH})\n`);

  // Build video filter
  let vfFilter: string;
  if (opts.fit) {
    vfFilter = fitScale(srcW, srcH, outW, outH);
  } else {
    const crop = coverFillCrop(srcW, srcH, targetAspectW, targetAspectH);
    vfFilter = [
      `crop=${crop.cropW}:${crop.cropH}:${crop.x}:${crop.y}`,
      `scale=${outW}:${outH}`,
      "setsar=1",
    ].join(",");
  }

  // Determine output path
  const segDuration = segment.end_s - segment.start_s;
  const ext = opts.format.startsWith(".") ? opts.format : `.${opts.format}`;
  const defaultOutput = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}_${segment.start_s.toFixed(0)}-${segment.end_s.toFixed(0)}${ext}`
  );
  const outputPath = path.resolve(opts.output ?? defaultOutput);

  // Build ffmpeg args
  const hwAccelInput = opts.hwAccel ? hwAccelArgs(opts.hwAccel, opts.codec) : null;
  const encoderName = hwAccelInput ? hwAccelInput.encoderName : opts.codec;

  const ffmpegArgs: string[] = [
    ...(hwAccelInput?.inputArgs ?? []),
    "-ss", String(segment.start_s),
    "-t", String(segDuration),
    "-i", inputPath,
    "-vf", vfFilter,
    "-c:v", encoderName,
    "-crf", opts.crf,
    "-preset", opts.preset,
    "-c:a", opts.audioCodec,
    "-b:a", opts.audioBitrate,
    "-threads", opts.threads,
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ];

  process.stderr.write(`Encoding: ${outputPath}\n`);
  const progress = new ProgressReporter();

  await runFfmpeg(
    ffmpegArgs,
    progress.ffmpegHandler(segDuration, "encoding")
  );

  const outSize = (fs.statSync(outputPath).size / 1e6).toFixed(1);
  progress.done();
  process.stderr.write(
    `Done: ${outputPath}  (${outSize} MB, ${segDuration.toFixed(1)}s, ${outW}×${outH})\n`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
