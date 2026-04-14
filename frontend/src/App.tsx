import { useEffect, useRef, useState } from "react";

type AgentEvent = {
  id: number;
  type: string;
  data: unknown;
  at: number;
};

export function App() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "open" | "closed" | "error">("idle");
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const connect = () => {
    esRef.current?.close();
    setEvents([]);
    setStatus("connecting");
    const es = new EventSource("/stream");
    esRef.current = es;
    let counter = 0;
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error");
    es.onmessage = (e) => {
      let parsed: unknown = e.data;
      try { parsed = JSON.parse(e.data); } catch {}
      const type =
        parsed && typeof parsed === "object" && "type" in parsed
          ? String((parsed as { type: unknown }).type)
          : "message";
      setEvents((prev) => [...prev, { id: counter++, type, data: parsed, at: Date.now() }]);
    };
  };

  const disconnect = () => {
    esRef.current?.close();
    esRef.current = null;
    setStatus("closed");
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">Agent Stream</h1>
          <div className="flex items-center gap-3">
            <StatusDot status={status} />
            {status === "open" || status === "connecting" ? (
              <button
                onClick={disconnect}
                className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm font-medium hover:bg-neutral-700"
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={connect}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500"
              >
                Connect
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-6">
        {events.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-800 p-10 text-center text-sm text-neutral-500">
            No events yet. Click Connect to stream from the agent.
          </div>
        ) : (
          <ol className="space-y-3">
            {events.map((ev) => (
              <EventBlock key={ev.id} ev={ev} />
            ))}
          </ol>
        )}
        <div ref={bottomRef} />
      </main>
    </div>
  );
}

function EventBlock({ ev }: { ev: AgentEvent }) {
  const body =
    typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data, null, 2);
  return (
    <li className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-emerald-400">
          {ev.type}
        </span>
        <span className="font-mono text-xs text-neutral-500">
          {new Date(ev.at).toLocaleTimeString()}
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-neutral-200">
        {body}
      </pre>
    </li>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "open"
      ? "bg-emerald-500"
      : status === "connecting"
        ? "bg-amber-500 animate-pulse"
        : status === "error"
          ? "bg-red-500"
          : "bg-neutral-600";
  return (
    <span className="flex items-center gap-2 text-xs text-neutral-400">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {status}
    </span>
  );
}
