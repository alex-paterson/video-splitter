import React from "react";
import { horizontalAlignmentToFlex, verticalAlignmentToFlex } from "./lib/alignment.js";
import type { CaptionConfig } from "./lib/types.js";

interface Props {
  currentSeconds: number;
  text: string;
  startSec: number;
  endSec: number;
  config: CaptionConfig;
}

export const StaticText: React.FC<Props> = ({ currentSeconds, text, startSec, endSec, config }) => {
  if (currentSeconds < startSec || currentSeconds > endSec) return null;

  const {
    fontColor,
    fontName,
    strokeWidth,
    strokeColor,
    verticalCaptionAlignment,
    horizontalCaptionAlignment,
    fontSizePx,
    textShadow,
    textCapitalization,
    backgroundColor,
    paddingVerticalPx,
    paddingHorizontalPx,
  } = config;

  const fontSize = `${fontSizePx}px`;
  const hasBackground = backgroundColor !== "transparent" && backgroundColor !== "";

  const textStyle: React.CSSProperties = {
    fontSize,
    lineHeight: 1.1,
    fontFamily: fontName,
    color: fontColor,
    textAlign: horizontalCaptionAlignment,
    textTransform: textCapitalization === "uppercase" ? "uppercase" : "none",
    margin: 0,
    position: "relative",
    zIndex: 1,
    whiteSpace: "pre-wrap",
  };

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
      <div style={{ position: "relative", display: "inline-block" }}>
        <span style={textStyle}>{text}</span>
        <span
          style={{
            ...textStyle,
            position: "absolute",
            inset: 0,
            zIndex: -1,
            color: "transparent",
            WebkitTextStrokeWidth: `${strokeWidth}px`,
            WebkitTextStrokeColor: strokeColor,
          }}
        >
          {text}
        </span>
        {textShadow && (
          <span
            style={{
              ...textStyle,
              position: "absolute",
              inset: 0,
              zIndex: -2,
              color: fontColor,
              textShadow,
            }}
          >
            {text}
          </span>
        )}
        {hasBackground && (
          <span
            style={{
              position: "absolute",
              zIndex: -3,
              left: -fontSizePx / 3,
              right: -fontSizePx / 3,
              top: -fontSizePx / 4,
              bottom: -fontSizePx / 4,
              backgroundColor,
              borderRadius: 12,
            }}
          />
        )}
      </div>
    </div>
  );
};
