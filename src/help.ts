#!/usr/bin/env tsx
/**
 * help — List all available commands in this project.
 */

const commands: Array<[string, string]> = [
  ["video-to-audio", "Extract a video's audio to a 16kHz mono MP3"],
  ["audio-to-transcript", "Transcribe audio with multi-speaker diarization → .transcript.json"],
  ["video-remove-silence", "Remove silent intervals from a video file"],
  ["transcript-find-segment", "Use an LLM to find a coherent standalone video segment in a transcript"],
  ["segment-render", "Render a .segment.json to a video, cover-fill cropped to target aspect"],
  ["transcript-to-distillation-plan", "Analyze a transcript → .distillation.json (narrative + keep intervals)"],
  ["distillation-render", "Render a .distillation.json plan to a condensed video"],
  ["transcript-to-topic", "Derive a topic's narrative from a transcript → .topic.json"],
  ["topic-to-compilation", "Filter a transcript by a .topic.json story → .compilation.json plan"],
  ["compilation-render", "Render a .compilation.json plan to a single concatenated video"],
];

const pad = Math.max(...commands.map(([n]) => n.length));
console.log("Available commands (run with no args or --help for details):\n");
for (const [name, desc] of commands) {
  console.log(`  npm run ${name.padEnd(pad)}  ${desc}`);
}
console.log();
