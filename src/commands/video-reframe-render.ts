#!/usr/bin/env tsx
/**
 * video-reframe-render — Reframe an MP4 to a target aspect using a
 * .framer.filtered.json. Per-scene: blurred background + centered crop of the
 * chosen region. Segments are concatenated via ffmpeg concat demuxer.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn } from "child_process";
import { Box, FramerScene, loadFramer } from "../../lib/framer.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("video-reframe-render")
  .description("Reframe a video to a target aspect using a .framer.filtered.json")
  .argument("<mp4>", "Input video")
  .argument("<filtered-json>", "Path to .framer.filtered[.N].json")
  .option("--width <n>", "Output width", "1080")
  .option("--height <n>", "Output height", "1920")
  .option("--output <path>", "Output MP4 (default: <base>.reframed.mp4)")
  .option("--preset <preset>", "ffmpeg libx264 preset", "fast")
  .option("--crf <n>", "libx264 CRF", "20")
  .parse(process.argv);

const opts = program.opts<{
  width: string;
  height: string;
  output?: string;
  preset: string;
  crf: string;
}>();
const [mp4Arg, filteredArg] = program.args;

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code}): ${err.slice(-500)}`)),
    );
  });
}

function sceneBox(scene: FramerScene, frameW: number, frameH: number): Box {
  const r = scene.regions[0];
  if (!r) return [0, 0, frameW, frameH];
  return r.box;
}

async function renderScene(
  mp4: string,
  scene: FramerScene,
  frameW: number,
  frameH: number,
  outW: number,
  outH: number,
  out: string,
  preset: string,
  crf: string,
): Promise<void> {
  const rawBox = sceneBox(scene, frameW, frameH);
  let bx = Math.max(0, Math.round(rawBox[0]));
  let by = Math.max(0, Math.round(rawBox[1]));
  let bw = Math.max(2, Math.round(rawBox[2] - rawBox[0]));
  let bh = Math.max(2, Math.round(rawBox[3] - rawBox[1]));
  bw = Math.min(bw, frameW - bx);
  bh = Math.min(bh, frameH - by);
  if (bw % 2) bw -= 1;
  if (bh % 2) bh -= 1;

  const filter =
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${outW}:${outH},gblur=sigma=30,eq=brightness=-0.15,setsar=1[bgc];` +
    `[fg]crop=${bw}:${bh}:${bx}:${by},` +
    `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fgs];` +
    `[bgc][fgs]overlay=(W-w)/2:(H-h)/2[v]`;

  const dur = scene.end_s - scene.start_s;
  const label = scene.regions[0]?.label ?? "full-frame";
  process.stderr.write(
    `scene ${scene.scene_id} [${scene.start_s.toFixed(1)}-${scene.end_s.toFixed(1)}s] "${label.slice(0, 40)}" crop=${bw}x${bh}@${bx},${by}\n`,
  );
  await runFfmpeg(
    [
      "-y",
      "-ss", scene.start_s.toFixed(3),
      "-i", mp4,
      "-t", dur.toFixed(3),
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", crf,
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      out,
    ],
    `scene ${scene.scene_id} render`,
  );
}

async function main() {
  const mp4Path = path.resolve(mp4Arg);
  const filteredPath = path.resolve(filteredArg);
  if (!fs.existsSync(mp4Path)) throw new Error(`MP4 not found: ${mp4Path}`);
  if (!fs.existsSync(filteredPath)) throw new Error(`Filtered JSON not found: ${filteredPath}`);

  const framer = loadFramer(filteredPath);
  const outW = Number(opts.width);
  const outH = Number(opts.height);
  process.stderr.write(
    `Source: ${framer.width}x${framer.height}, ${framer.scenes.length} scene(s); target: ${outW}x${outH}\n`,
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-reframe-"));
  const segPaths: string[] = [];
  try {
    for (const scene of framer.scenes) {
      const segPath = path.join(workDir, `seg_${String(scene.scene_id).padStart(4, "0")}.mp4`);
      await renderScene(
        mp4Path,
        scene,
        framer.width,
        framer.height,
        outW,
        outH,
        segPath,
        opts.preset,
        opts.crf,
      );
      segPaths.push(segPath);
    }

    const listPath = path.join(workDir, "list.txt");
    fs.writeFileSync(
      listPath,
      segPaths.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    );
    process.stderr.write(`Concatenating ${segPaths.length} segments\n`);
    const mp4Dir = path.dirname(mp4Path);
    const baseNoExt = path.basename(mp4Path).replace(/\.[^.]+$/, "");
    const outPath = path.resolve(opts.output ?? redirectOutToTmp(path.join(mp4Dir, `${baseNoExt}.reframed.mp4`)));
    await runFfmpeg(
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        outPath,
      ],
      "concat",
    );
    process.stderr.write(`Wrote ${outPath}\n`);
    process.stdout.write(outPath + "\n");
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
