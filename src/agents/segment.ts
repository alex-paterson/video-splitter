import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import {
  segmentRender,
  videoRemoveSilence,
  videoBleep,
  topicToBanner,
} from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";
import { segmentEstimateDuration } from "../tools/estimate.js";

export function makeSegmentAgent() {
  return new Agent({
    id: "agent_segment_planner",
    name: "agent_segment_planner",
    description:
      "Given one .segment.json, renders it to an MP4 clip, strips silence by default, optionally bleeps profanity, and returns the final MP4 path. Mirrors CompilationPlanner.",
    model: buildModel(),
    tools: [
      segmentRender,
      videoRemoveSilence,
      videoBleep,
      topicToBanner,
      segmentEstimateDuration,
      readFile,
    ],
    systemPrompt: `
${HARD_RULES}

You are the SegmentPlanner. You take ONE .segment.json and produce ONE polished clip MP4.

Procedure:
1. read_file the .segment.json to learn the source video path (the "source" field — must be the ORIGINAL MKV). Always call segment_estimate_duration to get the phrase-sum estimate of post-silence-strip duration — NEVER guess durations yourself; LLMs are bad at arithmetic.
2. If the segment file is actually a sibling .rejected.json (or the invocation surfaces a DISCARDED line from the scout), your final answer MUST be a single line "DISCARDED: <reason>". Do not render.
3. BANNER IS OPT-IN. Skip this step entirely unless the invocation explicitly asks for a banner / title card. Otherwise, call topic_to_banner with topic=<title>, description=<rationale>, output=<sibling .banner.png>.
4. Call segment_render with input=<source>, segment=<.segment.json path>. Defaults: aspect="landscape", resolution="1280x720", preset="fast", hwAccel="nvenc" (fall back to vaapi on error). Only pass banner=<png> if step 3 generated one.
5. By default, call video_remove_silence on that MP4 with reencode=true. Skip ONLY if the invocation explicitly says to keep silence.
6. If the invocation says to bleep/censor/profanity (or provides a words list), as the FINAL step call video_bleep on the silence-stripped MP4. Pass auto=true unless words were given; if words were given, pass them as the "words" argument. video_bleep re-transcribes the cut itself with word-level timestamps, so bleep timing is accurate to the final output. Return the resulting .bleeped.mp4 path.
7. Return ONLY the final MP4 path (bleeped if applicable, else silence-stripped, else raw rendered clip) as your final answer.
`.trim(),
  });
}
