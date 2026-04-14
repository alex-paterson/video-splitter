#!/usr/bin/env tsx
/**
 * transcript-to-topic — Derive a topic's narrative from a transcript and save
 * it as a .topic.json for later use by topic-to-compilation.
 *
 * Usage: tsx src/commands/transcript-to-topic.ts [options] <transcript>
 */

import "dotenv/config";
import { Command } from "commander";
import path from "path";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  loadTranscript,
  Transcript,
  TranscriptSegment,
  saveTopic,
} from "../../lib/transcript.js";

const program = new Command();

program
  .name("transcript-to-topic")
  .description(
    "Derive a topic narrative from a transcript and save it as .topic.json"
  )
  .argument("<transcript>", "Path to .transcript.json")
  .option("--topic <text>", "Topic to derive a story for (required)")
  .option("--output <path>", "Output .topic.json path")
  .option("--max-seconds <n>", "Maximum allowed duration for the resulting compilation (hint to LLM; not validated here)")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6");

if (process.argv.length <= 2) { program.outputHelp(); process.exit(0); }
program.parse();

const opts = program.opts<{
  topic?: string;
  output?: string;
  maxSeconds?: string;
  model: string;
}>();

const [transcriptArg] = program.args;

function buildTranscriptText(
  segments: TranscriptSegment[],
  maxChars = 200_000
): string {
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

async function deriveStory(
  transcript: Transcript,
  topic: string,
  model: string,
  client: Anthropic,
  maxSeconds?: number
): Promise<string> {
  const transcriptText = buildTranscriptText(transcript.segments);
  const maxLine = maxSeconds !== undefined
    ? `\n\nHARD CEILING: the final compilation derived from this story MUST NOT EXCEED ${maxSeconds} seconds total. Keep the story focused and tight enough that aggressive filtering of the transcript to this story will produce a compilation under that ceiling. If the topic cannot be told in under ${maxSeconds}s, narrow it sharply.`
    : "";
  const prompt = `You are analyzing a video transcript to extract the narrative of a specific topic.

Topic: "${topic}"${maxLine}

Read the transcript and write a concise story document (a few sentences to paragraphs) that captures:
- The narrative arc: how the topic unfolds from beginning to end
- The essential beats and turning points
- Key lines of dialogue that define the story
- What is fluff, tangent, or redundant that can be cut without losing the story

Keep topic singular. Don't do "game bug and other misadventures". Can do: game bug then sudden death.
Feel free to pick a couple witty one-liners to keep in.

Be specific about what matters and what doesn't. This will be used to aggressively filter the transcript.

TRANSCRIPT:
${transcriptText}`;

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function main() {
  if (!fs.existsSync(transcriptArg)) {
    console.error(`Error: transcript not found: ${transcriptArg}`);
    process.exit(1);
  }
  if (!opts.topic) {
    console.error("Error: --topic is required");
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const transcriptPath = path.resolve(transcriptArg);
  const transcript = loadTranscript(transcriptPath);

  process.stderr.write(
    `Transcript: ${transcript.segments.length} segments, ${transcript.duration_s.toFixed(1)}s\n`
  );
  process.stderr.write(`Topic: "${opts.topic}"\n`);
  process.stderr.write(`Deriving story with ${opts.model}…\n`);

  const client = new Anthropic({ apiKey });
  const maxSeconds = opts.maxSeconds !== undefined ? parseFloat(opts.maxSeconds) : undefined;
  const story = await deriveStory(transcript, opts.topic, opts.model, client, maxSeconds);
  process.stderr.write(`\nStory:\n${story}\n\n`);

  const base = path.basename(transcriptPath).replace(/\.transcript\.json$/, "");
  const dir = path.dirname(transcriptPath);
  const slug = opts.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const outputPath = path.resolve(
    opts.output ?? path.join(dir, `${base}.${slug}.topic.json`)
  );

  saveTopic(outputPath, {
    transcript: transcriptPath,
    topic: opts.topic,
    story,
  });
  process.stderr.write(`Saved: ${outputPath}\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
