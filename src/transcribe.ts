#!/usr/bin/env tsx
/**
 * transcribe — Extract audio from a video and produce a multi-speaker
 * diarized transcript saved as a .transcript.json file.
 *
 * Usage: tsx src/transcribe.ts [options] <input> [output]
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn } from "child_process";
import undici from "undici";
import { ffprobe, tmpPath, registerTmp } from "../lib/ffmpeg.js";
import {
  Transcript,
  TranscriptSegment,
  saveTranscript,
} from "../lib/transcript.js";
import { ProgressReporter } from "../lib/progress.js";

const program = new Command();

program
  .name("transcribe")
  .description("Transcribe video audio with multi-speaker diarization")
  .argument("<input>", "Input video file")
  .argument("[output]", "Output .transcript.json path")
  .option("--chunk-minutes <n>", "Audio chunk size for API uploads (minutes)", "10")
  .option("--language <lang>", "ISO-639-1 language hint for Whisper")
  .option("--speakers <n>", "Expected number of speakers (hint)", "0")
  .option("--no-diarize", "Disable speaker diarization (single speaker)")
  .option("--model <model>", "Whisper model", "whisper-1")
  .option("--resume", "Resume a partial transcript (skip already-transcribed chunks)")
  .option("--no-pre-extract", "Skip full audio pre-extraction (saves disk, slower for large files)");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  chunkMinutes: string;
  language?: string;
  speakers: string;
  diarize: boolean;
  model: string;
  resume: boolean;
  preExtract: boolean;
}>();

const [inputArg, outputArg] = program.args;

// ─── Audio extraction ────────────────────────────────────────────────────────

/**
 * Extract the entire audio track from a video to a 16kHz mono MP3.
 * This single pass is much faster than seeking into a large MKV per chunk.
 */
function extractFullAudio(
  inputPath: string,
  outPath: string,
  onProgress?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-i", inputPath,
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-b:a", "64k",
      "-f", "mp3",
      "-y",
      outPath,
    ];

    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      if (onProgress) text.split("\n").forEach((l) => l.trim() && onProgress(l));
    });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg audio extract failed: ${stderr.slice(-1000)}`));
      else resolve();
    });
    proc.on("error", reject);
  });
}

/**
 * Split a chunk from an already-extracted MP3 file.
 * Fast — sequential read from a small file, no video demuxing.
 */
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

/**
 * Extract a single chunk of audio directly from the source video.
 * Used when --no-pre-extract is set.
 */
function extractAudioChunk(
  inputPath: string,
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
      "-i", inputPath,
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-b:a", "64k",
      "-f", "mp3",
      "-y",
      outPath,
    ];

    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg audio extract failed: ${stderr}`));
      else resolve();
    });
    proc.on("error", reject);
  });
}

// ─── Whisper transcription ───────────────────────────────────────────────────

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Upload an audio chunk to the OpenAI Whisper API using undici.
 * The OpenAI SDK uses node-fetch internally which masks API errors (quota,
 * auth) as generic "Connection error" / ECONNRESET. undici gives proper
 * HTTP status codes and error messages.
 */
async function transcribeChunk(
  apiKey: string,
  audioPath: string,
  model: string,
  language?: string,
  offsetSec = 0
): Promise<WhisperSegment[]> {
  const audioBuffer = fs.readFileSync(audioPath);
  const blob = new Blob([audioBuffer], { type: "audio/mpeg" });

  const form = new undici.FormData();
  form.append("file", blob, "audio.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (language) form.append("language", language);

  const res = await undici.fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const json = await res.json() as {
    text?: string;
    segments?: WhisperSegment[];
    error?: { message: string; type: string; code: string };
  };

  if (!res.ok || json.error) {
    throw new Error(`Whisper API error ${res.status}: ${json.error?.message ?? res.statusText}`);
  }

  return (json.segments ?? []).map((seg) => ({
    start: seg.start + offsetSec,
    end: seg.end + offsetSec,
    text: seg.text.trim(),
  }));
}

// ─── Diarization ─────────────────────────────────────────────────────────────

interface DiarizedWindow {
  start: number;
  end: number;
  speaker: string;
}

/**
 * Heuristic diarization: group consecutive Whisper segments separated by
 * pauses > 0.5s into speaker turns, alternating speakers.
 * This is a simple fallback when no diarization backend is configured.
 */
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

/**
 * AssemblyAI diarization — uploads audio and polls for speaker labels.
 */
async function assemblyAIDiarize(
  audioPath: string,
  speakersExpected: number
): Promise<DiarizedWindow[]> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY not set");

  const { default: fetch } = await import("node-fetch");

  // Upload
  const uploadResp = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/octet-stream" },
    body: fs.createReadStream(audioPath),
  });
  if (!uploadResp.ok) throw new Error(`AssemblyAI upload failed: ${uploadResp.status}`);
  const { upload_url } = (await uploadResp.json()) as { upload_url: string };

  // Submit
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

  // Poll
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

/**
 * Assign a speaker label to each Whisper segment by finding the diarized
 * window with the most overlap.
 */
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: input file not found: ${inputArg}`);
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable not set");
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const chunkMinutes = parseFloat(opts.chunkMinutes);
  const chunkSecs = chunkMinutes * 60;
  const speakersHint = parseInt(opts.speakers);
  const diarizeBackend = process.env.DIARIZE_BACKEND ?? "whisper-heuristic";

  // Determine output path
  const defaultOutput =
    path.join(
      path.dirname(inputPath),
      path.basename(inputPath, path.extname(inputPath)) + ".transcript.json"
    );
  const outputPath = path.resolve(outputArg ?? defaultOutput);

  const progress = new ProgressReporter();
  process.stderr.write("Probing source file…\n");
  const probe = await ffprobe(inputPath);
  const duration = parseFloat(probe.format.duration);
  const sizeMB = (parseInt(probe.format.size) / 1e6).toFixed(0);
  process.stderr.write(`  Duration: ${duration.toFixed(1)}s  Size: ${sizeMB} MB\n`);

  // Load partial transcript if resuming
  let existingSegments: TranscriptSegment[] = [];
  let startChunk = 0;

  if (opts.resume && fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as Transcript;
    existingSegments = existing.segments;
    if (existingSegments.length > 0) {
      const lastEnd = existingSegments[existingSegments.length - 1].end_s;
      startChunk = Math.floor(lastEnd / chunkSecs);
      process.stderr.write(`Resuming from chunk ${startChunk} (${lastEnd.toFixed(1)}s)\n`);
    }
  }

  // Pre-extract full audio to MP3 (one pass through the source file, then
  // chunk splits are fast sequential reads — much faster for large MKV files).
  let audioSource = inputPath;
  let fullAudioFile: string | null = null;

  if (opts.preExtract) {
    fullAudioFile = tmpPath(".mp3");
    registerTmp(fullAudioFile);
    process.stderr.write("Extracting full audio track to MP3…\n");
    await extractFullAudio(
      inputPath,
      fullAudioFile,
      progress.ffmpegHandler(duration, "extracting")
    );
    progress.done("audio extracted");
    const audioMB = (fs.statSync(fullAudioFile).size / 1e6).toFixed(1);
    process.stderr.write(`  Audio: ${audioMB} MB\n`);
    audioSource = fullAudioFile;
  }

  const numChunks = Math.ceil(duration / chunkSecs);
  const allSegments: TranscriptSegment[] = [...existingSegments];

  // Process each chunk
  for (let i = startChunk; i < numChunks; i++) {
    const chunkStart = i * chunkSecs;
    const chunkDur = Math.min(chunkSecs, duration - chunkStart);
    const chunkLabel = `Chunk ${i + 1}/${numChunks} (${chunkStart.toFixed(0)}s)`;

    process.stderr.write(`\n${chunkLabel}: extracting audio…\n`);
    const audioFile = tmpPath(".mp3");
    registerTmp(audioFile);

    if (opts.preExtract) {
      // Fast: split from already-extracted MP3
      await splitAudioChunk(audioSource, chunkStart, chunkDur, audioFile);
    } else {
      // Seek directly into source (fine for small files or single chunks)
      await extractAudioChunk(inputPath, chunkStart, chunkDur, audioFile);
    }

    // Transcribe via Whisper
    process.stderr.write(`${chunkLabel}: transcribing…\n`);
    let whisperSegments: WhisperSegment[] = [];
    let attempts = 0;
    while (attempts < 3) {
      try {
        whisperSegments = await transcribeChunk(
          apiKey,
          audioFile,
          opts.model,
          opts.language,
          chunkStart
        );
        break;
      } catch (e: unknown) {
        attempts++;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempts >= 3) throw new Error(`Whisper failed after 3 attempts: ${msg}`);
        process.stderr.write(`  Whisper error (attempt ${attempts}): ${msg} — retrying…\n`);
        await new Promise((r) => setTimeout(r, 1000 * attempts * 2));
      }
    }

    // Diarize
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
      const diarized = await assemblyAIDiarize(audioFile, speakersHint);
      chunkSegments = assignSpeakers(whisperSegments, diarized);
    } else {
      // whisper-heuristic fallback
      const diarized = heuristicDiarize(whisperSegments);
      chunkSegments = assignSpeakers(whisperSegments, diarized);
    }

    allSegments.push(...chunkSegments);

    // Save incremental progress
    const speakers = [...new Set(allSegments.map((s) => s.speaker))].sort();
    const partialTranscript: Transcript = {
      source: inputPath,
      duration_s: duration,
      speakers,
      segments: allSegments,
    };
    saveTranscript(outputPath, partialTranscript);

    progress.update((i + 1) / numChunks, `chunk ${i + 1}/${numChunks}`);

    // Clean up chunk audio
    try { fs.unlinkSync(audioFile); } catch {}
  }

  const speakers = [...new Set(allSegments.map((s) => s.speaker))].sort();
  const transcript: Transcript = {
    source: inputPath,
    duration_s: duration,
    speakers,
    segments: allSegments,
  };

  saveTranscript(outputPath, transcript);

  // Clean up full audio file now that all chunks are done
  if (fullAudioFile) {
    try { fs.unlinkSync(fullAudioFile); } catch {}
  }

  progress.done();
  process.stderr.write(
    `\nTranscript saved: ${outputPath}\n` +
      `  ${allSegments.length} segments  ${speakers.length} speaker(s): ${speakers.join(", ")}\n`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
