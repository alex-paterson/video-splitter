import { z } from "zod";
import path from "path";
import fs from "fs";
import { tool } from "@strands-agents/sdk";
import { cliTool, runCli } from "./cli-tool.js";

export async function transcribeSourceFn(source: string): Promise<string> {
  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) return `ERROR: source not found: ${abs}`;
  const dir = path.dirname(abs);
  const base = path.basename(abs).replace(/\.[^.]+$/, "");
  const transcriptPath = path.join(dir, `${base}.transcript.json`);
  if (fs.existsSync(transcriptPath) && fs.statSync(transcriptPath).size > 0) {
    return transcriptPath;
  }
  const audioPath = path.join(dir, `${base}.audio.mp3`);
  if (!(fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0)) {
    await runCli("src/commands/video-to-audio.ts", [abs]);
  }
  await runCli("src/commands/audio-to-transcript.ts", [audioPath, "--source", abs]);
  return transcriptPath;
}

export const transcribeSource = tool({
  name: "transcribe_source",
  description:
    "Produce (or reuse) a .transcript.json for a source video. If a non-empty <base>.transcript.json already sits next to the source, it is returned as-is. Otherwise runs video_to_audio then audio_to_transcript. Returns the absolute transcript path.",
  inputSchema: z.object({
    source: z.string().describe("Absolute path to the source video (MKV)"),
  }),
  callback: async ({ source }: { source: string }) => {
    try {
      return await transcribeSourceFn(source);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("RUN_CANCELLED")) throw e;
      return `ERROR: ${msg}`;
    }
  },
});

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
    userPrompt: z.string().optional().describe("Original user request this work serves — forwarded to the LLM as context so it understands the broader intent."),
    output: z.string().optional(),
  }),
});

export const topicToCompilation = cliTool({
  name: "topic_to_compilation",
  description:
    "Given a .topic.json, filter the referenced transcript line-by-line and save a .compilation.json plan (no rendering yet). Review this plan before rendering.",
  script: "src/commands/topic-to-compilation.ts",
  positional: ["topic"],
  boolFlags: ["silenceStripped"],
  input: z.object({
    topic: z.string().describe("Path to .topic.json"),
    transcript: z.string().optional(),
    source: z.string().optional(),
    maxSeconds: z.number().optional().describe("Soft ceiling hinted to the LLM. If exceeded, stderr reports OVER_MAX — call compilation_refine to iterate."),
    userPrompt: z.string().optional().describe("Original user request this work serves — forwarded to the LLM as context."),
    silenceStripped: z.boolean().optional().describe("Set true when silence will be removed downstream (the default). Applies a 30% discount when comparing sum-of-clips against maxSeconds so the LLM doesn't over-trim."),
    output: z.string().optional(),
  }),
});

export const topicToBanner = cliTool({
  name: "topic_to_banner",
  description:
    "Generate a pictorial transparent PNG banner for a topic via the OpenAI images API. Pass the resulting path to caption_plan via --banner so it's overlaid in the same Remotion render as captions.",
  script: "src/commands/topic-to-banner.ts",
  positional: [],
  input: z.object({
    topic: z.string().describe("Short topic phrase (3-5 words; longer auto-trimmed). The subject anchor."),
    description: z
      .string()
      .describe(
        "Longer summary/story of what actually happens in this compilation/segment. Pull from the .topic.json 'story', the .compilation.json 'story', or the .segment.json 'rationale'. Grounds the illustration in real specifics."
      ),
    userPrompt: z
      .string()
      .optional()
      .describe("Original user request — shapes imagery tone/style/mood. Forward verbatim when available."),
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
  boolFlags: ["silenceStripped"],
  input: z.object({
    compilation: z.string().describe("Path to any .compilation[.N].json"),
    transcript: z.string().optional().describe("Override transcript path. Default: derived from compilation.source (replacing extension with .transcript.json). When loaded, refine may ADD new material from the transcript, not just drop/shrink existing clips."),
    maxSeconds: z.number().optional().describe("Hard ceiling in seconds (optional if instruction is provided)"),
    instruction: z.string().optional().describe("Free-text modification directive, e.g. 'drop the clip where the speaker talks about X'"),
    userPrompt: z.string().optional().describe("Original user request this work serves — forwarded to the LLM as context."),
    silenceStripped: z.boolean().optional().describe("Set true when silence will be removed downstream (the default). Applies a 30% discount when comparing current duration against maxSeconds so the LLM doesn't over-trim."),
    output: z.string().optional(),
  }),
});

export const compilationRender = cliTool({
  name: "compilation_render",
  description:
    "Render a .compilation.json plan to a single 9:16 portrait MP4 (default). Final step for the creator — only run after reviewing the plan. Banners are NOT applied here; they are overlaid by the post-processor via Remotion (caption_plan --banner + video_caption_render).",
  script: "src/commands/compilation-render.ts",
  positional: ["compilation"],
  input: z.object({
    compilation: z.string().describe("Path to .compilation.json"),
    source: z.string().optional().describe("Override source video path (must be the ORIGINAL MKV)"),
    aspect: z.string().optional(),
    resolution: z.string().optional().describe("Override output WxH, e.g. 540x960 for half-res"),
    preset: z.string().optional().describe("ffmpeg preset (ultrafast|fast|medium|slow)"),
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
    userPrompt: z.string().optional().describe("Original user request this work serves — forwarded to the LLM as context."),
    output: z.string().optional(),
  }),
});

export const segmentRender = cliTool({
  name: "segment_render",
  description: "Render a single .segment.json to a cropped/reframed video clip. Supports hwAccel (nvenc|vaapi|videotoolbox), resolution (e.g. 540x960 for half-res), and preset for fast encodes. Banners are NOT applied here; the post-processor overlays them via Remotion.",
  script: "src/commands/segment-render.ts",
  positional: ["input", "segment"],
  input: z.object({
    input: z.string().describe("Source video (original MKV)"),
    segment: z.string().describe("Path to .segment.json"),
    aspect: z.string().optional(),
    resolution: z.string().optional().describe("Override output WxH, e.g. 540x960 for half-res"),
    preset: z.string().optional().describe("ffmpeg preset (ultrafast|fast|medium|slow)"),
    hwAccel: z.string().optional().describe("nvenc | vaapi | videotoolbox"),
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

export const videoPublish = cliTool({
  name: "video_publish",
  description:
    "Publish the FINAL MP4 to out/. Call this exactly once at the very end of a production run, after all silence-stripping / bleeping / refinement is complete. Input path is typically in tmp/. Optionally pass replace=<path> to remove a previously-published file with a different basename.",
  script: "src/commands/video-publish.ts",
  positional: ["input"],
  input: z.object({
    input: z.string().describe("Path to the final MP4 (usually in tmp/)"),
    replace: z.string().optional().describe("Prior published filename to remove before copying"),
  }),
});

export const captionPlan = cliTool({
  name: "caption_plan",
  description:
    "Build a reviewable .caption.json plan from a .words.json. Phrase segmentation is deterministic (word gaps + max-words + sentence-end splits). Styling comes from `style` preset + optional overrides; title is optional. Consumed by video_caption_render. Refine via caption_refine.",
  script: "src/commands/caption-plan.ts",
  positional: ["wordsJson"],
  boolFlags: ["oneWordAtATime"],
  input: z.object({
    wordsJson: z.string().describe("Path to .words.json produced by transcript_project_words"),
    output: z.string().optional().describe("Output .caption.json path (default: <mp4-base>.caption.json)"),
    style: z
      .string()
      .optional()
      .describe("Style preset: default | bold-yellow | bold-red | clean-white | minimal"),
    fontColor: z.string().optional(),
    fontName: z.string().optional().describe("Must match a file under src/remotion/fonts"),
    fontSize: z.number().optional(),
    strokeWidth: z.number().optional(),
    strokeColor: z.string().optional(),
    textShadow: z.string().optional(),
    verticalAlign: z.string().optional().describe("top | middle | bottom"),
    horizontalAlign: z.string().optional().describe("left | center | right"),
    paddingVertical: z.number().optional(),
    paddingHorizontal: z.number().optional(),
    oneWordAtATime: z.boolean().optional(),
    highlightColor: z.string().optional(),
    animation: z.string().optional().describe("none | pop-in | fade-in | slide-in"),
    capitalization: z.string().optional().describe("none | uppercase"),
    backgroundColor: z.string().optional().describe("CSS color or 'transparent'"),
    phraseGapSec: z.number().optional(),
    maxWordsPerPhrase: z.number().optional(),
    fps: z.number().optional(),
    title: z.string().optional().describe("Optional static title rendered for the full clip"),
    titleStyle: z.string().optional().describe("Title preset; falls back to main --style"),
    titleFontColor: z.string().optional(),
    titleFontName: z.string().optional(),
    titleFontSize: z.number().optional(),
    titleStrokeWidth: z.number().optional(),
    titleStrokeColor: z.string().optional(),
    titleVerticalAlign: z.string().optional(),
    titleHorizontalAlign: z.string().optional(),
    titlePaddingVertical: z.number().optional(),
    titlePaddingHorizontal: z.number().optional(),
    titleCapitalization: z.string().optional(),
    titleBackgroundColor: z.string().optional(),
    banner: z.string().optional().describe("Absolute path to a PNG to overlay (aspect-scaled). Use topic_to_banner to generate one first."),
    bannerVerticalAlign: z.string().optional().describe("top | middle | bottom (default top)"),
    bannerHorizontalAlign: z.string().optional().describe("left | center | right (default center)"),
    bannerMaxWidthPct: z.number().optional().describe("Max banner width as a fraction of canvas width (default 0.9)"),
    bannerMaxHeightPct: z.number().optional().describe("Max banner height as a fraction of canvas height (default 0.35)"),
    bannerPaddingPx: z.number().optional().describe("Padding between banner bounding box and canvas edge (default 40)"),
    bannerOpacity: z.number().optional().describe("Opacity 0..1 (default 1.0)"),
    bannerStartSec: z.number().optional().describe("When banner appears (default 0)"),
    bannerEndSec: z.number().optional().describe("When banner disappears (default full duration)"),
  }),
});

export const transcriptProjectWords = cliTool({
  name: "transcript_project_words",
  description:
    "Build a .words.json for a rendered MP4 by projecting word timings from the ORIGINAL .transcript.json onto the output timeline (clips + optional silence removal). Never re-transcribes the cut MP4. Consumed by caption_plan and framer_filter (llm mode).",
  script: "src/commands/transcript-project-words.ts",
  positional: [],
  input: z.object({
    sourceTranscript: z.string().describe("Path to the original .transcript.json (must be schema v2 with words[])"),
    compilation: z.string().optional().describe("Path to .compilation[.N].json that produced the MP4 (exclusive with segment)"),
    segment: z.string().optional().describe("Path to .segment.json that produced the MP4 (exclusive with compilation)"),
    silence: z.string().optional().describe("Path to .silence.json (auto-detected as <mp4>.silence.json)"),
    mp4: z.string().optional().describe("Rendered MP4 path (for output naming + video dimensions)"),
    output: z.string().optional(),
  }),
});

export const videoSceneDetect = cliTool({
  name: "video_scene_detect",
  description:
    "Detect scene cuts in an MP4 (ffmpeg pixel-diff, optional luma-jump + silence-end). Writes <base>.scenes.json. First step of the reframe pipeline.",
  script: "src/commands/video-scene-detect.ts",
  positional: ["mp4"],
  boolFlags: ["includeLuma", "includeSilence"],
  input: z.object({
    mp4: z.string().describe("Input MP4"),
    pixelThreshold: z.number().optional().describe("ffmpeg scene filter threshold [0..1] (default 0.3)"),
    includeLuma: z.boolean().optional(),
    includeSilence: z.boolean().optional(),
    minScene: z.number().optional().describe("Drop scenes shorter than this many seconds"),
    output: z.string().optional(),
  }),
});

export const videoFramerDetect = cliTool({
  name: "video_framer_detect",
  description:
    "Extract midpoint frames for each scene in <scenes-json> and run Claude vision to detect software-window region candidates per scene. Writes <base>.framer.json (all candidates, unfiltered). Feed into framer_filter next.",
  script: "src/commands/video-framer-detect.ts",
  positional: ["mp4", "scenesJson"],
  boolFlags: ["keepFrames"],
  input: z.object({
    mp4: z.string(),
    scenesJson: z.string().describe("Path to .scenes.json"),
    framesPerScene: z.number().optional(),
    model: z.string().optional(),
    keepFrames: z.boolean().optional(),
    output: z.string().optional(),
  }),
});

export const framerFilter = cliTool({
  name: "framer_filter",
  description:
    "Reduce each scene in <framer-json> to exactly one chosen region. mode=biggest picks the largest-area region; mode=llm uses Claude + per-scene transcript excerpts to pick the region that matches what's being said. Writes <base>.framer.filtered.json.",
  script: "src/commands/framer-filter.ts",
  positional: ["framerJson"],
  input: z.object({
    framerJson: z.string().describe("Path to .framer.json"),
    mode: z.string().optional().describe("biggest | llm (default biggest)"),
    words: z.string().optional().describe("Path to .words.json (used in mode=llm for transcript context)"),
    model: z.string().optional(),
    output: z.string().optional(),
  }),
});

export const videoReframeRender = cliTool({
  name: "video_reframe_render",
  description:
    "Reframe an MP4 to a target aspect using a .framer.filtered.json: per-scene blurred background + centered crop of the chosen region. Writes <base>.reframed.mp4. Defaults to 1080x1920 portrait.",
  script: "src/commands/video-reframe-render.ts",
  positional: ["mp4", "filteredJson"],
  input: z.object({
    mp4: z.string(),
    filteredJson: z.string().describe("Path to .framer.filtered[.N].json"),
    width: z.number().optional(),
    height: z.number().optional(),
    preset: z.string().optional(),
    crf: z.number().optional(),
    output: z.string().optional(),
  }),
});

export const framerRefine = cliTool({
  name: "framer_refine",
  description:
    "Modify which region is chosen per scene in a .framer.filtered[.N].json. Loads the unfiltered .framer.json (all candidates) + optional .words.json (per-scene transcript) and picks a different candidate per scene based on the instruction. Writes the next .framer.filtered.N.json. Feed to video_reframe_render to see the result.",
  script: "src/commands/framer-refine.ts",
  positional: ["filteredJson"],
  input: z.object({
    filteredJson: z.string().describe("Path to .framer.filtered[.N].json"),
    instruction: z
      .string()
      .describe("Free-text modification, e.g. 'use the github window instead of the terminal when we were discussing code'"),
    unfiltered: z.string().optional().describe("Override .framer.json (default: derived by stripping .filtered)"),
    words: z.string().optional().describe("Optional .words.json for transcript context per scene"),
    userPrompt: z.string().optional(),
    output: z.string().optional(),
  }),
});

export const captionRefine = cliTool({
  name: "caption_refine",
  description:
    "Modify an existing .caption.json via a free-text instruction. Can edit phrase text (e.g. inject '$' or fix homophones), style fields (color/font/size/alignment/animation/etc.), or the title. Writes the next .caption.N.json. Pass to video_caption_render to produce a new captioned MP4.",
  script: "src/commands/caption-refine.ts",
  positional: ["captionJson"],
  input: z.object({
    captionJson: z.string().describe("Path to .caption[.N].json"),
    instruction: z
      .string()
      .describe("Free-text modification (e.g. 'add $ before 19 in the money phrase', 'change font color to red')"),
    words: z.string().optional().describe("Override .words.json path (default: plan.words_source)"),
    userPrompt: z.string().optional().describe("Original user request — forwarded to the LLM as context"),
    output: z.string().optional(),
  }),
});

export const videoCaptionRender = cliTool({
  name: "video_caption_render",
  description:
    "Burn captions onto an MP4 from a .caption.json plan (Remotion render). No style flags — all styling lives in the plan. Writes <mp4-base>.captioned.mp4 next to the source. Returns the output path on stdout.",
  script: "src/commands/video-caption-render.ts",
  positional: ["mp4", "captionJson"],
  input: z.object({
    mp4: z.string().describe("Input MP4 to caption (usually a compilation.cut.bleeped.mp4)"),
    captionJson: z.string().describe("Path to .caption[.N].json plan"),
    output: z.string().optional().describe("Output path (default: <mp4-base>.captioned.mp4)"),
    concurrency: z.number().optional().describe("Remotion render concurrency (default 4)"),
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
