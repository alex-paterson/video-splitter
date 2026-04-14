import { z } from "zod";
import fs from "fs";

export const TranscriptSegmentSchema = z.object({
  start_s: z.number(),
  end_s: z.number(),
  speaker: z.string(),
  text: z.string(),
});

export const TranscriptSchema = z.object({
  source: z.string(),
  duration_s: z.number(),
  speakers: z.array(z.string()),
  segments: z.array(TranscriptSegmentSchema),
});

export const SegmentSchema = z.object({
  source: z.string(),
  start_s: z.number(),
  end_s: z.number(),
  title: z.string(),
  rationale: z.string(),
  speakers: z.array(z.string()),
});

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type Segment = z.infer<typeof SegmentSchema>;

export function loadTranscript(path: string): Transcript {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return TranscriptSchema.parse(raw);
}

export function loadSegment(path: string): Segment {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return SegmentSchema.parse(raw);
}

export function saveTranscript(path: string, transcript: Transcript): void {
  fs.writeFileSync(path, JSON.stringify(transcript, null, 2));
}

export function saveSegment(path: string, segment: Segment): void {
  fs.writeFileSync(path, JSON.stringify(segment, null, 2));
}

export const CompilationClipSchema = z.object({
  start_s: z.number(),
  end_s: z.number(),
  summary: z.string().optional(),
  transcript: z.array(TranscriptSegmentSchema).optional(),
});

export const CompilationSchema = z.object({
  source: z.string(),
  topic: z.string(),
  story: z.string().optional(),
  clips: z.array(CompilationClipSchema),
});

export type CompilationClip = z.infer<typeof CompilationClipSchema>;
export type Compilation = z.infer<typeof CompilationSchema>;

export function saveCompilation(path: string, compilation: Compilation): void {
  fs.writeFileSync(path, JSON.stringify(compilation, null, 2));
}

/** Format seconds as HH:MM:SS.mmm */
export function formatTimestamp(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}`;
}

/** Parse HH:MM:SS.mmm or SS.mmm to seconds */
export function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}
