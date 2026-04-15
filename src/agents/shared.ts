import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";

export function buildModel() {
  return new AnthropicModel({
    modelId: "claude-sonnet-4-6",
    // modelId: "claude-opus-4-6",
    maxTokens: 16384,
    params: {
      thinking: { type: "enabled", budget_tokens: 4000 },
    },
  });
}

export const HARD_RULES = `
HARD RULES (apply to every agent in this swarm):
- Always operate on the ORIGINAL source video the user points at. NEVER transcribe or render from a .distilled.*, .cut.*, or otherwise derived file — timestamps in derivatives do not align with the original.
- Follow the pipeline order: video_to_audio → audio_to_transcript → transcript_to_topic → topic_to_compilation → compilation_render.
- By default, ALWAYS strip silent/empty audio from the final rendered MP4 using video_remove_silence with reencode=true. Only skip this step when the user's top-level request explicitly asks to keep silence.
- NARRATE. Before every tool call, emit a one-sentence plain-text note of what you're about to do and why (e.g. "Transcribing foo.mkv — need timestamps before scouting topics."). After a tool returns, emit one short line reacting to the result ("Got transcript at /…/foo.transcript.json — 412 segments. Scouting topics next."). Keep these terse — a sentence, not a paragraph. This narration is how the user sees your reasoning in real time; silent tool-calling looks to the user like the agent is stuck. This is MANDATORY.
`.trim();
