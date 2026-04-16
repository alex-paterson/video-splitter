#!/usr/bin/env tsx
/**
 * framer-filter — Reduce a .framer.json's per-scene region list to exactly one
 * region (biggest by area, or LLM-picked given a transcript context).
 * Writes <base>.framer.filtered.json.
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  FramerJson,
  FramerScene,
  Region,
  boxArea,
  loadFramer,
  saveFramer,
} from "../../lib/framer.js";
import { loadWordsJson, WordsJson } from "../../lib/words.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("framer-filter")
  .description("Pick one region per scene (biggest-area or LLM with transcript context)")
  .argument("<framer-json>", "Path to .framer.json from video-framer-detect")
  .option("--mode <mode>", "biggest | llm", "biggest")
  .option("--words <path>", "Words JSON for LLM context (only used when --mode=llm)")
  .option("--model <model>", "Claude model for LLM mode", "claude-opus-4-6")
  .option("--output <path>", "Output (default: <base>.framer.filtered.json)")
  .parse(process.argv);

const opts = program.opts<{ mode: string; words?: string; model: string; output?: string }>();
const [framerArg] = program.args;

function transcriptForScene(words: WordsJson | undefined, s: FramerScene): string {
  if (!words) return "";
  return words.words
    .filter((w) => w.start_s >= s.start_s - 0.05 && w.end_s <= s.end_s + 0.05)
    .map((w) => w.word)
    .join(" ")
    .slice(0, 2000);
}

async function pickByLlm(
  client: Anthropic,
  model: string,
  scene: FramerScene,
  transcriptText: string,
): Promise<Region> {
  if (scene.regions.length <= 1) return scene.regions[0];
  const candidates = scene.regions.map((r, i) => ({
    idx: i,
    label: r.label,
    category: r.category,
    box: r.box,
    confidence: r.confidence,
  }));
  const resp = await client.messages.create({
    model,
    max_tokens: 256,
    system:
      'You select the single most relevant on-screen region for a video scene given the spoken transcript. Reply with ONLY a JSON object {"idx": <integer>, "reason": "..."}.',
    messages: [
      {
        role: "user",
        content: `Transcript during scene: ${transcriptText || "(none)"}
Candidates:
${JSON.stringify(candidates, null, 2)}

Pick the idx whose label/category best matches what the speaker is talking about. Reply JSON only.`,
      },
    ],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in llm response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(m[0]) as { idx: number; reason?: string };
  const picked = scene.regions[parsed.idx];
  if (!picked) throw new Error(`llm idx ${parsed.idx} out of range`);
  process.stderr.write(
    `  scene ${scene.scene_id}: LLM picked [${parsed.idx}] "${picked.label ?? picked.category}" — ${parsed.reason ?? ""}\n`,
  );
  return picked;
}

async function main() {
  const framerPath = path.resolve(framerArg);
  if (!fs.existsSync(framerPath)) throw new Error(`Framer JSON not found: ${framerPath}`);
  const mode = opts.mode === "llm" ? "llm" : "biggest";

  const data = loadFramer(framerPath);
  let words: WordsJson | undefined;
  if (mode === "llm") {
    if (!opts.words) {
      process.stderr.write(
        `Warning: --mode=llm without --words will run with empty transcript context per scene.\n`,
      );
    } else {
      words = loadWordsJson(path.resolve(opts.words));
    }
  }

  let client: Anthropic | undefined;
  if (mode === "llm") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set (required for --mode=llm)");
    client = new Anthropic({ apiKey });
  }

  let kept = 0, dropped = 0;
  for (const scene of data.scenes) {
    const candidates = scene.regions;
    if (candidates.length === 0) continue;
    let picked: Region;
    if (mode === "llm" && client) {
      picked = await pickByLlm(client, opts.model, scene, transcriptForScene(words, scene));
    } else {
      picked = candidates.reduce((a, b) => (boxArea(b.box) > boxArea(a.box) ? b : a));
    }
    dropped += candidates.length - 1;
    scene.regions = [picked];
    kept++;
  }

  const dir = path.dirname(framerPath);
  const name = path.basename(framerPath);
  const outName = name.replace(/\.framer\.json$/, ".framer.filtered.json");
  const outPath = path.resolve(opts.output ?? redirectOutToTmp(path.join(dir, outName)));
  saveFramer(outPath, data as FramerJson);

  process.stderr.write(
    `Filtered ${data.scenes.length} scenes: kept ${kept}, dropped ${dropped} alternatives (mode=${mode})\n` +
      `Wrote ${outPath}\n`,
  );
  process.stdout.write(outPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
