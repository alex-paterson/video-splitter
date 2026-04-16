import { Transcript, hasWords } from "./transcript.js";
import { WordsJsonWord } from "./words.js";
import { TAIL_PAD_S } from "./whisper-pad.js";

export interface SilenceInterval {
  start_s: number;
  end_s: number;
}

/** A kept range on the pre-silence-strip timeline, as recorded in `.silence.json`. */
export interface KeepInterval {
  start_s: number;
  end_s: number;
}

export interface ClipRange {
  start_s: number;
  end_s: number;
}

/**
 * Project source-transcript words onto the timeline of a concat-rendered MP4
 * (a sequence of clips from the original). `tailPadSec` must match whatever
 * compilation-render added as a trailing pad per clip — otherwise downstream
 * words drift earlier by tailPadSec * clipIndex.
 *
 * Words fully contained in a clip (including its tail pad) are kept with
 * timestamps shifted by the clip's offset in the output.
 */
export function projectWordsThroughClips(
  transcript: Transcript,
  clips: ClipRange[],
  opts: { tailPadSec?: number } = {},
): WordsJsonWord[] {
  if (!hasWords(transcript)) {
    throw new Error(
      `Source transcript is missing word-level timings (schema_version < 2). Re-run audio_to_transcript.`,
    );
  }
  const tailPadSec = opts.tailPadSec ?? TAIL_PAD_S;
  const segments = transcript.segments;
  const out: WordsJsonWord[] = [];
  let cumulativeKept = 0;
  for (const clip of clips) {
    const clipDur = clip.end_s - clip.start_s + tailPadSec;
    const padEnd = clip.end_s + tailPadSec;
    for (const w of transcript.words) {
      if (w.start_s < clip.start_s || w.end_s > padEnd) continue;
      const speaker =
        w.segment_index != null ? segments[w.segment_index]?.speaker : undefined;
      out.push({
        start_s: w.start_s - clip.start_s + cumulativeKept,
        end_s: w.end_s - clip.start_s + cumulativeKept,
        word: w.word,
        ...(speaker ? { speaker } : {}),
      });
    }
    cumulativeKept += clipDur;
  }
  out.sort((a, b) => a.start_s - b.start_s);
  return out;
}

/**
 * Shift an already-projected word list to account for silence-stripping,
 * using the authoritative `keep` intervals recorded in the .silence.json
 * (not the raw `silence` intervals — those ignore the `pad_s` boundary
 * preservation).
 *
 * Keep intervals are on the pre-silence-strip (post-concat+tail_pad)
 * timeline — the same timeline the input words should be on.
 *
 * A word whose midpoint falls outside every keep interval is dropped.
 * Otherwise the word is shifted so input-time keep[i].start_s maps to
 * output-time (sum of prior keeps' durations).
 */
export function projectWordsThroughKeepIntervals(
  words: WordsJsonWord[],
  keep: KeepInterval[],
): WordsJsonWord[] {
  if (keep.length === 0) return words;
  const sorted = [...keep].sort((a, b) => a.start_s - b.start_s);
  const cumOut: number[] = [0];
  for (let i = 0; i < sorted.length; i++) {
    cumOut.push(cumOut[i] + (sorted[i].end_s - sorted[i].start_s));
  }
  const out: WordsJsonWord[] = [];
  for (const w of words) {
    const mid = (w.start_s + w.end_s) / 2;
    let idx = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (mid >= sorted[i].start_s && mid <= sorted[i].end_s) {
        idx = i;
        break;
      }
    }
    if (idx < 0) continue;
    const shift = cumOut[idx] - sorted[idx].start_s;
    out.push({
      ...w,
      start_s: w.start_s + shift,
      end_s: w.end_s + shift,
    });
  }
  return out;
}

/** Convenience: a single-segment case shares the same clip-projection logic. */
export function projectWordsForSegment(
  transcript: Transcript,
  segment: ClipRange,
  opts: { tailPadSec?: number } = {},
): WordsJsonWord[] {
  return projectWordsThroughClips(transcript, [segment], opts);
}

/**
 * Total kept duration after applying clips (with tail pads) and optional
 * silence-removal `keep` intervals.
 */
export function keptDuration(
  clips: ClipRange[],
  keep: KeepInterval[] = [],
  opts: { tailPadSec?: number } = {},
): number {
  const tailPadSec = opts.tailPadSec ?? TAIL_PAD_S;
  const clipTotal = clips.reduce((s, c) => s + (c.end_s - c.start_s) + tailPadSec, 0);
  if (keep.length === 0) return clipTotal;
  return keep.reduce((s, k) => s + (k.end_s - k.start_s), 0);
}
