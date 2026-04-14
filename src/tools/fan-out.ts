import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";

/**
 * Wraps a CompilationPlanner agent as a fan-out tool that plans+renders
 * multiple .topic.json files concurrently via Promise.allSettled. Returns one
 * MP4 path per input topic, in input order. Discarded plans surface as
 * "DISCARDED: <reason>" lines.
 */
export function makePlanAndRenderManyTool(compilationAgent: Agent) {
  return tool({
    name: "plan_and_render_many",
    description:
      "Run the CompilationPlanner concurrently across several .topic.json files. Given a list of topic paths, returns one final MP4 path (or DISCARDED line) per topic, in the same order. Use this instead of invoking compilation_planner sequentially when you have multiple topics to produce.",
    inputSchema: z.object({
      topics: z
        .array(z.string())
        .min(1)
        .describe("List of .topic.json paths to plan and render in parallel"),
      keepSilence: z
        .boolean()
        .optional()
        .describe(
          "If true, skip the final silence-strip pass. Default false (silence is always stripped)."
        ),
      maxSeconds: z
        .number()
        .optional()
        .describe(
          "Maximum total duration per compilation. Plans that exceed this are discarded (reported as DISCARDED)."
        ),
      bleep: z
        .boolean()
        .optional()
        .describe("If true, hint planners to bleep profanity after rendering."),
      bleepWords: z
        .string()
        .optional()
        .describe("Optional comma-separated list of words to bleep."),
    }),
    callback: async ({
      topics,
      keepSilence,
      maxSeconds,
      bleep,
      bleepWords,
    }: {
      topics: string[];
      keepSilence?: boolean;
      maxSeconds?: number;
      bleep?: boolean;
      bleepWords?: string;
    }) => {
      const silenceHint = keepSilence
        ? "\nThe top-level user explicitly asked to KEEP silence — skip the video_remove_silence step and return the raw compilation_render output path."
        : "";
      const maxHint =
        maxSeconds !== undefined
          ? `\nHARD CEILING: pass maxSeconds=${maxSeconds} to topic_to_compilation. If the tool output starts with DISCARDED:, your final answer is exactly that DISCARDED line.`
          : "";
      const bleepHint = bleep || bleepWords
        ? `\nBLEEP: after silence-stripping, run transcript_to_bleep_plan and video_apply_bleep (mode=mute).${bleepWords ? ` Use these words: ${bleepWords}.` : " Use auto=true."}`
        : "";
      const runs = await Promise.allSettled(
        topics.map((topicPath) =>
          compilationAgent.invoke(
            `Produce the final MP4 for this topic: ${topicPath}${silenceHint}${maxHint}${bleepHint}`
          )
        )
      );
      const lines: string[] = [];
      runs.forEach((r, i) => {
        if (r.status === "fulfilled") {
          const content =
            typeof r.value === "string"
              ? r.value
              : (r.value as { content?: string }).content ?? JSON.stringify(r.value);
          lines.push(`[${i + 1}] ${topics[i]} → ${content}`);
        } else {
          lines.push(`[${i + 1}] ${topics[i]} → ERROR: ${r.reason}`);
        }
      });
      return lines.join("\n");
    },
  });
}

/**
 * Wraps a SegmentPlanner agent as a fan-out tool that renders multiple
 * .segment.json files concurrently via Promise.allSettled.
 */
export function makePlanAndRenderSegmentsTool(segmentAgent: Agent) {
  return tool({
    name: "plan_and_render_segments",
    description:
      "Run the SegmentPlanner concurrently across several .segment.json files. Given a list of segment paths, returns one final MP4 path (or DISCARDED line) per segment, in the same order.",
    inputSchema: z.object({
      segments: z
        .array(z.string())
        .min(1)
        .describe("List of .segment.json paths to render in parallel"),
      keepSilence: z.boolean().optional(),
      maxSeconds: z.number().optional(),
      bleep: z.boolean().optional(),
      bleepWords: z.string().optional(),
    }),
    callback: async ({
      segments,
      keepSilence,
      maxSeconds,
      bleep,
      bleepWords,
    }: {
      segments: string[];
      keepSilence?: boolean;
      maxSeconds?: number;
      bleep?: boolean;
      bleepWords?: string;
    }) => {
      const silenceHint = keepSilence
        ? "\nThe top-level user explicitly asked to KEEP silence — skip video_remove_silence and return the raw segment_render output path."
        : "";
      const maxHint =
        maxSeconds !== undefined
          ? `\nHARD CEILING: ${maxSeconds} seconds. If the segment file indicates it's over (or a DISCARDED line is surfaced), your final answer is exactly the DISCARDED line.`
          : "";
      const bleepHint = bleep || bleepWords
        ? `\nBLEEP: after silence-stripping, run transcript_to_bleep_plan and video_apply_bleep (mode=mute).${bleepWords ? ` Use these words: ${bleepWords}.` : " Use auto=true."}`
        : "";
      const runs = await Promise.allSettled(
        segments.map((segmentPath) =>
          segmentAgent.invoke(
            `Produce the final MP4 for this segment: ${segmentPath}${silenceHint}${maxHint}${bleepHint}`
          )
        )
      );
      const lines: string[] = [];
      runs.forEach((r, i) => {
        if (r.status === "fulfilled") {
          const content =
            typeof r.value === "string"
              ? r.value
              : (r.value as { content?: string }).content ?? JSON.stringify(r.value);
          lines.push(`[${i + 1}] ${segments[i]} → ${content}`);
        } else {
          lines.push(`[${i + 1}] ${segments[i]} → ERROR: ${r.reason}`);
        }
      });
      return lines.join("\n");
    },
  });
}
