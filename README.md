# video-splitter

TypeScript pipeline for turning long recordings (typically 60GB+ OBS MKVs) into short publishable clips and topic compilations. It ships as:

1. A set of small, composable CLI commands in `src/commands/` (each reads/writes JSON or MP4 on disk).
2. A Strands-based agent layer in `src/agents/` that drives those commands end-to-end in response to a plain-English prompt.
3. A Node SSE backend (`src/server.ts`) and a React/Vite frontend (`frontend/`) that stream agent events into a browser UI.

Built on ffmpeg, OpenAI Whisper, OpenAI/Anthropic LLMs.

---

## How it works

`tmp/` (repo root) is the scratch workspace — staged source videos, transcripts, plan JSONs, and intermediate renders all live there. `out/` is reserved for the **final** publishable MP4(s); only the explicit `video-publish` step writes to it.

```
source MKV ──► stage_sources ──► tmp/source.mkv
                                     │
                                     ├─ video-to-audio ──► tmp/source.audio.mp3
                                     │                         │
                                     │                         └─ audio-to-transcript ──► tmp/source.transcript.json
                                     │
                       ┌─────────────┴─────────────┐
                       ▼                           ▼
          transcript-to-topic              transcript-find-segment
                  │                                │
                  ▼                                ▼
          topic-to-compilation             tmp/*.segment.json
                  │                                │
                  ▼                                │
        tmp/*.compilation.json                     │
          (compilation-refine loop                 │
           until duration ≤ max)                   │
                  │                                │
                  ▼                                ▼
          compilation-render               segment-render
                  │                                │
                  └──────────────┬─────────────────┘
                                 ▼
                        video-remove-silence
                                 │
                                 ▼
                         (optional) video-bleep
                                 │
                                 ▼
                           video-publish ──► out/<final>.mp4
```

Always start from the **original MKV**. Whisper timestamps are accurate on originals because natural silences anchor word boundaries; abrupt cuts in derivatives cause drift and every downstream step expects offsets that match the original.

---

## Agents

The agent layer wraps the CLI commands so a user can say "make me 2 shorts and 1 clip from /home/alex/OBS/foo.mkv, max 45s, bleep profanity" and get publishable MP4s back. There are four agent roles and one orchestrator.

| Role | Agent id | File | Responsibility |
|---|---|---|---|
| Orchestrator | `orchestrator` | `src/agents/orchestrator.ts` | Parses the prompt, stages sources, fans out to scouts then creators. Persists a short summary to memory at end of run. |
| Scouts | `agent_topic_scout`, `agent_segment_scout` | `src/agents/agent-topic-scout.ts`, `src/agents/agent-segment-scout.ts` | Read a transcript and propose N topic/segment candidates as `.topic.json` / `.segment.json` files. |
| Creators | `agent_compilation_creator`, `agent_segment_creator` | `src/agents/agent-compilation-creator.ts`, `src/agents/agent-segment-creator.ts` | Take ONE plan JSON → plan (for compilations), render, silence-strip, optionally bleep, publish. Return the final `out/*.mp4` path. |

Tooling (scouts, creators, transcription, stage/publish, fs helpers) lives in `src/tools/`. Fan-out helpers (`agents_plan_and_render_many`, `agents_plan_and_render_segments`, `transcribe_many`, `agents_topic_scout_many`, `agents_segment_scout_many`) run subagents in parallel via `Promise.allSettled`.

---

## Quick start

```bash
git clone <repo>
cd video-splitter
npm install
cp .env.example .env    # fill in OPENAI_API_KEY and ANTHROPIC_API_KEY
```

### Run the web UI

```bash
npm run dev    # concurrent: SSE backend + Vite frontend
```

Open http://localhost:5173, drop an MKV, type a prompt, hit Run. Tool-call events stream live; final MP4s appear in `out/` and in the UI's Files panel.

### Run the agent from the CLI

```bash
npx tsx src/agent.ts "make me 2 shorts from /home/alex/OBS/stream.mkv, under 45s, bleep profanity"
```

The agent accepts free-form English — path, count, intent (shorts vs clips), max-seconds, banner, bleep, hardware acceleration. Missing fields fall back to documented defaults (2 compilations, 120s, landscape 1280×720, `nvenc`).

### Use the raw CLI commands

Each step is an independent script, so you can bypass the agent:

```bash
npx tsx src/commands/<command>.ts [options] <args>
# or
npm run <command> -- [options] <args>
```

---

## Requirements

- **ffmpeg ≥ 6** with ffprobe
- **Node.js ≥ 20**
- **NVIDIA or VAAPI-capable GPU** (optional, for faster renders — CPU fallback works)

Install ffmpeg: `pacman -S ffmpeg` / `apt install ffmpeg` / `brew install ffmpeg`.

### API keys

| Env var | Used by | Where to get it |
|---|---|---|
| `OPENAI_API_KEY` | Whisper transcription, orchestrator/creator/scout LLM calls, topic_to_banner | platform.openai.com/api-keys |
| `ANTHROPIC_API_KEY` | `transcript-find-segment`, `transcript-to-topic`, `video-bleep --auto` word picker | console.anthropic.com/settings/keys |
| `ASSEMBLYAI_API_KEY` | Optional better diarization | assemblyai.com/dashboard |

Keys load from `.env` automatically at runtime.

---

## CLI commands

Every command writes its output next to its input (in `tmp/` when driven by the agent) unless `--output` is given. None of them publish to `out/` on their own — use `video-publish` for that.

### Transcription

| Command | Output | Notes |
|---|---|---|
| `video-to-audio` | `<base>.audio.mp3` | 16kHz mono MP3, fast single-pass extract. |
| `audio-to-transcript` | `<base>.transcript.json` | Whisper + diarization; resumable with `--resume`. Backend: `whisper-heuristic` (default) / `assemblyai` / `pyannote-local`. |

### Planning

| Command | Reads | Writes |
|---|---|---|
| `transcript-to-topic` | `.transcript.json` | `.topic.json` — a narrative "story" for a theme |
| `topic-to-compilation` | `.topic.json` | `.compilation.json` — clip-by-clip plan with phrase-level timestamps |
| `compilation-refine` | `.compilation.json` + `--instruction` and/or `--maxSeconds` | `.compilation.N.json` — iteratively trimmed. Reports `OVER_MAX` to stderr if still too long. |
| `transcript-find-segment` | `.transcript.json` | `.segment.json` — single standalone clip |
| `transcript-to-distillation-plan` | `.transcript.json` | `.distillation.json` — whole-session condense plan |
| `topic-to-banner` | topic + description | `<base>.banner.png` — illustrative title card (OpenAI image gen) |
| `transcript-to-bleep-plan` | `.transcript.json` | `.bleep.json` — word-level mute intervals |

### Rendering

| Command | What it does |
|---|---|
| `compilation-render` | Concatenate all clips in a `.compilation.json` into one MP4. Aspect/resolution/preset/hwAccel/banner all configurable. |
| `segment-render` | Extract one `.segment.json` range from the source and re-encode with cover-fill crop. |
| `distillation-render` | Render a `.distillation.json` (reference viewing only — don't feed back into pipeline). |

### Post-processing

| Command | What it does |
|---|---|
| `video-remove-silence` | Drop silent intervals. Use `--reencode` on already-encoded short MP4s to avoid audible repeats at cut points. |
| `video-bleep` | Re-transcribes the cut MP4 (word-level timestamps), picks target words with `--auto` or an explicit `--words <csv>` list, mutes or beeps them. "gay" is always in the bleep set when bleeping is active. |
| `video-apply-bleep` | Apply a pre-computed `.bleep.json` to a video (no LLM call). |
| `video-publish` | Copy the final MP4 to `out/`. Called once by the creator as the very last step. Optional `--replace <prior-path>` removes a stale published file. |

### `video-remove-silence` options

| Option | Default | Description |
|---|---|---|
| `--noise-db <dB>` | `-35` | Silence threshold. Higher (e.g. `-40`) = more aggressive. |
| `--min-silence <s>` | `0.5` | Minimum silence duration to cut. |
| `--pad <s>` | `0.1` | Silence kept at each boundary to avoid clipped words. |
| `--preview` | — | Print intervals, don't write. |
| `--reencode` | — | Re-encode instead of stream-copy. Required for short MP4 clips. |

### `segment-render` / `compilation-render` options

| Option | Default | Description |
|---|---|---|
| `--aspect <ratio>` | `landscape` (16:9) | Preset (`portrait`, `square`, `landscape`, `cinema`) or `W:H`. |
| `--resolution <WxH>` | `1280x720` | Explicit resolution. |
| `--preset <preset>` | `fast` | ffmpeg speed/quality trade-off. |
| `--crf <n>` | `18` | Quality (0–51). |
| `--hw-accel <api>` | — | `nvenc` \| `vaapi` \| `videotoolbox` \| `none`. Agent defaults to `nvenc` with vaapi fallback. |
| `--banner <png>` | — | Title card overlaid top-center (opt-in). |
| `--output <path>` | derived | Explicit output path. |

---

## Agent CLI / web UI usage

### Prompt examples

```
make me 2 shorts from /home/alex/OBS/stream.mkv
```
→ 2 compilations, 120s default, landscape 1280×720, no bleep, no banner.

```
3 clips about debugging from ~/OBS/day.mkv, under 45 seconds, with banners, bleeped
```
→ 3 segments, topic-filtered to "debugging", 45s ceiling, banner generated, `video-bleep --auto` applied.

```
half-res, fast preset, 4 shorts from A.mkv and B.mkv
```
→ Staged both, transcribed in parallel (`transcribe_many`), 4 topics per source, 854×480.

```
remove the part about the crash from /home/alex/OBS/stream.stream.compilation.2.json
```
→ Refine-existing mode. No transcription. Calls `compilation_refine` on the given JSON.

### Defaults the agent falls back to

| Missing input | Default |
|---|---|
| Source path | Most recent `.mkv` in `~/OBS` or `~/` |
| Intent | Compilations |
| Count | 2 |
| Max seconds | 120 |
| Aspect / resolution / preset | `landscape` / `1280x720` / `fast` |
| Hardware accel | `nvenc` → fallback `vaapi` |
| Banner | off |
| Bleep | off |

Defaults chosen are stated in the agent's final answer under `Assumed defaults:`.

### Frontend controls

`frontend/` is a small React app that posts the prompt to the backend and renders `agent_start`, tool-call, subagent, and CLI-stdout events in real time. Files panel polls `out/` for finished videos. A settings drawer exposes hardware-acceleration, bleep toggle, explicit bleep-word list, banner toggle, keep-silence, safe-for-work.

---

## Project structure

```
video-splitter/
├── src/
│   ├── agent.ts                          # CLI entry for orchestrator
│   ├── server.ts                         # SSE backend
│   ├── agents/
│   │   ├── orchestrator.ts
│   │   ├── agent-topic-scout.ts
│   │   ├── agent-segment-scout.ts
│   │   ├── agent-compilation-creator.ts
│   │   ├── agent-segment-creator.ts
│   │   └── shared.ts                     # buildModel(), HARD_RULES
│   ├── commands/                         # All CLI scripts (thin wrappers over lib/)
│   ├── tools/
│   │   ├── commands.ts                   # cliTool() wrappers exposing each CLI to agents
│   │   ├── fan-out.ts                    # Parallel subagent helpers
│   │   ├── fs-tools.ts                   # read_file / list_dir / stage_sources / project_overview
│   │   ├── cli-tool.ts                   # runCli() + cliTool() factory
│   │   ├── estimate.ts                   # compilation/segment duration estimators
│   │   ├── memory.ts                     # memory_read / memory_append
│   │   └── events.ts                     # event-bus plumbing for the SSE stream
│   └── lib/
│       ├── event-bus.ts
│       ├── ffmpeg.ts
│       ├── progress.ts
│       └── transcript.ts
├── frontend/                             # React + Vite UI
├── tmp/                                  # Scratch workspace (gitignored)
├── out/                                  # Final publishable videos (gitignored)
├── .env.example
├── CLAUDE.md                             # Project rules for Claude Code
└── SPEC.md
```

---

## Output file naming

| Step | Default name |
|---|---|
| `video-to-audio` | `<base>.audio.mp3` |
| `audio-to-transcript` | `<base>.transcript.json` |
| `transcript-to-topic` | `<base>.<topic-slug>.topic.json` |
| `topic-to-compilation` | `<base>.<topic-slug>.compilation.json` (then `.2.json`, `.3.json` on refine) |
| `compilation-render` | `<base>.<topic-slug>.compilation.mp4` |
| `segment-render` | `<base>_<start>-<end>.mp4` |
| `video-remove-silence` | `<base>.cut.mp4` (or `.mkv`) |
| `video-bleep` | `<base>.bleeped.mp4` |
| `video-publish` | `out/<basename(input)>` |
