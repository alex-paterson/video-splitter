import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { PROJECT_ROOT } from "./cli-tool.js";

const MEMORY_PATH = path.join(PROJECT_ROOT, ".memory.md");
const MAX_ENTRIES = 10;

function splitEntries(raw: string): string[] {
  return raw
    .split(/^---$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function appendMemoryEntry(summary: string): void {
  const ts = new Date().toISOString();
  const entry = `## ${ts}\n${summary.trim()}\n`;
  let existing = "";
  if (fs.existsSync(MEMORY_PATH)) existing = fs.readFileSync(MEMORY_PATH, "utf-8");
  const entries = splitEntries(existing);
  entries.push(entry);
  const kept = entries.slice(-MAX_ENTRIES);
  fs.writeFileSync(MEMORY_PATH, kept.join("\n---\n") + "\n");
}

export const memoryRead = tool({
  name: "memory_read",
  description:
    "Read the last-N run summaries from .memory.md (project-local, gitignored). Use at the START of a run to recall recent context.",
  inputSchema: z.object({}),
  callback: async () => {
    if (!fs.existsSync(MEMORY_PATH)) return "(no prior memory)";
    return fs.readFileSync(MEMORY_PATH, "utf-8");
  },
});

export const memoryAppend = tool({
  name: "memory_append",
  description:
    "Append a brief run summary to .memory.md and compact to the last 10 entries. Call this EXACTLY ONCE at the very end of every run, after all other work is finished. The summary should cover: what the user asked for, what was produced (paths), and anything notable (failures, assumptions, discarded ideas).",
  inputSchema: z.object({
    summary: z
      .string()
      .describe(
        "Short markdown summary (3-8 lines). Lead with a one-line title, then bullet points."
      ),
  }),
  callback: async ({ summary }: { summary: string }) => {
    appendMemoryEntry(summary);
    return "OK";
  },
});
