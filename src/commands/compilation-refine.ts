#!/usr/bin/env tsx
/**
 * compilation-refine — Trim an existing .compilation.json to fit within a
 * max-seconds ceiling by dropping and/or shortening the least-essential clips.
 * Writes the next version in sequence: foo.compilation.json →
 * foo.compilation.2.json → foo.compilation.3.json, preserving the story.
 *
 * Usage: tsx src/commands/compilation-refine.ts --max-seconds <n> <compilation>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  loadCompilation,
  saveCompilation,
  CompilationClip,
} from "../../lib/transcript.js";
import { z } from "zod";

const program = new Command();

program
  .name("compilation-refine")
  .description(
    "Trim a .compilation.json to fit under --max-seconds. Writes the next .compilation.N.json in sequence."
  )
  .argument("<compilation>", "Path to .compilation.json (any version)")
  .requiredOption("--max-seconds <n>", "Maximum total duration (seconds)")
  .option("--output <path>", "Explicit output path (default: auto-increment)")
  .option("--model <model>", "Claude model", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  maxSeconds: string;
  output?: string;
  model: string;
}>();
const [inputArg] = program.args;

function totalOf(clips: CompilationClip[]): number {
  return clips.reduce((s, c) => s + (c.end_s - c.start_s), 0);
}

function nextVersionPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  // Match foo.compilation.json or foo.compilation.N.json
  const m = base.match(/^(.*?)\.compilation(?:\.(\d+))?\.json$/);
  if (!m) {
    throw new Error(`Not a .compilation.json filename: ${base}`);
  }
  const stem = m[1];
  const currentN = m[2] ? parseInt(m[2], 10) : 1;
  let n = currentN + 1;
  for (;;) {
    const candidate = path.join(dir, `${stem}.compilation.${n}.json`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}

const RefinedArraySchema = z.array(
  z.object({
    start_s: z.number(),
    end_s: z.number(),
    summary: z.string().optional(),
  })
);

async function refine(
  clips: CompilationClip[],
  story: string | undefined,
  topic: string,
  maxSeconds: number,
  model: string,
  client: Anthropic
): Promise<CompilationClip[]> {
  const current = totalOf(clips);
  const over = current - maxSeconds;
  const clipsText = clips
    .map((c, i) => {
      const dur = (c.end_s - c.start_s).toFixed(1);
      const lines = (c.transcript ?? [])
        .map((t) => `    ${t.speaker}: ${t.text}`)
        .join("\n");
      return `[${i}] ${c.start_s.toFixed(1)}→${c.end_s.toFixed(1)} (${dur}s) — ${c.summary ?? ""}\n${lines}`;
    })
    .join("\n\n");

  const prompt = `You are trimming a video compilation to fit a strict time budget.

Topic: "${topic}"
${story ? `Story arc:\n${story}\n` : ""}

Current total: ${current.toFixed(1)}s
HARD MAX: ${maxSeconds}s
Must cut at least: ${over.toFixed(1)}s

Clips (indexed; each preserves a transcript excerpt):
${clipsText}

Return a JSON array of the clips to KEEP, in chronological order. You may:
- Drop entire clips (the least essential first)
- Shrink a clip by tightening its start_s / end_s to a tighter sub-range (values must stay within the original clip's range)

Prefer dropping redundancy over chopping single beats in half. Keep the narrative arc intact. Total duration MUST be <= ${maxSeconds}s.

Return ONLY a JSON array:
[ { "start_s": <number>, "end_s": <number>, "summary": "<optional>" }, ... ]`;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Could not parse refine output:\n${text}`);
  const refined = RefinedArraySchema.parse(JSON.parse(match[0]));

  // Preserve transcript excerpts from the source clips by intersecting ranges.
  return refined.map((r) => {
    const src = clips.find((c) => r.start_s >= c.start_s - 0.01 && r.end_s <= c.end_s + 0.01);
    const transcript = src?.transcript?.filter(
      (t) => t.end_s > r.start_s && t.start_s < r.end_s
    );
    return { ...r, transcript };
  });
}

async function main() {
  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: file not found: ${inputPath}`);
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const maxSeconds = parseFloat(opts.maxSeconds);
  const comp = loadCompilation(inputPath);
  const current = totalOf(comp.clips);

  process.stderr.write(
    `Input: ${inputPath}\nCurrent duration: ${current.toFixed(1)}s, target max: ${maxSeconds}s\n`
  );
  if (current <= maxSeconds) {
    process.stderr.write(`Already within budget — no refine needed.\n`);
    process.stderr.write(`DURATION: ${current.toFixed(1)}s MAX: ${maxSeconds}s\n`);
    process.exit(0);
  }

  const client = new Anthropic({ apiKey });
  const refined = await refine(comp.clips, comp.story, comp.topic, maxSeconds, opts.model, client);
  const newTotal = totalOf(refined);

  const outputPath = path.resolve(opts.output ?? nextVersionPath(inputPath));
  saveCompilation(outputPath, { ...comp, clips: refined });

  process.stderr.write(
    `Refined ${comp.clips.length} → ${refined.length} clip(s), ${current.toFixed(1)}s → ${newTotal.toFixed(1)}s\n`
  );
  process.stderr.write(`Saved: ${outputPath}\n`);
  process.stderr.write(`DURATION: ${newTotal.toFixed(1)}s MAX: ${maxSeconds}s\n`);
  if (newTotal > maxSeconds) {
    const over = newTotal - maxSeconds;
    process.stderr.write(
      `OVER_MAX: current=${newTotal.toFixed(1)}s max=${maxSeconds}s cut_at_least=${over.toFixed(1)}s — call compilation_refine again on ${outputPath}\n`
    );
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
