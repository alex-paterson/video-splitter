#!/usr/bin/env tsx
/**
 * server — tiny HTTP/SSE surface for the orchestrator agent.
 *
 * POST /run    { prompt: string } → { run_id }
 * GET  /events SSE stream of bus events (broadcast to all clients).
 */

import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { makeOrchestratorAgent } from "./agents/orchestrator.js";
import { streamAgentWithReasoning } from "./tools/fan-out.js";
import { bus, BusEvent } from "./lib/event-bus.js";
import { killRun, clearCancelled, isCancelled } from "./tools/cli-tool.js";

const runCancelRejects = new Map<string, (err: Error) => void>();

const OUT_DIR = path.resolve(new URL("../out", import.meta.url).pathname);
fs.mkdirSync(OUT_DIR, { recursive: true });

const PORT = parseInt(process.env.PORT ?? "8787");

const orchestrator = makeOrchestratorAgent();

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Tee process.stdout/stderr to the bus so any print during any run is streamed
// to frontend clients as `stdio` events. Keep the original terminal output too.
const origOutWrite = process.stdout.write.bind(process.stdout);
const origErrWrite = process.stderr.write.bind(process.stderr);

// Recursion guard: subscriber handlers may write to stderr, which would re-enter
// the bus and loop. While a publish is in flight, skip teeing.
let teeDepth = 0;
function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function dbg(msg: string): void {
  origErrWrite(`[${ts()}] [server-debug] ${msg}\n`);
}

const teeBuf: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
const atLineStart: Record<"stdout" | "stderr", boolean> = { stdout: true, stderr: true };

function teeWrite(stream: "stdout" | "stderr", orig: typeof origOutWrite) {
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    // Build a timestamp-prefixed copy for the underlying fd (terminal/log).
    let stamped = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (atLineStart[stream] && ch !== "\n") {
        stamped += `[${ts()}] `;
        atLineStart[stream] = false;
      }
      stamped += ch;
      if (ch === "\n") atLineStart[stream] = true;
    }
    // @ts-expect-error variadic passthrough
    const result = orig(stamped, ...rest);
    if (teeDepth === 0) {
      teeBuf[stream] += s;
      const idx = teeBuf[stream].lastIndexOf("\n");
      if (idx >= 0) {
        const complete = teeBuf[stream].slice(0, idx);
        teeBuf[stream] = teeBuf[stream].slice(idx + 1);
        for (const line of complete.split("\n")) {
          if (line.length === 0) continue;
          teeDepth++;
          try {
            bus.publish({ type: "stdio", stream, run_id: bus.getCurrentRunId(), line });
          } finally {
            teeDepth--;
          }
        }
      }
    }
    return result;
  };
}
process.stdout.write = teeWrite("stdout", origOutWrite) as typeof process.stdout.write;
process.stderr.write = teeWrite("stderr", origErrWrite) as typeof process.stderr.write;

// Debug: count subscribers on every publish.
let subscriberCount = 0;
const origSubscribe = bus.subscribe.bind(bus);
bus.subscribe = (handler) => {
  subscriberCount++;
  dbg(`subscribe: total=${subscriberCount}`);
  const off = origSubscribe(handler);
  return () => {
    subscriberCount--;
    dbg(`unsubscribe: total=${subscriberCount}`);
    off();
  };
};
const origPublish = bus.publish.bind(bus);
bus.publish = (ev) => {
  dbg(`publish type=${ev.type} subs=${subscriberCount}`);
  origPublish(ev);
};

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/run") {
    try {
      const body = (await readJsonBody(req)) as { prompt?: string };
      if (!body.prompt || typeof body.prompt !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing 'prompt' string" }));
        return;
      }
      const run_id = randomUUID();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ run_id }));

      // Kick off run async; publish start/end events tagged with run_id.
      (async () => {
        bus.setCurrentRunId(run_id);
        clearCancelled(run_id);
        bus.publish({ type: "agent_start", run_id, prompt: body.prompt });
        const cancelPromise = new Promise<never>((_, reject) => {
          runCancelRejects.set(run_id, reject);
        });
        const orchStartedAt = Date.now();
        bus.publish({ type: "subagent_start", run_id, agent: "orchestrator", label: "orchestrator" });
        try {
          const result = await Promise.race([
            streamAgentWithReasoning(orchestrator, "orchestrator", "orchestrator", body.prompt!),
            cancelPromise,
          ]);
          bus.publish({
            type: "subagent_end",
            run_id,
            agent: "orchestrator",
            label: "orchestrator",
            duration_ms: Date.now() - orchStartedAt,
          });
          const content =
            typeof result === "string"
              ? result
              : (result as { content?: string }).content ?? JSON.stringify(result);
          bus.publish({ type: "agent_end", run_id, content });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          bus.publish({
            type: "subagent_end",
            run_id,
            agent: "orchestrator",
            label: "orchestrator",
            duration_ms: Date.now() - orchStartedAt,
            error: msg,
          });
          if (isCancelled(run_id)) {
            bus.publish({ type: "agent_end", run_id, error: true, cancelled: true });
          } else {
            bus.publish({ type: "error", run_id, message: msg });
            bus.publish({ type: "agent_end", run_id, error: true });
          }
        } finally {
          runCancelRejects.delete(run_id);
          if (bus.getCurrentRunId() === run_id) bus.setCurrentRunId(undefined);
        }
      })();
      return;
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
      return;
    }
  }

  if (req.method === "GET" && (req.url === "/events" || req.url?.startsWith("/events?"))) {
    dbg(`/events connected from ${req.socket.remoteAddress}`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(": connected\n\n");

    // Replay backlog so late-connecting clients see prior events.
    const backlog = bus.getBacklog();
    for (const ev of backlog) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    dbg(`/events replayed backlog (${backlog.length} events)`);

    let delivered = 0;
    const unsubscribe = bus.subscribe((ev: BusEvent) => {
      const wrote = res.write(`data: ${JSON.stringify(ev)}\n\n`);
      delivered++;
      if (delivered <= 3 || delivered % 20 === 0) {
        dbg(`delivered #${delivered} type=${ev.type} wrote=${wrote}`);
      }
    });
    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    req.on("close", () => {
      dbg(`/events disconnected (delivered ${delivered})`);
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  if (req.method === "GET" && req.url === "/files") {
    try {
      const entries = fs
        .readdirSync(OUT_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".mp4"))
        .map((e) => {
          const st = fs.statSync(path.join(OUT_DIR, e.name));
          return { name: e.name, size: st.size, created_ms: st.mtimeMs };
        })
        .sort((a, b) => b.created_ms - a.created_ms);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/files/")) {
    const raw = decodeURIComponent(req.url.slice("/files/".length));
    const name = path.basename(raw);
    const full = path.join(OUT_DIR, name);
    if (!full.startsWith(OUT_DIR + path.sep) || !fs.existsSync(full)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const st = fs.statSync(full);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(st.size),
      "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  if (req.method === "POST" && req.url === "/cancel") {
    try {
      const body = (await readJsonBody(req)) as { run_id?: string };
      const runId = body.run_id ?? bus.getCurrentRunId();
      if (!runId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no run_id and no active run" }));
        return;
      }
      const killed = killRun(runId);
      bus.publish({ type: "error", run_id: runId, message: `Run cancelled by user (killed ${killed} subprocess(es))` });
      const rej = runCancelRejects.get(runId);
      if (rej) {
        rej(new Error("RUN_CANCELLED"));
        runCancelRejects.delete(runId);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, run_id: runId, killed }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/debug-ping") {
    bus.publish({ type: "error", message: "debug ping from /debug-ping" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, subscribers: subscriberCount }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`server listening on http://0.0.0.0:${PORT}\n`);
  process.stderr.write(`  POST /run    { prompt }\n`);
  process.stderr.write(`  GET  /events (SSE)\n`);
});
