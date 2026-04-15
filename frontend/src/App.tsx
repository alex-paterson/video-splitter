import React, { createContext, useContext, useEffect, useRef, useState } from "react";

type AgentEvent = {
  id: string;
  type: string;
  data: unknown;
  at: number;
};

let fallbackCounter = 0;

const WrapContext = createContext(true);
const useWrapClass = () =>
  useContext(WrapContext) ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto";

const CollapseContext = createContext<{ allCollapsed: boolean; tick: number }>({
  allCollapsed: false,
  tick: 0,
});

type OutFile = { name: string; size: number; created_ms: number };

const STORAGE_KEY = "agent-stream-events-v1";
const MAX_PERSISTED = 5000;

function loadEvents(): AgentEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function App() {
  const [events, setEvents] = useState<AgentEvent[]>(() => loadEvents());
  const [status, setStatus] = useState<"idle" | "connecting" | "open" | "closed" | "error">("idle");
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const [filterLanguage, setFilterLanguage] = useState(true);
  const [safeForWork, setSafeForWork] = useState(true);
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [collapseTick, setCollapseTick] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  const toggleAll = () => {
    setAllCollapsed((v) => !v);
    setCollapseTick((t) => t + 1);
  };

  const runPrompt = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    try {
      const parts: string[] = [];
      if (filterLanguage) {
        parts.push("Bleep curse words (profanity) in the final video output.");
      }
      if (safeForWork) {
        parts.push(
          "Keep it safe-for-work: avoid selecting clips with graphic sexual content, hard drugs, or slurs. " +
          "However, do NOT discard phrases just because they mention mild/borderline topics (e.g. 'I'm going to go hit a bong', casual drinking, mild innuendo). " +
          "Only individual curse words should be bleeped — the surrounding phrases stay in."
        );
      }
      const suffix = parts.length ? "\n\n" + parts.join("\n") : "";
      const finalPrompt = prompt.trim() + suffix;
      const r = await fetch("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: finalPrompt }),
      });
      const j = await r.json();
      if (j.run_id) {
        setLastRunId(j.run_id);
        setPrompt("");
      }
    } catch (e) {
      setEvents((prev) => [
        ...prev,
        { id: `local-${++fallbackCounter}`, type: "error", data: String(e), at: Date.now() },
      ]);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    try {
      const slice = events.slice(-MAX_PERSISTED);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
    } catch { }
  }, [events]);

  useEffect(() => {
    setStatus("connecting");
    const es = new EventSource("/events");
    esRef.current = es;
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error");
    es.onmessage = (e) => {
      let parsed: unknown = e.data;
      try { parsed = JSON.parse(e.data); } catch { }
      const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      const type = typeof obj.type === "string" ? obj.type : "message";
      const busId = typeof obj.id === "string" ? obj.id : null;
      const at = typeof obj.ts === "number" ? obj.ts : Date.now();
      setEvents((prev) => {
        if (busId !== null && prev.some((p) => p.id === busId)) return prev;
        const id = busId ?? `local-${++fallbackCounter}`;
        return [...prev, { id, type, data: parsed, at }];
      });
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return (
    <WrapContext.Provider value={wrap}>
      <CollapseContext.Provider value={{ allCollapsed, tick: collapseTick }}>
        <div className="min-h-screen bg-neutral-950 text-neutral-100">
          <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
            <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
              <h1 className="text-lg font-semibold tracking-tight">Agent Stream</h1>
              <div className="flex items-center gap-4">
                <button
                  onClick={toggleAll}
                  className="rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
                >
                  {allCollapsed ? "expand all" : "collapse all"}
                </button>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={wrap}
                    onChange={(e) => setWrap(e.target.checked)}
                    className="h-3 w-3 accent-emerald-600"
                  />
                  wrap
                </label>
                <StatusDot status={status} />
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-3xl px-6 py-6">
            <FilesPanel />
            <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900 p-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    runPrompt();
                  }
                }}
                placeholder={`e.g.
  "make me 3 shorts from /home/alex/OBS/foo.mkv, max 60s each"
  "2 clips of the funniest moments from foo.mkv, portrait 9:16"
  "1 compilation about the bugs we hit, landscape 1080p, with banner"
  "90s highlight reel from foo.mkv, no swearing"
  "find the segment where we talk about auth and render it"
  "what's in foo.mkv? list the main topics"`}
                rows={8}
                className="w-full resize-y rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-emerald-600"
              />
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
                    <input
                      type="checkbox"
                      checked={filterLanguage}
                      onChange={(e) => setFilterLanguage(e.target.checked)}
                      className="h-3 w-3 accent-emerald-600"
                    />
                    Bleep curse words
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
                    <input
                      type="checkbox"
                      checked={safeForWork}
                      onChange={(e) => setSafeForWork(e.target.checked)}
                      className="h-3 w-3 accent-emerald-600"
                    />
                    Safe for work
                  </label>
                  <span className="font-mono text-xs text-neutral-500">
                    {lastRunId ? `last run_id: ${lastRunId}` : "⌘/Ctrl+Enter to run"}
                  </span>
                </div>
                <button
                  onClick={runPrompt}
                  disabled={running || !prompt.trim()}
                  className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700"
                >
                  {running ? "Submitting…" : "Run"}
                </button>
              </div>
            </div>
            {events.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-800 p-10 text-center text-sm text-neutral-500">
                No events yet. Submit a prompt above to start.
              </div>
            ) : (
              <ol className="space-y-3">
                {groupEvents(events).slice().reverse().map((g) =>
                  g.kind === "tool" ? (
                    <ToolGroup key={g.id} group={g} />
                  ) : g.kind === "stdio" ? (
                    <StdioGroup key={g.id} group={g} />
                  ) : (
                    <EventBlock key={g.ev.id} ev={g.ev} />
                  )
                )}
              </ol>
            )}
          </main>
        </div>
      </CollapseContext.Provider>
    </WrapContext.Provider>
  );
}

function EventBlock({ ev }: { ev: AgentEvent }) {
  const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
  const runId = typeof d.run_id === "string" ? d.run_id : undefined;
  const ts = typeof d.ts === "number" ? d.ts : ev.at;
  const typeColor =
    ev.type === "error"
      ? "text-red-400"
      : ev.type === "agent_end"
        ? "text-emerald-400"
        : ev.type === "agent_start"
          ? "text-sky-400"
          : ev.type === "stdio"
            ? "text-neutral-400"
            : "text-amber-400";
  return (
    <li className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className={`rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs ${typeColor}`}>
            {ev.type}
          </span>
          {runId && (
            <span
              title={`run_id: ${runId}`}
              className="cursor-help rounded bg-neutral-800/60 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500"
            >
              {runId.slice(0, 8)}
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-neutral-500" title={new Date(ts).toISOString()}>
          {new Date(ts).toLocaleTimeString()}
        </span>
      </div>
      <EventBody type={ev.type} data={ev.data} />
    </li>
  );
}

function EventBody({ type, data }: { type: string; data: unknown }) {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const wrapCls = useWrapClass();

  if (type === "agent_start" && typeof d.prompt === "string") {
    return (
      <div className="px-4 py-3 text-sm text-neutral-200">
        <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">prompt</div>
        <div className="whitespace-pre-wrap">{d.prompt}</div>
      </div>
    );
  }

  if (type === "agent_end") {
    const text = extractAgentEndText(d);
    if (text) {
      return (
        <div className="prose prose-invert prose-sm max-w-none px-4 py-3 text-sm text-neutral-100">
          <Markdown source={text} />
        </div>
      );
    }
  }

  if (type === "stdio" && typeof d.line === "string") {
    const isErr = d.stream === "stderr";
    return (
      <pre
        className={`px-4 py-2 font-mono text-xs ${wrapCls} ${isErr ? "text-amber-300" : "text-neutral-300"}`}
      >
        {d.line}
      </pre>
    );
  }

  if (type === "error") {
    const msg = typeof d.message === "string" ? d.message : typeof data === "string" ? data : JSON.stringify(data);
    return <div className="px-4 py-3 text-sm text-red-300">{msg}</div>;
  }

  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return (
    <pre className={`px-4 py-3 font-mono text-xs leading-relaxed text-neutral-300 ${wrapCls}`}>
      {body}
    </pre>
  );
}

function extractAgentEndText(d: Record<string, unknown>): string | null {
  if (typeof d.error === "boolean" && d.error) return null;
  const content = d.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as {
      lastMessage?: { content?: Array<{ text?: string }> };
    };
    const text = parsed.lastMessage?.content?.map((c) => c.text ?? "").join("\n").trim();
    if (text) return text;
  } catch { }
  return content;
}

function Markdown({ source }: { source: string }) {
  // Minimal renderer: paragraphs, code spans, bullet lines.
  const lines = source.split("\n");
  const out: React.ReactNode[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="my-2 list-disc space-y-1 pl-5">
        {listBuf.map((l, i) => (
          <li key={i}>{renderInline(l)}</li>
        ))}
      </ul>
    );
    listBuf = [];
  };
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      listBuf.push(m[1]);
      continue;
    }
    flushList();
    if (raw.trim() === "") {
      out.push(<div key={`sp-${out.length}`} className="h-2" />);
    } else {
      out.push(
        <p key={`p-${out.length}`} className="my-1 whitespace-pre-wrap">
          {renderInline(raw)}
        </p>
      );
    }
  }
  flushList();
  return <>{out}</>;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? (
      <code key={i} className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs text-emerald-300">
        {p.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

type Group =
  | { kind: "solo"; ev: AgentEvent }
  | { kind: "tool"; id: string; script: string; events: AgentEvent[]; closed: boolean }
  | { kind: "stdio"; id: string; events: AgentEvent[] };

function groupEvents(events: AgentEvent[]): Group[] {
  const groups: Group[] = [];
  const openByScript = new Map<string, Group & { kind: "tool" }>();
  for (const ev of events) {
    const d = (ev.data as { script?: string } | null) ?? null;
    const script = d?.script;
    const isTool =
      script &&
      (ev.type === "tool_start" ||
        ev.type === "tool_end" ||
        ev.type === "tool_output_line");
    if (isTool) {
      let g = openByScript.get(script);
      if (!g || g.closed) {
        g = { kind: "tool", id: `${script}-${ev.id}`, script, events: [], closed: false };
        openByScript.set(script, g);
        groups.push(g);
      }
      g.events.push(ev);
      if (ev.type === "tool_end") g.closed = true;
      continue;
    }
    if (ev.type === "stdio") {
      const last = groups[groups.length - 1];
      if (last && last.kind === "stdio") {
        last.events.push(ev);
      } else {
        groups.push({ kind: "stdio", id: `stdio-${ev.id}`, events: [ev] });
      }
      continue;
    }
    groups.push({ kind: "solo", ev });
  }
  return groups;
}

function StdioGroup({ group }: { group: Extract<Group, { kind: "stdio" }> }) {
  const collapse = useContext(CollapseContext);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    setExpanded(!collapse.allCollapsed);
  }, [collapse.tick]);
  const wrapCls = useWrapClass();
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  return (
    <li className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between border-b border-neutral-800 px-4 py-2 hover:bg-neutral-800/50"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-400">
            stdio
          </span>
          <span className="font-mono text-xs text-neutral-500">
            {group.events.length} line{group.events.length === 1 ? "" : "s"}
          </span>
        </div>
        <span className="font-mono text-xs text-neutral-500">
          {new Date(first.at).toLocaleTimeString()}
          {last !== first ? `–${new Date(last.at).toLocaleTimeString()}` : ""} {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <pre className={`max-h-80 overflow-auto px-4 py-2 font-mono text-xs leading-relaxed ${wrapCls}`}>
          {group.events.slice().reverse().map((e, i) => {
            const d = (e.data as { line?: string; stream?: string }) ?? {};
            const cls = d.stream === "stderr" ? "text-amber-300" : "text-neutral-300";
            return (
              <div key={i} className={cls}>
                {d.line ?? ""}
              </div>
            );
          })}
        </pre>
      )}
    </li>
  );
}

function ToolGroup({ group }: { group: Extract<Group, { kind: "tool" }> }) {
  const collapse = useContext(CollapseContext);
  const [expanded, setExpanded] = useState(!group.closed);
  useEffect(() => {
    setExpanded(!collapse.allCollapsed);
  }, [collapse.tick]);
  const wrapCls = useWrapClass();
  const start = group.events.find((e) => e.type === "tool_start");
  const end = group.events.find((e) => e.type === "tool_end");
  const lines = group.events.filter((e) => e.type === "tool_output_line");
  const code = (end?.data as { code?: number } | undefined)?.code;
  const duration = (end?.data as { duration_ms?: number } | undefined)?.duration_ms;
  const status = !group.closed
    ? "running"
    : code === 0
      ? "done"
      : `exit ${code}`;
  const statusColor =
    status === "running"
      ? "text-amber-400"
      : status === "done"
        ? "text-emerald-400"
        : "text-red-400";
  return (
    <li className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between border-b border-neutral-800 px-4 py-2 hover:bg-neutral-800/50"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-sky-400">
            {group.script}
          </span>
          <span className={`font-mono text-xs ${statusColor}`}>{status}</span>
          <span className="font-mono text-xs text-neutral-500">
            {lines.length} line{lines.length === 1 ? "" : "s"}
            {duration ? ` · ${(duration / 1000).toFixed(1)}s` : ""}
          </span>
        </div>
        <span className="font-mono text-xs text-neutral-500">
          {new Date(start?.at ?? group.events[0].at).toLocaleTimeString()} {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <pre className={`max-h-80 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-neutral-300 ${wrapCls}`}>
          {lines.slice().reverse().map((l) => (l.data as { line?: string }).line ?? "").join("\n")}
        </pre>
      )}
    </li>
  );
}

function FilesPanel() {
  const [files, setFiles] = useState<OutFile[]>([]);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetch("/files");
        if (!r.ok) return;
        const j = (await r.json()) as OutFile[];
        if (active) setFiles(j);
      } catch { }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, []);
  const fmtSize = (b: number) =>
    b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between border-b border-neutral-800 px-4 py-2 hover:bg-neutral-800/50"
      >
        <span className="text-sm font-medium text-neutral-200">
          Outputs <span className="text-neutral-500">({files.length})</span>
        </span>
        <span className="font-mono text-xs text-neutral-500">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="divide-y divide-neutral-800">
          {files.length === 0 ? (
            <div className="px-4 py-3 text-xs text-neutral-500">No mp4s in out/ yet.</div>
          ) : (
            files.map((f) => (
              <div key={f.name} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-neutral-200">{f.name}</div>
                  <div className="font-mono text-[10px] text-neutral-500">
                    {new Date(f.created_ms).toLocaleString()} · {fmtSize(f.size)}
                  </div>
                </div>
                <a
                  href={`/files/${encodeURIComponent(f.name)}`}
                  download={f.name}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  download
                </a>
              </div>
            ))
          )}
        </div>
      )}
    </div>
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
