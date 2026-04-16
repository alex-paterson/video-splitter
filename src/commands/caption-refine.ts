#!/usr/bin/env tsx
/**
 * caption-refine — Apply a free-text instruction to an existing .caption.json,
 * producing the next version (.caption.2.json → .caption.3.json → ...).
 *
 * The LLM sees the current plan + the words.json (for reference) + the user's
 * instruction. It can edit phrase text (e.g. inject "$"), styling, or title.
 *
 * Usage: tsx src/commands/caption-refine.ts <caption-json> --instruction "<text>"
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  CaptionPlan,
  CaptionPlanSchema,
  loadCaptionPlan,
  saveCaptionPlan,
  nextCaptionPlanPath,
} from "../../lib/caption.js";
import { loadWordsJson } from "../../lib/words.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("caption-refine")
  .description(
    "Modify an existing .caption.json via a free-text instruction. Can edit phrase text, styling, or title. Writes the next .caption.N.json.",
  )
  .argument("<caption-json>", "Path to .caption[.N].json")
  .requiredOption("--instruction <text>", "Free-text modification (e.g. 'add a $ before 19 in the money phrase', 'change font color to red')")
  .option("--words <path>", "Override path to .words.json (default: plan.words_source)")
  .option("--user-prompt <text>", "Original user request — forwarded to the LLM as context")
  .option("--output <path>", "Explicit output path (default: auto-increment)")
  .option("--model <model>", "Claude model", "claude-opus-4-6");

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}
program.parse();

const opts = program.opts<{
  instruction: string;
  words?: string;
  userPrompt?: string;
  output?: string;
  model: string;
}>();
const [inputArg] = program.args;

function findBalancedObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const scanText = fence ? fence[1] : text;
  for (let i = 0; i < scanText.length; i++) {
    if (scanText[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let j = i; j < scanText.length; j++) {
      const ch = scanText[j];
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return scanText.slice(i, j + 1);
      }
    }
  }
  return null;
}

async function refine(
  current: CaptionPlan,
  wordsRaw: string,
  instruction: string,
  userPrompt: string | undefined,
  model: string,
  client: Anthropic,
): Promise<CaptionPlan> {
  const userContextLine = userPrompt
    ? `\nUSER REQUEST CONTEXT (the broader ask this work is serving):\n"""${userPrompt}"""\n`
    : "";

  const prompt = `You are modifying a video caption plan.

The plan carries three mutable aspects:
1. Phrases (\`phrases[]\`) — the exact word text and timings that will appear on screen. Word text can be edited (e.g. injecting "$", fixing homophones, rewriting for clarity) but \`start\` timings come from forced-alignment and should be kept. You may split or merge phrases; each phrase's \`start\`/\`end\` must fit within its words' timings.
2. Style (\`style\`) — font, color, alignment, animation, padding, etc. All 17 fields listed in the current plan are editable; do not invent new fields.
3. Title (\`title\`) — optional { text, style }. You may add, remove, or restyle the title.

IMMUTABLE fields: source_mp4, words_source, videoWidth, videoHeight, durationSec.

VALID style values:
- verticalCaptionAlignment: "top" | "middle" | "bottom"
- horizontalCaptionAlignment: "left" | "center" | "right"
- textAnimation: "none" | "pop-in" | "fade-in" | "slide-in"
- textCapitalization: "none" | "uppercase"
- fontName: pick from the font family set (Anton-Regular, Inter-Black, Inter-Bold, Inter-ExtraBold, Montserrat-Black, Montserrat-Bold, Montserrat-ExtraBold, Rubik-Black, Rubik-ExtraBold, FjallaOne-Regular, PlayfairDisplay-Black, PlayfairDisplay-Bold, PlayfairDisplay-ExtraBold, Rokkitt-Black, Rokkitt-Bold, Rokkitt-ExtraBold, Sora-Bold, Sora-ExtraBold, Dosis-Bold, Dosis-ExtraBold, Arvo-Bold, ZillaSlab-Bold, LibreBaskerville-Bold, Slabo27px-Regular, Socake, AlfaSlabOne-Regular, AbrilFatface-Regular, IBMPlexMono-Bold, IBMPlexMono-SemiBold)
- colors: any CSS color string (hex, rgb, rgba, "transparent")

${userContextLine}
User's modification instruction (apply literally; preserve everything else):
"""${instruction}"""

Current plan (edit in place — return the FULL updated plan, not a diff):
${JSON.stringify(current, null, 2)}

For reference, the words.json the plan was built from (word-level source of truth; useful if you want to re-derive or cross-check phrases):
${wordsRaw.slice(0, 80_000)}${wordsRaw.length > 80_000 ? "\n[...words truncated...]" : ""}

Return ONLY the updated plan as a single JSON object (no prose, no markdown fences). It must parse against the same shape as the input plan.`;

  const response = await client.messages.create({
    model,
    max_tokens: 16_384,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const matched = findBalancedObject(text);
  if (!matched) throw new Error(`Could not parse caption-refine output:\n${text}`);
  let parsed;
  try {
    parsed = CaptionPlanSchema.parse(JSON.parse(matched));
  } catch (e) {
    process.stderr.write(`\n--- caption-refine parse failed ---\n`);
    process.stderr.write(`raw text (${text.length} chars):\n${text}\n`);
    process.stderr.write(`--- end ---\n`);
    throw e;
  }
  // Re-assert the immutable fields in case the LLM tried to change them.
  return {
    ...parsed,
    source_mp4: current.source_mp4,
    words_source: current.words_source,
    videoWidth: current.videoWidth,
    videoHeight: current.videoHeight,
    durationSec: current.durationSec,
  };
}

async function main() {
  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`ERROR: file not found: ${inputPath}\n`);
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write(`ERROR: ANTHROPIC_API_KEY not set\n`);
    process.exit(1);
  }
  const instruction = opts.instruction.trim();
  if (!instruction) {
    process.stderr.write(`ERROR: --instruction is empty\n`);
    process.exit(1);
  }

  const current = loadCaptionPlan(inputPath);
  const wordsPath = path.resolve(opts.words ?? current.words_source);
  if (!fs.existsSync(wordsPath)) {
    process.stderr.write(`ERROR: words file not found: ${wordsPath}\n`);
    process.exit(1);
  }
  // Validate the words file; keep raw text for the LLM to see formatting.
  loadWordsJson(wordsPath);
  const wordsRaw = fs.readFileSync(wordsPath, "utf-8");

  process.stderr.write(
    `Input: ${inputPath}\n` +
      `  ${current.phrases.length} phrases, style="${current.style.fontName}" color=${current.style.fontColor}${current.title ? `, title="${current.title.text}"` : ""}\n` +
      `Instruction: ${instruction}\n`,
  );

  const client = new Anthropic({ apiKey });
  const refined = await refine(current, wordsRaw, instruction, opts.userPrompt, opts.model, client);

  const outputPath = path.resolve(opts.output ?? redirectOutToTmp(nextCaptionPlanPath(inputPath)));
  saveCaptionPlan(outputPath, refined);

  process.stderr.write(
    `Refined ${current.phrases.length} → ${refined.phrases.length} phrase(s); style=${refined.style.fontName}/${refined.style.fontColor}${refined.title ? `; title="${refined.title.text}"` : ""}\n` +
      `Saved: ${outputPath}\n`,
  );
  process.stdout.write(outputPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
