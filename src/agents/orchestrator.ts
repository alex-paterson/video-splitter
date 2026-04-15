import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import { makeTopicScoutAgent } from "./agent-topic-scout.js";
import { makeCompilationCreatorAgent } from "./agent-compilation-creator.js";
import { makeSegmentScoutAgent } from "./agent-segment-scout.js";
import { makeSegmentCreatorAgent } from "./agent-segment-creator.js";
import {
  makePlanAndRenderManyTool,
  makePlanAndRenderSegmentsTool,
  makeTranscribeManyTool,
  makeTopicScoutManyTool,
  makeSegmentScoutManyTool,
  makeSubagentTool,
} from "../tools/fan-out.js";
import { readFile, listDir, projectOverview, stageSource, stageSources } from "../tools/fs-tools.js";
import { transcribeSource } from "../tools/commands.js";
import { memoryRead, memoryAppend } from "../tools/memory.js";

export function makeOrchestratorAgent() {
  const topicScout = makeSubagentTool({
    name: "agent_topic_scout",
    description: "Scout N topics from ONE .transcript.json. Input: natural-language prompt with transcript path, count, and optional maxSeconds. Returns one .topic.json path per topic.",
    makeAgent: makeTopicScoutAgent,
  });
  const compilation = makeSubagentTool({
    name: "agent_compilation_creator",
    description: "Plan, render, and silence-strip ONE compilation from a .topic.json, or refine an existing .compilation.json. Input: natural-language prompt. Returns the final MP4 path.",
    makeAgent: makeCompilationCreatorAgent,
  });
  const segmentScout = makeSubagentTool({
    name: "agent_segment_scout",
    description: "Scout N standalone segments from ONE .transcript.json. Input: natural-language prompt with transcript path, count, and optional maxSeconds. Returns .segment.json paths.",
    makeAgent: makeSegmentScoutAgent,
  });
  const segment = makeSubagentTool({
    name: "agent_segment_creator",
    description: "Render and silence-strip ONE segment from a .segment.json. Input: natural-language prompt. Returns the final MP4 path.",
    makeAgent: makeSegmentCreatorAgent,
  });
  const planAndRenderMany = makePlanAndRenderManyTool(makeCompilationCreatorAgent);
  const planAndRenderSegments = makePlanAndRenderSegmentsTool(makeSegmentCreatorAgent);
  const transcribeMany = makeTranscribeManyTool();
  const topicScoutMany = makeTopicScoutManyTool(makeTopicScoutAgent);
  const segmentScoutMany = makeSegmentScoutManyTool(makeSegmentScoutAgent);

  return new Agent({
    id: "orchestrator",
    name: "Orchestrator",
    description: "Top-level agent that turns a user request into short compilation videos and/or clip segments.",
    model: buildModel(),
    tools: [
      transcribeSource,
      topicScout,
      compilation,
      segmentScout,
      segment,
      planAndRenderMany,
      planAndRenderSegments,
      transcribeMany,
      topicScoutMany,
      segmentScoutMany,
      readFile,
      listDir,
      projectOverview,
      stageSource,
      stageSources,
      memoryRead,
      memoryAppend,
    ],
    systemPrompt: `
${HARD_RULES}

FIRST and LAST:
- At the very start of each run, call memory_read ONCE to recall the last 10 summaries. Use them only for context — do not re-execute prior work.
- At the very end of EVERY run, call memory_append ONCE with a brief summary (3-8 lines). This is MANDATORY and unconditional — call it whether the run succeeded, partially succeeded, was cancelled, or failed outright. Memory is the agent's persistent knowledge of the conversation, so a failed run is just as important to record as a successful one. Do not call memory_append more than once per run, and call it as the very last action.
  - On SUCCESS: what the user asked, the final MP4 path(s) produced, notable assumptions/defaults. For any compilation produced, ALSO record the final .compilation[.N].json path — a future run may ask to modify/refine that compilation and needs the JSON path to do so.
  - On PARTIAL: what the user asked, what was produced vs. what was skipped, why some slots failed.
  - On FAILURE: what the user asked, what was attempted, where it broke (which tool, which input), the error message, and any defaults you committed to. Don't editorialise — record what you observed so a future run can avoid the same dead end.

You are the Orchestrator. The user will talk to you in plain English (e.g. "make me 2 shorts and 1 clip from /home/alex/OBS/foo.mkv, no swearing, max 45s").

Step 0 — Classify the request:
- PURE-METADATA questions (file listings, durations, memory recall — things answerable without video content): use list_dir / read_file / memory_read / project_overview and stop. Do NOT transcribe. Do NOT call memory_append.
- CONTENT questions that require knowing what's SAID or SHOWN in the video(s) — e.g. "summarize these mkvs", "what's in foo.mkv", "what topics does this recording cover", "give me an overview", "list the interesting moments", "what did we talk about" — DO require transcription. Transcribe the relevant MKVs (use transcribe_many if 2+, otherwise transcribe_source), then read_file each .transcript.json and write the summary/overview directly in your final answer. You are NOT forbidden from transcribing just because no clips are requested — transcription is how you see the content. Skip Steps 1-3 (no scouting, no rendering). You MAY still call memory_append with a short summary of what you found, but it is optional for content-questions (unlike video-production runs, which require it).
- MODIFY-EXISTING-COMPILATION requests — cues: "remove the part where…", "cut out…", "drop the clip about…", "tweak/edit/modify the compilation/short you just made", "shorter version of the last one", "redo the previous compilation but …". DO NOT transcribe or topic-scout — the compilation JSON already has the clips. Instead:
  1. Locate the prior .compilation[.N].json:
     - If the user's message includes a path ending in .compilation.json or .compilation.N.json, use it directly.
     - Else call memory_read and find the most recently recorded .compilation[.N].json path.
     - Else list_dir /home/alex/OBS (or the dir the user hints at) and pick the newest *.compilation*.json. If several candidates tie and the user's wording doesn't disambiguate, pick the most recently modified.
     - If none found, answer "ERROR: no prior .compilation.json found — can't refine." and stop.
  2. Invoke the CompilationCreator (agent_compilation_creator) ONCE with a prompt like:
       "Refine-existing mode. Compilation JSON: <path>. User instruction: <verbatim user text>. Render, silence-strip, return the new MP4 path."
     Pass maxSeconds only if the user explicitly specified one.
  3. In the final answer, list the new MP4 path and the new .compilation[.N].json path. Record both in memory_append.
- Only proceed to Step 1 if the user is explicitly asking to PRODUCE one or more NEW videos from source(s) (shorts, clips, compilations, segments, highlights) — i.e. not a modification of an existing one.

Step 1 — Parse the user's message:
- SOURCE VIDEO PATH (typically absolute, ending .mkv).
- INTENT — pick one or both:
  - "shorts" / "compilation" / "compilations" / "highlights" / "best bits" → COMPILATIONS.
  - "clip" / "clips" / "segment" / "segments" / "moment" → SEGMENTS.
  - "both", or a mixed count like "2 shorts and 3 clips" → BOTH (in parallel).
  - If intent is ambiguous (just "a few videos"), ask the user to clarify.
- COUNTS — an integer for each requested type. "2 shorts and 3 clips" means N_compilations=2, N_segments=3. A single count like "3 shorts" means N_compilations=3, N_segments=0.
- MAX-SECONDS — if the user says "under 45s", "max 1 minute", "no longer than Ns", capture as maxSeconds.
- BANNER — if the user says "with a banner", "title card", "add a banner", "with a label", set banner=true and PASS banner=true to agents_plan_and_render_many / agents_plan_and_render_segments. Otherwise omit banner (default false).
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
0. STAGE every source video into tmp/ FIRST — this step is MANDATORY for every production run (any run that will transcribe, scout, or render). Call stage_sources(sources=[...all resolved source paths...]) EXACTLY ONCE with the full list, even if there is only one source. Use the returned tmp/*.mkv paths everywhere downstream (transcribe, scout, render). Never pass a non-tmp/ path to transcribe_source / transcribe_many or any fan-out tool. tmp/ is the scratch workspace — transcripts, audio, topic/compilation/segment JSONs, and intermediate renders all live there. out/ is reserved for the FINAL publishable videos. Publishing is explicit: after all editing is done (render, silence-strip, optional bleep, optional refinement), the subagent must call video_publish on the final MP4 — that is the ONLY thing that writes to out/. No other tool does. If stage_sources is skipped, artifacts will land in the wrong directory and the run is broken — so do not skip.
1. Transcribe source(s):
     - With exactly ONE source video, call transcribe_source(source=<out/*.mkv>).
     - With 2 OR MORE source videos, you MUST call transcribe_many(sources=[...all paths...]) ONCE with the full list. DO NOT loop and call transcribe_source sequentially — that is strictly slower and wastes time.
2. If N_compilations > 0:
     - With ONE transcript, call TopicScout(transcript, N_compilations, maxSeconds) → N .topic.json paths.
     - With 2+ transcripts, call agents_topic_scout_many(transcripts, countPerTranscript=N_compilations, maxSeconds) → one group of .topic.json paths per transcript.
   If N_segments > 0:
     - With ONE transcript, call SegmentScout(transcript, N_segments, maxSeconds).
     - With 2+ transcripts, call agents_segment_scout_many(transcripts, countPerTranscript=N_segments, maxSeconds).
3. Fan out the rendering:
   - agents_plan_and_render_many(topics, keepSilence?, maxSeconds?, bleep?, bleepWords?) for compilations.
   - agents_plan_and_render_segments(segments, keepSilence?, maxSeconds?, bleep?, bleepWords?) for segments.
   Invoke both if both requested — Strands will run them in parallel when possible.

Step 3 — Final answer: a short summary listing the final MP4 paths (one line per short/clip). If any slot reports a duration still over max after refinement, note that too.

Note: the planners self-correct on length via compilation_refine (compilations) or by tightening segment bounds. You do NOT need a regenerate loop — each slot keeps refining the same idea until it fits (or exhausts attempts).
`.trim(),
  });
}
