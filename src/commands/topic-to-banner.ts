#!/usr/bin/env tsx
/**
 * topic-to-banner — Generate a transparent PNG banner containing short text
 * (3-5 words) describing the topic, using the OpenAI images API. Intended to
 * be overlaid at the top-center of rendered videos.
 *
 * Usage: tsx src/commands/topic-to-banner.ts --topic "<text>" --output <path.png>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import OpenAI from "openai";

const program = new Command();

program
  .name("topic-to-banner")
  .description("Generate a PNG banner image for a topic via OpenAI images API.")
  .requiredOption("--topic <text>", "Short topic (used as the subject anchor)")
  .requiredOption("--description <text>", "Longer summary/story describing what happens or matters — used to ground the illustration in real specifics")
  .requiredOption("--output <path>", "Output PNG path")
  .option("--user-prompt <text>", "Original user request — shapes the imagery (e.g. 'make it feel chaotic', 'retro 8-bit style')")
  .option("--width <px>", "Image width in pixels", "1024")
  .option("--model <model>", "OpenAI image model", "gpt-image-1")
  .option("--style <desc>", "Style hint", "bold illustrated raster artwork, vivid saturated colors, thick black outlines, comic/sticker style, transparent background");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  topic: string;
  description: string;
  userPrompt?: string;
  output: string;
  width: string;
  model: string;
  style: string;
}>();

function pickPhrase(topic: string): string {
  const cleaned = topic.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter((w) => w.length > 0);
  if (words.length <= 5) return words.join(" ");
  const stop = new Set(["the","a","an","and","or","of","to","in","on","for","with","by","at","is","are","this","that"]);
  const content = words.filter((w) => !stop.has(w.toLowerCase()));
  return (content.length >= 3 ? content : words).slice(0, 5).join(" ");
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY not set");
    process.exit(1);
  }
  const width = parseInt(opts.width, 10);
  const phrase = pickPhrase(opts.topic);
  const outputPath = path.resolve(opts.output);

  process.stderr.write(`Topic: "${opts.topic}"\nPhrase: "${phrase}"\nSize: 1024x1024 (rendered ${width}px wide)\n`);

  const client = new OpenAI({ apiKey });
  const description = opts.description.replace(/\s+/g, " ").trim().slice(0, 1200);
  const userPromptBlock = opts.userPrompt
    ? `\nUser's original request (their tone, style, or mood cues should shape the imagery):\n"""${opts.userPrompt.replace(/\s+/g, " ").trim().slice(0, 600)}"""\n`
    : "";
  const prompt =
    `A wide horizontal illustration depicting the subject: "${phrase}".\n` +
    `Context / what is actually happening in the source material (ground the illustration in these specifics, not generic imagery):\n${description}\n` +
    userPromptBlock +
    `\n${opts.style}. Pure pictorial imagery — NO text, NO letters, NO words, NO captions anywhere in the image. ` +
    `The subject is centered and clearly recognizable, composed for a horizontal top-banner aspect.`;

  const res = await client.images.generate({
    model: opts.model,
    prompt,
    size: "1536x1024",
    background: "transparent",
    n: 1,
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("No b64_json in OpenAI images response");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(b64, "base64"));

  process.stderr.write(`Saved: ${outputPath}\n`);
  process.stderr.write(`BANNER: ${outputPath}\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
