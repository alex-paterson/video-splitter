import { tool } from "@strands-agents/sdk";
import { spawn } from "child_process";
import path from "path";
import { z, ZodObject, ZodRawShape } from "zod";
import { bus } from "../lib/event-bus.js";

export const PROJECT_ROOT = path.resolve(
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..")
);

export type CliSpec<S extends ZodRawShape> = {
  name: string;
  description: string;
  script: string;
  positional: (keyof S & string)[];
  boolFlags?: (keyof S & string)[];
  negatedBoolFlags?: (keyof S & string)[];
  input: ZodObject<S>;
};

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

export function runCli(script: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    bus.publish({ type: "tool_start", script, argv });
    const proc = spawn("npx", ["tsx", path.join(PROJECT_ROOT, script), ...argv], {
      cwd: PROJECT_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderrTail = "";
    let lineBuf = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      process.stderr.write(s);
      // Raw per-line event emission (don't filter progress bars here — frontend can).
      lineBuf += s;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        bus.publish({ type: "tool_output_line", script, line });
      }
      const cleaned = s
        .split("\n")
        .filter((line) => !/\[[█░▏▎▍▌▋▊▉ ]+\]\s*\d+(\.\d+)?\s*%/.test(line))
        .filter((line) => !/^\s*frame=\s*\d+/.test(line))
        .join("\n");
      stderrTail += cleaned;
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });
    proc.on("error", (err) => {
      bus.publish({ type: "error", script, message: String(err) });
      reject(err);
    });
    proc.on("close", (code) => {
      if (lineBuf.length > 0) {
        bus.publish({ type: "tool_output_line", script, line: lineBuf });
        lineBuf = "";
      }
      const duration_ms = Date.now() - startedAt;
      bus.publish({ type: "tool_end", script, code, duration_ms });
      const tail = stdout.length > 8000 ? stdout.slice(-8000) : stdout;
      if (code !== 0) {
        reject(new Error(`${script} exited ${code}\nstderr tail:\n${stderrTail}`));
      } else {
        resolve(tail || stderrTail.slice(-2000) || "(no output)");
      }
    });
  });
}

export function cliTool<S extends ZodRawShape>(spec: CliSpec<S>) {
  const bools = new Set<string>(spec.boolFlags ?? []);
  const negated = new Set<string>(spec.negatedBoolFlags ?? []);
  const positional = new Set<string>(spec.positional);

  return tool({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input,
    callback: async (input: z.infer<typeof spec.input>) => {
      const argv: string[] = [];
      const rec = input as Record<string, unknown>;

      for (const key of spec.positional) {
        const v = rec[key];
        if (v !== undefined && v !== null && v !== "") argv.push(String(v));
      }

      for (const key of Object.keys(rec)) {
        if (positional.has(key)) continue;
        const v = rec[key];
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
