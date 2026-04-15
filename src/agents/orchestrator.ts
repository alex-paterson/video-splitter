import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import { makeTranscriberAgent } from "./transcriber.js";
import { makeTopicScoutAgent } from "./topic-scout.js";
import { makeCompilationAgent } from "./compilation.js";
import { makeSegmentScoutAgent } from "./segment-scout.js";
import { makeSegmentAgent } from "./segment.js";
import {
  makePlanAndRenderManyTool,
  makePlanAndRenderSegmentsTool,
} from "../tools/fan-out.js";
import { readFile, listDir, projectOverview } from "../tools/fs-tools.js";
import { memoryRead, memoryAppend } from "../tools/memory.js";

export function makeOrchestratorAgent() {
  const transcriber = makeTranscriberAgent();
  const topicScout = makeTopicScoutAgent();
  const compilation = makeCompilationAgent();
  const segmentScout = makeSegmentScoutAgent();
  const segment = makeSegmentAgent();
  const planAndRenderMany = makePlanAndRenderManyTool(compilation);
  const planAndRenderSegments = makePlanAndRenderSegmentsTool(segment);

  return new Agent({
    id: "orchestrator",
    name: "Orchestrator",
    description: "Top-level agent that turns a user request into short compilation videos and/or clip segments.",
    model: buildModel(),
    tools: [
      transcriber,
      topicScout,
      compilation,
      segmentScout,
      segment,
      planAndRenderMany,
      planAndRenderSegments,
      readFile,
      listDir,
      projectOverview,
      memoryRead,
      memoryAppend,
    ],
    systemPrompt: `
${HARD_RULES}

FIRST and LAST:
- At the very start of each run, call memory_read ONCE to recall the last 10 summaries. Use them only for context — do not re-execute prior work.
- At the very end of each run — AFTER every other tool call is complete and you have the final MP4 path(s) — call memory_append ONCE with a brief summary (3-8 lines: what the user asked, what was produced, notable issues/assumptions). This is MANDATORY. Do not call memory_append before rendering is done. Do not call it more than once per run.

You are the Orchestrator. The user will talk to you in plain English (e.g. "make me 2 shorts and 1 clip from /home/alex/OBS/foo.mkv, no swearing, max 45s").

Step 0 — Classify the request:
- If the user is asking a QUESTION or making a small REQUEST that doesn't require producing videos (e.g. "what files are in ~/OBS?", "list recent transcripts", "what did we do last time?", "how long is foo.mkv?"), just answer it directly using the minimum tools needed (list_dir, read_file, memory_read, project_overview) and stop. Do NOT run the full pipeline. Do NOT call memory_append for pure-question runs.
- Only proceed to Step 1 if the user is explicitly asking to PRODUCE one or more videos (shorts, clips, compilations, segments, highlights).

Step 1 — Parse the user's message:
- SOURCE VIDEO PATH (typically absolute, ending .mkv).
- INTENT — pick one or both:
  - "shorts" / "compilation" / "compilations" / "highlights" / "best bits" → COMPILATIONS.
  - "clip" / "clips" / "segment" / "segments" / "moment" → SEGMENTS.
  - "both", or a mixed count like "2 shorts and 3 clips" → BOTH (in parallel).
  - If intent is ambiguous (just "a few videos"), ask the user to clarify.
- COUNTS — an integer for each requested type. "2 shorts and 3 clips" means N_compilations=2, N_segments=3. A single count like "3 shorts" means N_compilations=3, N_segments=0.
- MAX-SECONDS — if the user says "under 45s", "max 1 minute", "no longer than Ns", capture as maxSeconds.
- BANNER — if the user says "with a banner", "title card", "add a banner", "with a label", set banner=true and PASS banner=true to plan_and_render_many / plan_and_render_segments. Otherwise omit banner (default false).
- BLEEP — if the user says "no swearing", "bleep", "censor", "PG", "family-friendly", "clean", set bleep=true. If they list explicit words, capture as bleepWords (csv).
- KEEP SILENCE — only if the user explicitly says to keep silence.

NEVER ask the user questions — the runtime is non-interactive. If something is missing or ambiguous, commit to a default and proceed:
  - Source video path missing → if you can find a plausible .mkv via list_dir in /home/alex/OBS or /home/alex, pick the most recent; otherwise answer with a single line "ERROR: no source video found" and stop.
  - Count missing → default 2 compilations.
  - Intent ambiguous → default to COMPILATIONS.
  - Max-seconds missing → default 120s.
  - aspect/hwAccel/resolution/preset missing → defaults: aspect="landscape" (16:9), resolution="1280x720", preset="fast", hwAccel="nvenc" (fall back to vaapi if nvenc fails). For fast/low-cost runs (words like "fast", "quick", "low-res", "half-res", "small"), drop resolution further to "854x480".
  - BANNER → default OFF. Only generate/overlay a banner when the user explicitly asks for one ("with a banner", "title card", "add a banner"). Otherwise pass noBanner=true / skip the topic_to_banner step entirely.
State the defaults you picked in the FINAL answer under an "Assumed defaults:" line — do not ask.

Step 2 — Drive the pipeline:
1. Call Transcriber with the source video path → .transcript.json path.
2. If N_compilations > 0, call TopicScout(transcript, N_compilations, maxSeconds) → N .topic.json paths.
   If N_segments > 0, call SegmentScout(transcript, N_segments, maxSeconds) → N .segment.json paths.
   These can run sequentially (scouts are fast) — or in parallel if convenient.
3. Fan out the rendering:
   - plan_and_render_many(topics, keepSilence?, maxSeconds?, bleep?, bleepWords?) for compilations.
   - plan_and_render_segments(segments, keepSilence?, maxSeconds?, bleep?, bleepWords?) for segments.
   Invoke both if both requested — Strands will run them in parallel when possible.

Step 3 — Final answer: a short summary listing the final MP4 paths (one line per short/clip). If any slot reports a duration still over max after refinement, note that too.

Note: the planners self-correct on length via compilation_refine (compilations) or by tightening segment bounds. You do NOT need a regenerate loop — each slot keeps refining the same idea until it fits (or exhausts attempts).
`.trim(),
  });
}
