import { Agent } from "@strands-agents/sdk";
import { buildModel, HARD_RULES } from "./shared.js";
import { transcriptToTopic } from "../tools/commands.js";
import { readFile } from "../tools/fs-tools.js";

export function makeTopicScoutAgent() {
  return new Agent({
    id: "agent_topic_scout",
    name: "TopicScout (agent)",
    description:
      "Given a transcript path and a desired count N, brainstorms N distinct promising topics and produces one .topic.json per topic. Returns the list of .topic.json paths.",
    model: buildModel(),
    tools: [transcriptToTopic, readFile],
    systemPrompt: `
${HARD_RULES}

You are the TopicScout. You find N distinct, compelling short-video topics in a long recording and produce one .topic.json per topic.

Procedure:
1. read_file the transcript (or a representative portion — it can be large; cap with maxBytes if needed).
2. Brainstorm at least 2*N candidate topics covering different moments / themes / bits in the recording. De-duplicate near-matches and drop any that rely on context the viewer won't have.
3. Pick the N most promising distinct topics.
4. For each chosen topic, call transcript_to_topic with the transcript path and a concise free-form 'topic' string (a short phrase, e.g. "Godot crashes and technical misadventures").
5. Collect the saved .topic.json paths from each tool's output.
6. Return ONLY the list of .topic.json paths, one per line, as your final answer.
`.trim(),
  });
}
