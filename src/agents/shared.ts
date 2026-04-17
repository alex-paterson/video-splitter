import { OpenAIModel } from "@strands-agents/sdk/models/openai";
// import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";

export function buildModel() {
  return new OpenAIModel({ api: "chat" });
  // return new AnthropicModel({
  //   modelId: "claude-sonnet-4-6",
  //   // modelId: "claude-opus-4-6",
  //   maxTokens: 16384,
  //   params: {
  //     thinking: { type: "enabled", budget_tokens: 4000 },
  //   },
  // });
}

export const HARD_RULES = `
HARD RULES (apply to every agent in this swarm):
- Always operate on the ORIGINAL source video the user points at. NEVER transcribe or render from a .distilled.*, .cut.*, or otherwise derived file — timestamps in derivatives do not align with the original.
- Follow the pipeline order: video_to_audio → audio_to_transcript → transcript_to_topic → topic_to_compilation → compilation_render.
- By default, ALWAYS strip silent/empty audio from the final rendered MP4 using video_remove_silence with reencode=true. Only skip this step when the user's top-level request explicitly asks to keep silence.
- out/ is the PUBLISH surface. The ONLY tool allowed to write to out/ is video_publish. All other reads/writes (transcripts, plans, intermediate MP4s, sidecar JSONs, .caption.json, .framer.*.json, .words.json, .scenes.json, .reframed.mp4, .captioned.mp4, …) MUST stay in tmp/. When post-processing a previously-published MP4, work on its tmp/ counterpart — never on the out/ copy. If you receive a path inside out/ for any tool other than video_publish, derive the tmp/ counterpart first (same basename) and operate on that; otherwise re-stage from out/ back into tmp/.
- NARRATE. Before every tool call, emit a one-sentence plain-text note that names the tool and explains why (e.g. "Calling transcribe_source on foo.mkv — need timestamps before scouting topics.", "Calling video_scene_detect on the cut MP4 — first step of the reframe pipeline."). Always include the tool name so the user knows exactly what's about to run. After a tool returns, emit one short line reacting to the result ("Got transcript at /…/foo.transcript.json — 412 segments. Calling agent_topic_scout next."). Keep these terse — a sentence, not a paragraph. This narration is how the user sees your reasoning in real time; silent tool-calling looks to the user like the agent is stuck. This is MANDATORY.
`.trim();
