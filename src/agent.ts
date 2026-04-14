#!/usr/bin/env tsx
/**
 * agent — Autonomous swarm that turns a long stream recording into short
 * compilation videos. Driven by a plain-English prompt.
 *
 * Usage: tsx src/agent.ts "make me 2 shorts from /path/to/source.mkv"
 */

import "dotenv/config";
import { makeOrchestratorAgent } from "./agents/orchestrator.js";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error(
      'Usage: tsx src/agent.ts "<plain-english request>"\n' +
        'Example: tsx src/agent.ts "make me 2 shorts from /home/alex/OBS/foo.mkv"'
    );
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY not set");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const agent = makeOrchestratorAgent();
  const result = await agent.invoke(prompt);
  const text = extractText(result);
  console.log("\n" + (text || "(no response)"));
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as {
    content?: string;
    lastMessage?: { content?: Array<{ text?: string }> };
  };
  if (typeof r?.content === "string") return r.content;
  const parts = r?.lastMessage?.content ?? [];
  return parts.map((p) => p?.text ?? "").filter(Boolean).join("\n");
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
