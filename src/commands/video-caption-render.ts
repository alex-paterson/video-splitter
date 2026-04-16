#!/usr/bin/env tsx
/**
 * video-caption-render — Burn captions onto <mp4> using <caption-json> via Remotion.
 *
 * Usage: tsx src/commands/video-caption-render.ts <mp4> <caption-json> [--output <path>] [--concurrency <n>]
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { ffprobe, getVideoStream, parseFraction } from "../../lib/ffmpeg.js";
import { loadCaptionPlan, type CaptionPlan } from "../../lib/caption.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();
program
  .name("video-caption-render")
  .description("Burn captions into an MP4 using a .caption.json plan")
  .argument("<mp4>", "Input MP4 to caption")
  .argument("<caption-json>", "Path to .caption[.N].json plan")
  .option("--output <path>", "Output MP4 path (default: <mp4-base>.captioned.mp4)")
  .option("--concurrency <n>", "Remotion render concurrency", "4")
  .parse(process.argv);

const opts = program.opts<{ output?: string; concurrency: string }>();
const [mp4Arg, planArg] = program.args;

async function main() {
  const mp4Path = path.resolve(mp4Arg);
  const planPath = path.resolve(planArg);
  if (!fs.existsSync(mp4Path)) throw new Error(`MP4 not found: ${mp4Path}`);
  if (!fs.existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);

  const plan = loadCaptionPlan(planPath);

  process.stderr.write(`Probing ${mp4Path}\n`);
  const probe = await ffprobe(mp4Path);
  const vs = getVideoStream(probe);
  const width = vs.width ?? plan.videoWidth;
  const height = vs.height ?? plan.videoHeight;
  const durationSec = parseFloat(probe.format.duration) || plan.durationSec;
  const containerFps = vs.r_frame_rate ? parseFraction(vs.r_frame_rate) : plan.style.fps;
  process.stderr.write(`  ${width}x${height} @${containerFps.toFixed(2)}fps, ${durationSec.toFixed(2)}s\n`);

  const repoRoot = path.resolve(new URL("../../", import.meta.url).pathname);
  const fontsDir = path.join(repoRoot, "src/remotion/fonts");
  const fonts = fs.existsSync(fontsDir)
    ? fs
        .readdirSync(fontsDir)
        .filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
        .map((f) => ({ family: f.replace(/\.[^.]+$/, ""), url: `fonts/${f}` }))
    : [];
  process.stderr.write(`Registered ${fonts.length} fonts\n`);

  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-caption-"));
  const mp4BasenameInPublic = path.basename(mp4Path);
  try {
    fs.linkSync(mp4Path, path.join(publicDir, mp4BasenameInPublic));
  } catch {
    fs.copyFileSync(mp4Path, path.join(publicDir, mp4BasenameInPublic));
  }
  fs.mkdirSync(path.join(publicDir, "fonts"), { recursive: true });
  for (const f of fonts) {
    fs.copyFileSync(
      path.join(fontsDir, path.basename(f.url)),
      path.join(publicDir, "fonts", path.basename(f.url)),
    );
  }

  const config = { ...plan.style, fonts };
  const title = plan.title ? { text: plan.title.text, config: { ...plan.title.style, fonts } } : undefined;
  const inputProps = {
    videoSrc: mp4BasenameInPublic,
    videoWidth: width,
    videoHeight: height,
    durationSec,
    phrases: plan.phrases,
    config,
    title,
  };

  const entry = path.join(repoRoot, "src/remotion/index.ts");
  process.stderr.write(`Bundling Remotion entry ${entry}\n`);
  const serveUrl = await bundle({
    entryPoint: entry,
    publicDir,
    webpackOverride: (c) => ({
      ...c,
      resolve: {
        ...c.resolve,
        extensionAlias: { ".js": [".js", ".ts", ".tsx"] },
      },
    }),
  });

  const composition = await selectComposition({
    serveUrl,
    id: "Captions",
    inputProps: inputProps as unknown as Record<string, unknown>,
  });
  process.stderr.write(
    `Rendering ${composition.width}x${composition.height} @${composition.fps}fps, ${composition.durationInFrames} frames\n`,
  );

  const mp4Dir = path.dirname(mp4Path);
  const baseNoExt = path.basename(mp4Path).replace(/\.[^.]+$/, "");
  const outPath = path.resolve(opts.output ?? redirectOutToTmp(path.join(mp4Dir, `${baseNoExt}.captioned.mp4`)));

  let lastLogged = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outPath,
    inputProps: inputProps as unknown as Record<string, unknown>,
    concurrency: Number(opts.concurrency),
    imageFormat: "jpeg",
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 100);
      if (pct !== lastLogged && pct % 5 === 0) {
        lastLogged = pct;
        process.stderr.write(`Render ${pct}%\n`);
      }
    },
  });
  process.stderr.write(`Wrote ${outPath}\n`);
  process.stdout.write(outPath + "\n");

  try {
    fs.rmSync(publicDir, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
