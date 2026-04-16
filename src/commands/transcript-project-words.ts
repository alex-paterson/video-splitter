#!/usr/bin/env tsx
/**
 * transcript-project-words — Build a .words.json for a rendered MP4 by
 * projecting word timings from the ORIGINAL .transcript.json onto the
 * compiled/segmented + silence-stripped output timeline.
 *
 * Never re-transcribes the cut MP4 (CLAUDE.md forbids that).
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import { z } from "zod";
import {
  Compilation,
  CompilationSchema,
  Segment,
  SegmentSchema,
  Transcript,
  loadTranscript,
} from "../../lib/transcript.js";
import { WordsJson, saveWordsJson } from "../../lib/words.js";
import {
  KeepInterval,
  keptDuration,
  projectWordsForSegment,
  projectWordsThroughClips,
  projectWordsThroughKeepIntervals,
} from "../../lib/words-projection.js";
import { ffprobe, getVideoStream } from "../../lib/ffmpeg.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("transcript-project-words")
  .description(
    "Build a .words.json for a rendered MP4 by projecting words from the ORIGINAL transcript onto the output timeline (clips + optional silence removal). Never re-transcribes the cut MP4.",
  )
  .requiredOption("--source-transcript <path>", "Path to the original .transcript.json (must be schema v2 with words[])")
  .option("--compilation <path>", "Path to .compilation[.N].json that produced the MP4")
  .option("--segment <path>", "Path to .segment.json that produced the MP4 (exclusive with --compilation)")
  .option("--silence <path>", "Path to .silence.json (auto-detected as <mp4>.silence.json when omitted)")
  .option("--mp4 <path>", "Rendered MP4 path (used for output naming + video_width/height; also used to locate a sibling .silence.json)")
  .option("--output <path>", "Output .words.json path (default: <mp4-base>.words.json)")
  .parse(process.argv);

const opts = program.opts<{
  sourceTranscript: string;
  compilation?: string;
  segment?: string;
  silence?: string;
  mp4?: string;
  output?: string;
}>();

const SilenceFileSchema = z.object({
  silence: z
    .array(z.object({ start_s: z.number(), end_s: z.number(), duration_s: z.number().optional() }))
    .optional(),
  keep: z
    .array(z.object({ start_s: z.number(), end_s: z.number(), duration_s: z.number().optional() }))
    .optional(),
});

/** Load .silence.json and return the `keep` intervals (authoritative shifts). */
function loadKeepIntervals(p: string): KeepInterval[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  const parsed = SilenceFileSchema.parse(raw);
  if (!parsed.keep || parsed.keep.length === 0) {
    throw new Error(
      `${p} has no \`keep\` array — this is from an old silence.json before keep intervals were recorded. Re-run video_remove_silence.`,
    );
  }
  return parsed.keep.map((k) => ({ start_s: k.start_s, end_s: k.end_s }));
}

/**
 * Given a final MP4 path like `<base>.compilation.cut.bleeped.reframed.captioned.mp4`,
 * return the path of the silence.json that was produced when video_remove_silence
 * ran on this clip. That file lives next to the PRE-strip input, e.g.
 * `<base>.compilation.silence.json`. Strips trailing derivative suffixes
 * (.captioned, .reframed, .bleeped, .cut) before appending `.silence.json`.
 */
function deriveSilencePath(mp4Path: string): string {
  const dir = path.dirname(mp4Path);
  let base = path.basename(mp4Path).replace(/\.[^.]+$/, "");
  // Strip derivative suffixes iteratively, tolerating optional -\d+
  // disambiguators from publish auto-increment (e.g. ".captioned-1").
  const strip = ["captioned", "reframed", "bleeped", "cut"];
  let changed = true;
  while (changed) {
    changed = false;
    // Drop any trailing -N first (publish disambiguator).
    const dashN = base.match(/^(.*)-\d+$/);
    if (dashN) {
      base = dashN[1];
      changed = true;
      continue;
    }
    for (const s of strip) {
      const re = new RegExp(`\\.${s}$`);
      if (re.test(base)) {
        base = base.replace(re, "");
        changed = true;
        break;
      }
    }
  }
  // Also resolve inside tmp/ — .silence.json lives there, not in out/.
  const tmpDir = path.resolve(new URL("../../tmp/", import.meta.url).pathname);
  return path.join(tmpDir, `${base}.silence.json`);
}

function loadCompilationSidecar(p: string): Compilation {
  return CompilationSchema.parse(JSON.parse(fs.readFileSync(p, "utf-8")));
}

function loadSegmentSidecar(p: string): Segment {
  return SegmentSchema.parse(JSON.parse(fs.readFileSync(p, "utf-8")));
}

async function main() {
  if (!opts.compilation && !opts.segment) {
    process.stderr.write(`ERROR: pass --compilation <path> or --segment <path>\n`);
    process.exit(1);
  }
  if (opts.compilation && opts.segment) {
    process.stderr.write(`ERROR: pass exactly one of --compilation or --segment\n`);
    process.exit(1);
  }

  const transcriptPath = path.resolve(opts.sourceTranscript);
  if (!fs.existsSync(transcriptPath)) {
    process.stderr.write(`ERROR: source transcript not found: ${transcriptPath}\n`);
    process.exit(1);
  }
  const transcript: Transcript = loadTranscript(transcriptPath);

  let clipRanges: { start_s: number; end_s: number }[];
  let sidecarSource: string;
  if (opts.compilation) {
    const comp = loadCompilationSidecar(path.resolve(opts.compilation));
    clipRanges = comp.clips.map((c) => ({ start_s: c.start_s, end_s: c.end_s }));
    sidecarSource = comp.source;
  } else {
    const seg = loadSegmentSidecar(path.resolve(opts.segment!));
    clipRanges = [{ start_s: seg.start_s, end_s: seg.end_s }];
    sidecarSource = seg.source;
  }

  // Choose the MP4 path — if not provided, we still need SOMETHING for output naming.
  const mp4Path = opts.mp4 ? path.resolve(opts.mp4) : undefined;

  // Auto-detect silence.json by stripping derivative suffixes from the MP4 basename.
  // video_remove_silence writes <pre-strip-base>.silence.json, NOT next to the final
  // .cut.bleeped.mp4 — so we derive backwards through the post-processing chain.
  let silencePath: string | undefined = opts.silence ? path.resolve(opts.silence) : undefined;
  if (!silencePath && mp4Path) {
    const cand = deriveSilencePath(mp4Path);
    if (fs.existsSync(cand)) silencePath = cand;
  }
  const keep: KeepInterval[] = silencePath ? loadKeepIntervals(silencePath) : [];
  if (silencePath) {
    process.stderr.write(`Applying silence shift from ${silencePath} (${keep.length} keep intervals)\n`);
  }

  let projected = opts.segment
    ? projectWordsForSegment(transcript, clipRanges[0])
    : projectWordsThroughClips(transcript, clipRanges);
  if (keep.length > 0) {
    projected = projectWordsThroughKeepIntervals(projected, keep);
  }

  // Probe the MP4 for dimensions + duration if given — caption-plan needs these.
  let videoWidth: number | undefined;
  let videoHeight: number | undefined;
  let durationSec = keptDuration(clipRanges, keep);
  if (mp4Path && fs.existsSync(mp4Path)) {
    try {
      const probe = await ffprobe(mp4Path);
      const vs = getVideoStream(probe);
      videoWidth = vs.width ?? undefined;
      videoHeight = vs.height ?? undefined;
      const probed = parseFloat(probe.format.duration);
      if (Number.isFinite(probed)) durationSec = probed;
    } catch (e) {
      process.stderr.write(
        `Warning: ffprobe of ${mp4Path} failed (${e instanceof Error ? e.message : String(e)}); falling back to computed duration ${durationSec.toFixed(2)}s\n`,
      );
    }
  }

  const outData: WordsJson = {
    source_mp4: mp4Path ?? sidecarSource,
    source_transcript: transcriptPath,
    duration_s: durationSec,
    ...(videoWidth ? { video_width: videoWidth } : {}),
    ...(videoHeight ? { video_height: videoHeight } : {}),
    words: projected,
  };

  let outPath: string;
  if (opts.output) {
    outPath = path.resolve(opts.output);
  } else if (mp4Path) {
    const dir = path.dirname(mp4Path);
    const base = path.basename(mp4Path).replace(/\.[^.]+$/, "");
    outPath = redirectOutToTmp(path.join(dir, `${base}.words.json`));
  } else {
    process.stderr.write(`ERROR: pass --output or --mp4 so we can derive an output name\n`);
    process.exit(1);
  }

  saveWordsJson(outPath, outData);
  process.stderr.write(
    `Projected ${projected.length} words onto ${durationSec.toFixed(2)}s timeline (${clipRanges.length} clip(s)${keep.length ? `, ${keep.length} keep interval(s)` : ""})\n` +
      `Wrote ${outPath}\n`,
  );
  process.stdout.write(outPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
