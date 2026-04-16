#!/usr/bin/env tsx
/**
 * framer-refine — Modify which region is chosen per scene in a
 * .framer.filtered.json, using candidates from the unfiltered .framer.json
 * and optional words.json transcript excerpts.
 *
 * Writes the next version (.framer.filtered.2.json → .3.json → …).
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  FramerJson,
  FramerScene,
  loadFramer,
  nextFilteredPath,
  saveFramer,
} from "../../lib/framer.js";
import { WordsJson, loadWordsJson } from "../../lib/words.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("framer-refine")
  .description(
    "Modify region choices in a .framer.filtered.json via a free-text instruction, using the unfiltered .framer.json as the candidate pool.",
  )
  .argument("<filtered-json>", "Path to .framer.filtered[.N].json")
  .requiredOption("--instruction <text>", "Free-text modification (e.g. 'use the github window instead of the terminal when we were discussing code')")
  .option("--unfiltered <path>", "Override unfiltered path (default: derived by stripping .filtered[.N])")
  .option("--words <path>", "Optional .words.json for per-scene transcript excerpts")
  .option("--user-prompt <text>", "Original user request — forwarded to the LLM")
  .option("--output <path>", "Explicit output path (default: auto-increment)")
  .option("--model <model>", "Claude model", "claude-opus-4-6");

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}
program.parse();

const opts = program.opts<{
  instruction: string;
  unfiltered?: string;
  words?: string;
  userPrompt?: string;
  output?: string;
  model: string;
}>();
const [inputArg] = program.args;

function deriveUnfilteredPath(filteredPath: string): string {
  const dir = path.dirname(filteredPath);
  const name = path.basename(filteredPath);
  const m = name.match(/^(.*)\.framer\.filtered(?:\.\d+)?\.json$/);
  if (!m) throw new Error(`Not a .framer.filtered[.N].json filename: ${name}`);
  return path.join(dir, `${m[1]}.framer.json`);
}

function transcriptForScene(words: WordsJson | undefined, s: FramerScene): string {
  if (!words) return "";
  return words.words
    .filter((w) => w.start_s >= s.start_s - 0.05 && w.end_s <= s.end_s + 0.05)
    .map((w) => w.word)
    .join(" ")
    .slice(0, 2000);
}

const DecisionSchema = z.array(
  z.union([
    z.object({ scene_id: z.number().int(), chosen_idx: z.number().int() }),
    z.object({ scene_id: z.number().int(), keep: z.literal(true) }),
  ]),
);

function findBalancedArray(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const scan = fence ? fence[1] : text;
  for (let i = 0; i < scan.length; i++) {
    if (scan[i] !== "[") continue;
    let depth = 0, inStr = false, escape = false;
    for (let j = i; j < scan.length; j++) {
      const ch = scan[j];
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) return scan.slice(i, j + 1);
      }
    }
  }
  return null;
}

async function main() {
  const filteredPath = path.resolve(inputArg);
  if (!fs.existsSync(filteredPath)) throw new Error(`Filtered JSON not found: ${filteredPath}`);
  const unfilteredPath = path.resolve(opts.unfiltered ?? deriveUnfilteredPath(filteredPath));
  if (!fs.existsSync(unfilteredPath)) {
    throw new Error(
      `Unfiltered .framer.json not found at ${unfilteredPath}. Pass --unfiltered to override.`,
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const filtered = loadFramer(filteredPath);
  const unfiltered = loadFramer(unfilteredPath);
  const words = opts.words ? loadWordsJson(path.resolve(opts.words)) : undefined;

  // Build per-scene context for the LLM. Scenes in filtered must map to scenes
  // in unfiltered by scene_id; we rely on that alignment.
  const sceneById = new Map(unfiltered.scenes.map((s) => [s.scene_id, s]));
  const sceneBlocks = filtered.scenes.map((fs) => {
    const uf = sceneById.get(fs.scene_id);
    const current = fs.regions[0];
    const candidates = (uf?.regions ?? []).map((r, idx) => ({
      idx,
      label: r.label,
      category: r.category,
      box: r.box,
      confidence: r.confidence,
      attributes: r.attributes,
    }));
    const transcript = transcriptForScene(words, fs);
    return {
      scene_id: fs.scene_id,
      start_s: fs.start_s,
      end_s: fs.end_s,
      transcript,
      current_region: current ? { label: current.label, box: current.box } : null,
      candidates,
    };
  });

  const userContextLine = opts.userPrompt
    ? `\nUSER REQUEST CONTEXT:\n"""${opts.userPrompt}"""\n`
    : "";

  const prompt = `You are modifying which on-screen region gets featured per scene in a video reframe plan.

For each scene, I give you:
- scene_id, time range
- the transcript text spoken during that scene (may be empty)
- candidate regions from vision detection (label, category, box, confidence)
- the currently chosen region

${userContextLine}
User instruction (apply literally; preserve scenes it doesn't mention):
"""${opts.instruction}"""

Scenes:
${JSON.stringify(sceneBlocks, null, 2)}

For EVERY scene, emit one decision:
- \`{"scene_id": N, "chosen_idx": K}\` — pick candidate K from that scene's candidates list (0-indexed)
- \`{"scene_id": N, "keep": true}\` — keep the currently chosen region

Return ONLY a JSON array of decisions, in scene_id order, with NO prose.`;

  process.stderr.write(
    `Input: ${filteredPath}\n  ${filtered.scenes.length} scenes; unfiltered has ${unfiltered.scenes.reduce((n, s) => n + s.regions.length, 0)} total candidates\nInstruction: ${opts.instruction}\n`,
  );

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: opts.model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const arr = findBalancedArray(text);
  if (!arr) throw new Error(`Could not parse framer-refine output:\n${text}`);
  const decisions = DecisionSchema.parse(JSON.parse(arr));

  const decisionById = new Map(decisions.map((d) => [d.scene_id, d]));
  let changed = 0, kept = 0, missing = 0;
  const newScenes: FramerScene[] = filtered.scenes.map((fs) => {
    const d = decisionById.get(fs.scene_id);
    if (!d || "keep" in d) {
      kept++;
      return fs;
    }
    const uf = sceneById.get(fs.scene_id);
    if (!uf) {
      missing++;
      return fs;
    }
    const candidate = uf.regions[d.chosen_idx];
    if (!candidate) {
      missing++;
      return fs;
    }
    const wasChanged = !fs.regions[0] || fs.regions[0].label !== candidate.label;
    if (wasChanged) changed++;
    return { ...fs, regions: [candidate] };
  });

  const out: FramerJson = { ...filtered, scenes: newScenes };
  const outPath = path.resolve(opts.output ?? redirectOutToTmp(nextFilteredPath(filteredPath)));
  saveFramer(outPath, out);

  process.stderr.write(
    `Refined: ${changed} changed, ${kept} kept${missing ? `, ${missing} could not resolve` : ""}\n` +
      `Saved: ${outPath}\n`,
  );
  process.stdout.write(outPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
