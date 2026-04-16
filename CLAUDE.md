# Video Splitter — Project Rules

## Clipping pipeline

The correct end-to-end pipeline for making a clip is:

1. **`video-to-transcript`** the original MKV — Whisper timestamps are accurate on originals (natural silences act as anchors). Never transcribe distilled files; abrupt cuts between speech segments confuse Whisper and cause timestamp drift.
2. **`transcript-find-segment`** on the original transcript.
3. **`segment-render`** from the original MKV.
4. **`video-remove-silence --reencode`** the rendered clip to strip silences. Always use `--reencode` on already-encoded clips — the default concat-demuxer mode causes audible audio repeats at cut points on short MP4s.

The distilled file is for watching/reference only — not for transcribing or rendering from.

## File locations

- Always write `.segment.json` files to the same directory as the source video (e.g. `~/OBS/`), never to `/tmp/`.
- **`out/` is publish-only.** The ONLY tool that writes to `out/` is `video-publish`. Every other artifact — transcripts, `.compilation.json`, `.segment.json`, `.caption.json`, `.framer.*.json`, `.words.json`, `.scenes.json`, intermediate MP4s (`.cut`, `.bleeped`, `.reframed`, `.captioned`) — lives in `tmp/`. When modifying a previously-published clip, always work on its `tmp/` counterpart (same basename), never on the `out/` copy.

## Post-processing (captions & reframe)

These operate on an already-rendered MP4 (a compilation or segment output), not on the original MKV.

- **Never re-transcribe a cut MP4.** Even with word-level granularity, cuts across silence/speech confuse Whisper. Instead use `transcript-project-words` to shift the original transcript's word timings onto the compiled timeline (accounts for compilation clips + `.silence.json`). This requires the original `.transcript.json` to be schema v2 (re-run `audio-to-transcript` if it's v1).
- **Caption pipeline:** `transcript-project-words` → `caption-plan` (deterministic; style preset + overrides; builds phrases from words; optional `--banner <png>` + alignment/scale flags; optional `--title`) → `video-caption-render` (single Remotion pass burns captions + optional title + optional banner). Refine via `caption-refine` → writes `.caption.N.json`, then re-render.
- **Banner pipeline:** `topic-to-banner` (OpenAI images API) is invoked by `agent_post_processor` with topic + description (story/rationale from the sidecar JSON) + userPrompt (verbatim top-level request). The resulting PNG goes into `caption-plan --banner`, so the banner is overlaid in the same Remotion render as captions — never a second render pass. Default banner position: aspect scale-to-fit, top-center, max 90% width × 35% height. Creator agents do NOT handle banners.
- **Reframe pipeline:** `video-scene-detect` (ffmpeg pixel-diff) → `video-framer-detect` (Claude vision per scene midpoint frame; writes `.framer.json` with all candidates) → `framer-filter` (biggest-area or llm mode) → `video-reframe-render` (per-scene blurred bg + centered crop, then concat). Refine via `framer-refine` → writes `.framer.filtered.N.json`, then re-render.
- **When both are requested, always reframe FIRST, then caption.** Captions depend on the final canvas dimensions.
- **Styling lives in the `.caption.json` sidecar, not CLI flags.** This is what makes refinement possible: `caption-refine` can edit phrase text (e.g. inject `$`), style (color/font/size), or title. Word timings remain pinned to the original transcript via `words_source`.
- **Publish once, at the end, with `video-publish --replace`** pointing at the prior published path so `out/` only ever contains the current version of each clip.
