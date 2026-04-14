import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import {
  segmentRender,
  videoRemoveSilence,
  transcriptToBleepPlan,
  videoApplyBleep,
  topicToBanner,
} from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";
import { segmentEstimateDuration } from "../tools/estimate.js";

export function makeSegmentAgent() {
  return new Agent({
    id: "segment_planner",
    name: "SegmentPlanner",
    description:
      "Given one .segment.json, renders it to an MP4 clip, strips silence by default, optionally bleeps profanity, and returns the final MP4 path. Mirrors CompilationPlanner.",
    model: buildModel(),
    tools: [
      segmentRender,
      videoRemoveSilence,
      transcriptToBleepPlan,
      videoApplyBleep,
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
3. Before rendering, call topic_to_banner with topic=<the segment's title>, description=<the segment's "rationale" field — the longer summary of what happens>, and output=<sibling .banner.png> to generate a pictorial PNG grounded in the segment's actual content. Skip only if the user explicitly asks for "no banner".
4. Call segment_render with input=<source>, segment=<.segment.json path>, aspect="9:16" (portrait), and banner=<the banner.png> so the title is overlaid at top-center. This writes an MP4 next to the source.
5. By default, call video_remove_silence on that MP4 with reencode=true. Skip ONLY if the invocation explicitly says to keep silence.
6. If the invocation says to bleep/censor/profanity (or provides a words list), call transcript_to_bleep_plan on the transcript referenced by the segment source (derive .transcript.json next to the source; or use the path in the invocation). Then call video_apply_bleep on the silence-stripped MP4 with the resulting .bleep.json (mode="mute"). Return the .bleeped.mp4 path.
7. Return ONLY the final MP4 path (bleeped if applicable, else silence-stripped, else raw rendered clip) as your final answer.
`.trim(),
  });
}
