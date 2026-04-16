import { z } from "zod";
import fs from "fs";
import path from "path";

export const BoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Box = z.infer<typeof BoxSchema>;

export const RegionSchema = z.object({
  category: z.string(),
  label: z.string().optional(),
  box: BoxSchema,
  confidence: z.number().optional(),
  attributes: z.array(z.string()).optional(),
  source: z.string().optional(),
});

export const FrameRefSchema = z.object({
  t_s: z.number(),
  path: z.string(),
});

export const FramerSceneSchema = z.object({
  scene_id: z.number().int(),
  start_s: z.number(),
  end_s: z.number(),
  frames: z.array(FrameRefSchema).optional(),
  transcript: z.string().optional(),
  regions: z.array(RegionSchema),
});

export const FramerSchema = z.object({
  source_mp4: z.string(),
  width: z.number(),
  height: z.number(),
  duration_s: z.number(),
  scenes: z.array(FramerSceneSchema),
});

export type Region = z.infer<typeof RegionSchema>;
export type FramerScene = z.infer<typeof FramerSceneSchema>;
export type FramerJson = z.infer<typeof FramerSchema>;

export function loadFramer(p: string): FramerJson {
  return FramerSchema.parse(JSON.parse(fs.readFileSync(p, "utf-8")));
}

export function saveFramer(p: string, f: FramerJson): void {
  fs.writeFileSync(p, JSON.stringify(f, null, 2));
}

export function boxArea(b: Box): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/**
 * `.framer.filtered.json` paths: `<base>.framer.filtered.json`, `.filtered.2.json`, ...
 * Mirrors the compilation-refine auto-increment pattern.
 */
export function nextFilteredPath(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  const dir = path.dirname(basePath);
  const name = path.basename(basePath);
  const m = name.match(/^(.*)\.framer\.filtered(?:\.(\d+))?\.json$/);
  if (!m) return basePath;
  const stem = m[1];
  let n = m[2] ? parseInt(m[2], 10) + 1 : 2;
  while (true) {
    const candidate = path.join(dir, `${stem}.framer.filtered.${n}.json`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}
