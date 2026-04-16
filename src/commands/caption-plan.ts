#!/usr/bin/env tsx
/**
 * caption-plan — Build a .caption.json plan from a .words.json.
 *
 * Deterministic: segments words into phrases, applies a style preset + overrides,
 * optionally attaches a title. Output is a reviewable/refinable JSON sidecar
 * consumed by video-caption-render.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import {
  BannerConfig,
  CaptionPlan,
  CaptionStyle,
  DEFAULT_BANNER_CONFIG,
  DEFAULT_STYLE,
  applyPreset,
  applyTitlePreset,
  phrasesFromWords,
  saveCaptionPlan,
} from "../../lib/caption.js";
import { loadWordsJson } from "../../lib/words.js";
import { redirectOutToTmp } from "../../lib/tmp-paths.js";

const program = new Command();

program
  .name("caption-plan")
  .description("Build a reviewable .caption.json plan from a words JSON")
  .argument("<words-json>", "Path to .words.json")
  .option("--output <path>", "Output plan path (default: <mp4-base>.caption.json next to the MP4)")
  .option("--style <preset>", "Style preset: default | bold-yellow | bold-red | clean-white | minimal", "default")
  .option("--font-color <c>", "Main caption font color")
  .option("--font-name <n>", "Font family (must match a file in src/remotion/fonts)")
  .option("--font-size <n>", "Font size in px")
  .option("--stroke-width <n>", "Text outline width")
  .option("--stroke-color <c>", "Text outline color")
  .option("--text-shadow <s>", "CSS text-shadow value")
  .option("--vertical-align <v>", "top | middle | bottom")
  .option("--horizontal-align <h>", "left | center | right")
  .option("--padding-vertical <n>", "Vertical padding in px")
  .option("--padding-horizontal <n>", "Horizontal padding in px")
  .option("--one-word-at-a-time", "Show one word at a time (karaoke style)")
  .option("--highlight-color <c>", "Current-word highlight color")
  .option("--animation <a>", "none | pop-in | fade-in | slide-in")
  .option("--capitalization <c>", "none | uppercase")
  .option("--background-color <c>", "Phrase background color or 'transparent'")
  .option("--phrase-gap-sec <n>", "Word-gap threshold (seconds) for phrase splits", "0.6")
  .option("--max-words-per-phrase <n>", "Max words per phrase", "8")
  .option("--fps <n>", "Output fps")
  .option("--title <text>", "Optional title text rendered for full duration")
  .option("--title-style <preset>", "Title preset (falls back to main --style)")
  .option("--title-font-color <c>")
  .option("--title-font-name <n>")
  .option("--title-font-size <n>")
  .option("--title-stroke-width <n>")
  .option("--title-stroke-color <c>")
  .option("--title-text-shadow <s>")
  .option("--title-vertical-align <v>")
  .option("--title-horizontal-align <h>")
  .option("--title-padding-vertical <n>")
  .option("--title-padding-horizontal <n>")
  .option("--title-capitalization <c>")
  .option("--title-background-color <c>")
  .option("--banner <png>", "Absolute path to a PNG to overlay on the video. Default: no banner.")
  .option("--banner-vertical-align <v>", "top | middle | bottom (default top)")
  .option("--banner-horizontal-align <h>", "left | center | right (default center)")
  .option("--banner-max-width-pct <n>", "Max banner width as fraction of canvas width (default 0.9)")
  .option("--banner-max-height-pct <n>", "Max banner height as fraction of canvas height (default 0.35)")
  .option("--banner-padding-px <n>", "Padding around banner in px (default 40)")
  .option("--banner-opacity <n>", "Opacity 0..1 (default 1.0)")
  .option("--banner-start-sec <n>", "When banner appears (default 0)")
  .option("--banner-end-sec <n>", "When banner disappears (default full duration)")
  .parse(process.argv);

const opts = program.opts<Record<string, string | boolean | undefined>>();
const [wordsArg] = program.args;

function num(v: unknown, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function styleOverridesFromOpts(prefix: "" | "title"): Partial<CaptionStyle> {
  const pick = (k: string) => opts[prefix ? (prefix + k.charAt(0).toUpperCase() + k.slice(1)) : k];
  const o: Partial<CaptionStyle> = {};
  if (pick("fontColor") != null) o.fontColor = String(pick("fontColor"));
  if (pick("fontName") != null) o.fontName = String(pick("fontName"));
  if (pick("fontSize") != null) o.fontSizePx = num(pick("fontSize"), DEFAULT_STYLE.fontSizePx);
  if (pick("strokeWidth") != null) o.strokeWidth = num(pick("strokeWidth"), DEFAULT_STYLE.strokeWidth);
  if (pick("strokeColor") != null) o.strokeColor = String(pick("strokeColor"));
  if (pick("textShadow") != null) o.textShadow = String(pick("textShadow"));
  if (pick("verticalAlign") != null)
    o.verticalCaptionAlignment = String(pick("verticalAlign")) as CaptionStyle["verticalCaptionAlignment"];
  if (pick("horizontalAlign") != null)
    o.horizontalCaptionAlignment = String(pick("horizontalAlign")) as CaptionStyle["horizontalCaptionAlignment"];
  if (pick("paddingVertical") != null)
    o.paddingVerticalPx = num(pick("paddingVertical"), DEFAULT_STYLE.paddingVerticalPx);
  if (pick("paddingHorizontal") != null)
    o.paddingHorizontalPx = num(pick("paddingHorizontal"), DEFAULT_STYLE.paddingHorizontalPx);
  if (pick("capitalization") != null)
    o.textCapitalization = String(pick("capitalization")) as CaptionStyle["textCapitalization"];
  if (pick("backgroundColor") != null) o.backgroundColor = String(pick("backgroundColor"));
  return o;
}

function mainStyleOverrides(): Partial<CaptionStyle> {
  const o = styleOverridesFromOpts("");
  if (opts.oneWordAtATime) o.oneWordAtATime = true;
  if (opts.highlightColor != null) o.textHighlightColor = String(opts.highlightColor);
  if (opts.animation != null) o.textAnimation = String(opts.animation) as CaptionStyle["textAnimation"];
  if (opts.phraseGapSec != null) o.phraseGapSec = num(opts.phraseGapSec, DEFAULT_STYLE.phraseGapSec);
  if (opts.fps != null) o.fps = num(opts.fps, DEFAULT_STYLE.fps);
  return o;
}

async function main() {
  const wordsPath = path.resolve(wordsArg);
  if (!fs.existsSync(wordsPath)) {
    process.stderr.write(`ERROR: words file not found: ${wordsPath}\n`);
    process.exit(1);
  }

  const wordsFile = loadWordsJson(wordsPath);
  if (wordsFile.words.length === 0) {
    process.stderr.write(`ERROR: words file has no words\n`);
    process.exit(1);
  }
  if (!wordsFile.video_width || !wordsFile.video_height) {
    process.stderr.write(
      `ERROR: words file missing video_width/video_height. Run transcript-project-words with --mp4 to populate these.\n`,
    );
    process.exit(1);
  }

  const style = applyPreset(opts.style as string | undefined, mainStyleOverrides());

  const title = opts.title
    ? {
        text: String(opts.title),
        style: applyTitlePreset(
          (opts.titleStyle as string | undefined) ?? (opts.style as string | undefined),
          styleOverridesFromOpts("title"),
        ),
      }
    : undefined;

  const phrases = phrasesFromWords(wordsFile.words, {
    maxWords: num(opts.maxWordsPerPhrase, 8),
    gapSec: style.phraseGapSec,
  });

  let banner: BannerConfig | undefined;
  if (opts.banner) {
    const bannerSrc = path.resolve(String(opts.banner));
    if (!fs.existsSync(bannerSrc)) {
      process.stderr.write(`ERROR: banner PNG not found: ${bannerSrc}\n`);
      process.exit(1);
    }
    banner = {
      src: bannerSrc,
      horizontalAlignment: (opts.bannerHorizontalAlign as BannerConfig["horizontalAlignment"]) ?? DEFAULT_BANNER_CONFIG.horizontalAlignment,
      verticalAlignment: (opts.bannerVerticalAlign as BannerConfig["verticalAlignment"]) ?? DEFAULT_BANNER_CONFIG.verticalAlignment,
      maxWidthPct: num(opts.bannerMaxWidthPct, DEFAULT_BANNER_CONFIG.maxWidthPct),
      maxHeightPct: num(opts.bannerMaxHeightPct, DEFAULT_BANNER_CONFIG.maxHeightPct),
      paddingPx: num(opts.bannerPaddingPx, DEFAULT_BANNER_CONFIG.paddingPx),
      opacity: num(opts.bannerOpacity, DEFAULT_BANNER_CONFIG.opacity),
      ...(opts.bannerStartSec != null ? { startSec: num(opts.bannerStartSec, 0) } : {}),
      ...(opts.bannerEndSec != null ? { endSec: num(opts.bannerEndSec, wordsFile.duration_s) } : {}),
    };
  }

  const plan: CaptionPlan = {
    source_mp4: wordsFile.source_mp4,
    words_source: wordsPath,
    videoWidth: wordsFile.video_width,
    videoHeight: wordsFile.video_height,
    durationSec: wordsFile.duration_s,
    style,
    title,
    banner,
    phrases,
  };

  const mp4Dir = path.dirname(path.resolve(wordsFile.source_mp4));
  const baseNoExt = path.basename(wordsFile.source_mp4).replace(/\.[^.]+$/, "");
  const defaultOut = redirectOutToTmp(path.join(mp4Dir, `${baseNoExt}.caption.json`));
  const outPath = path.resolve((opts.output as string | undefined) ?? defaultOut);

  saveCaptionPlan(outPath, plan);
  process.stderr.write(
    `Wrote ${outPath}\n` +
      `  ${phrases.length} phrases from ${wordsFile.words.length} words, ${plan.durationSec.toFixed(1)}s @${style.fps}fps\n` +
      `  style: ${opts.style ?? "default"}${title ? ` + title "${title.text}"` : ""}${banner ? ` + banner ${banner.verticalAlignment}/${banner.horizontalAlignment} ${Math.round(banner.maxWidthPct * 100)}%x${Math.round(banner.maxHeightPct * 100)}%` : ""}\n`,
  );
  process.stdout.write(outPath + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
