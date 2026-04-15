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

export const stageSources = tool({
  name: "stage_sources",
  description:
    "Copy one OR MORE source videos into tmp/ (the run workspace) if they aren't already there. Accepts an array of absolute paths; returns a newline-separated list of the corresponding tmp/ paths. Call this ONCE at the start of every run, even for a single source, so all downstream artifacts (.transcript.json, .topic.json, .compilation.json, rendered MP4s) land in tmp/. out/ is reserved for the final publishable video(s).",
  inputSchema: z.object({
    sources: z.array(z.string()).min(1).describe("Absolute paths to source video files"),
  }),
  callback: ({ sources }: { sources: string[] }) => {
    const outDir = path.join(PROJECT_ROOT, "tmp");
    fs.mkdirSync(outDir, { recursive: true });
    const results: string[] = [];
    for (const src of sources) {
      const abs = path.isAbsolute(src) ? src : path.join(PROJECT_ROOT, src);
      if (!fs.existsSync(abs)) {
        results.push(`ERROR: not found: ${abs}`);
        continue;
      }
      const dest = path.join(outDir, path.basename(abs));
      if (path.resolve(abs) !== path.resolve(dest) && !fs.existsSync(dest)) {
        fs.copyFileSync(abs, dest);
      }
      results.push(dest);
    }
    return results.join("\n");
  },
});

export const stageSource = tool({
  name: "stage_source",
  description:
    "Copy a source video into tmp/ (the run workspace) if it isn't already there. Returns the absolute path inside tmp/. Call this for EVERY source video before transcribing/rendering — all downstream artifacts (.transcript.json, .topic.json, .compilation.json, rendered MP4s) will then land in tmp/ alongside it. out/ is reserved for final publishable videos.",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the source video file"),
  }),
  callback: ({ path: p }: { path: string }) => {
    const abs = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
    if (!fs.existsSync(abs)) return `ERROR: not found: ${abs}`;
    const outDir = path.join(PROJECT_ROOT, "tmp");
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(abs);
    const dest = path.join(outDir, base);
    if (path.resolve(abs) === path.resolve(dest)) return dest;
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(abs, dest);
    }
    return dest;
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
