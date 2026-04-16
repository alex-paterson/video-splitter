export type HorizontalAlignment = "left" | "center" | "right";
export type VerticalAlignment = "top" | "middle" | "bottom";
export type TextAnimation = "none" | "pop-in" | "fade-in" | "slide-in";
export type TextCapitalization = "none" | "uppercase";

export interface CaptionConfig {
  fontColor: string;
  fontName: string;
  strokeWidth: number;
  strokeColor: string;
  verticalCaptionAlignment: VerticalAlignment;
  horizontalCaptionAlignment: HorizontalAlignment;
  fontSizePx: number;
  oneWordAtATime: boolean;
  textHighlightColor: string;
  textShadow: string;
  textAnimation: TextAnimation;
  textCapitalization: TextCapitalization;
  backgroundColor: string;
  paddingVerticalPx: number;
  paddingHorizontalPx: number;
  fps: number;
  /** Words separated by more than this many seconds start a new caption phrase. */
  phraseGapSec: number;
  /** Fonts to load at render time. Each url is resolved via staticFile (relative to publicDir). */
  fonts?: { family: string; url: string }[];
}

export const DEFAULT_CONFIG: CaptionConfig = {
  fontColor: "#FFFFFF",
  fontName: "Anton-Regular",
  strokeWidth: 4,
  strokeColor: "#000000",
  verticalCaptionAlignment: "bottom",
  horizontalCaptionAlignment: "center",
  fontSizePx: 80,
  oneWordAtATime: false,
  textHighlightColor: "#5FFF93",
  textShadow: "0 4px 12px rgba(0,0,0,0.6)",
  textAnimation: "fade-in",
  textCapitalization: "uppercase",
  backgroundColor: "transparent",
  paddingVerticalPx: 200,
  paddingHorizontalPx: 100,
  fps: 30,
  phraseGapSec: 0.8,
};

export interface PhraseWord {
  text: string;
  /** Seconds RELATIVE to phrase.start. */
  start: number;
}

export interface Phrase {
  index: number;
  /** Absolute seconds in source video. */
  start: number;
  end: number;
  words: PhraseWord[];
}

export interface CaptionCompositionProps {
  videoSrc: string;
  videoWidth: number;
  videoHeight: number;
  durationSec: number;
  phrases: Phrase[];
  config: CaptionConfig;
  title?: { text: string; config: CaptionConfig };
}
