import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { PROJECT_ROOT } from "./cli-tool.js";

const TMP_DIR = path.join(PROJECT_ROOT, "tmp");
const MEMORY_PATH = path.join(TMP_DIR, "memory.md");
const MEMORY_DEBUG_PATH = path.join(TMP_DIR, "memory.debug.md");
const MAX_ENTRIES = 10;
const MAX_DEBUG_ENTRIES = 10;

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

export function appendDebugMemoryEntry(body: string): void {
  const ts = new Date().toISOString();
  const entry = `## ${ts}\n${body.trim()}\n`;
  let existing = "";
  if (fs.existsSync(MEMORY_DEBUG_PATH)) existing = fs.readFileSync(MEMORY_DEBUG_PATH, "utf-8");
  const entries = splitEntries(existing);
  entries.push(entry);
  const kept = entries.slice(-MAX_DEBUG_ENTRIES);
  const header =
    "# memory.debug — tool-chain + reasoning trace per run. The agent IGNORES this file; it's for humans.\n\n";
  fs.writeFileSync(MEMORY_DEBUG_PATH, header + kept.join("\n---\n") + "\n");
}

export const memoryRead = tool({
  name: "memory_read",
  description:
    "Read the last-N run summaries from tmp/memory.md. Use at the START of a run to recall recent context.",
  inputSchema: z.object({}),
  callback: async () => {
    if (!fs.existsSync(MEMORY_PATH)) return "(no prior memory)";
    return fs.readFileSync(MEMORY_PATH, "utf-8");
  },
});

export const memoryAppend = tool({
  name: "memory_append",
  description:
    "Append a brief run summary to tmp/memory.md and compact to the last 10 entries. Call this EXACTLY ONCE at the very end of every run, after all other work is finished. The summary should cover: what the user asked for, what was produced (paths), and anything notable (failures, assumptions, discarded ideas). You MUST also pass the `files` list — every file the run modified or generated, each with a short reason (e.g. 'final published MP4', 'compilation sidecar', 'reframe plan').",
  inputSchema: z.object({
    summary: z
      .string()
      .describe(
        "Short markdown summary (3-8 lines). Lead with a one-line title, then bullet points."
      ),
    files: z
      .array(
        z.object({
          path: z.string().describe("Absolute path to a file the run modified or generated."),
          reason: z
            .string()
            .describe("Why the file was written (e.g. 'final published MP4', 'scouted topic', 'caption sidecar v2')."),
        })
      )
      .describe(
        "Every file the run modified or generated. Include final published MP4s (out/*.mp4), all sidecars the run produced in tmp/ (.topic.json, .compilation.json, .segment.json, .caption.json, .framer.filtered.json, .banner.png, .words.json, .scenes.json), and any transcripts that were regenerated. Omit read-only lookups. For a content-question run with no writes, pass []."
      ),
  }),
  callback: async ({ summary, files }: { summary: string; files: Array<{ path: string; reason: string }> }) => {
    const filesBlock = files.length
      ? "\n\n**Files modified/generated:**\n" +
        files.map((f) => `- \`${f.path}\` — ${f.reason}`).join("\n")
      : "";
    appendMemoryEntry(summary + filesBlock);
    return "OK";
  },
});
