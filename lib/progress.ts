import { parseProgressTime } from "./ffmpeg.js";

/** Render a simple ASCII progress bar to stderr */
export function renderBar(frac: number, width = 40): string {
  const filled = Math.round(frac * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = (frac * 100).toFixed(1).padStart(5);
  return `[${bar}] ${pct}%`;
}

export class ProgressReporter {
  private lastLine = "";
  private isTTY = process.stderr.isTTY;

  update(frac: number, label = ""): void {
    const bar = renderBar(Math.max(0, Math.min(1, frac)));
    const line = label ? `${label}  ${bar}` : bar;
    if (this.isTTY) {
      process.stderr.write(`\r${line}`);
    } else if (line !== this.lastLine) {
      process.stderr.write(`${line}\n`);
      this.lastLine = line;
    }
  }

  done(label = "done"): void {
    if (this.isTTY) process.stderr.write(`\r${renderBar(1)}  ${label}\n`);
    else process.stderr.write(`${label}\n`);
  }

  /** Create an ffmpeg progress handler that updates the bar */
  ffmpegHandler(totalSecs: number, label = ""): (line: string) => void {
    return (line: string) => {
      const t = parseProgressTime(line);
      if (t !== null && totalSecs > 0) this.update(t / totalSecs, label);
    };
  }
}
