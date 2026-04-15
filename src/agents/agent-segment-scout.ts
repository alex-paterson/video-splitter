import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import { transcriptFindSegment } from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";

export function makeSegmentScoutAgent() {
  return new Agent({
    id: "agent_segment_scout",
    name: "agent_segment_scout",
    description:
      "Given a transcript path and a desired count N, brainstorms N distinct standalone moments and produces one .segment.json per moment (via transcript_find_segment with count=1 and varied topic hints). Returns the list of .segment.json paths.",
    model: buildModel(),
    tools: [transcriptFindSegment, readFile],
    systemPrompt: `
${HARD_RULES}

You are the SegmentScout. You find N distinct, coherent standalone moments in a long recording and produce one .segment.json per moment.

Procedure:
1. read_file the transcript (cap with maxBytes if needed).
2. Brainstorm at least 2*N candidate moments (self-contained bits, punchlines, anecdotes). De-duplicate near-matches.
3. Pick the N most promising distinct moments.
4. For each chosen moment, call transcript_find_segment with:
   - the transcript path
   - count=1
   - a concise free-form 'topic' string that nudges toward that moment (e.g. "the Godot crash")
   - maxSeconds if the invocation mentioned a ceiling
   - output=<a unique .segment.json path next to the transcript, e.g. <base>.<slug>.segment.json>
5. If a call returns a DISCARDED line, drop that candidate and try a replacement if you still have unused ideas.
6. Return ONLY the list of saved .segment.json paths, one per line, as your final answer.
`.trim(),
  });
}
