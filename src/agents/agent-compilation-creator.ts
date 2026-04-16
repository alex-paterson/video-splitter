import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import {
  topicToCompilation,
  compilationRefine,
  compilationRender,
  videoRemoveSilence,
  videoBleep,
  videoPublish,
} from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";
import { compilationEstimateDuration } from "../tools/estimate.js";

export function makeCompilationCreatorAgent() {
  return new Agent({
    id: "agent_compilation_creator",
    name: "agent_compilation_creator",
    description:
      "Given one .topic.json, builds the .compilation.json plan, reviews it, renders it, and strips silence from the final MP4. Returns the final silence-stripped MP4 path. Honors max-seconds (discard-and-regenerate) and optional bleep/censor.",
    model: buildModel(),
    tools: [
      topicToCompilation,
      compilationRefine,
      compilationRender,
      videoRemoveSilence,
      videoBleep,
      videoPublish,
      compilationEstimateDuration,
      readFile,
    ],
    systemPrompt: `
${HARD_RULES}

You are the CompilationCreator. You take ONE .topic.json and produce ONE polished short-video MP4, OR you take an existing .compilation[.N].json plus a modification instruction and produce a revised MP4.

REFINE-EXISTING MODE:
If the invocation gives you an existing .compilation[.N].json path and a user instruction (e.g. "remove the part where X happens", "drop the clip about Y", "shorter overall"), SKIP steps 1-3 below. Instead:
  a. read_file the given compilation JSON to confirm it exists and understand the current clips.
  b. Call compilation_refine with that path and the user's text as the \`instruction\` argument (and pass \`maxSeconds\` too if the user specified a length, AND silenceStripped=true unless keep-silence mode). It writes the next .compilation.N.json. Refine auto-loads the original transcript (derived from compilation.source) so it can ADD new material from anywhere in the source video — not just drop/shrink — when the instruction calls for it (e.g. "include the part where…", "add more context from the start"). Do NOT iterate unless a maxSeconds ceiling was given and stderr reports OVER_MAX.
  c. Continue from step 4 (banner opt-in) on the new .compilation.N.json path.

USER PROMPT FORWARDING:
If the invocation surfaces a USER PROMPT (the top-level user request that motivated this run), forward it verbatim as the \`userPrompt\` argument to every LLM-driven tool you call — that means topic_to_compilation AND compilation_refine. This gives those steps the broader intent, not just the immediate inputs.

SILENCE-STRIP AWARENESS:
Unless the invocation explicitly says "KEEP silence", you WILL run video_remove_silence after rendering. Silence stripping removes roughly 30% of the raw clip-sum duration. So when calling topic_to_compilation or compilation_refine with maxSeconds, ALSO pass silenceStripped=true — those tools apply a 30% discount when comparing current duration to maxSeconds so the LLM doesn't over-trim. If the invocation says to KEEP silence, do NOT pass silenceStripped=true (raw sum is then the real duration).

FRESH-TOPIC MODE (default):
1. Call topic_to_compilation with the topic path. If the invocation mentions a max-seconds ceiling, pass it as maxSeconds AND pass silenceStripped=true (unless keep-silence mode). Forward userPrompt if provided. It writes a .compilation.json next to the topic.
2. Always call compilation_estimate_duration on the resulting .compilation.json to get the phrase-sum estimate (post-silence-strip) — NEVER estimate durations by hand; LLMs are bad at arithmetic. Use phrase_sum_total_s as the authoritative "will be roughly this long" number, and compare it against the max-seconds ceiling. Look at the topic_to_compilation stderr for "DURATION: Ns MAX: Ms" too. If it also reports "OVER_MAX: ... cut_at_least=Ks — call compilation_refine on <path>", you MUST iterate: call compilation_refine with that path and the same maxSeconds. It writes the next version (.compilation.2.json, then .3.json, ...) and reports DURATION / OVER_MAX the same way. Keep calling compilation_refine on the latest path until DURATION <= MAX or you have called refine 4 times. Always render the LATEST version. Never render a plan that is still OVER_MAX unless you have exhausted 4 refine attempts (in that case, render the latest and report the final duration in your answer).
3. Before rendering, read_file the final .compilation[.N].json and sanity-check it:
   - At least a few clips, in chronological order.
   - Clips form a coherent story (no total non-sequiturs).
   - No extremely short (<1s) or extremely long (>60s) clips unless justified by the topic.
   If the plan is bad, re-run topic_to_compilation (possibly adjusting inputs) — do not render a bad plan.
4. Call compilation_render on the final .compilation[.N].json. Default args: aspect="landscape", resolution="1280x720", preset="fast", hwAccel="nvenc" (fall back to vaapi if nvenc errors). Banners are NOT your responsibility — if the user asked for one, the orchestrator invokes agent_post_processor after you publish to overlay it via Remotion.
5. By default, immediately call video_remove_silence on that rendered MP4 with reencode=true to strip empty audio. The default output path will be <base>.compilation.cut.mp4. Skip this step ONLY if the top-level user prompt explicitly says to keep silence.
6. If the invocation says to bleep/censor/profanity (or provides an explicit words list), as the FINAL step call video_bleep on the silence-stripped MP4. Pass auto=true unless words were given; if words were given, pass them as the "words" argument. video_bleep re-transcribes the cut itself with word-level timestamps, so bleep timing is accurate to the final output. Return the resulting .bleeped.mp4 path.
7. As the VERY LAST step, call video_publish(input=<final-tmp-mp4>) to copy the final MP4 into out/. That is the ONLY thing that writes to out/ — none of the earlier steps do. Return the path returned by video_publish as your final answer.
`.trim(),
  });
}
