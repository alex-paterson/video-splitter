#!/usr/bin/env tsx
/**
 * agent — Autonomous agent that makes short clips from a long stream recording.
 * Wraps every CLI tool in this repo as a strands tool, plus a few filesystem
 * read tools so it can inspect source, docs, transcripts, and plan JSON files.
 *
 * Usage: tsx src/agent.ts [options] <input>
 */

import "dotenv/config";
import { Agent, tool } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { Command } from "commander";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { z, ZodObject, ZodRawShape } from "zod";

const program = new Command();
program
  .name("agent")
  .description("Autonomous agent that produces short compilation videos from a stream recording")
  .argument("<input>", "Source video file (original MKV)")
  .option("--shorts <n>", "Number of shorts to produce", "3")
  .parse();

const opts = program.opts<{ shorts: string }>();
const [inputArg] = program.args;

// ---------------------------------------------------------------------------
// CLI tool factory — one spec per tool, converted to a strands tool uniformly
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));

type CliSpec<S extends ZodRawShape> = {
  name: string;
  description: string;
  script: string;                // path relative to project root
  positional: (keyof S & string)[]; // input keys that map to positional args (in order)
  boolFlags?: (keyof S & string)[];         // true → include `--flag` with no value
  negatedBoolFlags?: (keyof S & string)[];  // false → include `--no-flag`
  input: ZodObject<S>;
};

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

function runCli(script: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", path.join(PROJECT_ROOT, script), ...argv], {
      cwd: PROJECT_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderrTail = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      process.stderr.write(s);          // surface progress in real time
      stderrTail += s;
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const tail = stdout.length > 8000 ? stdout.slice(-8000) : stdout;
      if (code !== 0) {
        reject(new Error(`${script} exited ${code}\nstderr tail:\n${stderrTail}`));
      } else {
        resolve(tail || stderrTail.slice(-2000) || "(no output)");
      }
    });
  });
}

function cliTool<S extends ZodRawShape>(spec: CliSpec<S>) {
  const bools = new Set(spec.boolFlags ?? []);
  const negated = new Set(spec.negatedBoolFlags ?? []);
  const positional = new Set(spec.positional);

  return tool({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input,
    callback: async (input: z.infer<typeof spec.input>) => {
      const argv: string[] = [];
      const inRecord = input as Record<string, unknown>;

      // Positional args, in declared order
      for (const key of spec.positional) {
        const v = inRecord[key];
        if (v !== undefined && v !== null && v !== "") argv.push(String(v));
      }

      // Flag args
      for (const key of Object.keys(inRecord)) {
        if (positional.has(key)) continue;
        const v = inRecord[key];
        if (v === undefined || v === null || v === "") continue;

        const flag = "--" + camelToKebab(key);
        if (bools.has(key)) {
          if (v === true) argv.push(flag);
        } else if (negated.has(key)) {
          if (v === false) argv.push("--no-" + camelToKebab(key));
        } else {
          argv.push(flag, String(v));
        }
      }

      try {
        return await runCli(spec.script, argv);
      } catch (e: unknown) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Tool specs — one per CLI. Schemas are intentionally small: only the fields
// the agent is likely to set. Defaults in the CLIs cover the rest.
// ---------------------------------------------------------------------------

const videoToAudio = cliTool({
  name: "video_to_audio",
  description: "Extract a video's audio track to a 16kHz mono MP3 (written next to the source). Step 1 of the compilation pipeline.",
  script: "src/video-to-audio.ts",
  positional: ["input"],
  input: z.object({
    input: z.string().describe("Path to the source video (original MKV)"),
  }),
});

const audioToTranscript = cliTool({
  name: "audio_to_transcript",
  description: "Transcribe an MP3 with Whisper + multi-speaker diarization. Produces <base>.transcript.json. Step 2.",
  script: "src/audio-to-transcript.ts",
  positional: ["audio"],
  negatedBoolFlags: ["diarize"],
  boolFlags: ["resume"],
  input: z.object({
    audio: z.string().describe("Path to the .audio.mp3 produced by video_to_audio"),
    source: z.string().optional().describe("Original video path to record inside the transcript (recommended)"),
    chunkMinutes: z.number().optional().describe("Chunk size in minutes for API upload (default 10)"),
    language: z.string().optional().describe("ISO-639-1 language hint, e.g. 'en'"),
    speakers: z.number().optional().describe("Expected speaker count hint"),
    diarize: z.boolean().optional().describe("Set to false to skip diarization (single speaker)"),
    resume: z.boolean().optional().describe("Resume a partially written transcript"),
  }),
});

const transcriptToTopic = cliTool({
  name: "transcript_to_topic",
  description: "Use Claude to derive a focused narrative/story for a given topic from a transcript. Writes <base>.<slug>.topic.json. Call multiple times with different topics to explore ideas.",
  script: "src/transcript-to-topic.ts",
  positional: ["transcript"],
  input: z.object({
    transcript: z.string().describe("Path to .transcript.json"),
    topic: z.string().describe("Free-form topic/theme to derive a story for (required)"),
    output: z.string().optional().describe("Override output path (default: <base>.<slug>.topic.json)"),
  }),
});

const topicToCompilation = cliTool({
  name: "topic_to_compilation",
  description: "Given a .topic.json, filter the referenced transcript line-by-line and save a .compilation.json plan (no rendering yet). Review this plan before rendering.",
  script: "src/topic-to-compilation.ts",
  positional: ["topic"],
  input: z.object({
    topic: z.string().describe("Path to .topic.json"),
    transcript: z.string().optional().describe("Override transcript path"),
    source: z.string().optional().describe("Override source video path"),
    output: z.string().optional().describe("Override output path"),
  }),
});

const compilationRender = cliTool({
  name: "compilation_render",
  description: "Render a .compilation.json plan to a single 9:16 portrait MP4 (default). Final step — only run after reviewing the plan.",
  script: "src/compilation-render.ts",
  positional: ["compilation"],
  input: z.object({
    compilation: z.string().describe("Path to .compilation.json"),
    source: z.string().optional().describe("Override source video path (must be the ORIGINAL MKV)"),
    aspect: z.string().optional().describe("Aspect ratio preset or W:H (default 9:16)"),
    output: z.string().optional().describe("Override output path"),
  }),
});

const transcriptFindSegment = cliTool({
  name: "transcript_find_segment",
  description: "Use Claude to find a single coherent standalone segment in a transcript → .segment.json.",
  script: "src/transcript-find-segment.ts",
  positional: ["transcript"],
  input: z.object({
    transcript: z.string(),
    duration: z.number().optional().describe("Target segment duration in seconds (default 60)"),
    tolerance: z.number().optional(),
    topic: z.string().optional(),
    speaker: z.string().optional(),
    count: z.number().optional(),
    output: z.string().optional().describe("Write .segment.json here (default: stdout)"),
  }),
});

const segmentRender = cliTool({
  name: "segment_render",
  description: "Render a single .segment.json to a cropped/reframed video clip.",
  script: "src/segment-render.ts",
  positional: ["input", "segment"],
  input: z.object({
    input: z.string().describe("Source video (original MKV)"),
    segment: z.string().describe("Path to .segment.json"),
    aspect: z.string().optional(),
    output: z.string().optional(),
  }),
});

const transcriptToDistillationPlan = cliTool({
  name: "transcript_to_distillation_plan",
  description: "Plan a whole-session narrative distillation → .distillation.json (keep intervals + summary). Used for reference viewing; not for compilations.",
  script: "src/transcript-to-distillation-plan.ts",
  positional: ["transcript"],
  input: z.object({
    transcript: z.string(),
    targetMinutes: z.number().optional(),
    focus: z.string().optional(),
    output: z.string().optional(),
  }),
});

const distillationRender = cliTool({
  name: "distillation_render",
  description: "Render a .distillation.json plan to a condensed video.",
  script: "src/distillation-render.ts",
  positional: ["distillation"],
  input: z.object({
    distillation: z.string(),
    source: z.string().optional(),
    output: z.string().optional(),
  }),
});

const videoRemoveSilence = cliTool({
  name: "video_remove_silence",
  description: "Remove silent intervals from a video. Use --reencode on short MP4 clips (e.g. rendered segments/compilations) to avoid audible audio repeats.",
  script: "src/video-remove-silence.ts",
  positional: ["input", "output"],
  boolFlags: ["preview", "reencode"],
  input: z.object({
    input: z.string(),
    output: z.string().optional(),
    noiseDb: z.number().optional().describe("Silence threshold in dBFS (default -35)"),
    minSilence: z.number().optional(),
    pad: z.number().optional(),
    preview: z.boolean().optional(),
    reencode: z.boolean().optional().describe("Frame-accurate re-encode — use on short MP4s"),
  }),
});

// ---------------------------------------------------------------------------
// Filesystem read tools — inspect source, docs, transcripts, plans
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 200_000;

const readFile = tool({
  name: "read_file",
  description: "Read a text file from disk. Use for inspecting transcripts, .topic.json, .compilation.json, source code, README/CLAUDE.md/SPEC.md, etc. Paths may be absolute or relative to the project root.",
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
      const truncated = stat.size > buf.length ? `\n[... truncated, file is ${stat.size} bytes]` : "";
      return buf.toString("utf-8") + truncated;
    } finally {
      fs.closeSync(fd);
    }
  },
});

const listDir = tool({
  name: "list_dir",
  description: "List entries in a directory with size and type. Use to discover transcripts, plans, rendered videos next to a source file.",
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
      try { size = e.isFile() ? String(fs.statSync(full).size) : ""; } catch {}
      return `${kind}  ${size.padStart(12)}  ${e.name}`;
    });
    return `${abs}\n` + rows.join("\n");
  },
});

const projectOverview = tool({
  name: "project_overview",
  description: "Return the list of CLI scripts in src/ and key docs (CLAUDE.md, README.md, BACKLOG.md). Call this first if you need to orient yourself.",
  inputSchema: z.object({}),
  callback: () => {
    const srcDir = path.join(PROJECT_ROOT, "src");
    const libDir = path.join(PROJECT_ROOT, "lib");
    const scripts = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort();
    const libs = fs.existsSync(libDir) ? fs.readdirSync(libDir).filter((f) => f.endsWith(".ts")).sort() : [];
    const docs = ["CLAUDE.md", "README.md", "BACKLOG.md", "SPEC.md"]
      .filter((f) => fs.existsSync(path.join(PROJECT_ROOT, f)));
    return [
      `project root: ${PROJECT_ROOT}`,
      `src/:\n  ${scripts.join("\n  ")}`,
      `lib/:\n  ${libs.join("\n  ")}`,
      `docs: ${docs.join(", ")}`,
    ].join("\n\n");
  },
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(inputArg)) {
    console.error(`Error: input video not found: ${inputArg}`);
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY not set");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY not set (required by transcript-to-topic and friends)");
    process.exit(1);
  }

  const absInput = path.resolve(inputArg);
  const shorts = parseInt(opts.shorts);

  const model = new OpenAIModel({ api: "chat" });

  const agent = new Agent({
    model,
    tools: [
      videoToAudio,
      audioToTranscript,
      transcriptToTopic,
      topicToCompilation,
      compilationRender,
      transcriptFindSegment,
      segmentRender,
      transcriptToDistillationPlan,
      distillationRender,
      videoRemoveSilence,
      readFile,
      listDir,
      projectOverview,
    ],
    systemPrompt: `
You are the world's most skilled editor at turning long game-dev stream recordings into short, punchy social videos.

You have tools that wrap every CLI in this repo plus filesystem read tools. Use them to orient yourself (project_overview, read_file CLAUDE.md) before acting.

HARD RULES:
- Always operate on the ORIGINAL source video (the MKV the user points you at). NEVER transcribe or render from a .distilled.* or .cut.* derivative — timestamps won't match.
- The compilation pipeline is: video_to_audio → audio_to_transcript → transcript_to_topic → topic_to_compilation → compilation_render. Follow it in order.
- After topic_to_compilation, read the resulting .compilation.json with read_file and sanity-check it (coverage, ordering, obvious clunkers) BEFORE calling compilation_render. Revise the topic or re-run if the plan is bad.
- To explore ideas, call transcript_to_topic multiple times with different topics and pick the best ones. Discard duplicates.
- Stop when you have produced ${shorts} rendered compilation MP4 file(s).

Output: at the end, list the paths of the final compilation videos.
`,
  });

  console.log(`Agent: producing ${shorts} short(s) from ${absInput}\n`);
  for await (const event of agent.stream(
    `Produce ${shorts} distinct short compilation video(s) from this source recording: ${absInput}`
  )) {
    console.log("[Event]", event.type);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
