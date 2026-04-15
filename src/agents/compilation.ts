import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import {
  topicToCompilation,
  compilationRefine,
  compilationRender,
  videoRemoveSilence,
  videoBleep,
  topicToBanner,
} from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";
import { compilationEstimateDuration } from "../tools/estimate.js";

export function makeCompilationAgent() {
  return new Agent({
    id: "agent_compilation_planner",
    name: "CompilationPlanner (agent)",
    description:
      "Given one .topic.json, builds the .compilation.json plan, reviews it, renders it, and strips silence from the final MP4. Returns the final silence-stripped MP4 path. Honors max-seconds (discard-and-regenerate) and optional bleep/censor.",
    model: buildModel(),
    tools: [
      topicToCompilation,
      compilationRefine,
      compilationRender,
      videoRemoveSilence,
      videoBleep,
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
4. BANNER IS OPT-IN. Skip steps 4a-4c entirely unless the invocation explicitly asks for a banner / title card. If skipped, call compilation_render WITHOUT a banner argument.
4a. Before rendering, call topic_to_banner with:
   - topic = the compilation's topic string
   - description = the "story" field from the .compilation[.N].json (the full narrative summary — this grounds the illustration in what actually happens, not generic imagery)
   - output = <same-dir>/<base>.banner.png
   It generates a pictorial PNG via OpenAI. Pass that path as the "banner" argument to compilation_render so it's overlaid at top-center. Skip only if the user explicitly asks for "no banner".
5. Call compilation_render on the final .compilation[.N].json. Default args: aspect="landscape", resolution="1280x720", preset="fast", hwAccel="nvenc" (fall back to vaapi if nvenc errors). Pass banner=<png> only if step 4 generated one.
6. By default, immediately call video_remove_silence on that rendered MP4 with reencode=true to strip empty audio. The default output path will be <base>.compilation.cut.mp4. Skip this step ONLY if the top-level user prompt explicitly says to keep silence.
7. If the invocation says to bleep/censor/profanity (or provides an explicit words list), as the FINAL step call video_bleep on the silence-stripped MP4. Pass auto=true unless words were given; if words were given, pass them as the "words" argument. video_bleep re-transcribes the cut itself with word-level timestamps, so bleep timing is accurate to the final output. Return the resulting .bleeped.mp4 path.
8. Return ONLY the final MP4 path (bleeped if applicable, else silence-stripped, else raw compilation) as your final answer.
`.trim(),
  });
}
