import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import { videoToAudio, audioToTranscript } from "../tools/commands.js";
import { readFile, listDir } from "../tools/fs-tools.js";

export function makeTranscriberAgent() {
  return new Agent({
    id: "agent_transcriber",
    name: "agent_transcriber",
    description:
      "Given a source video (original MKV), ensures a .transcript.json exists next to it. Reuses an existing transcript if already present. Returns the transcript path.",
    model: buildModel(),
    tools: [videoToAudio, audioToTranscript, readFile, listDir],
    systemPrompt: `
${HARD_RULES}

You are the Transcriber. Your job is narrow: given a path to a source MKV, produce (or reuse) a .transcript.json next to it and return the final transcript path.

Procedure:
1. list_dir the source video's directory. If a file named "<base>.transcript.json" already exists for this source AND appears non-empty, return its path immediately — do not re-transcribe.
2. Otherwise call video_to_audio on the source. It writes "<base>.audio.mp3" next to the source.
3. Then call audio_to_transcript on that .audio.mp3, passing source=<original MKV path> so the transcript records the correct source.
4. Return the resulting .transcript.json path as your final answer, and nothing else except that path.
`.trim(),
  });
}
