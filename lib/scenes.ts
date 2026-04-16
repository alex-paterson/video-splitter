import { z } from "zod";
import fs from "fs";
import { spawn } from "child_process";

export const SceneSchema = z.object({
  scene_id: z.number().int(),
  start_s: z.number(),
  end_s: z.number(),
  method: z.string().optional(),
  score: z.number().optional(),
});

export const SceneListSchema = z.object({
  source_mp4: z.string(),
  width: z.number(),
  height: z.number(),
  duration_s: z.number(),
  fps: z.number().optional(),
  scenes: z.array(SceneSchema),
});

export type Scene = z.infer<typeof SceneSchema>;
export type SceneList = z.infer<typeof SceneListSchema>;

export function loadSceneList(p: string): SceneList {
  return SceneListSchema.parse(JSON.parse(fs.readFileSync(p, "utf-8")));
}

export function saveSceneList(p: string, s: SceneList): void {
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
}

export interface SceneCut {
  t_s: number;
  score: number;
  method: string;
}

function ffmpegCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let stderr = "";
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", () => resolve(stderr));
  });
}

/** Pixel-diff scene detector using ffmpeg's `scene` filter. */
export async function pixelDiffCuts(video: string, threshold = 0.3): Promise<SceneCut[]> {
  const stderr = await ffmpegCapture([
    "-i", video,
    "-filter:v", `select='gt(scene,${threshold})',metadata=print`,
    "-an", "-f", "null", "-",
  ]);
  const cuts: SceneCut[] = [];
  const blocks = stderr.split(/frame:\d+/);
  for (const b of blocks) {
    const tm = b.match(/pts_time:([0-9.]+)/);
    const sm = b.match(/lavfi\.scene_score=([0-9.]+)/);
    if (tm && sm) cuts.push({ t_s: Number(tm[1]), score: Number(sm[1]), method: "pixel-diff" });
  }
  return cuts;
}

/** Luma-jump secondary signal via signalstats YAVG. */
export async function lumaCuts(video: string, deltaThreshold = 25): Promise<SceneCut[]> {
  const stderr = await ffmpegCapture([
    "-i", video,
    "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-an", "-f", "null", "-",
  ]);
  const series: { t: number; y: number }[] = [];
  const blocks = stderr.split(/frame:\d+/);
  for (const b of blocks) {
    const tm = b.match(/pts_time:([0-9.]+)/);
    const ym = b.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    if (tm && ym) series.push({ t: Number(tm[1]), y: Number(ym[1]) });
  }
  const cuts: SceneCut[] = [];
  for (let i = 1; i < series.length; i++) {
    const d = Math.abs(series[i].y - series[i - 1].y);
    if (d > deltaThreshold) cuts.push({ t_s: series[i].t, score: Math.min(1, d / 100), method: "luma-jump" });
  }
  return cuts;
}

/** Silence-end signal — hard cuts often coincide with audio changes. */
export async function silenceCuts(video: string, noiseDb = -30, minDurSec = 0.4): Promise<SceneCut[]> {
  const stderr = await ffmpegCapture([
    "-i", video,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurSec}`,
    "-f", "null", "-",
  ]);
  const cuts: SceneCut[] = [];
  const re = /silence_end:\s*([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    cuts.push({ t_s: Number(m[1]), score: 0.4, method: "silence-end" });
  }
  return cuts;
}

/** Merge cuts within a time window; union methods, max score. */
export function mergeCuts(all: SceneCut[], mergeWindowSec = 0.4): SceneCut[] {
  if (all.length === 0) return [];
  const sorted = [...all].sort((a, b) => a.t_s - b.t_s);
  const merged: SceneCut[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.t_s - last.t_s < mergeWindowSec) {
      last.score = Math.max(last.score, c.score);
      if (!last.method.includes(c.method)) last.method = `${last.method}+${c.method}`;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/** Convert a list of cut times to a list of [start,end] scene ranges. */
export function cutsToScenes(cuts: SceneCut[], durationSec: number, minSceneSec = 0.5): Scene[] {
  const times = cuts.map((c) => c.t_s).filter((t) => t > minSceneSec && t < durationSec - minSceneSec);
  const boundaries = [0, ...times, durationSec];
  const scenes: Scene[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end - start < minSceneSec) continue;
    const matchingCut = cuts.find((c) => Math.abs(c.t_s - start) < 0.01);
    scenes.push({
      scene_id: scenes.length,
      start_s: start,
      end_s: end,
      method: matchingCut?.method ?? (i === 0 ? "start" : "merged"),
      score: matchingCut?.score,
    });
  }
  return scenes;
}
