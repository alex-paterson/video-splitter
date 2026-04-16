import { z } from "zod";
import fs from "fs";
import path from "path";

export const HorizontalAlignmentSchema = z.enum(["left", "center", "right"]);
export const VerticalAlignmentSchema = z.enum(["top", "middle", "bottom"]);
export const TextAnimationSchema = z.enum(["none", "pop-in", "fade-in", "slide-in"]);
export const TextCapitalizationSchema = z.enum(["none", "uppercase"]);

export const CaptionStyleSchema = z.object({
  fontColor: z.string(),
  fontName: z.string(),
  fontSizePx: z.number(),
  strokeWidth: z.number(),
  strokeColor: z.string(),
  textShadow: z.string(),
  verticalCaptionAlignment: VerticalAlignmentSchema,
  horizontalCaptionAlignment: HorizontalAlignmentSchema,
  paddingVerticalPx: z.number(),
  paddingHorizontalPx: z.number(),
  oneWordAtATime: z.boolean(),
  textHighlightColor: z.string(),
  textAnimation: TextAnimationSchema,
  textCapitalization: TextCapitalizationSchema,
  backgroundColor: z.string(),
  phraseGapSec: z.number(),
  fps: z.number(),
});

export const PhraseWordSchema = z.object({
  text: z.string(),
  start: z.number(),
});

export const PhraseSchema = z.object({
  index: z.number().int(),
  start: z.number(),
  end: z.number(),
  words: z.array(PhraseWordSchema),
});

export const CaptionTitleSchema = z.object({
  text: z.string(),
  style: CaptionStyleSchema,
});

export const CaptionPlanSchema = z.object({
  source_mp4: z.string(),
  words_source: z.string(),
  videoWidth: z.number(),
  videoHeight: z.number(),
  durationSec: z.number(),
  style: CaptionStyleSchema,
  title: CaptionTitleSchema.optional(),
  phrases: z.array(PhraseSchema),
});

export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;
export type Phrase = z.infer<typeof PhraseSchema>;
export type PhraseWord = z.infer<typeof PhraseWordSchema>;
export type CaptionTitle = z.infer<typeof CaptionTitleSchema>;
export type CaptionPlan = z.infer<typeof CaptionPlanSchema>;

export const DEFAULT_STYLE: CaptionStyle = {
  fontColor: "#FFFFFF",
  fontName: "Anton-Regular",
  fontSizePx: 80,
  strokeWidth: 4,
  strokeColor: "#000000",
  textShadow: "0 4px 12px rgba(0,0,0,0.6)",
  verticalCaptionAlignment: "bottom",
  horizontalCaptionAlignment: "center",
  paddingVerticalPx: 200,
  paddingHorizontalPx: 100,
  oneWordAtATime: false,
  textHighlightColor: "#5FFF93",
  textAnimation: "fade-in",
  textCapitalization: "uppercase",
  backgroundColor: "transparent",
  phraseGapSec: 0.8,
  fps: 30,
};

export const DEFAULT_TITLE_STYLE: CaptionStyle = {
  ...DEFAULT_STYLE,
  fontSizePx: 70,
  strokeWidth: 5,
  verticalCaptionAlignment: "top",
  paddingVerticalPx: 80,
  paddingHorizontalPx: 60,
};

export const STYLE_PRESETS: Record<string, Partial<CaptionStyle>> = {
  default: {},
  "bold-yellow": {
    fontColor: "#FFD400",
    fontName: "Montserrat-Black",
    textHighlightColor: "#FFFFFF",
    strokeWidth: 6,
  },
  "bold-red": {
    fontColor: "#FF2D2D",
    fontName: "Montserrat-Black",
    textHighlightColor: "#FFFFFF",
    strokeWidth: 6,
  },
  "clean-white": {
    fontColor: "#FFFFFF",
    fontName: "Inter-Black",
    textHighlightColor: "#5FFF93",
    strokeWidth: 3,
    textShadow: "0 2px 8px rgba(0,0,0,0.5)",
  },
  minimal: {
    fontColor: "#FFFFFF",
    fontName: "Inter-Bold",
    textHighlightColor: "#FFFFFF",
    strokeWidth: 0,
    textShadow: "0 2px 4px rgba(0,0,0,0.8)",
    textCapitalization: "none",
    fontSizePx: 64,
  },
};

export function applyPreset(name: string | undefined, overrides: Partial<CaptionStyle> = {}): CaptionStyle {
  const preset = (name && STYLE_PRESETS[name]) || {};
  return CaptionStyleSchema.parse({ ...DEFAULT_STYLE, ...preset, ...overrides });
}

export function applyTitlePreset(
  name: string | undefined,
  overrides: Partial<CaptionStyle> = {},
): CaptionStyle {
  const preset = (name && STYLE_PRESETS[name]) || {};
  return CaptionStyleSchema.parse({ ...DEFAULT_TITLE_STYLE, ...preset, ...overrides });
}

export interface WordTiming {
  start_s: number;
  end_s: number;
  word: string;
}

/**
 * Build phrases from a flat words array.
 * Split rules (mirrors video-framer's resegment):
 *   1. Word gap > gapSec
 *   2. Phrase length >= maxWords
 *   3. Sentence end (. ! ?) AND phrase length >= max(3, maxWords - 2)
 */
export function phrasesFromWords(
  words: WordTiming[],
  opts: { maxWords?: number; gapSec?: number } = {},
): Phrase[] {
  const maxWords = Math.max(1, opts.maxWords ?? 8);
  const gapSec = opts.gapSec ?? 0.6;
  const phrases: Phrase[] = [];
  let cur: WordTiming[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const start = cur[0].start_s;
    const end = cur[cur.length - 1].end_s;
    phrases.push({
      index: phrases.length,
      start,
      end,
      words: cur.map((w) => ({ text: w.word.trim(), start: w.start_s - start })),
    });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1];
      const gap = w.start_s - last.end_s;
      const endsSentence = /[.!?]$/.test(last.word.trim());
      if (gap > gapSec || cur.length >= maxWords || (endsSentence && cur.length >= Math.max(3, maxWords - 2))) {
        flush();
      }
    }
    cur.push(w);
  }
  flush();
  return phrases;
}

export function loadCaptionPlan(p: string): CaptionPlan {
  return CaptionPlanSchema.parse(JSON.parse(fs.readFileSync(p, "utf-8")));
}

export function saveCaptionPlan(p: string, plan: CaptionPlan): void {
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
}

/**
 * Given a desired output path like `<base>.caption.json`, find the next
 * non-colliding sibling: `.caption.2.json`, `.caption.3.json`, … when the
 * caller wants to auto-increment. Returns the first non-existent path.
 */
export function nextCaptionPlanPath(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  const dir = path.dirname(basePath);
  const name = path.basename(basePath); // e.g. foo.caption.json
  const m = name.match(/^(.*)\.caption(?:\.(\d+))?\.json$/);
  if (!m) return basePath;
  const stem = m[1];
  let n = m[2] ? parseInt(m[2], 10) + 1 : 2;
  while (true) {
    const candidate = path.join(dir, `${stem}.caption.${n}.json`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}
