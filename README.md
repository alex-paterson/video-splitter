# video-splitter

TypeScript CLI tools for processing large (60GB+) MKV video files. Built on ffmpeg, OpenAI Whisper, and Claude.

## Tools

| Tool | What it does |
|---|---|
| `video-remove-silence` | Remove silent intervals — fast stream copy, no re-encode |
| `video-to-audio` | Extract a video's audio track to 16kHz mono MP3 |
| `audio-to-transcript` | Multi-speaker diarized transcript via Whisper → `.transcript.json` |
| `transcript-find-segment` | Claude finds a coherent standalone segment → `.segment.json` |
| `segment-render` | Extract + reframe to any aspect ratio with cover-fill crop |
| `transcript-to-distillation-plan` | Plan a narrative distillation → `.distillation.json` (keep intervals) |
| `distillation-render` | Render a `.distillation.json` plan to a condensed video |
| `transcript-to-topic` | Derive a topic's narrative from a transcript → `.topic.json` |
| `topic-to-compilation` | Filter a transcript by a topic story → `.compilation.json` plan |
| `compilation-render` | Render a `.compilation.json` plan to a concatenated video |

> **Always build compilations (and clips) from the original source MKV** — never from a distilled or silence-cut derivative. Whisper timestamps are accurate on originals because natural silences act as anchors; abrupt cuts in derivatives cause timestamp drift, and every downstream step (`transcript-find-segment`, `topic-to-compilation`, `segment-render`, `compilation-render`) expects offsets that match the original file. Distilled outputs are for watching, not for re-processing.

---

## Requirements

### System

- **ffmpeg ≥ 6** with ffprobe — `ffmpeg -version`
- **Node.js ≥ 20** — `node --version`

Install ffmpeg on Arch: `sudo pacman -S ffmpeg`
Install ffmpeg on Ubuntu/Debian: `sudo apt install ffmpeg`
Install ffmpeg on macOS: `brew install ffmpeg`

### API keys

| Key | Tool | Where to get it |
|---|---|---|
| `OPENAI_API_KEY` | `video-to-transcript` | platform.openai.com/api-keys |
| `ANTHROPIC_API_KEY` | `transcript-find-segment` | console.anthropic.com/settings/keys |
| `ASSEMBLYAI_API_KEY` | `video-to-transcript` (optional, better diarization) | assemblyai.com/dashboard |

---

## Setup

```bash
git clone <repo>
cd video-splitter
npm install
cp .env.example .env
# edit .env and fill in your API keys
```

---

## Environment variables

Copy `.env.example` to `.env` and set your keys:

```bash
# Required for video-to-transcript
OPENAI_API_KEY=sk-...

# Required for transcript-find-segment
ANTHROPIC_API_KEY=sk-ant-...

# Diarization backend: whisper-heuristic (default) | assemblyai | pyannote-local
DIARIZE_BACKEND=whisper-heuristic

# Required if DIARIZE_BACKEND=assemblyai
# ASSEMBLYAI_API_KEY=...

# Required if DIARIZE_BACKEND=pyannote-local
# PYANNOTE_ENDPOINT=http://localhost:8000
```

Keys are loaded automatically from `.env` at runtime — no need to export them.

---

## Usage

All tools run with `npx tsx`:

```bash
npx tsx src/<tool>.ts [options] <args>
```

Or via npm scripts:

```bash
npm run video-remove-silence -- [options] <args>
npm run video-to-transcript  -- [options] <args>
npm run transcript-find-segment -- [options] <args>
npm run segment-render -- [options] <args>
```

---

## video-remove-silence

Remove silent intervals from a video. Uses ffmpeg's `silencedetect` filter then stream-copies the keep intervals — no re-encoding, works on 60GB+ files.

```
video-remove-silence [options] <input> [output]
```

| Option | Default | Description |
|---|---|---|
| `--noise-db <dB>` | `-35` | Silence threshold in dBFS. Higher = more aggressive (try `-40` for quiet speakers) |
| `--min-silence <s>` | `0.5` | Minimum silence duration to cut (seconds) |
| `--pad <s>` | `0.1` | Silence padding to preserve at each cut boundary |
| `--preview` | — | Print detected intervals without writing output |
| `--format <ext>` | `mkv` | Output container format |
| `--threads <n>` | `0` | ffmpeg thread count (0 = auto) |

### Examples

```bash
# Preview what silence would be cut
npx tsx src/commands/video-remove-silence.ts --preview lecture.mkv

# Cut silence with default settings
npx tsx src/commands/video-remove-silence.ts lecture.mkv
# → lecture.cut.mkv

# More aggressive cut, custom output path
npx tsx src/commands/video-remove-silence.ts --noise-db -40 --min-silence 0.8 lecture.mkv out/tight.mkv

# Output as MP4
npx tsx src/commands/video-remove-silence.ts --format mp4 lecture.mkv
```

### Notes

- Output is the stream-copied input with silent segments removed. Because it's a stream copy, it runs roughly as fast as your disk can read.
- The `--pad` option keeps a small amount of silence at each boundary to avoid clipped words. Reduce to `0` for the tightest cut.
- Use `--preview` first to tune `--noise-db` for your content before committing to a cut.

---

## video-to-transcript

Extract audio from a video and produce a word-timed, multi-speaker diarized transcript using OpenAI Whisper.

```
video-to-transcript [options] <input> [output]
```

| Option | Default | Description |
|---|---|---|
| `--chunk-minutes <n>` | `10` | Audio chunk size for API uploads |
| `--language <lang>` | auto | ISO-639-1 language code hint (e.g. `en`, `es`) |
| `--speakers <n>` | auto | Expected speaker count (hint for diarization) |
| `--no-diarize` | — | Disable diarization, label everything `SPEAKER_00` |
| `--model <model>` | `whisper-1` | Whisper model name |
| `--resume` | — | Resume a partial transcript (skip already-done chunks) |
| `--no-pre-extract` | — | Skip full audio pre-extraction (saves disk space, slower for large files) |

Output is a `.transcript.json` file alongside the input by default.

### Examples

```bash
# Basic transcription (whisper-heuristic diarization)
npx tsx src/commands/video-to-transcript.ts lecture.mkv
# → lecture.transcript.json

# With AssemblyAI diarization (better accuracy, requires key)
DIARIZE_BACKEND=assemblyai npx tsx src/commands/video-to-transcript.ts --speakers 2 lecture.mkv

# English, large chunks (fewer API calls for long files)
npx tsx src/commands/video-to-transcript.ts --language en --chunk-minutes 20 lecture.mkv

# Resume after an interrupted run
npx tsx src/commands/video-to-transcript.ts --resume lecture.mkv

# No diarization, just transcript
npx tsx src/commands/video-to-transcript.ts --no-diarize lecture.mkv
```

### Transcript format

```json
{
  "source": "/path/to/lecture.mkv",
  "duration_s": 3661.4,
  "speakers": ["SPEAKER_00", "SPEAKER_01"],
  "segments": [
    {
      "start_s": 0.0,
      "end_s": 4.2,
      "speaker": "SPEAKER_00",
      "text": "Hello and welcome to the show."
    }
  ]
}
```

### Diarization backends

| Backend | Quality | Requirements |
|---|---|---|
| `whisper-heuristic` | Basic — alternates speakers on pauses | None |
| `assemblyai` | Good — cloud-based neural diarization | `ASSEMBLYAI_API_KEY` |
| `pyannote-local` | Best — local model, no data leaves machine | Docker sidecar |

To run the pyannote local sidecar:
```bash
docker run -p 8000:8000 pyannote/speaker-diarization
# then set DIARIZE_BACKEND=pyannote-local in .env
```

### Notes

- **By default, the full audio track is extracted to a temporary MP3 first** (one fast pass through the source file), then chunks are split from that MP3. For a 60 GB MKV this is dramatically faster than seeking back into the video file for each chunk. The temp file is deleted when transcription completes.
- Use `--no-pre-extract` only if you're tight on disk space or the input is already a short file with a single chunk.
- The transcript is saved incrementally after each chunk. If the process is interrupted, `--resume` will pick up where it left off.
- Whisper timestamps are offset to absolute file positions automatically when chunking.
- Audio is extracted as 16kHz mono MP3 (64kbps) — no video data is sent to the API.

---

## transcript-find-segment

Use Claude to analyze a transcript and identify the best coherent, standalone video segment at a target duration.

```
transcript-find-segment [options] <transcript>
```

| Option | Default | Description |
|---|---|---|
| `--duration <s>` | `60` | Target segment duration in seconds |
| `--tolerance <s>` | `30` | Acceptable deviation from target duration |
| `--topic <text>` | — | Topic/theme hint to guide selection |
| `--speaker <id>` | — | Prefer segments dominated by this speaker |
| `--min-speakers <n>` | `1` | Minimum speakers that must appear |
| `--count <n>` | `1` | Number of candidate segments to return |
| `--output <path>` | stdout | Write `.segment.json` to file |
| `--model <model>` | `claude-opus-4-6` | Claude model |

### Examples

```bash
# Find a 60-second standalone segment, print to stdout
npx tsx src/commands/transcript-find-segment.ts lecture.transcript.json

# 90-second segment about a specific topic, save to file
npx tsx src/commands/transcript-find-segment.ts \
  --duration 90 --tolerance 20 \
  --topic "introduction to neural networks" \
  --output segment.json \
  lecture.transcript.json

# Get 3 candidates for manual review
npx tsx src/commands/transcript-find-segment.ts --count 3 --duration 120 lecture.transcript.json

# Only consider one speaker
npx tsx src/commands/transcript-find-segment.ts --speaker SPEAKER_01 --duration 60 lecture.transcript.json

# Pipe directly into segment-render
npx tsx src/commands/transcript-find-segment.ts --duration 90 lecture.transcript.json \
  | npx tsx src/commands/segment-render.ts --aspect portrait lecture.mkv
```

### Segment format

```json
{
  "source": "/path/to/lecture.mkv",
  "start_s": 120.5,
  "end_s": 210.0,
  "title": "Why transformers changed everything",
  "rationale": "Self-contained explanation with clear setup and conclusion.",
  "speakers": ["SPEAKER_01"]
}
```

### Notes

- Timestamps are snapped to the nearest transcript segment boundary so cuts always land on complete words.
- Claude is instructed to avoid segments that open with context-dependent language ("as I mentioned", "that thing we discussed") that would confuse a viewer with no prior context.
- Use `--count 3` to get multiple options and pick the best one manually.

---

## segment-render

Extract a time range from the source video, crop to a target aspect ratio using cover-fill from center, and encode to a new file.

```
segment-render [options] <input> [segment]
```

The segment can be:
- A path to a `.segment.json` file
- An inline JSON string
- Piped from stdin (omit the segment argument)

| Option | Default | Description |
|---|---|---|
| `--aspect <ratio>` | `9:16` | Target aspect ratio: `W:H` or a preset name |
| `--resolution <WxH>` | derived | Override output resolution (e.g. `1080x1920`) |
| `--fit` | — | Fit (letterbox) instead of cover-fill crop |
| `--crf <n>` | `18` | CRF quality (0–51, lower = better, larger file) |
| `--preset <preset>` | `slow` | ffmpeg encoding preset |
| `--codec <codec>` | `libx264` | Video codec |
| `--audio-codec <codec>` | `aac` | Audio codec |
| `--audio-bitrate <br>` | `192k` | Audio bitrate |
| `--format <ext>` | `mp4` | Output container format |
| `--output <path>` | auto | Output file path |
| `--threads <n>` | `0` | ffmpeg thread count (0 = auto) |
| `--hw-accel <api>` | — | Hardware acceleration: `nvenc` \| `vaapi` \| `videotoolbox` |

### Aspect ratio presets

| Preset | Ratio | Use case |
|---|---|---|
| `portrait` | 9:16 | TikTok, Instagram Reels, YouTube Shorts |
| `square` | 1:1 | Instagram feed |
| `landscape` | 16:9 | YouTube, Twitter/X |
| `cinema` | 21:9 | Widescreen / cinematic |

### Examples

```bash
# 9:16 portrait from a segment file
npx tsx src/commands/segment-render.ts --aspect portrait lecture.mkv segment.json

# Square clip with a specific output path
npx tsx src/commands/segment-render.ts --aspect square --output clip.mp4 lecture.mkv segment.json

# Letterbox instead of crop
npx tsx src/commands/segment-render.ts --aspect 9:16 --fit lecture.mkv segment.json

# Inline JSON segment
npx tsx src/commands/segment-render.ts --aspect landscape lecture.mkv \
  '{"source":"lecture.mkv","start_s":60,"end_s":120,"title":"Test","rationale":"","speakers":[]}'

# Hardware-accelerated encode (NVIDIA)
npx tsx src/commands/segment-render.ts --aspect portrait --hw-accel nvenc lecture.mkv segment.json

# Hardware-accelerated encode (AMD/Intel on Linux)
npx tsx src/commands/segment-render.ts --aspect portrait --hw-accel vaapi lecture.mkv segment.json

# Faster encode, slightly larger file
npx tsx src/commands/segment-render.ts --aspect portrait --preset fast --crf 22 lecture.mkv segment.json
```

### Cover-fill crop explained

Given a 2560×1440 (16:9) source and a 9:16 portrait target:
- The source is wider than the target ratio
- Height is kept at 1440, width is cropped to `1440 × 9/16 = 810`
- The 810px crop is taken from the horizontal center
- The cropped region is scaled to the output resolution (default 1080×1920)

No black bars, no letterboxing — the frame fills the target completely.

### Notes

- Default output resolution uses 1920px on the long edge. Override with `--resolution`.
- `--preset slow` gives the best quality/size ratio. Use `--preset fast` or `--preset ultrafast` for quick previews.
- `--crf 18` is visually lossless for most content. Go up to `23` for smaller files with minimal quality loss.
- Hardware acceleration (`--hw-accel`) does not support CRF on all drivers — if encoding fails, omit `--hw-accel`.

---

## Pipelines

All pipelines start from the **original** MKV. Do not transcribe or render from distilled/silence-cut derivatives — their timestamps don't align with the original source.

### Single clip (9:16 portrait)

```bash
# 1. Extract audio from original
npx tsx src/commands/video-to-audio.ts lecture.mkv
# 2. Transcribe
npx tsx src/commands/audio-to-transcript.ts --speakers 2 lecture.audio.mp3 --source lecture.mkv
# 3. Find a 90-second segment
npx tsx src/commands/transcript-find-segment.ts --duration 90 --topic "your topic" \
  --output segment.json lecture.transcript.json
# 4. Render from the original
npx tsx src/commands/segment-render.ts --aspect portrait lecture.mkv segment.json
# 5. Tighten by removing silence in the rendered clip
npx tsx src/commands/video-remove-silence.ts --reencode lecture_<start>-<end>.mp4
```

### Topic compilation (stitched highlights from one video)

```bash
# 1–2. Audio + transcript from original (as above)
# 3. Derive a topic story
npx tsx src/commands/transcript-to-topic.ts --topic "bug discoveries" lecture.transcript.json
# 4. Filter the transcript into a compilation plan
npx tsx src/commands/topic-to-compilation.ts lecture.bug-discoveries.topic.json
# 5. Render the compilation from the ORIGINAL MKV
npx tsx src/commands/compilation-render.ts --aspect portrait lecture.bug-discoveries.compilation.json
```

### Narrative distillation (whole-session condense, for reference viewing)

```bash
# 1–2. Audio + transcript from original
# 3. Plan the distillation
npx tsx src/commands/transcript-to-distillation-plan.ts lecture.transcript.json
# 4. Render
npx tsx src/commands/distillation-render.ts lecture.distillation.json
```
Distilled videos are for watching only — do not feed them back into the pipeline.

---

## Project structure

```
video-splitter/
├── src/
│   ├── video-remove-silence.ts       # Tool 1: silence removal
│   ├── video-to-transcript.ts        # Tool 2: Whisper transcription + diarization
│   ├── transcript-find-segment.ts      # Tool 3: Claude segment detection
│   └── segment-render.ts    # Tool 4: aspect-ratio crop + encode
├── lib/
│   ├── ffmpeg.ts            # ffprobe, silencedetect, runFfmpeg helpers
│   ├── progress.ts          # ASCII progress bar
│   └── transcript.ts        # Zod schemas + read/write for JSON formats
├── .env.example             # Environment variable template
├── SPEC.md                  # Full tool specification
├── package.json
└── tsconfig.json
```

---

## Output file naming

| Tool | Default output name |
|---|---|
| `video-remove-silence` | `<input>.cut.mkv` |
| `video-to-transcript` | `<input>.transcript.json` |
| `transcript-find-segment` | stdout (use `--output` to save) |
| `segment-render` | `<input>_<start>-<end>.mp4` |
