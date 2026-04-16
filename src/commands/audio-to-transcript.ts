#!/usr/bin/env tsx
/**
 * audio-to-transcript — Transcribe an audio file via Whisper with multi-speaker
 * diarization, saved as a .transcript.json file.
 *
 * Usage: tsx src/commands/audio-to-transcript.ts [options] <audio> [output]
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import undici from "undici";
import { ffprobe, tmpPath, registerTmp } from "../../lib/ffmpeg.js";
import {
  Transcript,
  TranscriptSegment,
  TranscriptWord,
  saveTranscript,
} from "../../lib/transcript.js";
import { ProgressReporter } from "../../lib/progress.js";

const program = new Command();

program
  .name("audio-to-transcript")
  .description("Transcribe an audio file with multi-speaker diarization")
  .argument("<audio>", "Input audio file (mp3, wav, m4a, …)")
  .argument("[output]", "Output .transcript.json path")
  .option("--source <path>", "Original source video to record in transcript (default: audio path)")
  .option("--chunk-minutes <n>", "Audio chunk size for API uploads (minutes)", "10")
  .option("--language <lang>", "ISO-639-1 language hint for Whisper")
  .option("--speakers <n>", "Expected number of speakers (hint)", "0")
  .option("--no-diarize", "Disable speaker diarization (single speaker)")
  .option("--model <model>", "Whisper model", "whisper-1")
  .option("--resume", "Resume a partial transcript (skip already-transcribed chunks)");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  source?: string;
  chunkMinutes: string;
  language?: string;
  speakers: string;
  diarize: boolean;
  model: string;
  resume: boolean;
}>();

const [inputArg, outputArg] = program.args;

function splitAudioChunk(
  audioPath: string,
  startSec: number,
  durationSec: number,
  outPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-ss", String(startSec),
      "-t", String(durationSec),
      "-i", audioPath,
      "-c", "copy",
      "-y",
      outPath,
    ];
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg chunk split failed: ${stderr}`));
      else resolve();
    });
    proc.on("error", reject);
  });
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface ChunkResult {
  segments: WhisperSegment[];
  words: WhisperWord[];
}

async function transcribeChunk(
  apiKey: string,
  audioPath: string,
  model: string,
  language?: string,
  offsetSec = 0
): Promise<ChunkResult> {
  const audioBuffer = fs.readFileSync(audioPath);
  const blob = new Blob([audioBuffer], { type: "audio/mpeg" });

  const form = new undici.FormData();
  form.append("file", blob, "audio.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  if (language) form.append("language", language);

  const res = await undici.fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const json = (await res.json()) as {
    text?: string;
    segments?: WhisperSegment[];
    words?: WhisperWord[];
    error?: { message: string; type: string; code: string };
  };

  if (!res.ok || json.error) {
    throw new Error(`Whisper API error ${res.status}: ${json.error?.message ?? res.statusText}`);
  }

  const segments = (json.segments ?? []).map((seg) => ({
    start: seg.start + offsetSec,
    end: seg.end + offsetSec,
    text: seg.text.trim(),
  }));
  const words = (json.words ?? []).map((w) => ({
    word: w.word,
    start: w.start + offsetSec,
    end: w.end + offsetSec,
  }));
  return { segments, words };
}

/**
 * Collapse runs of identical consecutive tokens that Whisper emits during
 * near-silence (e.g. "33","33","33"). Merge into a single token spanning the run.
 */
function collapseHallucinations(words: WhisperWord[]): WhisperWord[] {
  const out: WhisperWord[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && last.word.toLowerCase() === w.word.toLowerCase()) {
      last.end = w.end;
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * Whisper sometimes returns zero-duration words when forced-alignment can't
 * anchor them. Give them a real duration capped by the next word's start.
 */
function fixZeroDurations(words: WhisperWord[]): WhisperWord[] {
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].end <= out[i].start) {
      const next = out[i + 1]?.start ?? Infinity;
      out[i].end = Math.min(out[i].start + 0.25, next - 0.01);
      if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.05;
    }
  }
  return out;
}

/** Map each word to the segment whose range contains the word's midpoint. */
function stampSegmentIndex(
  words: WhisperWord[],
  segments: TranscriptSegment[],
): TranscriptWord[] {
  return words.map((w) => {
    const mid = (w.start + w.end) / 2;
    let segIdx: number | undefined;
    for (let i = 0; i < segments.length; i++) {
      if (mid >= segments[i].start_s && mid <= segments[i].end_s) {
        segIdx = i;
        break;
      }
    }
    return {
      start_s: w.start,
      end_s: w.end,
      word: w.word,
      ...(segIdx != null ? { segment_index: segIdx } : {}),
    };
  });
}

interface DiarizedWindow {
  start: number;
  end: number;
  speaker: string;
}

function heuristicDiarize(segments: WhisperSegment[]): DiarizedWindow[] {
  if (segments.length === 0) return [];
  const windows: DiarizedWindow[] = [];
  let currentSpeaker = "SPEAKER_00";
  let speakerIdx = 0;
  const PAUSE_THRESHOLD = 0.8;

  let windowStart = segments[0].start;
  let windowEnd = segments[0].end;

  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].start - segments[i - 1].end;
    if (gap > PAUSE_THRESHOLD) {
      windows.push({ start: windowStart, end: windowEnd, speaker: currentSpeaker });
      speakerIdx = 1 - speakerIdx;
      currentSpeaker = `SPEAKER_0${speakerIdx}`;
      windowStart = segments[i].start;
    }
    windowEnd = segments[i].end;
  }
  windows.push({ start: windowStart, end: windowEnd, speaker: currentSpeaker });
  return windows;
}

async function assemblyAIDiarize(
  audioPath: string,
  speakersExpected: number
): Promise<DiarizedWindow[]> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY not set");

  const { default: fetch } = await import("node-fetch");

  const uploadResp = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/octet-stream" },
    body: fs.createReadStream(audioPath),
  });
  if (!uploadResp.ok) throw new Error(`AssemblyAI upload failed: ${uploadResp.status}`);
  const { upload_url } = (await uploadResp.json()) as { upload_url: string };

  const submitBody: Record<string, unknown> = {
    audio_url: upload_url,
    speaker_labels: true,
  };
  if (speakersExpected > 0) submitBody.speakers_expected = speakersExpected;

  const submitResp = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify(submitBody),
  });
  if (!submitResp.ok) throw new Error(`AssemblyAI submit failed: ${submitResp.status}`);
  const { id } = (await submitResp.json()) as { id: string };

  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollResp = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: apiKey },
    });
    const result = (await pollResp.json()) as {
      status: string;
      utterances?: Array<{ start: number; end: number; speaker: string }>;
      error?: string;
    };

    if (result.status === "completed") {
      return (result.utterances ?? []).map((u) => ({
        start: u.start / 1000,
        end: u.end / 1000,
        speaker: `SPEAKER_${u.speaker}`,
      }));
    }
    if (result.status === "error") {
      throw new Error(`AssemblyAI error: ${result.error}`);
    }
  }
}

function assignSpeakers(
  segments: WhisperSegment[],
  diarized: DiarizedWindow[]
): TranscriptSegment[] {
  return segments.map((seg) => {
    let bestSpeaker = "SPEAKER_00";
    let bestOverlap = 0;
    for (const w of diarized) {
      const overlap = Math.min(seg.end, w.end) - Math.max(seg.start, w.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = w.speaker;
      }
    }
    return {
      start_s: seg.start,
      end_s: seg.end,
      speaker: bestSpeaker,
      text: seg.text.trim(),
    };
  });
}

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: audio file not found: ${inputArg}`);
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY not set");
    process.exit(1);
  }

  const audioPath = path.resolve(inputArg);
  const chunkMinutes = parseFloat(opts.chunkMinutes);
  const chunkSecs = chunkMinutes * 60;
  const speakersHint = parseInt(opts.speakers);
  const diarizeBackend = process.env.DIARIZE_BACKEND ?? "whisper-heuristic";
  const sourcePath = opts.source ? path.resolve(opts.source) : audioPath;

  const base = path.basename(audioPath).replace(/\.audio\.mp3$/, "").replace(/\.[^.]+$/, "");
  const defaultOutput = path.join(path.dirname(audioPath), base + ".transcript.json");
  const outputPath = path.resolve(outputArg ?? defaultOutput);

  const progress = new ProgressReporter();
  process.stderr.write("Probing audio…\n");
  const probe = await ffprobe(audioPath);
  const duration = parseFloat(probe.format.duration);
  process.stderr.write(`  Duration: ${duration.toFixed(1)}s\n`);

  let existingSegments: TranscriptSegment[] = [];
  let existingWords: WhisperWord[] = [];
  let startChunk = 0;
  if (opts.resume && fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as Transcript;
    existingSegments = existing.segments;
    if (existing.words) {
      existingWords = existing.words.map((w) => ({ word: w.word, start: w.start_s, end: w.end_s }));
    }
    if (existingSegments.length > 0) {
      const lastEnd = existingSegments[existingSegments.length - 1].end_s;
      startChunk = Math.floor(lastEnd / chunkSecs);
      process.stderr.write(`Resuming from chunk ${startChunk} (${lastEnd.toFixed(1)}s)\n`);
    }
  }

  const numChunks = Math.ceil(duration / chunkSecs);
  const allSegments: TranscriptSegment[] = [...existingSegments];
  const allRawWords: WhisperWord[] = [...existingWords];

  for (let i = startChunk; i < numChunks; i++) {
    const chunkStart = i * chunkSecs;
    const chunkDur = Math.min(chunkSecs, duration - chunkStart);
    const chunkLabel = `Chunk ${i + 1}/${numChunks} (${chunkStart.toFixed(0)}s)`;

    process.stderr.write(`\n${chunkLabel}: splitting audio…\n`);
    const chunkFile = tmpPath(".mp3");
    registerTmp(chunkFile);
    await splitAudioChunk(audioPath, chunkStart, chunkDur, chunkFile);

    process.stderr.write(`${chunkLabel}: transcribing…\n`);
    let whisperSegments: WhisperSegment[] = [];
    let whisperWords: WhisperWord[] = [];
    let attempts = 0;
    while (attempts < 3) {
      try {
        const result = await transcribeChunk(
          apiKey,
          chunkFile,
          opts.model,
          opts.language,
          chunkStart
        );
        whisperSegments = result.segments;
        whisperWords = result.words;
        break;
      } catch (e: unknown) {
        attempts++;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempts >= 3) throw new Error(`Whisper failed after 3 attempts: ${msg}`);
        process.stderr.write(`  Whisper error (attempt ${attempts}): ${msg} — retrying…\n`);
        await new Promise((r) => setTimeout(r, 1000 * attempts * 2));
      }
    }

    let chunkSegments: TranscriptSegment[];
    if (!opts.diarize) {
      chunkSegments = whisperSegments.map((s) => ({
        start_s: s.start,
        end_s: s.end,
        speaker: "SPEAKER_00",
        text: s.text.trim(),
      }));
    } else if (diarizeBackend === "assemblyai") {
      process.stderr.write(`${chunkLabel}: diarizing via AssemblyAI…\n`);
      const diarized = await assemblyAIDiarize(chunkFile, speakersHint);
      chunkSegments = assignSpeakers(whisperSegments, diarized);
    } else {
      const diarized = heuristicDiarize(whisperSegments);
      chunkSegments = assignSpeakers(whisperSegments, diarized);
    }

    allSegments.push(...chunkSegments);
    allRawWords.push(...whisperWords);

    const speakers = [...new Set(allSegments.map((s) => s.speaker))].sort();
    const cleanedWords = fixZeroDurations(collapseHallucinations(allRawWords));
    const words = stampSegmentIndex(cleanedWords, allSegments);
    saveTranscript(outputPath, {
      source: sourcePath,
      duration_s: duration,
      speakers,
      segments: allSegments,
      words,
      schema_version: 2,
    });

    progress.update((i + 1) / numChunks, `chunk ${i + 1}/${numChunks}`);
    try { fs.unlinkSync(chunkFile); } catch {}
  }

  const speakers = [...new Set(allSegments.map((s) => s.speaker))].sort();
  const cleanedWords = fixZeroDurations(collapseHallucinations(allRawWords));
  const words = stampSegmentIndex(cleanedWords, allSegments);
  saveTranscript(outputPath, {
    source: sourcePath,
    duration_s: duration,
    speakers,
    segments: allSegments,
    words,
    schema_version: 2,
  });

  progress.done();
  process.stderr.write(
    `\nTranscript saved: ${outputPath}\n` +
      `  ${allSegments.length} segments, ${words.length} words, ${speakers.length} speaker(s): ${speakers.join(", ")}\n`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
