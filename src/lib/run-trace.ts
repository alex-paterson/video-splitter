import { bus, BusEvent } from "./event-bus.js";

export class RunTraceCollector {
  readonly events: BusEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  constructor(private readonly runId: string) { }

  start(): void {
    this.unsubscribe = bus.subscribe((ev) => {
      if (ev.run_id === this.runId) this.events.push(ev);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

export function renderDebugTrace(runId: string, prompt: string, events: BusEvent[]): string {
  const lines: string[] = [];
  lines.push(`**run_id:** \`${runId}\``);
  lines.push(`**prompt:**`);
  lines.push("```");
  lines.push(prompt.trim());
  lines.push("```");
  lines.push("");
  lines.push("### tool-chain + reasoning");
  lines.push("");

  type ReasoningBuf = { label: string; agent: string; chunks: string[] };
  const reasoningByLabel = new Map<string, ReasoningBuf>();

  const flushReasoning = (key: string) => {
    const buf = reasoningByLabel.get(key);
    if (!buf) return;
    const text = buf.chunks.join("").trim();
    if (text) {
      lines.push(`  thinking[${buf.label}]:`);
      for (const ln of text.split("\n")) lines.push(`    ${ln}`);
    }
    reasoningByLabel.delete(key);
  };

  for (const ev of events) {
    const d = ev as Record<string, unknown>;
    switch (ev.type) {
      case "agent_start":
        lines.push(`- [start] orchestrator`);
        break;
      case "subagent_start": {
        const label = String(d.label ?? d.agent ?? "?");
        const agent = String(d.agent ?? "?");
        lines.push(`- [subagent:start] ${agent} (${label})`);
        break;
      }
      case "subagent_reasoning": {
        const label = String(d.label ?? d.agent ?? "?");
        const agent = String(d.agent ?? "?");
        const text = typeof d.text === "string" ? d.text : "";
        const existing = reasoningByLabel.get(label) ?? { label, agent, chunks: [] };
        existing.chunks.push(text);
        reasoningByLabel.set(label, existing);
        break;
      }
      case "agent_tool_call_start": {
        const label = String(d.label ?? "?");
        flushReasoning(label);
        const name = String(d.tool_name ?? "?");
        const input = d.input !== undefined ? JSON.stringify(d.input) : "";
        const inputSnippet = input.length > 300 ? input.slice(0, 300) + "…" : input;
        lines.push(`  ↳ tool ${name}(${inputSnippet})`);
        break;
      }
      case "agent_tool_call_end": {
        const name = String(d.tool_name ?? "?");
        const err = typeof d.error === "string" ? d.error : undefined;
        const out = typeof d.output === "string" ? d.output : "";
        const outSnippet = out.length > 300 ? out.slice(0, 300) + "…" : out;
        if (err) {
          lines.push(`    ← ${name} ERROR: ${err}`);
        } else if (outSnippet) {
          lines.push(`    ← ${name} → ${outSnippet}`);
        } else {
          lines.push(`    ← ${name} done`);
        }
        break;
      }
      case "tool_start": {
        const script = String(d.script ?? "?");
        const argv = Array.isArray(d.argv) ? (d.argv as unknown[]).map(String).join(" ") : "";
        lines.push(`    $ ${script} ${argv}`);
        break;
      }
      case "tool_end": {
        const code = d.code;
        const ms = d.duration_ms;
        lines.push(`    exit ${code} (${ms}ms)`);
        break;
      }
      case "subagent_end": {
        const label = String(d.label ?? d.agent ?? "?");
        flushReasoning(label);
        const err = typeof d.error === "string" ? d.error : undefined;
        const ms = d.duration_ms;
        lines.push(`- [subagent:end] ${label}${err ? ` ERROR: ${err}` : ""} (${ms}ms)`);
        break;
      }
      case "agent_end": {
        lines.push(`- [end] agent${d.cancelled ? " CANCELLED" : d.error ? " ERROR" : ""}`);
        break;
      }
      case "error": {
        const msg = typeof d.message === "string" ? d.message : JSON.stringify(d);
        lines.push(`  !! error: ${msg}`);
        break;
      }
      default:
        break;
    }
  }
  for (const key of Array.from(reasoningByLabel.keys())) flushReasoning(key);
  return lines.join("\n");
}
