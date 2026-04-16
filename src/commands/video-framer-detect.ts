#!/usr/bin/env tsx
/**
 * video-framer-detect — For each scene in <scenes-json>, extract a midpoint
 * frame and ask Claude vision for candidate software-window regions.
 * Writes <base>.framer.json.
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import { loadSceneList } from "../../lib/scenes.js";
import { FramerJson, FramerScene, Region, saveFramer } from "../../lib/framer.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("video-framer-detect")
  .description("Extract scene-midpoint frames and detect regions via Claude vision")
  .argument("<mp4>", "Input video")
  .argument("<scenes-json>", "Path to .scenes.json from video-scene-detect")
  .option("--frames-per-scene <n>", "Number of frames sampled per scene (middle 50% spread)", "1")
  .option("--model <model>", "Claude vision model", "claude-opus-4-6")
  .option("--output <path>", "Output path (default: <base>.framer.json)")
  .option("--keep-frames", "Keep extracted frame JPEGs (default: delete after detection)", false)
  .parse(process.argv);

const opts = program.opts<{
  framesPerScene: string;
  model: string;
  output?: string;
  keepFrames: boolean;
}>();
const [mp4Arg, scenesArg] = program.args;

const VISION_SYSTEM = `You identify every distinct software window in a single video frame.
A "software window" is a self-contained application surface: an editor, terminal, browser tab content area, game viewport, file manager, video player, etc. Each top-level visible app surface is one region.
Return ONLY JSON: {"regions":[{"category":"software_window","label":"...","box":[x1,y1,x2,y2],"attributes":[...],"confidence":0-1}]}.
Coordinates MUST be NORMALIZED FRACTIONS in [0,1] of the image (top-left origin). Example: a window covering the full image is [0,0,1,1]; the right half is [0.5,0,1,1]. Use category "software_window" for every region. Keep labels <= 10 words.`;

function extractFrame(mp4: string, t: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-ss", t.toFixed(3),
      "-i", mp4,
      "-frames:v", "1",
      "-q:v", "3",
      out,
    ];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg frame extract: ${err.slice(-300)}`))));
  });
}

function extractJson(s: string): string | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return null;
}

async function detectRegions(
  client: Anthropic,
  model: string,
  framePath: string,
  width: number,
  height: number,
): Promise<Region[]> {
  const buf = fs.readFileSync(framePath);
  const b64 = buf.toString("base64");
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    system: VISION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          { type: "text", text: "Emit JSON only. All box coordinates are NORMALIZED fractions in [0,1]." },
        ],
      },
    ],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const json = extractJson(text);
  if (!json) return [];
  let parsed: { regions?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(json);
  } catch {
    process.stderr.write(`  claude-vision: JSON parse failed, skipping frame\n`);
    return [];
  }
  const out: Region[] = [];
  for (const r of parsed.regions ?? []) {
    if (r.category !== "software_window") continue;
    const rawBox = r.box;
    if (!Array.isArray(rawBox) || rawBox.length !== 4) continue;
    const box: [number, number, number, number] = [
      Math.round(Number(rawBox[0]) * width),
      Math.round(Number(rawBox[1]) * height),
      Math.round(Number(rawBox[2]) * width),
      Math.round(Number(rawBox[3]) * height),
    ];
    if (!box.every(Number.isFinite)) continue;
    out.push({
      category: "software_window",
      box,
      label: typeof r.label === "string" ? r.label : undefined,
      attributes: Array.isArray(r.attributes)
        ? (r.attributes.filter((a: unknown) => typeof a === "string") as string[])
        : undefined,
      confidence: typeof r.confidence === "number" ? r.confidence : 0.7,
      source: "claude-vision",
    });
  }
  return out;
}

async function main() {
  const mp4Path = path.resolve(mp4Arg);
  const scenesPath = path.resolve(scenesArg);
  if (!fs.existsSync(mp4Path)) throw new Error(`MP4 not found: ${mp4Path}`);
  if (!fs.existsSync(scenesPath)) throw new Error(`Scenes JSON not found: ${scenesPath}`);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const scenesFile = loadSceneList(scenesPath);
  const client = new Anthropic({ apiKey });
  const framesPerScene = Math.max(1, parseInt(opts.framesPerScene, 10));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-framer-"));

  const outScenes: FramerScene[] = [];
  for (const scene of scenesFile.scenes) {
    const dur = scene.end_s - scene.start_s;
    const frames: { t_s: number; path: string }[] = [];
    for (let i = 0; i < framesPerScene; i++) {
      const t = scene.start_s + (dur * (i + 0.5)) / framesPerScene;
      const framePath = path.join(workDir, `scene${scene.scene_id}_f${i}.jpg`);
      await extractFrame(mp4Path, t, framePath);
      frames.push({ t_s: t, path: framePath });
    }
    const regions: Region[] = [];
    for (const f of frames) {
      process.stderr.write(
        `scene ${scene.scene_id} [${scene.start_s.toFixed(1)}-${scene.end_s.toFixed(1)}s] → vision\n`,
      );
      const r = await detectRegions(client, opts.model, f.path, scenesFile.width, scenesFile.height);
      regions.push(...r);
    }
    outScenes.push({
      scene_id: scene.scene_id,
      start_s: scene.start_s,
      end_s: scene.end_s,
      frames: opts.keepFrames ? frames : undefined,
      regions,
    });
  }

  const out: FramerJson = {
    source_mp4: mp4Path,
    width: scenesFile.width,
    height: scenesFile.height,
    duration_s: scenesFile.duration_s,
    scenes: outScenes,
  };

  const dir = path.dirname(mp4Path);
  const baseNoExt = path.basename(mp4Path).replace(/\.[^.]+$/, "");
  const outPath = path.resolve(opts.output ?? redirectOutToTmp(path.join(dir, `${baseNoExt}.framer.json`)));
  saveFramer(outPath, out);

  if (!opts.keepFrames) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
  const totalRegions = outScenes.reduce((n, s) => n + s.regions.length, 0);
  process.stderr.write(
    `Wrote ${outPath}  (${outScenes.length} scenes, ${totalRegions} region candidate(s))\n`,
  );
  process.stdout.write(outPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
