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
  loadTranscript,
  CompilationClip,
  Transcript,
  TranscriptSegment,
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
  .option("--transcript <path>", "Override transcript path (default: derived from compilation.source, replacing .mkv → .transcript.json). When available, refine may ADD new material from the transcript, not just drop/shrink existing clips.")
  .option("--user-prompt <text>", "Original user request this work serves — passed verbatim to the LLM as context")
  .option("--silence-stripped", "Silence will be removed downstream — apply a 30% discount when comparing current vs max duration, and tell the LLM the same.")
  .option("--model <model>", "Claude model", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  maxSeconds?: string;
  instruction?: string;
  output?: string;
  transcript?: string;
  userPrompt?: string;
  silenceStripped?: boolean;
  model: string;
}>();

function buildTranscriptText(segments: TranscriptSegment[], maxChars = 200_000): string {
  const lines: string[] = [];
  let total = 0;
  for (const seg of segments) {
    const line = `[${seg.start_s.toFixed(2)}s → ${seg.end_s.toFixed(2)}s] ${seg.speaker}: ${seg.text}`;
    if (total + line.length > maxChars) {
      lines.push("[...transcript truncated for context window...]");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

function snapToSegmentStart(transcript: Transcript, target: number): number {
  let best = transcript.segments[0].start_s;
  let bestDist = Math.abs(target - best);
  for (const seg of transcript.segments) {
    const dist = Math.abs(seg.start_s - target);
    if (dist < bestDist) { bestDist = dist; best = seg.start_s; }
  }
  return best;
}

function snapToSegmentEnd(transcript: Transcript, target: number): number {
  let best = transcript.segments[transcript.segments.length - 1].end_s;
  let bestDist = Math.abs(target - best);
  for (const seg of transcript.segments) {
    const dist = Math.abs(seg.end_s - target);
    if (dist < bestDist) { bestDist = dist; best = seg.end_s; }
  }
  return best;
}

const SILENCE_STRIP_FACTOR = 0.7;
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
  userPrompt?: string,
  silenceStripped?: boolean,
  transcript?: Transcript
): Promise<CompilationClip[]> {
  const raw = totalOf(clips);
  const current = silenceStripped ? raw * SILENCE_STRIP_FACTOR : raw;
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
    const silenceNote = silenceStripped
      ? ` (post-silence-strip estimate — raw clip sum is ${raw.toFixed(1)}s but silence removal will cut ~30%)`
      : "";
    goalLines.push(`HARD MAX duration: ${maxSeconds}s (current: ${current.toFixed(1)}s${silenceNote}${over > 0 ? `, must cut at least ${over.toFixed(1)}s of post-silence-strip length` : ""}).`);
  }
  if (goalLines.length === 0) {
    throw new Error("refine(): need either instruction or maxSeconds");
  }

  const userContextLine = userPrompt
    ? `\nUSER REQUEST CONTEXT (the broader ask this work is serving):\n"""${userPrompt}"""\n`
    : "";
  const transcriptBlock = transcript
    ? `\nFULL TRANSCRIPT (format: [start → end] SPEAKER: text). Adding NEW clips from this transcript is ONLY permitted when the instruction explicitly asks for additional material using phrasing like "add …", "include …", "also cover …", "bring in …", "more from …". Narrowing instructions like "start at X", "end at Y", "trim to X", "drop Z", "cut the part about W", "shorter", or any length-trim MUST NOT add new clips — only drop/shrink existing ones. When in doubt, do NOT add. When adding is permitted, use EXACT start_s / end_s values from the transcript below — no mid-word cuts.\n${buildTranscriptText(transcript.segments)}\n`
    : "";
  const capabilities = transcript
    ? `- Drop entire clips (matching the user's instruction, or the least essential first when trimming for length)
- Shrink a clip by tightening its start_s / end_s (values must stay within the original clip's range)
- ADD a new clip from the full transcript above — ONLY if the instruction explicitly requests additional material (see rules in the transcript block). Otherwise, do not add.
- Re-order or merge clips as needed for narrative flow`
    : `- Drop entire clips (matching the user's instruction, or the least essential first when trimming for length)
- Shrink a clip by tightening its start_s / end_s to a tighter sub-range (values must stay within the original clip's range)`;

  const prompt = `You are modifying an existing video compilation.

Topic: "${topic}"
${story ? `Story arc:\n${story}\n` : ""}${userContextLine}

${goalLines.join("\n")}

Clips currently in the compilation (indexed; each preserves a transcript excerpt):
${clipsText}
${transcriptBlock}
Return a JSON array of the FINAL set of clips (kept + any newly-added), in chronological order. You may:
${capabilities}

Prefer dropping redundancy over chopping single beats in half. Keep the narrative arc intact.${maxSeconds !== undefined ? ` Total duration MUST be <= ${maxSeconds}s.` : ""}

Return ONLY a JSON array (no prose, no markdown fences):
[ { "start_s": <number>, "end_s": <number>, "summary": "<optional>" }, ... ]`;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const matched = extractJsonArray(text);
  if (!matched) throw new Error(`Could not parse refine output:\n${text}`);
  let refined;
  try {
    refined = RefinedArraySchema.parse(JSON.parse(matched));
  } catch (e) {
    process.stderr.write(`\n--- refine parse failed ---\n`);
    process.stderr.write(`content blocks: ${JSON.stringify(response.content.map((c) => c.type))}\n`);
    process.stderr.write(`raw text (${text.length} chars):\n${text}\n`);
    process.stderr.write(`matched (${matched.length} chars):\n${matched}\n`);
    process.stderr.write(`--- end refine parse failed ---\n`);
    throw e;
  }

  // When the full transcript is available, snap boundaries and source excerpts
  // from it — this lets newly-added clips outside the original set still carry
  // transcript text. Otherwise fall back to the union of existing clips' excerpts.
  if (transcript) {
    const segs = transcript.segments;
    return refined.map((r) => {
      const start_s = snapToSegmentStart(transcript, r.start_s);
      const end_s = snapToSegmentEnd(transcript, r.end_s);
      const excerpt = segs
        .filter((t) => t.end_s > start_s && t.start_s < end_s)
        .sort((a, b) => a.start_s - b.start_s);
      return { ...r, start_s, end_s, transcript: excerpt };
    });
  }
  const allSegments = clips.flatMap((c) => c.transcript ?? []);
  return refined.map((r) => {
    const transcript = allSegments
      .filter((t) => t.end_s > r.start_s && t.start_s < r.end_s)
      .sort((a, b) => a.start_s - b.start_s);
    return { ...r, transcript };
  });
}

// Extract a JSON array from model output. Prefers ```json fenced blocks,
// then the last top-level `[...]` (bracket-balanced), ignoring stray `[N]`
// prose refs that tripped up naive regex matching.
function extractJsonArray(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fence) {
    const inside = fence[1].trim();
    const arr = findBalancedArray(inside);
    if (arr) return arr;
  }
  return findBalancedArray(text);
}

function findBalancedArray(text: string): string | null {
  // Scan for the first `[` that begins a balanced array containing at least
  // one `{` (our schema is an array of objects) — skips `[3]`-style prose refs.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    let depth = 0;
    let sawObject = false;
    let inStr = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") sawObject = true;
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          if (sawObject) return text.slice(i, j + 1);
          break;
        }
      }
    }
  }
  return null;
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
  const rawCurrent = totalOf(comp.clips);
  const silenceStripped = !!opts.silenceStripped;
  const current = silenceStripped ? rawCurrent * SILENCE_STRIP_FACTOR : rawCurrent;

  const transcriptPath = opts.transcript
    ? path.resolve(opts.transcript)
    : comp.source.replace(/\.[^.]+$/, ".transcript.json");
  let transcript: Transcript | undefined;
  if (fs.existsSync(transcriptPath)) {
    try {
      transcript = loadTranscript(transcriptPath);
      process.stderr.write(`Transcript loaded (${transcript.segments.length} segments) — refine may add new material.\n`);
    } catch (e) {
      process.stderr.write(`Warning: could not load transcript at ${transcriptPath}: ${e instanceof Error ? e.message : String(e)}\n  Falling back to drop/shrink-only mode.\n`);
    }
  } else {
    process.stderr.write(`No transcript at ${transcriptPath} — refine runs in drop/shrink-only mode (cannot add new material).\n`);
  }

  process.stderr.write(
    `Input: ${inputPath}\nCurrent duration: ${current.toFixed(1)}s${silenceStripped ? ` (post-silence-strip est; raw=${rawCurrent.toFixed(1)}s, −30%)` : ""}${maxSeconds !== undefined ? `, target max: ${maxSeconds}s` : ""}${instruction ? `\nInstruction: ${instruction}` : ""}\n`
  );
  // Only short-circuit when the sole goal is a length trim and we're already under budget.
  if (!instruction && maxSeconds !== undefined && current <= maxSeconds) {
    process.stderr.write(`Already within budget — no refine needed.\n`);
    process.stderr.write(`DURATION: ${current.toFixed(1)}s MAX: ${maxSeconds}s\n`);
    process.exit(0);
  }

  const client = new Anthropic({ apiKey });
  const refined = await refine(comp.clips, comp.story, comp.topic, maxSeconds, instruction, opts.model, client, opts.userPrompt, silenceStripped, transcript);
  const rawNewTotal = totalOf(refined);
  const newTotal = silenceStripped ? rawNewTotal * SILENCE_STRIP_FACTOR : rawNewTotal;

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
