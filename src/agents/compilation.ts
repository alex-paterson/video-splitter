import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import {
  topicToCompilation,
  compilationRefine,
  compilationRender,
  videoRemoveSilence,
  transcriptToBleepPlan,
  videoApplyBleep,
  topicToBanner,
} from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";
import { compilationEstimateDuration } from "../tools/estimate.js";

export function makeCompilationAgent() {
  return new Agent({
    id: "compilation_planner",
    name: "CompilationPlanner",
    description:
      "Given one .topic.json, builds the .compilation.json plan, reviews it, renders it, and strips silence from the final MP4. Returns the final silence-stripped MP4 path. Honors max-seconds (discard-and-regenerate) and optional bleep/censor.",
    model: buildModel(),
    tools: [
      topicToCompilation,
      compilationRefine,
      compilationRender,
      videoRemoveSilence,
      transcriptToBleepPlan,
      videoApplyBleep,
      topicToBanner,
      compilationEstimateDuration,
      readFile,
    ],
    systemPrompt: `
${HARD_RULES}

You are the CompilationPlanner. You take ONE .topic.json and produce ONE polished short-video MP4.

Procedure:
1. Call topic_to_compilation with the topic path. If the invocation mentions a max-seconds ceiling, pass it as maxSeconds. It writes a .compilation.json next to the topic.
2. Always call compilation_estimate_duration on the resulting .compilation.json to get the phrase-sum estimate (post-silence-strip) — NEVER estimate durations by hand; LLMs are bad at arithmetic. Use phrase_sum_total_s as the authoritative "will be roughly this long" number, and compare it against the max-seconds ceiling. Look at the topic_to_compilation stderr for "DURATION: Ns MAX: Ms" too. If it also reports "OVER_MAX: ... cut_at_least=Ks — call compilation_refine on <path>", you MUST iterate: call compilation_refine with that path and the same maxSeconds. It writes the next version (.compilation.2.json, then .3.json, ...) and reports DURATION / OVER_MAX the same way. Keep calling compilation_refine on the latest path until DURATION <= MAX or you have called refine 4 times. Always render the LATEST version. Never render a plan that is still OVER_MAX unless you have exhausted 4 refine attempts (in that case, render the latest and report the final duration in your answer).
3. Before rendering, read_file the final .compilation[.N].json and sanity-check it:
   - At least a few clips, in chronological order.
   - Clips form a coherent story (no total non-sequiturs).
   - No extremely short (<1s) or extremely long (>60s) clips unless justified by the topic.
   If the plan is bad, re-run topic_to_compilation (possibly adjusting inputs) — do not render a bad plan.
4. Before rendering, call topic_to_banner with:
   - topic = the compilation's topic string
   - description = the "story" field from the .compilation[.N].json (the full narrative summary — this grounds the illustration in what actually happens, not generic imagery)
   - output = <same-dir>/<base>.banner.png
   It generates a pictorial PNG via OpenAI. Pass that path as the "banner" argument to compilation_render so it's overlaid at top-center. Skip only if the user explicitly asks for "no banner".
5. Call compilation_render on the final .compilation[.N].json with aspect="portrait" AND banner=<the banner.png path from step 4>. This writes a <base>.compilation.mp4. The banner is baked into pixels and will survive the later silence-strip re-encode. MANDATORY: always include the banner argument unless step 4 was explicitly skipped. Verify the tool's stderr shows "Banner: <path>" (not "(none)") before moving on.
6. By default, immediately call video_remove_silence on that rendered MP4 with reencode=true to strip empty audio. The default output path will be <base>.compilation.cut.mp4. Skip this step ONLY if the top-level user prompt explicitly says to keep silence.
7. If the invocation says to bleep/censor/profanity (or provides an explicit words list), after silence-stripping: call transcript_to_bleep_plan with the transcript referenced by the topic/compilation (use auto=true unless words were given; if words were given, pass them as --words). Then call video_apply_bleep on the silence-stripped MP4 with the resulting .bleep.json (mode="mute" by default). Return the <base>.bleeped.mp4 path.
8. Return ONLY the final MP4 path (bleeped if applicable, else silence-stripped, else raw compilation) as your final answer.
`.trim(),
  });
}
