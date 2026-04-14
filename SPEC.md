# Video Splitter — Tool Specification

A collection of standalone TypeScript CLI executables for processing large (60GB+) MKV video files. Each tool is independently runnable and composable via shell pipelines or scripting. All tools are built to handle large files efficiently via streaming and chunking.

---

## Architecture Overview

```
video-splitter/
├── src/
│   ├── silence-cut.ts        # Remove silence from video
│   ├── transcribe.ts         # Multi-speaker diarization + transcription
│   ├── find-segment.ts       # LLM-assisted coherent segment detection
│   └── render-segment.ts     # Render a segment in a target aspect ratio
├── lib/
│   ├── ffmpeg.ts             # ffmpeg wrapper utilities
│   ├── chunker.ts            # Large file streaming/chunking helpers
│   └── transcript.ts         # Transcript file format types + I/O
├── package.json
├── tsconfig.json
└── SPEC.md
```

### Shared data formats

**Transcript file** (`.transcript.json`) — output of `transcribe`, input to `find-segment`:

```json
{
  "source": "/path/to/input.mkv",
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

**Segment file** (`.segment.json`) — output of `find-segment`, input to `render-segment`:

```json
{
  "source": "/path/to/input.mkv",
  "start_s": 120.5,
  "end_s": 245.0,
  "title": "Introduction to the topic",
  "rationale": "Self-contained explanation of X with clear beginning and end.",
  "speakers": ["SPEAKER_01"]
}
```

---

## Tool 1 — `silence-cut`

**Purpose:** Remove periods of silence from a video, producing a tighter cut. Designed to stream through 60GB+ files without loading them into memory.

**Binary:** `npx ts-node src/silence-cut.ts`

**Dependencies:** `ffmpeg` (system), `fluent-ffmpeg` (npm)

### CLI

```
silence-cut [options] <input> [output]

Arguments:
  input                  Path to input MKV (or any ffmpeg-supported format)
  output                 Output path (default: <input-basename>.cut.mkv)

Options:
  --noise-db <dB>        Silence threshold in dBFS (default: -35)
  --min-silence <s>      Minimum silence duration to cut, seconds (default: 0.5)
  --pad <s>              Seconds of silence to keep at each cut boundary (default: 0.1)
  --preview              Print detected silence intervals without writing output
  --format <ext>         Output container format (default: mkv)
  --threads <n>          ffmpeg thread count (default: 0 = auto)
```

### Behavior

1. Run `ffmpeg`'s `silencedetect` audio filter over the input file to detect silent intervals. Parse stdout as the filter emits `silence_start` / `silence_end` lines.
2. Build a list of "keep" time ranges (the inverse of silence), with configurable padding on each boundary.
3. Use `ffmpeg`'s segment concat approach: write a concat demuxer input list of trimmed segments, then mux into the output container. All video/audio streams are copied (no re-encode) unless the source container is incompatible with segment copy, in which case the user is warned and stream copy is still attempted.
4. Progress is reported to stderr as a percentage of total duration processed.

### Performance notes

- `silencedetect` is a fast single-pass audio scan. For 60 GB files it runs in roughly real-time or faster depending on codec.
- Segment copy avoids re-encoding, keeping processing fast even for large files.
- Temporary concat list is written to a system temp directory and cleaned up on exit.

---

## Tool 2 — `transcribe`

**Purpose:** Produce a multi-speaker diarized transcript of the video's audio track, saved as a `.transcript.json` file.

**Binary:** `npx ts-node src/transcribe.ts`

**Dependencies:** `ffmpeg` (system), `openai` (npm — Whisper API), `@anthropic-ai/sdk` optional post-processing

### CLI

```
transcribe [options] <input> [output]

Arguments:
  input                  Path to input MKV
  output                 Transcript output path (default: <input-basename>.transcript.json)

Options:
  --chunk-minutes <n>    Audio chunk size for API uploads, minutes (default: 10)
  --language <lang>      ISO-639-1 language hint for Whisper (default: auto-detect)
  --speakers <n>         Expected number of speakers, hint for diarization (default: auto)
  --diarize              Enable speaker diarization (default: true)
  --no-diarize           Disable speaker diarization (transcript only)
  --model <model>        Whisper model (default: whisper-1)
  --resume               Resume a partial transcript (skip already-transcribed chunks)
```

### Behavior

1. **Audio extraction:** Extract audio from the MKV to a temporary 16kHz mono WAV/MP3 using ffmpeg. Done via pipe/stream — no full-file temp copy needed for extraction, but chunks are staged to disk to meet API upload requirements.
2. **Chunking:** Split audio into `--chunk-minutes` chunks. Each chunk is uploaded independently to the OpenAI Whisper API (`audio.transcriptions.create`) with `response_format: "verbose_json"` to get word-level timestamps.
3. **Diarization:** Use the `pyannote`-style approach via a local or remote diarization service, **or** use a heuristic based on silence gaps + Whisper speaker turns if no external service is configured. The recommended path is to call the **AssemblyAI** diarization API or use a locally running `pyannote/speaker-diarization` model via a sidecar REST endpoint. Both are supported; selection is via `DIARIZE_BACKEND` env var (`assemblyai` | `pyannote-local` | `whisper-heuristic`).
4. **Merging:** Align Whisper word timestamps with diarization speaker windows to produce per-segment speaker labels.
5. **Output:** Write `.transcript.json` in the shared format.
6. **Resume support:** If `--resume` is passed and a partial `.transcript.json` exists, already-transcribed chunk ranges are skipped.

### Environment variables

```
OPENAI_API_KEY          Required for Whisper
ASSEMBLYAI_API_KEY      Required if DIARIZE_BACKEND=assemblyai
DIARIZE_BACKEND         assemblyai | pyannote-local | whisper-heuristic (default)
PYANNOTE_ENDPOINT       URL for local pyannote sidecar (default: http://localhost:8000)
```

---

## Tool 3 — `find-segment`

**Purpose:** Use an LLM to analyze a transcript and identify a coherent, standalone video segment within a specified approximate duration.

**Binary:** `npx ts-node src/find-segment.ts`

**Dependencies:** `@anthropic-ai/sdk` (npm)

### CLI

```
find-segment [options] <transcript>

Arguments:
  transcript             Path to .transcript.json file

Options:
  --duration <s>         Target segment duration in seconds (default: 60)
  --tolerance <s>        Acceptable deviation from target duration (default: 30)
  --topic <text>         Optional topic/theme hint for the LLM
  --speaker <id>         Restrict search to segments dominated by this speaker
  --min-speakers <n>     Minimum number of speakers that must appear (default: 1)
  --count <n>            Number of candidate segments to return (default: 1)
  --output <path>        Write .segment.json to this path (default: stdout)
  --model <model>        Claude model to use (default: claude-opus-4-6)
```

### Behavior

1. Load the `.transcript.json` file.
2. Build a prompt that includes the full transcript (or a windowed subset for very long transcripts) plus the target duration, topic hint, and any speaker constraints.
3. Send to the Claude API with a structured output schema (JSON tool use) requesting one or more candidate segments with `start_s`, `end_s`, `title`, and `rationale` fields.
4. Validate that each returned segment:
   - Falls within the actual transcript time range.
   - Meets the duration target ± tolerance.
   - Begins and ends at natural speech boundaries (sentence-start / sentence-end), not mid-word.
5. If `--count > 1`, return an array of non-overlapping candidates, ranked by coherence score from the LLM.
6. Write `.segment.json` (or an array thereof) to `--output` or stdout.

### LLM prompt strategy

The LLM is instructed to:
- Prefer segments that start at the beginning of a thought or sentence and end at a natural conclusion.
- Avoid segments that begin with a pronoun referring to something outside the clip ("as I was saying", "that thing we discussed").
- Prefer segments with a clear single topic.
- Return timestamps that align with the nearest segment boundary in the transcript (to avoid mid-word cuts).

### Environment variables

```
ANTHROPIC_API_KEY       Required
```

---

## Tool 4 — `render-segment`

**Purpose:** Extract and render a video segment from the source MKV, reframed to a target aspect ratio using center-fill cropping.

**Binary:** `npx ts-node src/render-segment.ts`

**Dependencies:** `ffmpeg` (system), `fluent-ffmpeg` (npm)

### CLI

```
render-segment [options] <input> [segment]

Arguments:
  input                  Path to source MKV
  segment                Path to .segment.json (or JSON string); if omitted, reads stdin

Options:
  --aspect <ratio>       Target aspect ratio as W:H (default: 9:16)
  --resolution <res>     Output resolution, e.g. 1080x1920 (default: derived from aspect + source height)
  --fill                 Crop to fill (default). Center crop, no letterbox/pillarbox.
  --fit                  Fit instead of fill (adds bars)
  --crf <n>              Output CRF quality (default: 18)
  --preset <preset>      ffmpeg encoding preset (default: slow)
  --codec <codec>        Video codec (default: libx264)
  --audio-codec <codec>  Audio codec (default: aac)
  --audio-bitrate <br>   Audio bitrate (default: 192k)
  --format <ext>         Output container (default: mp4)
  --output <path>        Output file path (default: <source-stem>_<start>-<end>.<format>)
  --threads <n>          ffmpeg thread count (default: 0 = auto)
  --hw-accel <api>       Hardware acceleration: nvenc | vaapi | videotoolbox (optional)
```

### Behavior

1. Load the `.segment.json` to get `source`, `start_s`, `end_s`.
2. Probe the source file with `ffprobe` to get the original width, height, SAR, DAR, and frame rate.
3. Compute the crop rectangle for cover-fill from center:
   - Given original dimensions `(W, H)` and target ratio `(tw, th)`:
     - If `W/H > tw/th` (source is wider than target): crop width to `H * tw/th`, center horizontally.
     - Else: crop height to `W * th/tw`, center vertically.
   - Scale the cropped region to the output resolution.
4. Build ffmpeg filter chain: `trim` → `crop` → `scale` → `setsar=1`.
5. Encode with the specified codec. Hardware acceleration is applied at the encoder level if `--hw-accel` is set.
6. Report progress to stderr.
7. Write output file.

### Aspect ratio presets

| Name        | Ratio   | Common use         |
|-------------|---------|---------------------|
| `portrait`  | `9:16`  | TikTok, Reels, Shorts |
| `square`    | `1:1`   | Instagram feed      |
| `landscape` | `16:9`  | YouTube, Twitter    |
| `cinema`    | `21:9`  | Widescreen          |

Named presets can be passed to `--aspect` instead of `W:H`.

---

## Composing the tools

### Full pipeline example

```bash
# 1. Remove silence
silence-cut --noise-db -40 --min-silence 0.8 lecture.mkv lecture.cut.mkv

# 2. Transcribe with diarization
transcribe --chunk-minutes 15 --speakers 2 lecture.cut.mkv

# 3. Find a coherent 90-second segment on a topic
find-segment --duration 90 --tolerance 20 --topic "introduction to neural networks" \
  lecture.cut.transcript.json > segment.json

# 4. Render as 9:16 portrait video
render-segment --aspect 9:16 --output clip.mp4 lecture.cut.mkv segment.json
```

### Stdin/stdout piping

`find-segment` writes JSON to stdout by default; `render-segment` reads segment JSON from stdin if no file argument is given, enabling:

```bash
find-segment --duration 60 transcript.json | render-segment --aspect 1:1 source.mkv
```

---

## Dependencies

### System requirements

| Tool     | Version  | Purpose                        |
|----------|----------|--------------------------------|
| `ffmpeg` | ≥ 6.0    | All video/audio processing     |
| `ffprobe`| ≥ 6.0    | Media probing (bundled with ffmpeg) |
| Node.js  | ≥ 20.0   | Runtime                        |

### npm packages

| Package              | Used by                 | Purpose                          |
|----------------------|-------------------------|----------------------------------|
| `fluent-ffmpeg`      | silence-cut, render-segment | ffmpeg process wrapper      |
| `@ffprobe-installer/ffprobe` | render-segment  | Bundled ffprobe binary           |
| `openai`             | transcribe              | Whisper transcription API        |
| `@anthropic-ai/sdk`  | find-segment            | Claude segment detection         |
| `commander`          | all                     | CLI argument parsing             |
| `zod`                | all                     | Runtime schema validation        |
| `tsx` / `ts-node`    | all                     | TypeScript execution             |

### Optional / diarization backends

| Package / Service    | Purpose                             |
|----------------------|-------------------------------------|
| AssemblyAI API       | Cloud speaker diarization           |
| pyannote (local)     | Local speaker diarization via sidecar |
| ElevenLabs API       | Future: voice cloning / re-dubbing  |

---

## Error handling & large file considerations

- All tools use streaming I/O for audio/video data; no tool requires the full file in memory.
- ffmpeg processes are spawned as child processes; stdout/stderr are streamed and parsed incrementally.
- API calls (Whisper, Claude) are retried up to 3 times with exponential backoff on transient errors (5xx, rate limit 429).
- Chunk temp files are written to `os.tmpdir()` and cleaned up on process exit (including SIGINT).
- All tools write to a `.lock` file alongside their output during processing; if a lock file is present and the process is not running, the user is warned of a possible incomplete prior run.

---

## Future tools (planned, not yet specified)

- **`elevenlabs-dub`** — Replace a speaker's voice using ElevenLabs voice cloning, aligned to the diarization transcript.
- **`chapter-cut`** — Split a long video into chapters based on LLM-detected topic boundaries in the transcript.
- **`highlight-reel`** — Automatically select and assemble multiple coherent segments into a highlight reel of a target total duration.
- **`subtitle-burn`** — Burn styled subtitles (from transcript) into a rendered segment, with optional speaker color coding.
