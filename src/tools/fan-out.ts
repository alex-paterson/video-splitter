import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";

/**
 * Minimal promise-pool: runs `task(item)` across `items` with at most
 * `concurrency` in flight at once. Returns settled results in input order.
 */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await task(items[i], i) };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Wraps a TopicScout agent as a fan-out tool that scouts N topics across
 * several transcripts concurrently.
 */
export function makeTopicScoutManyTool(topicScoutAgent: Agent) {
  return tool({
    name: "topic_scout_many",
    description:
      "Run TopicScout concurrently across several transcripts. For each transcript, scouts `countPerTranscript` topics and returns the resulting .topic.json paths grouped by input transcript. Prefer over calling TopicScout sequentially.",
    inputSchema: z.object({
      transcripts: z.array(z.string()).min(1),
      countPerTranscript: z.number().min(1),
      maxSeconds: z.number().optional(),
      concurrency: z.number().optional().describe("Max concurrent scouts. Default 4."),
    }),
    callback: async ({
      transcripts,
      countPerTranscript,
      maxSeconds,
      concurrency,
    }: {
      transcripts: string[];
      countPerTranscript: number;
      maxSeconds?: number;
      concurrency?: number;
    }) => {
      const cap = Math.max(1, Math.min(concurrency ?? 4, 8));
      const maxHint = maxSeconds !== undefined ? ` maxSeconds=${maxSeconds}` : "";
      const runs = await pool(transcripts, cap, (t) =>
        topicScoutAgent.invoke(
          `Scout ${countPerTranscript} topic(s) from this transcript: ${t}${maxHint}`
        )
      );
      return runs
        .map((r, i) => {
          const header = `=== [${i + 1}] ${transcripts[i]} ===`;
          if (r.status === "fulfilled") {
            const content =
              typeof r.value === "string"
                ? r.value
                : (r.value as { content?: string }).content ?? JSON.stringify(r.value);
            return `${header}\n${content.trim()}`;
          }
          return `${header}\nERROR: ${r.reason}`;
        })
        .join("\n");
    },
  });
}

/**
 * Wraps a SegmentScout agent as a fan-out tool across several transcripts.
 */
export function makeSegmentScoutManyTool(segmentScoutAgent: Agent) {
  return tool({
    name: "segment_scout_many",
    description:
      "Run SegmentScout concurrently across several transcripts. For each transcript, scouts `countPerTranscript` segments and returns the resulting .segment.json paths grouped by input transcript.",
    inputSchema: z.object({
      transcripts: z.array(z.string()).min(1),
      countPerTranscript: z.number().min(1),
      maxSeconds: z.number().optional(),
      concurrency: z.number().optional().describe("Max concurrent scouts. Default 4."),
    }),
    callback: async ({
      transcripts,
      countPerTranscript,
      maxSeconds,
      concurrency,
    }: {
      transcripts: string[];
      countPerTranscript: number;
      maxSeconds?: number;
      concurrency?: number;
    }) => {
      const cap = Math.max(1, Math.min(concurrency ?? 4, 8));
      const maxHint = maxSeconds !== undefined ? ` maxSeconds=${maxSeconds}` : "";
      const runs = await pool(transcripts, cap, (t) =>
        segmentScoutAgent.invoke(
          `Scout ${countPerTranscript} segment(s) from this transcript: ${t}${maxHint}`
        )
      );
      return runs
        .map((r, i) => {
          const header = `=== [${i + 1}] ${transcripts[i]} ===`;
          if (r.status === "fulfilled") {
            const content =
              typeof r.value === "string"
                ? r.value
                : (r.value as { content?: string }).content ?? JSON.stringify(r.value);
            return `${header}\n${content.trim()}`;
          }
          return `${header}\nERROR: ${r.reason}`;
        })
        .join("\n");
    },
  });
}

/**
 * Wraps a Transcriber agent as a fan-out tool that transcribes several source
 * videos concurrently. Caps concurrency to avoid flooding the Whisper API.
 */
export function makeTranscribeManyTool(transcriberAgent: Agent) {
  return tool({
    name: "transcribe_many",
    description:
      "Transcribe several source videos concurrently. Returns one .transcript.json path per input (or ERROR line), in input order. Prefer this over calling the Transcriber agent sequentially when you have >1 video.",
    inputSchema: z.object({
      sources: z
        .array(z.string())
        .min(1)
        .describe("List of source video paths (original MKVs)"),
      concurrency: z
        .number()
        .optional()
        .describe("Max concurrent transcriptions. Default 4."),
    }),
    callback: async ({
      sources,
      concurrency,
    }: {
      sources: string[];
      concurrency?: number;
    }) => {
      const cap = Math.max(1, Math.min(concurrency ?? 4, 8));
      const runs = await pool(sources, cap, (src) =>
        transcriberAgent.invoke(`Transcribe this source video: ${src}`)
      );
      return runs
        .map((r, i) => {
          if (r.status === "fulfilled") {
            const content =
              typeof r.value === "string"
                ? r.value
                : (r.value as { content?: string }).content ?? JSON.stringify(r.value);
            return `[${i + 1}] ${sources[i]} → ${content.trim()}`;
          }
          return `[${i + 1}] ${sources[i]} → ERROR: ${r.reason}`;
        })
        .join("\n");
    },
  });
}

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
      banner: z
        .boolean()
        .optional()
        .describe("If true, generate and overlay a centered banner PNG. Default false."),
    }),
    callback: async ({
      topics,
      keepSilence,
      maxSeconds,
      bleep,
      bleepWords,
      banner,
    }: {
      topics: string[];
      keepSilence?: boolean;
      maxSeconds?: number;
      bleep?: boolean;
      bleepWords?: string;
      banner?: boolean;
    }) => {
      const silenceHint = keepSilence
        ? "\nThe top-level user explicitly asked to KEEP silence — skip the video_remove_silence step and return the raw compilation_render output path."
        : "";
      const maxHint =
        maxSeconds !== undefined
          ? `\nMAX SECONDS: ${maxSeconds}. Pass maxSeconds=${maxSeconds} to topic_to_compilation; if the plan is OVER_MAX, iterate with compilation_refine (up to 4×) until DURATION <= MAX. Render the latest version.`
          : "";
      const bleepHint = bleep || bleepWords
        ? `\nBLEEP: after silence-stripping, run transcript_to_bleep_plan and video_apply_bleep (mode=mute).${bleepWords ? ` Use these words: ${bleepWords}.` : " Use auto=true."}`
        : "";
      const bannerHint = banner
        ? "\nBANNER: REQUIRED. Run topic_to_banner and pass banner=<png> to compilation_render. Verify the render's stderr shows 'Banner: <path>' (not '(none)')."
        : "";
      const runs = await pool(topics, 4, (topicPath) =>
        compilationAgent.invoke(
          `Produce the final MP4 for this topic: ${topicPath}${silenceHint}${maxHint}${bleepHint}${bannerHint}`
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
      banner: z.boolean().optional(),
    }),
    callback: async ({
      segments,
      keepSilence,
      maxSeconds,
      bleep,
      bleepWords,
      banner,
    }: {
      segments: string[];
      keepSilence?: boolean;
      maxSeconds?: number;
      bleep?: boolean;
      bleepWords?: string;
      banner?: boolean;
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
      const bannerHint = banner
        ? "\nBANNER: REQUIRED. Run topic_to_banner and pass banner=<png> to segment_render. Verify the render's stderr shows 'Banner: <path>' (not '(none)')."
        : "";
      const runs = await pool(segments, 4, (segmentPath) =>
        segmentAgent.invoke(
          `Produce the final MP4 for this segment: ${segmentPath}${silenceHint}${maxHint}${bleepHint}${bannerHint}`
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
