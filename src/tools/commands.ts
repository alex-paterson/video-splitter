import { z } from "zod";
import { cliTool } from "./cli-tool.js";

export const videoToAudio = cliTool({
  name: "video_to_audio",
  description:
    "Extract a video's audio track to a 16kHz mono MP3 (written next to the source). Step 1 of the compilation pipeline.",
  script: "src/commands/video-to-audio.ts",
  positional: ["input"],
  input: z.object({
    input: z.string().describe("Path to the source video (original MKV)"),
  }),
});

export const audioToTranscript = cliTool({
  name: "audio_to_transcript",
  description:
    "Transcribe an MP3 with Whisper + multi-speaker diarization. Produces <base>.transcript.json. Step 2.",
  script: "src/commands/audio-to-transcript.ts",
  positional: ["audio"],
  negatedBoolFlags: ["diarize"],
  boolFlags: ["resume"],
  input: z.object({
    audio: z.string().describe("Path to the .audio.mp3 produced by video_to_audio"),
    source: z
      .string()
      .optional()
      .describe("Original video path to record inside the transcript (recommended)"),
    chunkMinutes: z.number().optional(),
    language: z.string().optional(),
    speakers: z.number().optional(),
    diarize: z.boolean().optional(),
    resume: z.boolean().optional(),
  }),
});

export const transcriptToTopic = cliTool({
  name: "transcript_to_topic",
  description:
    "Use Claude to derive a focused narrative/story for a given topic from a transcript. Writes <base>.<slug>.topic.json. Call multiple times with different topics to explore ideas.",
  script: "src/commands/transcript-to-topic.ts",
  positional: ["transcript"],
  input: z.object({
    transcript: z.string().describe("Path to .transcript.json"),
    topic: z.string().describe("Free-form topic/theme to derive a story for (required)"),
    maxSeconds: z.number().optional().describe("Maximum allowed total duration for the resulting compilation"),
    output: z.string().optional(),
  }),
});

export const topicToCompilation = cliTool({
  name: "topic_to_compilation",
  description:
    "Given a .topic.json, filter the referenced transcript line-by-line and save a .compilation.json plan (no rendering yet). Review this plan before rendering.",
  script: "src/commands/topic-to-compilation.ts",
  positional: ["topic"],
  input: z.object({
    topic: z.string().describe("Path to .topic.json"),
    transcript: z.string().optional(),
    source: z.string().optional(),
    maxSeconds: z.number().optional().describe("Soft ceiling hinted to the LLM. If exceeded, stderr reports OVER_MAX — call compilation_refine to iterate."),
    output: z.string().optional(),
  }),
});

export const topicToBanner = cliTool({
  name: "topic_to_banner",
  description:
    "Generate a transparent PNG banner (3-5 word headline) for a topic via the OpenAI images API. Pass the resulting path as `banner` to compilation_render or segment_render to overlay it at top-center.",
  script: "src/commands/topic-to-banner.ts",
  positional: [],
  input: z.object({
    topic: z.string().describe("Short topic phrase (3-5 words; longer auto-trimmed). The subject anchor."),
    description: z
      .string()
      .describe(
        "Longer summary/story of what actually happens in this compilation or segment. Pulled from the .topic.json 'story' field, the .compilation.json 'story', or the .segment.json 'rationale'. Used to ground the illustration in real specifics."
      ),
    output: z.string().describe("Output PNG path"),
    width: z.number().optional(),
    style: z.string().optional(),
  }),
});

export const compilationRefine = cliTool({
  name: "compilation_refine",
  description:
    "Modify an existing .compilation.json. Pass `maxSeconds` to trim to a length budget, `instruction` for free-text edits (e.g. \"remove the part where X happens\"), or both. Writes the next version (.compilation.2.json, .3.json, …). Stderr reports `DURATION: Ns MAX: Ms` and `OVER_MAX: …` when a length ceiling is given and still exceeded. Iterate by calling again on the new path.",
  script: "src/commands/compilation-refine.ts",
  positional: ["compilation"],
  input: z.object({
    compilation: z.string().describe("Path to any .compilation[.N].json"),
    maxSeconds: z.number().optional().describe("Hard ceiling in seconds (optional if instruction is provided)"),
    instruction: z.string().optional().describe("Free-text modification directive, e.g. 'drop the clip where the speaker talks about X'"),
    output: z.string().optional(),
  }),
});

export const compilationRender = cliTool({
  name: "compilation_render",
  description:
    "Render a .compilation.json plan to a single 9:16 portrait MP4 (default). Final step — only run after reviewing the plan.",
  script: "src/commands/compilation-render.ts",
  positional: ["compilation"],
  input: z.object({
    compilation: z.string().describe("Path to .compilation.json"),
    source: z.string().optional().describe("Override source video path (must be the ORIGINAL MKV)"),
    aspect: z.string().optional(),
    resolution: z.string().optional().describe("Override output WxH, e.g. 540x960 for half-res"),
    preset: z.string().optional().describe("ffmpeg preset (ultrafast|fast|medium|slow)"),
    banner: z.string().optional().describe("Optional PNG overlaid centered on the video"),
    output: z.string().optional(),
  }),
});

export const transcriptFindSegment = cliTool({
  name: "transcript_find_segment",
  description:
    "Use Claude to find a single coherent standalone segment in a transcript → .segment.json.",
  script: "src/commands/transcript-find-segment.ts",
  positional: ["transcript"],
  input: z.object({
    transcript: z.string(),
    duration: z.number().optional(),
    tolerance: z.number().optional(),
    topic: z.string().optional(),
    speaker: z.string().optional(),
    count: z.number().optional(),
    maxSeconds: z.number().optional().describe("Maximum allowed segment duration; discarded if exceeded"),
    output: z.string().optional(),
  }),
});

export const segmentRender = cliTool({
  name: "segment_render",
  description: "Render a single .segment.json to a cropped/reframed video clip. Supports hwAccel (nvenc|vaapi|videotoolbox), resolution (e.g. 540x960 for half-res), and preset for fast encodes.",
  script: "src/commands/segment-render.ts",
  positional: ["input", "segment"],
  input: z.object({
    input: z.string().describe("Source video (original MKV)"),
    segment: z.string().describe("Path to .segment.json"),
    aspect: z.string().optional(),
    resolution: z.string().optional().describe("Override output WxH, e.g. 540x960 for half-res"),
    preset: z.string().optional().describe("ffmpeg preset (ultrafast|fast|medium|slow)"),
    hwAccel: z.string().optional().describe("nvenc | vaapi | videotoolbox"),
    banner: z.string().optional().describe("Optional PNG overlaid at top-center of the output, scaled to video width"),
    output: z.string().optional(),
  }),
});

export const transcriptToDistillationPlan = cliTool({
  name: "transcript_to_distillation_plan",
  description:
    "Plan a whole-session narrative distillation → .distillation.json (keep intervals + summary). Used for reference viewing; not for compilations.",
  script: "src/commands/transcript-to-distillation-plan.ts",
  positional: ["transcript"],
  input: z.object({
    transcript: z.string(),
    targetMinutes: z.number().optional(),
    focus: z.string().optional(),
    output: z.string().optional(),
  }),
});

export const distillationRender = cliTool({
  name: "distillation_render",
  description: "Render a .distillation.json plan to a condensed video.",
  script: "src/commands/distillation-render.ts",
  positional: ["distillation"],
  input: z.object({
    distillation: z.string(),
    source: z.string().optional(),
    output: z.string().optional(),
  }),
});

export const transcriptToBleepPlan = cliTool({
  name: "transcript_to_bleep_plan",
  description:
    "Produce a .bleep.json of intervals to mute/beep/cut from a transcript. Either pass --words (csv) or --auto (LLM picks profanities). Writes <base>.bleep.json.",
  script: "src/commands/transcript-to-bleep-plan.ts",
  positional: ["transcript"],
  boolFlags: ["auto"],
  input: z.object({
    transcript: z.string(),
    words: z.string().optional().describe("Comma-separated words to bleep"),
    auto: z.boolean().optional(),
    topic: z.string().optional(),
    source: z.string().optional(),
    output: z.string().optional(),
  }),
});

export const videoApplyBleep = cliTool({
  name: "video_apply_bleep",
  description:
    "Apply a .bleep.json plan to an MP4 using mute (default), beep, or cut mode. Writes <base>.bleeped.mp4.",
  script: "src/commands/video-apply-bleep.ts",
  positional: ["input", "plan"],
  input: z.object({
    input: z.string(),
    plan: z.string().describe("Path to .bleep.json"),
    mode: z.string().optional().describe("mute | beep | cut (default mute)"),
    output: z.string().optional(),
  }),
});

export const videoBleep = cliTool({
  name: "video_bleep",
  description:
    "End-of-pipeline profanity bleeper. Transcribes the given MP4 itself (word-level timestamps), picks target words (--auto or --words), and mutes/beeps them. Writes <base>.bleeped.mp4 and publishes it to out/, replacing the pre-bleep file.",
  script: "src/commands/video-bleep.ts",
  positional: ["input"],
  boolFlags: ["auto"],
  input: z.object({
    input: z.string().describe("Path to final MP4 (post-silence-strip)"),
    words: z.string().optional().describe("Comma-separated words to bleep"),
    auto: z.boolean().optional().describe("Let Claude pick profanities from the transcribed clip"),
    topic: z.string().optional(),
    mode: z.string().optional().describe("mute | beep (default mute)"),
    output: z.string().optional(),
  }),
});

export const videoRemoveSilence = cliTool({
  name: "video_remove_silence",
  description:
    "Remove silent intervals from a video. Use `reencode: true` on short MP4 clips (e.g. rendered compilations/segments) to avoid audible audio repeats.",
  script: "src/commands/video-remove-silence.ts",
  positional: ["input", "output"],
  boolFlags: ["preview", "reencode"],
  input: z.object({
    input: z.string(),
    output: z.string().optional(),
    noiseDb: z.number().optional(),
    minSilence: z.number().optional(),
    pad: z.number().optional(),
    preview: z.boolean().optional(),
    reencode: z.boolean().optional(),
  }),
});
