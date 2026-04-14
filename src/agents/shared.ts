import { OpenAIModel } from "@strands-agents/sdk/models/openai";

export function buildModel() {
  return new OpenAIModel({ api: "chat" });
}

export const HARD_RULES = `
HARD RULES (apply to every agent in this swarm):
- Always operate on the ORIGINAL source video the user points at. NEVER transcribe or render from a .distilled.*, .cut.*, or otherwise derived file — timestamps in derivatives do not align with the original.
- Follow the pipeline order: video_to_audio → audio_to_transcript → transcript_to_topic → topic_to_compilation → compilation_render.
- By default, ALWAYS strip silent/empty audio from the final rendered MP4 using video_remove_silence with reencode=true. Only skip this step when the user's top-level request explicitly asks to keep silence.
`.trim();
