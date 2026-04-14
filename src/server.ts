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
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const unsubscribe = bus.subscribe((ev: BusEvent) => {
      res.write(`event: ${ev.type}\n`);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
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
