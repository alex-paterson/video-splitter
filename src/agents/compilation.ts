import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import {
  topicToCompilation,
  compilationRender,
  videoRemoveSilence,
  transcriptToBleepPlan,
  videoApplyBleep,
} from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";

export function makeCompilationAgent() {
  return new Agent({
    id: "compilation_planner",
    name: "CompilationPlanner",
    description:
      "Given one .topic.json, builds the .compilation.json plan, reviews it, renders it, and strips silence from the final MP4. Returns the final silence-stripped MP4 path. Honors max-seconds (discard-and-regenerate) and optional bleep/censor.",
    model: buildModel(),
    tools: [
      topicToCompilation,
      compilationRender,
      videoRemoveSilence,
      transcriptToBleepPlan,
      videoApplyBleep,
      readFile,
    ],
    systemPrompt: `
${HARD_RULES}

You are the CompilationPlanner. You take ONE .topic.json and produce ONE polished short-video MP4.

Procedure:
1. Call topic_to_compilation with the topic path. If the invocation mentions a max-seconds ceiling, pass it as maxSeconds. It writes a .compilation.json next to the topic.
2. If the topic_to_compilation tool result contains a line starting with "DISCARDED:" (the plan was over the max-seconds ceiling), STOP. Your final answer MUST be a single line: "DISCARDED: <reason>" copying the reason from the tool output. Do not render.
3. Otherwise, read_file the resulting .compilation.json and sanity-check it:
   - At least a few clips, in chronological order.
   - Clips form a coherent story (no total non-sequiturs).
   - No extremely short (<1s) or extremely long (>60s) clips unless justified by the topic.
   If the plan is bad, re-run topic_to_compilation (possibly adjusting inputs) — do not render a bad plan.
4. Call compilation_render on the .compilation.json with aspect="portrait". This writes a <base>.compilation.mp4.
5. By default, immediately call video_remove_silence on that rendered MP4 with reencode=true to strip empty audio. The default output path will be <base>.compilation.cut.mp4. Skip this step ONLY if the top-level user prompt explicitly says to keep silence.
6. If the invocation says to bleep/censor/profanity (or provides an explicit words list), after silence-stripping: call transcript_to_bleep_plan with the transcript referenced by the topic/compilation (use auto=true unless words were given; if words were given, pass them as --words). Then call video_apply_bleep on the silence-stripped MP4 with the resulting .bleep.json (mode="mute" by default). Return the <base>.bleeped.mp4 path.
7. Return ONLY the final MP4 path (bleeped if applicable, else silence-stripped, else raw compilation) as your final answer.
`.trim(),
  });
}
