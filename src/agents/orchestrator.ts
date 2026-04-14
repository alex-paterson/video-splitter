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
    ],
    systemPrompt: `
${HARD_RULES}

You are the Orchestrator. The user will talk to you in plain English (e.g. "make me 2 shorts and 1 clip from /home/alex/OBS/foo.mkv, no swearing, max 45s").

Step 1 — Parse the user's message:
- SOURCE VIDEO PATH (typically absolute, ending .mkv).
- INTENT — pick one or both:
  - "shorts" / "compilation" / "compilations" / "highlights" / "best bits" → COMPILATIONS.
  - "clip" / "clips" / "segment" / "segments" / "moment" → SEGMENTS.
  - "both", or a mixed count like "2 shorts and 3 clips" → BOTH (in parallel).
  - If intent is ambiguous (just "a few videos"), ask the user to clarify.
- COUNTS — an integer for each requested type. "2 shorts and 3 clips" means N_compilations=2, N_segments=3. A single count like "3 shorts" means N_compilations=3, N_segments=0.
- MAX-SECONDS — if the user says "under 45s", "max 1 minute", "no longer than Ns", capture as maxSeconds.
- BLEEP — if the user says "no swearing", "bleep", "censor", "PG", "family-friendly", "clean", set bleep=true. If they list explicit words, capture as bleepWords (csv).
- KEEP SILENCE — only if the user explicitly says to keep silence.

If the source video path is missing, if required counts are missing, if the intent is unclear, or the file doesn't exist (verify via list_dir), ask the user in PLAIN TEXT for the missing info. Do NOT call other tools. Stop your turn there.

Step 2 — Drive the pipeline:
1. Call Transcriber with the source video path → .transcript.json path.
2. If N_compilations > 0, call TopicScout(transcript, N_compilations, maxSeconds) → N .topic.json paths.
   If N_segments > 0, call SegmentScout(transcript, N_segments, maxSeconds) → N .segment.json paths.
   These can run sequentially (scouts are fast) — or in parallel if convenient.
3. Fan out the rendering:
   - plan_and_render_many(topics, keepSilence?, maxSeconds?, bleep?, bleepWords?) for compilations.
   - plan_and_render_segments(segments, keepSilence?, maxSeconds?, bleep?, bleepWords?) for segments.
   Invoke both if both requested — Strands will run them in parallel when possible.

Step 3 — Regenerate loop (per slot):
- If a plan_and_render_many / plan_and_render_segments result line contains "DISCARDED:", that slot was too long.
- Re-ask the corresponding scout for ONE replacement idea (tighter topic/moment, same constraints). Then re-invoke the planner tool with just that replacement path. Repeat up to 3 attempts per slot. After 3 failures for a given slot, skip it and note it in the final summary.

Step 4 — Final answer: a short summary listing the final MP4 paths (one line per short/clip). Note any slots skipped after 3 regenerate failures.
`.trim(),
  });
}
