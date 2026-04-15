import { EventEmitter } from "events";

export type BusEventType =
  | "agent_start"
  | "agent_end"
  | "tool_start"
  | "tool_end"
  | "tool_output_line"
  | "subagent_start"
  | "subagent_end"
  | "subagent_reasoning"
  | "agent_tool_call_start"
  | "agent_tool_call_end"
  | "stdio"
  | "error";

export interface BusEvent {
  id: string;
  type: BusEventType;
  run_id?: string;
  ts: number;
  [key: string]: unknown;
}

const BACKLOG_SIZE = 5000;

class EventBus {
  private emitter = new EventEmitter();
  private currentRunId: string | undefined;
  private backlog: BusEvent[] = [];
  private nextId = 1;
  private readonly instance = Date.now().toString(36);

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  setCurrentRunId(id: string | undefined): void {
    this.currentRunId = id;
  }

  getCurrentRunId(): string | undefined {
    return this.currentRunId;
  }

  publish(event: { type: BusEventType; run_id?: string; [key: string]: unknown }): void {
    const ev: BusEvent = {
      ...event,
      id: `${this.instance}-${this.nextId++}`,
      ts: Date.now(),
      run_id: event.run_id ?? this.currentRunId,
    };
    this.backlog.push(ev);
    if (this.backlog.length > BACKLOG_SIZE) {
      this.backlog.splice(0, this.backlog.length - BACKLOG_SIZE);
    }
    this.emitter.emit("event", ev);
  }

  getBacklog(): BusEvent[] {
    return this.backlog.slice();
  }

  subscribe(handler: (ev: BusEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}

export const bus = new EventBus();
