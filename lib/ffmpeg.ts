import { spawn, SpawnOptionsWithoutStdio } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

export interface ProbeFormat {
  duration: string;
  size: string;
  bit_rate: string;
  format_name: string;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: ProbeFormat;
}

export async function ffprobe(inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      inputPath,
    ];
    let stdout = "";
    const proc = spawn("ffprobe", args);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with ${code}`));
      try {
        resolve(JSON.parse(stdout) as ProbeResult);
      } catch (e) {
        reject(new Error(`ffprobe JSON parse failed: ${e}`));
      }
    });
    proc.on("error", reject);
  });
}

export function getVideoStream(probe: ProbeResult): ProbeStream {
  const s = probe.streams.find((s) => s.codec_type === "video");
  if (!s) throw new Error("No video stream found");
  return s;
}

export function getAudioStream(probe: ProbeResult): ProbeStream {
  const s = probe.streams.find((s) => s.codec_type === "audio");
  if (!s) throw new Error("No audio stream found");
  return s;
}

export function parseFraction(frac: string): number {
  const [num, den] = frac.split("/").map(Number);
  return den ? num / den : num;
}

export interface SilenceInterval {
  start: number;
  end: number;
}

/**
 * Run ffmpeg silencedetect on inputPath and return detected silence intervals.
 * Calls onProgress with fraction [0..1] as detection proceeds.
 */
export async function detectSilence(
  inputPath: string,
  noiseDb: number,
  minSilenceSec: number,
  totalDuration: number,
  onProgress?: (frac: number) => void
): Promise<SilenceInterval[]> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-i", inputPath,
      "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
      "-vn",
      "-f", "null",
      "-",
    ];

    const intervals: SilenceInterval[] = [];
    let currentStart: number | null = null;
    let stderr = "";

    const proc = spawn("ffmpeg", args);

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;

      for (const line of text.split("\n")) {
        const startMatch = line.match(/silence_start:\s*([\d.]+)/);
        if (startMatch) currentStart = parseFloat(startMatch[1]);

        const endMatch = line.match(/silence_end:\s*([\d.]+)/);
        if (endMatch && currentStart !== null) {
          intervals.push({ start: currentStart, end: parseFloat(endMatch[1]) });
          currentStart = null;
        }

        // Parse time= progress from ffmpeg output
        const timeMatch = line.match(/time=(\d+):(\d+):([\d.]+)/);
        if (timeMatch && totalDuration > 0 && onProgress) {
          const secs =
            parseInt(timeMatch[1]) * 3600 +
            parseInt(timeMatch[2]) * 60 +
            parseFloat(timeMatch[3]);
          onProgress(Math.min(secs / totalDuration, 1));
        }
      }
    });

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        return reject(new Error(`ffmpeg silencedetect failed (exit ${code})\n${stderr}`));
      }
      // If silence started but never ended (file ended during silence)
      if (currentStart !== null) {
        intervals.push({ start: currentStart, end: totalDuration });
      }
      resolve(intervals);
    });

    proc.on("error", reject);
  });
}

/**
 * Write a ffmpeg concat demuxer file for the given keep intervals.
 * Returns the temp file path.
 */
export function writeConcatFile(
  inputPath: string,
  keepIntervals: Array<{ start: number; end: number }>
): string {
  const lines: string[] = [];
  for (const interval of keepIntervals) {
    lines.push(`file '${inputPath.replace(/'/g, "'\\''")}'`);
    lines.push(`inpoint ${interval.start.toFixed(6)}`);
    lines.push(`outpoint ${interval.end.toFixed(6)}`);
  }
  const tmpFile = path.join(os.tmpdir(), `vsp-concat-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, lines.join("\n") + "\n");
  return tmpFile;
}

/**
 * Spawn ffmpeg and return a promise that resolves on exit.
 * Streams progress lines from stderr to onProgress callback.
 */
export function runFfmpeg(
  args: string[],
  onProgress?: (line: string) => void,
  spawnOpts?: SpawnOptionsWithoutStdio
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", ...args], spawnOpts);
    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (onProgress) {
        for (const line of text.split("\n")) {
          if (line.trim()) onProgress(line);
        }
      }
    });

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`ffmpeg exited with ${code}\n${stderr.slice(-2000)}`));
      } else {
        resolve();
      }
    });

    proc.on("error", reject);
  });
}

/** Parse a time= line from ffmpeg progress output into seconds */
export function parseProgressTime(line: string): number | null {
  const m = line.match(/time=(\d+):(\d+):([\d.]+)/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

/** Create a temp file path with given extension */
export function tmpPath(ext: string): string {
  return path.join(os.tmpdir(), `vsp-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/** Register cleanup of temp files on process exit */
const tmpFiles: string[] = [];
export function registerTmp(...paths: string[]): void {
  tmpFiles.push(...paths);
}
process.on("exit", () => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
