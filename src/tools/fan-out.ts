import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { bus } from "../lib/event-bus.js";
import { isCancelled } from "./cli-tool.js";
import { runCtx } from "../lib/run-context.js";
import { transcribeSourceFn } from "./commands.js";

type ToolCtx = { agent?: { cancelSignal?: AbortSignal } };
const getCancelSignal = (ctx?: ToolCtx): AbortSignal | undefined => ctx?.agent?.cancelSignal;

export async function streamAgentWithReasoning(
  agent: Agent,
  label: string,
  agentId: string,
  prompt: string,
  cancelSignal?: AbortSignal,
): Promise<unknown> {
  return runCtx.run({ agentId, label }, async () => {
  const gen = agent.stream(prompt, cancelSignal ? { cancelSignal } : undefined);
  let result: unknown;

  // Coalesce textDelta fragments so we don't fire an SSE event per token.
  let pending = "";
  let lastEmittedChar = "";
  let flushTimer: NodeJS.Timeout | null = null;
  const MAX_BUFFER_CHARS = 200;
  const FLUSH_MS = 80;
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending.length === 0) return;
    const text = pending;
    pending = "";
    lastEmittedChar = text.slice(-1);
    bus.publish({ type: "subagent_reasoning", agent: agentId, label, text });
  };
  const pushDelta = (text: string) => {
    if (!text) return;
    pending += text;
    if (pending.length >= MAX_BUFFER_CHARS) { flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  };
  const emitSeparator = () => {
    flush();
    if (lastEmittedChar === "\n" || lastEmittedChar === "") return;
    lastEmittedChar = "\n";
    bus.publish({ type: "subagent_reasoning", agent: agentId, label, text: "\n" });
  };

  try {
  while (true) {
    if (isCancelled(bus.getCurrentRunId())) {
      try { await gen.return(undefined as never); } catch { /* ignore */ }
      throw new Error("RUN_CANCELLED");
    }
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    const ev = next.value as {
      type?: string;
      contentBlock?: { type?: string; text?: string };
      toolUse?: { name?: string; toolUseId?: string; input?: unknown };
      event?: { type?: string; delta?: { type?: string; text?: string } };
      result?: unknown;
      error?: { message?: string } | Error;
    };
    if (ev?.type === "modelStreamUpdateEvent") {
      const inner = ev.event;
      if (inner?.type === "modelContentBlockDeltaEvent" && inner.delta?.type === "textDelta") {
        pushDelta(inner.delta.text ?? "");
      } else if (inner?.type === "modelContentBlockStopEvent") {
        emitSeparator();
      }
    } else if (ev?.type === "contentBlockEvent") {
      const cb = ev.contentBlock;
      // textBlock is already streamed via modelStreamUpdateEvent textDelta above;
      // only fall back to publishing here for reasoningBlock (unused with the
      // current OpenAI adapter, but correct if an Anthropic model is swapped in).
      if (cb?.type === "reasoningBlock") {
        const text = cb.text ?? "";
        if (text) {
          flush();
          lastEmittedChar = text.slice(-1);
          bus.publish({ type: "subagent_reasoning", agent: agentId, label, text });
          emitSeparator();
        }
      }
    } else if (ev?.type === "beforeToolCallEvent" && ev.toolUse) {
      flush();
      const store = runCtx.getStore();
      if (store) store.currentToolUseId = ev.toolUse.toolUseId;
      bus.publish({
        type: "agent_tool_call_start",
        agent: agentId,
        label,
        tool_name: ev.toolUse.name,
        tool_use_id: ev.toolUse.toolUseId,
        input: ev.toolUse.input,
      });
    } else if (ev?.type === "afterToolCallEvent" && ev.toolUse) {
      const store = runCtx.getStore();
      if (store) store.currentToolUseId = undefined;
      const errMsg = ev.error
        ? ev.error instanceof Error
          ? ev.error.message
          : (ev.error as { message?: string }).message ?? String(ev.error)
        : undefined;
      const result = (ev as unknown as { result?: { content?: Array<{ type?: string; text?: string; json?: unknown }> } }).result;
      const output = result?.content
        ?.map((c) => {
          if (c.type === "textBlock") return c.text ?? "";
          if (c.type === "jsonBlock") return JSON.stringify(c.json, null, 2);
          return "";
        })
        .filter((s) => s.length > 0)
        .join("\n");
      bus.publish({
        type: "agent_tool_call_end",
        agent: agentId,
        label,
        tool_name: ev.toolUse.name,
        tool_use_id: ev.toolUse.toolUseId,
        error: errMsg,
        output: output && output.length > 0 ? output : undefined,
      });
    }
  }
  } finally {
    flush();
  }
  return result;
  });
}

/**
 * Wrap a subagent Agent as a tool so it renders as its own SubagentGroup in
 * the frontend (with streamed thinking). Without this, the SDK's built-in
 * agent-as-tool wrapper calls the child silently, hiding its thinking.
 */
export function makeSubagentTool(opts: {
  name: string;
  description: string;
  makeAgent: () => Agent;
}) {
  return tool({
    name: opts.name,
    description: opts.description,
    inputSchema: z.object({
      prompt: z.string().describe("Natural-language instruction for the subagent."),
    }),
    callback: async ({ prompt }: { prompt: string }, ctx?: ToolCtx) => {
      const sig = getCancelSignal(ctx);
      const result = await invokeSubagent(opts.makeAgent(), opts.name, prompt, sig);
      return typeof result === "string"
        ? result
        : (result as { content?: string }).content ?? JSON.stringify(result);
    },
  });
}

async function invokeSubagent(agent: Agent, label: string, prompt: string, cancelSignal?: AbortSignal): Promise<unknown> {
  if (isCancelled(bus.getCurrentRunId())) throw new Error("RUN_CANCELLED");
  if (cancelSignal?.aborted) throw new Error("RUN_CANCELLED");
  const agentId = (agent as unknown as { id?: string }).id ?? "agent";
  const startedAt = Date.now();
  bus.publish({ type: "subagent_start", agent: agentId, label });
  try {
    const result = await streamAgentWithReasoning(agent, label, agentId, prompt, cancelSignal);
    bus.publish({ type: "subagent_end", agent: agentId, label, duration_ms: Date.now() - startedAt });
    return result;
  } catch (e) {
    bus.publish({
      type: "subagent_end",
      agent: agentId,
      label,
      duration_ms: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

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
export function makeTopicScoutManyTool(makeAgent: () => Agent) {
  return tool({
    name: "agents_topic_scout_many",
    description:
      "Run TopicScout concurrently across several transcripts. For each transcript, scouts `countPerTranscript` topics and returns the resulting .topic.json paths grouped by input transcript. Prefer over calling TopicScout sequentially.",
    inputSchema: z.object({
      transcripts: z.array(z.string()).min(1),
      countPerTranscript: z.number().min(1),
      maxSeconds: z.number().optional(),
      userPrompt: z.string().optional().describe("Original top-level user request; forwarded to each scout so downstream LLM calls see the broader intent."),
      concurrency: z.number().optional().describe("Max concurrent scouts. Default 4."),
    }),
    callback: async ({
      transcripts,
      countPerTranscript,
      maxSeconds,
      userPrompt,
      concurrency,
    }: {
      transcripts: string[];
      countPerTranscript: number;
      maxSeconds?: number;
      userPrompt?: string;
      concurrency?: number;
    }, ctx?: ToolCtx) => {
      const sig = getCancelSignal(ctx);
      const cap = Math.max(1, Math.min(concurrency ?? 4, 8));
      const maxHint = maxSeconds !== undefined ? ` maxSeconds=${maxSeconds}` : "";
      const userHint = userPrompt ? `\nUSER PROMPT (forward verbatim as userPrompt to transcript_to_topic for every topic): """${userPrompt}"""` : "";
      const runs = await pool(transcripts, cap, (t, i) =>
        invokeSubagent(
          makeAgent(),
          `topic_scout[${i + 1}/${transcripts.length}] ${t}`,
          `Scout ${countPerTranscript} topic(s) from this transcript: ${t}${maxHint}${userHint}`,
          sig,
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
export function makeSegmentScoutManyTool(makeAgent: () => Agent) {
  return tool({
    name: "agents_segment_scout_many",
    description:
      "Run SegmentScout concurrently across several transcripts. For each transcript, scouts `countPerTranscript` segments and returns the resulting .segment.json paths grouped by input transcript.",
    inputSchema: z.object({
      transcripts: z.array(z.string()).min(1),
      countPerTranscript: z.number().min(1),
      maxSeconds: z.number().optional(),
      userPrompt: z.string().optional().describe("Original top-level user request; forwarded to each scout."),
      concurrency: z.number().optional().describe("Max concurrent scouts. Default 4."),
    }),
    callback: async ({
      transcripts,
      countPerTranscript,
      maxSeconds,
      userPrompt,
      concurrency,
    }: {
      transcripts: string[];
      countPerTranscript: number;
      maxSeconds?: number;
      userPrompt?: string;
      concurrency?: number;
    }, ctx?: ToolCtx) => {
      const sig = getCancelSignal(ctx);
      const cap = Math.max(1, Math.min(concurrency ?? 4, 8));
      const maxHint = maxSeconds !== undefined ? ` maxSeconds=${maxSeconds}` : "";
      const userHint = userPrompt ? `\nUSER PROMPT (forward verbatim as userPrompt to transcript_find_segment for every segment): """${userPrompt}"""` : "";
      const runs = await pool(transcripts, cap, (t, i) =>
        invokeSubagent(
          makeAgent(),
          `segment_scout[${i + 1}/${transcripts.length}] ${t}`,
          `Scout ${countPerTranscript} segment(s) from this transcript: ${t}${maxHint}${userHint}`,
          sig,
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
export function makeTranscribeManyTool() {
  return tool({
    name: "transcribe_many",
    description:
      "Transcribe several source videos concurrently. Returns one .transcript.json path per input (or ERROR line), in input order. Prefer this over calling transcribe_source sequentially when you have >1 video.",
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
      const runs = await pool(sources, cap, (src) => transcribeSourceFn(src));
      return runs
        .map((r, i) => {
          if (r.status === "fulfilled") {
            return `[${i + 1}] ${sources[i]} → ${String(r.value).trim()}`;
          }
          return `[${i + 1}] ${sources[i]} → ERROR: ${r.reason}`;
        })
        .join("\n");
    },
  });
}

/**
 * Wraps a CompilationCreator agent as a fan-out tool that plans+renders
 * multiple .topic.json files concurrently via Promise.allSettled. Returns one
 * MP4 path per input topic, in input order. Discarded plans surface as
 * "DISCARDED: <reason>" lines.
 */
export function makePlanAndRenderManyTool(makeAgent: () => Agent) {
  return tool({
    name: "agents_plan_and_render_many",
    description:
      "Run the CompilationCreator concurrently across several .topic.json files. Given a list of topic paths, returns one final MP4 path (or DISCARDED line) per topic, in the same order. Use this instead of invoking agent_compilation_creator sequentially when you have multiple topics to produce.",
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
      userPrompt: z
        .string()
        .optional()
        .describe("Original top-level user request; forwarded to each creator so topic_to_compilation / compilation_refine see the broader intent."),
    }),
    callback: async ({
      topics,
      keepSilence,
      maxSeconds,
      bleep,
      bleepWords,
      userPrompt,
    }: {
      topics: string[];
      keepSilence?: boolean;
      maxSeconds?: number;
      bleep?: boolean;
      bleepWords?: string;
      userPrompt?: string;
    }, ctx?: ToolCtx) => {
      const sig = getCancelSignal(ctx);
      const silenceHint = keepSilence
        ? "\nThe top-level user explicitly asked to KEEP silence — skip the video_remove_silence step and return the raw compilation_render output path."
        : "";
      const silenceStrippedDownstream = !keepSilence;
      const silenceStrippedHint = silenceStrippedDownstream
        ? `\nSILENCE WILL BE STRIPPED after render. When calling topic_to_compilation or compilation_refine, ALWAYS pass silenceStripped=true — they'll apply a 30% discount when comparing current duration to maxSeconds, so you don't over-trim.`
        : `\nSILENCE WILL BE KEPT. Do NOT pass silenceStripped=true to topic_to_compilation / compilation_refine — raw clip sum is the real duration.`;
      const maxHint =
        maxSeconds !== undefined
          ? `\nMAX SECONDS: ${maxSeconds}. Pass maxSeconds=${maxSeconds} to topic_to_compilation${silenceStrippedDownstream ? ` AND silenceStripped=true` : ``}; if the plan is OVER_MAX, iterate with compilation_refine (up to 4×) passing the same flags until DURATION <= MAX. Render the latest version.`
          : "";
      const bleepHint = bleep || bleepWords
        ? `\nBLEEP: after silence-strip and before video_publish, call video_bleep on the silence-stripped MP4.${bleepWords ? ` Pass words="${bleepWords}".` : " Pass auto=true."} Then call video_publish on it.`
        : "";
      const userHint = userPrompt
        ? `\nUSER PROMPT (forward verbatim as userPrompt to topic_to_compilation and any compilation_refine calls): """${userPrompt}"""`
        : "";
      const runs = await pool(topics, 4, (topicPath, i) =>
        invokeSubagent(
          makeAgent(),
          `compilation[${i + 1}/${topics.length}] ${topicPath}`,
          `Produce the final MP4 for this topic: ${topicPath}${silenceHint}${silenceStrippedHint}${maxHint}${bleepHint}${userHint}`,
          sig,
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
 * Wraps a SegmentCreator agent as a fan-out tool that renders multiple
 * .segment.json files concurrently via Promise.allSettled.
 */
export function makePlanAndRenderSegmentsTool(makeAgent: () => Agent) {
  return tool({
    name: "agents_plan_and_render_segments",
    description:
      "Run the SegmentCreator concurrently across several .segment.json files. Given a list of segment paths, returns one final MP4 path (or DISCARDED line) per segment, in the same order.",
    inputSchema: z.object({
      segments: z
        .array(z.string())
        .min(1)
        .describe("List of .segment.json paths to render in parallel"),
      keepSilence: z.boolean().optional(),
      maxSeconds: z.number().optional(),
      bleep: z.boolean().optional(),
      bleepWords: z.string().optional(),
      userPrompt: z.string().optional().describe("Original top-level user request; forwarded to each creator."),
    }),
    callback: async ({
      segments,
      keepSilence,
      maxSeconds,
      bleep,
      bleepWords,
      userPrompt,
    }: {
      segments: string[];
      keepSilence?: boolean;
      maxSeconds?: number;
      bleep?: boolean;
      bleepWords?: string;
      userPrompt?: string;
    }, ctx?: ToolCtx) => {
      const sig = getCancelSignal(ctx);
      const silenceHint = keepSilence
        ? "\nThe top-level user explicitly asked to KEEP silence — skip video_remove_silence and return the raw segment_render output path."
        : "";
      const maxHint =
        maxSeconds !== undefined
          ? `\nHARD CEILING: ${maxSeconds} seconds. If the segment file indicates it's over (or a DISCARDED line is surfaced), your final answer is exactly the DISCARDED line.`
          : "";
      const bleepHint = bleep || bleepWords
        ? `\nBLEEP: after silence-strip and before video_publish, call video_bleep on the silence-stripped MP4.${bleepWords ? ` Pass words="${bleepWords}".` : " Pass auto=true."} Then call video_publish on it.`
        : "";
      const userHint = userPrompt
        ? `\nUSER PROMPT (top-level user request that motivated this segment): """${userPrompt}"""`
        : "";
      const runs = await pool(segments, 4, (segmentPath, i) =>
        invokeSubagent(
          makeAgent(),
          `segment[${i + 1}/${segments.length}] ${segmentPath}`,
          `Produce the final MP4 for this segment: ${segmentPath}${silenceHint}${maxHint}${bleepHint}${userHint}`,
          sig,
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
