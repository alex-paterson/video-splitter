import { tool } from "@strands-agents/sdk";
import path from "path";
import fs from "fs";
import { z } from "zod";
import { PROJECT_ROOT } from "./cli-tool.js";

const MAX_READ_BYTES = 200_000;

export const readFile = tool({
  name: "read_file",
  description:
    "Read a text file from disk. Use for inspecting transcripts, .topic.json, .compilation.json, source code, README/CLAUDE.md/SPEC.md, etc. Paths may be absolute or relative to the project root.",
  inputSchema: z.object({
    path: z.string().describe("File path (absolute or relative to the project root)"),
    maxBytes: z.number().optional().describe(`Cap bytes read (default ${MAX_READ_BYTES})`),
  }),
  callback: ({ path: p, maxBytes }: { path: string; maxBytes?: number }) => {
    const abs = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
    if (!fs.existsSync(abs)) return `ERROR: not found: ${abs}`;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return `ERROR: is a directory: ${abs}`;
    const cap = maxBytes ?? MAX_READ_BYTES;
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(Math.min(cap, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const truncated =
        stat.size > buf.length ? `\n[... truncated, file is ${stat.size} bytes]` : "";
      return buf.toString("utf-8") + truncated;
    } finally {
      fs.closeSync(fd);
    }
  },
});

export const listDir = tool({
  name: "list_dir",
  description:
    "List entries in a directory with size and type. Use to discover transcripts, plans, rendered videos next to a source file.",
  inputSchema: z.object({
    path: z.string().describe("Directory path (absolute or relative to project root)"),
  }),
  callback: ({ path: p }: { path: string }) => {
    const abs = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
    if (!fs.existsSync(abs)) return `ERROR: not found: ${abs}`;
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const rows = entries.map((e) => {
      const full = path.join(abs, e.name);
      const kind = e.isDirectory() ? "dir " : "file";
      let size = "";
      try {
        size = e.isFile() ? String(fs.statSync(full).size) : "";
      } catch {}
      return `${kind}  ${size.padStart(12)}  ${e.name}`;
    });
    return `${abs}\n` + rows.join("\n");
  },
});

export const projectOverview = tool({
  name: "project_overview",
  description:
    "Return the list of CLI scripts in src/commands/ and key docs (CLAUDE.md, README.md, BACKLOG.md). Call this first if you need to orient yourself.",
  inputSchema: z.object({}),
  callback: () => {
    const cmdDir = path.join(PROJECT_ROOT, "src", "commands");
    const libDir = path.join(PROJECT_ROOT, "lib");
    const scripts = fs.readdirSync(cmdDir).filter((f) => f.endsWith(".ts")).sort();
    const libs = fs.existsSync(libDir)
      ? fs.readdirSync(libDir).filter((f) => f.endsWith(".ts")).sort()
      : [];
    const docs = ["CLAUDE.md", "README.md", "BACKLOG.md", "SPEC.md"].filter((f) =>
      fs.existsSync(path.join(PROJECT_ROOT, f))
    );
    return [
      `project root: ${PROJECT_ROOT}`,
      `src/commands/:\n  ${scripts.join("\n  ")}`,
      `lib/:\n  ${libs.join("\n  ")}`,
      `docs: ${docs.join(", ")}`,
    ].join("\n\n");
  },
});
