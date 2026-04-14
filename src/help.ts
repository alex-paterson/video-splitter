#!/usr/bin/env tsx
/**
 * help — List all available commands in this project.
 */

const commands: Array<[string, string]> = [
  ["transcribe", "Transcribe video audio with multi-speaker diarization"],
  ["silence-cut", "Remove silent intervals from a video file"],
  ["find-segment", "Use an LLM to find a coherent standalone video segment in a transcript"],
  ["render-segment", "Extract and render a video segment with cover-fill cropping"],
  ["distill", "Condense a video by keeping only the narrative core"],
  ["topic-cut", "Filter a transcript to topic-relevant passages and render them as a compilation"],
];

const pad = Math.max(...commands.map(([n]) => n.length));
console.log("Available commands (run with no args or --help for details):\n");
for (const [name, desc] of commands) {
  console.log(`  npm run ${name.padEnd(pad)}  ${desc}`);
}
console.log();
