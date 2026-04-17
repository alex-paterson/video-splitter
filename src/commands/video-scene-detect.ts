#!/usr/bin/env tsx
/**
 * video-scene-detect — Detect scene cuts in a video using ffmpeg's scene filter
 * (plus optional luma-jump and silence-end signals). Writes <base>.scenes.json.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import { ffprobe, getVideoStream, parseFraction } from "../../lib/ffmpeg.js";
import {
  SceneCut,
  cutsToScenes,
  lumaCuts,
  mergeCuts,
  pixelDiffCuts,
  saveSceneList,
  silenceCuts,
} from "../../lib/scenes.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("video-scene-detect")
  .description("Detect scene cuts and write <base>.scenes.json")
  .argument("<mp4>", "Input video")
  .option("--pixel-threshold <n>", "ffmpeg scene filter threshold [0..1]", "0.1")
  .option("--include-luma", "Include luma-jump signal", false)
  .option("--include-silence", "Include silence-end signal", false)
  .option("--min-scene <n>", "Drop scenes shorter than this many seconds", "0.5")
  .option("--output <path>", "Output path (default: <base>.scenes.json next to the MP4)")
  .parse(process.argv);

const opts = program.opts<{
  pixelThreshold: string;
  includeLuma: boolean;
  includeSilence: boolean;
  minScene: string;
  output?: string;
}>();
const [mp4Arg] = program.args;

async function main() {
  const mp4Path = path.resolve(mp4Arg);
  if (!fs.existsSync(mp4Path)) throw new Error(`MP4 not found: ${mp4Path}`);

  process.stderr.write(`Probing ${mp4Path}\n`);
  const probe = await ffprobe(mp4Path);
  const vs = getVideoStream(probe);
  const width = vs.width ?? 0;
  const height = vs.height ?? 0;
  const durationSec = parseFloat(probe.format.duration);
  const fps = vs.r_frame_rate ? parseFraction(vs.r_frame_rate) : 30;
  process.stderr.write(`  ${width}x${height} @${fps.toFixed(2)}fps, ${durationSec.toFixed(2)}s\n`);

  const all: SceneCut[] = [];
  process.stderr.write(`Pixel-diff scan (threshold=${opts.pixelThreshold})…\n`);
  all.push(...(await pixelDiffCuts(mp4Path, Number(opts.pixelThreshold))));
  if (opts.includeLuma) {
    process.stderr.write(`Luma-jump scan…\n`);
    all.push(...(await lumaCuts(mp4Path)));
  }
  if (opts.includeSilence) {
    process.stderr.write(`Silence-end scan…\n`);
    all.push(...(await silenceCuts(mp4Path)));
  }
  const merged = mergeCuts(all);
  const scenes = cutsToScenes(merged, durationSec, Number(opts.minScene));
  process.stderr.write(`Detected ${merged.length} cut(s) → ${scenes.length} scene(s)\n`);

  const dir = path.dirname(mp4Path);
  const baseNoExt = path.basename(mp4Path).replace(/\.[^.]+$/, "");
  const outPath = path.resolve(opts.output ?? redirectOutToTmp(path.join(dir, `${baseNoExt}.scenes.json`)));
  saveSceneList(outPath, {
    source_mp4: mp4Path,
    width,
    height,
    duration_s: durationSec,
    fps,
    scenes,
  });
  process.stderr.write(`Wrote ${outPath}\n`);
  process.stdout.write(outPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
