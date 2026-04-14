import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { loadCompilation, loadSegment, loadTranscript } from "../../lib/transcript.js";

type Span = { start_s: number; end_s: number };
const sumSpans = (xs: Span[]): number =>
  xs.reduce((s, x) => s + Math.max(0, x.end_s - x.start_s), 0);

export const compilationEstimateDuration = tool({
  name: "compilation_estimate_duration",
  description:
    "ESTIMATE the post-silence-strip duration of a .compilation.json by summing the durations of its transcript phrases (not the raw clip boundaries). Use this INSTEAD OF guessing. Reports both: raw clip-bounds total (pre-cut) and phrase-sum total (post-cut estimate). Silence between phrases is assumed to be removed.",
  inputSchema: z.object({
    compilation: z.string().describe("Path to .compilation[.N].json"),
  }),
  callback: async ({ compilation }: { compilation: string }) => {
    const p = path.resolve(compilation);
    if (!fs.existsSync(p)) return `ERROR: not found: ${p}`;
    const comp = loadCompilation(p);
    const clipBoundsTotal = sumSpans(comp.clips);
    let phraseTotal = 0;
    let phraseCount = 0;
    for (const clip of comp.clips) {
      if (clip.transcript && clip.transcript.length > 0) {
        phraseTotal += sumSpans(clip.transcript);
        phraseCount += clip.transcript.length;
      } else {
        phraseTotal += clip.end_s - clip.start_s;
      }
    }
    return [
      `ESTIMATE for ${p}`,
      `  clip_bounds_total_s: ${clipBoundsTotal.toFixed(1)} (raw, pre-silence-cut)`,
      `  phrase_sum_total_s:  ${phraseTotal.toFixed(1)} (ESTIMATE of post-silence-cut duration, across ${phraseCount} phrases)`,
      `  clips: ${comp.clips.length}`,
      `Note: phrase_sum_total_s is an estimate — actual will vary slightly with --pad and speech boundary detection.`,
    ].join("\n");
  },
});

export const segmentEstimateDuration = tool({
  name: "segment_estimate_duration",
  description:
    "ESTIMATE the post-silence-strip duration of a .segment.json. Reports both raw range duration and, if a sibling .transcript.json exists, the phrase-sum estimate across the segment's time range.",
  inputSchema: z.object({
    segment: z.string().describe("Path to .segment.json"),
    transcript: z
      .string()
      .optional()
      .describe("Optional transcript path; defaults to sibling .transcript.json of the source"),
  }),
  callback: async ({ segment, transcript }: { segment: string; transcript?: string }) => {
    const p = path.resolve(segment);
    if (!fs.existsSync(p)) return `ERROR: not found: ${p}`;
    const seg = loadSegment(p);
    const rangeTotal = seg.end_s - seg.start_s;
    const txPath = transcript
      ? path.resolve(transcript)
      : seg.source.replace(/\.(mkv|mp4|mov|webm)$/i, ".transcript.json");
    const lines = [
      `ESTIMATE for ${p}`,
      `  range_total_s: ${rangeTotal.toFixed(1)} (raw, pre-silence-cut)`,
    ];
    if (fs.existsSync(txPath)) {
      const tx = loadTranscript(txPath);
      const overlapping = tx.segments.filter(
        (s) => s.end_s > seg.start_s && s.start_s < seg.end_s
      );
      const phraseTotal = sumSpans(
        overlapping.map((s) => ({
          start_s: Math.max(s.start_s, seg.start_s),
          end_s: Math.min(s.end_s, seg.end_s),
        }))
      );
      lines.push(
        `  phrase_sum_total_s: ${phraseTotal.toFixed(1)} (ESTIMATE post-silence-cut, ${overlapping.length} phrases)`
      );
    } else {
      lines.push(`  (no transcript at ${txPath} — phrase-sum estimate unavailable)`);
    }
    lines.push(`Note: phrase_sum_total_s is an estimate — actual will vary slightly.`);
    return lines.join("\n");
  },
});
