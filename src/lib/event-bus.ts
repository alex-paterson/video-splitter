import { EventEmitter } from "events";

export type BusEventType =
  | "agent_start"
  | "agent_end"
  | "tool_start"
  | "tool_end"
  | "tool_output_line"
  | "error";

export interface BusEvent {
  type: BusEventType;
  run_id?: string;
  ts: number;
  [key: string]: unknown;
}

class EventBus {
  private emitter = new EventEmitter();
  private currentRunId: string | undefined;

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
      ts: Date.now(),
      run_id: event.run_id ?? this.currentRunId,
    };
    this.emitter.emit("event", ev);
  }

  subscribe(handler: (ev: BusEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}

export const bus = new EventBus();
