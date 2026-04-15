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
    "Modify an existing .compilation.json. Either trim to fit --max-seconds, or apply a free-text --instruction (e.g. 'remove the part where X happens'), or both. Writes the next .compilation.N.json in sequence."
  )
  .argument("<compilation>", "Path to .compilation.json (any version)")
  .option("--max-seconds <n>", "Maximum total duration (seconds)")
  .option("--instruction <text>", "Free-text modification instruction (e.g. 'drop the clip about X')")
  .option("--output <path>", "Explicit output path (default: auto-increment)")
  .option("--user-prompt <text>", "Original user request this work serves — passed verbatim to the LLM as context")
  .option("--model <model>", "Claude model", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  maxSeconds?: string;
  instruction?: string;
  output?: string;
  userPrompt?: string;
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
  maxSeconds: number | undefined,
  instruction: string | undefined,
  model: string,
  client: Anthropic,
  userPrompt?: string
): Promise<CompilationClip[]> {
  const current = totalOf(clips);
  const clipsText = clips
    .map((c, i) => {
      const dur = (c.end_s - c.start_s).toFixed(1);
      const lines = (c.transcript ?? [])
        .map((t) => `    ${t.speaker}: ${t.text}`)
        .join("\n");
      return `[${i}] ${c.start_s.toFixed(1)}→${c.end_s.toFixed(1)} (${dur}s) — ${c.summary ?? ""}\n${lines}`;
    })
    .join("\n\n");

  const goalLines: string[] = [];
  if (instruction) {
    goalLines.push(`User's modification instruction (apply literally, but preserve narrative flow where the instruction is silent):`);
    goalLines.push(`  """${instruction}"""`);
  }
  if (maxSeconds !== undefined) {
    const over = current - maxSeconds;
    goalLines.push(`HARD MAX duration: ${maxSeconds}s (current: ${current.toFixed(1)}s${over > 0 ? `, must cut at least ${over.toFixed(1)}s` : ""}).`);
  }
  if (goalLines.length === 0) {
    throw new Error("refine(): need either instruction or maxSeconds");
  }

  const userContextLine = userPrompt
    ? `\nUSER REQUEST CONTEXT (the broader ask this work is serving):\n"""${userPrompt}"""\n`
    : "";
  const prompt = `You are modifying an existing video compilation.

Topic: "${topic}"
${story ? `Story arc:\n${story}\n` : ""}${userContextLine}

${goalLines.join("\n")}

Clips (indexed; each preserves a transcript excerpt):
${clipsText}

Return a JSON array of the clips to KEEP, in chronological order. You may:
- Drop entire clips (matching the user's instruction, or the least essential first when trimming for length)
- Shrink a clip by tightening its start_s / end_s to a tighter sub-range (values must stay within the original clip's range)

Prefer dropping redundancy over chopping single beats in half. Keep the narrative arc intact.${maxSeconds !== undefined ? ` Total duration MUST be <= ${maxSeconds}s.` : ""}

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
  let refined;
  try {
    refined = RefinedArraySchema.parse(JSON.parse(match[0]));
  } catch (e) {
    process.stderr.write(`\n--- refine parse failed ---\n`);
    process.stderr.write(`content blocks: ${JSON.stringify(response.content.map((c) => c.type))}\n`);
    process.stderr.write(`raw text (${text.length} chars):\n${text}\n`);
    process.stderr.write(`matched (${match[0].length} chars):\n${match[0]}\n`);
    process.stderr.write(`--- end refine parse failed ---\n`);
    throw e;
  }

  // Preserve transcript excerpts by intersecting the refined range against
  // every source clip's transcript segments — works even when the LLM shifts
  // bounds or produces a clip spanning two originals.
  const allSegments = clips.flatMap((c) => c.transcript ?? []);
  return refined.map((r) => {
    const transcript = allSegments
      .filter((t) => t.end_s > r.start_s && t.start_s < r.end_s)
      .sort((a, b) => a.start_s - b.start_s);
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

  const maxSeconds = opts.maxSeconds !== undefined ? parseFloat(opts.maxSeconds) : undefined;
  const instruction = opts.instruction?.trim() || undefined;
  if (maxSeconds === undefined && !instruction) {
    console.error("Error: pass --max-seconds and/or --instruction");
    process.exit(1);
  }
  const comp = loadCompilation(inputPath);
  const current = totalOf(comp.clips);

  process.stderr.write(
    `Input: ${inputPath}\nCurrent duration: ${current.toFixed(1)}s${maxSeconds !== undefined ? `, target max: ${maxSeconds}s` : ""}${instruction ? `\nInstruction: ${instruction}` : ""}\n`
  );
  // Only short-circuit when the sole goal is a length trim and we're already under budget.
  if (!instruction && maxSeconds !== undefined && current <= maxSeconds) {
    process.stderr.write(`Already within budget — no refine needed.\n`);
    process.stderr.write(`DURATION: ${current.toFixed(1)}s MAX: ${maxSeconds}s\n`);
    process.exit(0);
  }

  const client = new Anthropic({ apiKey });
  const refined = await refine(comp.clips, comp.story, comp.topic, maxSeconds, instruction, opts.model, client, opts.userPrompt);
  const newTotal = totalOf(refined);

  const outputPath = path.resolve(opts.output ?? nextVersionPath(inputPath));
  saveCompilation(outputPath, { ...comp, clips: refined });

  process.stderr.write(
    `Refined ${comp.clips.length} → ${refined.length} clip(s), ${current.toFixed(1)}s → ${newTotal.toFixed(1)}s\n`
  );
  process.stderr.write(`Saved: ${outputPath}\n`);
  if (maxSeconds !== undefined) {
    process.stderr.write(`DURATION: ${newTotal.toFixed(1)}s MAX: ${maxSeconds}s\n`);
    if (newTotal > maxSeconds) {
      const over = newTotal - maxSeconds;
      process.stderr.write(
        `OVER_MAX: current=${newTotal.toFixed(1)}s max=${maxSeconds}s cut_at_least=${over.toFixed(1)}s — call compilation_refine again on ${outputPath}\n`
      );
    }
  } else {
    process.stderr.write(`DURATION: ${newTotal.toFixed(1)}s\n`);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
