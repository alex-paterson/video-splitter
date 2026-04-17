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
        {hasBackground && (
          <span
            style={{
              position: "absolute",
              zIndex: -1,
              left: -fontSizePx / 3,
              right: -fontSizePx / 3,
              top: -fontSizePx / 4,
              bottom: -fontSizePx / 4,
              backgroundColor,
              borderRadius: 12,
            }}
          />
        )}
        <span
          style={{
            fontSize,
            lineHeight: 1.1,
            fontFamily: fontName,
            color: fontColor,
            textAlign: horizontalCaptionAlignment,
            textTransform: textCapitalization === "uppercase" ? "uppercase" : "none",
            whiteSpace: "pre-wrap",
            WebkitTextStrokeWidth: strokeWidth > 0 ? `${strokeWidth}px` : undefined,
            WebkitTextStrokeColor: strokeWidth > 0 ? strokeColor : undefined,
            paintOrder: "stroke fill",
            textShadow: textShadow || undefined,
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
