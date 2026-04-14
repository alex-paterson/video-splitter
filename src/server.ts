#!/usr/bin/env tsx
/**
 * server — tiny HTTP/SSE surface for the orchestrator agent.
 *
 * POST /run    { prompt: string } → { run_id }
 * GET  /events SSE stream of bus events (broadcast to all clients).
 */

import "dotenv/config";
import http from "http";
import { randomUUID } from "crypto";
import { makeOrchestratorAgent } from "./agents/orchestrator.js";
import { bus, BusEvent } from "./lib/event-bus.js";

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
function dbg(msg: string): void {
  origErrWrite(`[server-debug] ${msg}\n`);
}

function teeWrite(stream: "stdout" | "stderr", orig: typeof origOutWrite) {
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    // Always write to the underlying fd first so terminal output is immediate.
    // @ts-expect-error variadic passthrough
    const result = orig(chunk, ...rest);
    if (teeDepth === 0) {
      const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      for (const line of s.split("\n")) {
        if (line.length > 0) {
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
        bus.publish({ type: "agent_start", run_id, prompt: body.prompt });
        try {
          const result = await orchestrator.invoke(body.prompt!);
          const content =
            typeof result === "string"
              ? result
              : (result as { content?: string }).content ?? JSON.stringify(result);
          bus.publish({ type: "agent_end", run_id, content });
        } catch (e) {
          bus.publish({
            type: "error",
            run_id,
            message: e instanceof Error ? e.message : String(e),
          });
          bus.publish({ type: "agent_end", run_id, error: true });
        } finally {
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

  if (req.method === "GET" && req.url === "/debug-ping") {
    bus.publish({ type: "error", message: "debug ping from /debug-ping" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, subscribers: subscriberCount }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  process.stderr.write(`server listening on http://localhost:${PORT}\n`);
  process.stderr.write(`  POST /run    { prompt }\n`);
  process.stderr.write(`  GET  /events (SSE)\n`);
});
