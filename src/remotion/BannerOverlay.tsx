import React from "react";
import { Img, staticFile } from "remotion";
import { horizontalAlignmentToFlex, verticalAlignmentToFlex } from "./lib/alignment.js";
import type { BannerOverlay as BannerProps } from "./lib/types.js";

interface Props {
  currentSeconds: number;
  durationSec: number;
  banner: BannerProps;
}

export const BannerOverlay: React.FC<Props> = ({ currentSeconds, durationSec, banner }) => {
  const startSec = banner.startSec ?? 0;
  const endSec = banner.endSec ?? durationSec;
  if (currentSeconds < startSec || currentSeconds > endSec) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: verticalAlignmentToFlex[banner.verticalAlignment],
        justifyContent: horizontalAlignmentToFlex[banner.horizontalAlignment],
        padding: banner.paddingPx,
        pointerEvents: "none",
      }}
    >
      <Img
        src={staticFile(banner.src)}
        style={{
          maxWidth: `${banner.maxWidthPct * 100}%`,
          maxHeight: `${banner.maxHeightPct * 100}%`,
          objectFit: "contain",
          opacity: banner.opacity,
        }}
      />
    </div>
  );
};
