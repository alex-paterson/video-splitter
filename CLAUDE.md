# Video Splitter — Project Rules

## Clipping pipeline

The correct end-to-end pipeline for making a clip is:

1. **Transcribe the original MKV** — Whisper timestamps are accurate on originals (natural silences act as anchors). Never transcribe distilled files; abrupt cuts between speech segments confuse Whisper and cause timestamp drift.
2. **`find-segment`** on the original transcript.
3. **`render-segment`** from the original MKV.
4. **`silence-cut --reencode`** the rendered clip to strip silences. Always use `--reencode` on already-encoded clips — the default concat-demuxer mode causes audible audio repeats at cut points on short MP4s.

The distilled file is for watching/reference only — not for transcribing or rendering from.

## File locations

- Always write `.segment.json` files to the same directory as the source video (e.g. `~/OBS/`), never to `/tmp/`.
