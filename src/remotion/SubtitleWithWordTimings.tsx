import React from "react";
import { horizontalAlignmentToFlex, verticalAlignmentToFlex } from "./lib/alignment.js";
import { SLIDE_WIDTH_PX } from "./lib/constants.js";
import { getPhraseProgressDecimal } from "./lib/getPhraseProgress.js";
import { getWordProgressDecimal } from "./lib/getWordProgress.js";
import type { CaptionConfig, Phrase } from "./lib/types.js";

interface Props {
  currentSeconds: number;
  phrases: Phrase[];
  config: CaptionConfig;
}

export const SubtitleWithWordTimings: React.FC<Props> = ({ currentSeconds, phrases, config }) => {
  const {
    fontColor,
    fontName,
    strokeWidth,
    strokeColor,
    verticalCaptionAlignment,
    horizontalCaptionAlignment,
    fontSizePx,
    oneWordAtATime,
    textHighlightColor,
    textShadow,
    textAnimation,
    textCapitalization,
    backgroundColor,
    paddingVerticalPx,
    paddingHorizontalPx,
  } = config;

  const phrase = phrases.find((p) => p.start <= currentSeconds && p.end >= currentSeconds);
  if (!phrase) return null;

  const phraseProgress = getPhraseProgressDecimal(oneWordAtATime, phrase, currentSeconds);
  const phraseScale = textAnimation === "pop-in" ? phraseProgress : 1;
  const fontSize = `${fontSizePx}px`;
  const hasBackground = backgroundColor !== "transparent" && backgroundColor !== "";

  const renderWord = (text: string) => (
    <span style={{ display: "block", width: "max-content" }}>
      {text}
      &nbsp;
    </span>
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: horizontalAlignmentToFlex[horizontalCaptionAlignment],
        justifyContent: verticalAlignmentToFlex[verticalCaptionAlignment],
        paddingTop: paddingVerticalPx,
        paddingBottom: paddingVerticalPx,
        paddingLeft: paddingHorizontalPx,
        paddingRight: paddingHorizontalPx,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: horizontalAlignmentToFlex[horizontalCaptionAlignment],
          alignItems: verticalAlignmentToFlex[verticalCaptionAlignment],
          transform: `scale(${phraseScale}, ${phraseScale})`,
        }}
      >
        {phrase.words.map((word, index) => {
          const { wordProgressDecimal, shouldRenderHighlight } = getWordProgressDecimal(
            index,
            oneWordAtATime,
            phrase,
            currentSeconds,
          );

          const progress = phraseProgress * wordProgressDecimal;
          const wordScale = textAnimation === "pop-in" ? wordProgressDecimal : 1;
          const slideFactor = textAnimation === "slide-in" ? progress : 1;
          const left = SLIDE_WIDTH_PX - slideFactor * SLIDE_WIDTH_PX;

          let opacity = !oneWordAtATime || wordProgressDecimal > 0 ? 1 : 0;
          if (textAnimation === "fade-in") opacity = progress;

          return (
            <span
              key={index}
              style={{
                fontSize,
                opacity,
                lineHeight: 1,
                fontFamily: fontName,
                textAlign: horizontalCaptionAlignment,
                wordBreak: "break-word",
                position: "relative",
                zIndex: 1,
                color: shouldRenderHighlight ? textHighlightColor : fontColor,
                transform: `scale(${wordScale}, ${wordScale})`,
                textTransform: textCapitalization === "uppercase" ? "uppercase" : "none",
                WebkitTextStrokeWidth: strokeWidth > 0 ? `${strokeWidth}px` : undefined,
                WebkitTextStrokeColor: strokeWidth > 0 ? strokeColor : undefined,
                paintOrder: "stroke fill",
                textShadow: textShadow || undefined,
              }}
            >
              {/* invisible placeholder reserves width so other words don't shift */}
              <span style={{ opacity: 0, fontSize }}>{renderWord(word.text)}</span>

              {/* visible text on top */}
              <span style={{ position: "absolute", top: 0, left, bottom: 0, right: 0 }}>
                {renderWord(word.text)}
              </span>

              {hasBackground && (
                <span
                  style={{
                    position: "absolute",
                    zIndex: -1,
                    left: left - fontSizePx / 3,
                    top: -(fontSizePx / 3.5),
                    bottom: -(fontSizePx / 4),
                    right: -5,
                    opacity,
                    fontSize,
                    backgroundColor,
                    borderRadius: 10,
                  }}
                >
                  <span style={{ opacity: 0 }}>{renderWord(word.text)}</span>
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};
