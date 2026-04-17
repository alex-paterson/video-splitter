#!/usr/bin/env tsx
/**
 * transcript-to-words — Convert a .transcript.json (transcribed directly from
 * a cut/rendered MP4) into a .words.json suitable for caption_plan.
 *
 * Unlike transcript-project-words, this does NOT project through compilation
 * clips or silence intervals — the transcript's word timings are already on
 * the MP4's own timeline because Whisper ran on the cut MP4 itself.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import { loadTranscript, hasWords } from "../../lib/transcript.js";
import { WordsJson, saveWordsJson } from "../../lib/words.js";
import { ffprobe, getVideoStream } from "../../lib/ffmpeg.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("transcript-to-words")
  .description(
    "Convert a .transcript.json (transcribed from a cut MP4) to .words.json for caption_plan. " +
    "No projection needed — timings are already on the MP4 timeline."
  )
  .argument("<transcript>", "Path to .transcript.json (transcribed from the cut MP4)")
  .argument("<mp4>", "The cut MP4 the transcript was produced from (for dimensions + duration)")
  .option("--output <path>", "Output .words.json path (default: <mp4-base>.words.json)")
  .parse(process.argv);

const opts = program.opts<{ output?: string }>();
const [transcriptArg, mp4Arg] = program.args;

async function main() {
  const transcriptPath = path.resolve(transcriptArg);
  const mp4Path = path.resolve(mp4Arg);

  if (!fs.existsSync(transcriptPath)) throw new Error(`Transcript not found: ${transcriptPath}`);
  if (!fs.existsSync(mp4Path)) throw new Error(`MP4 not found: ${mp4Path}`);

  const transcript = loadTranscript(transcriptPath);

  if (!transcript.segments?.length && !hasWords(transcript)) {
    throw new Error("Transcript has no segments or words.");
  }

  const allWords = hasWords(transcript)
    ? transcript.words.map((w) => {
        const seg = transcript.segments.find(
          (s) => w.segment_index !== undefined ? transcript.segments.indexOf(s) === w.segment_index : s.start_s <= w.start_s && w.end_s <= s.end_s
        );
        return {
          start_s: w.start_s,
          end_s: w.end_s,
          word: w.word,
          ...(seg?.speaker ? { speaker: seg.speaker } : {}),
        };
      })
    : transcript.segments.map((seg) => ({
        start_s: seg.start_s,
        end_s: seg.end_s,
        word: seg.text.trim(),
        ...(seg.speaker ? { speaker: seg.speaker } : {}),
      }));

  let videoWidth: number | undefined;
  let videoHeight: number | undefined;
  let durationSec = 0;
  try {
    const probe = await ffprobe(mp4Path);
    const vs = getVideoStream(probe);
    videoWidth = vs.width ?? undefined;
    videoHeight = vs.height ?? undefined;
    durationSec = parseFloat(probe.format.duration);
  } catch (e) {
    process.stderr.write(
      `Warning: ffprobe failed (${e instanceof Error ? e.message : String(e)}); duration may be inaccurate.\n`
    );
    const lastWord = allWords[allWords.length - 1];
    durationSec = lastWord ? lastWord.end_s : 0;
  }

  const out: WordsJson = {
    source_mp4: mp4Path,
    source_transcript: transcriptPath,
    duration_s: durationSec,
    ...(videoWidth ? { video_width: videoWidth } : {}),
    ...(videoHeight ? { video_height: videoHeight } : {}),
    words: allWords,
  };

  const dir = path.dirname(mp4Path);
  const base = path.basename(mp4Path).replace(/\.[^.]+$/, "");
  const outPath = path.resolve(
    opts.output ?? redirectOutToTmp(path.join(dir, `${base}.words.json`))
  );

  saveWordsJson(outPath, out);
  process.stderr.write(
    `Extracted ${allWords.length} words from ${transcript.segments.length} segments\n` +
    `Wrote ${outPath}\n`
  );
  process.stdout.write(outPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
