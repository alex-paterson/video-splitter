import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { SubtitleWithWordTimings } from "./SubtitleWithWordTimings.js";
import { StaticText } from "./StaticText.js";
import { FontLoader } from "./FontLoader.js";
import type { CaptionCompositionProps } from "./lib/types.js";

export const CaptionComposition: React.FC<CaptionCompositionProps> = ({
  videoSrc,
  phrases,
  config,
  durationSec,
  title,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentSeconds = frame / fps;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <FontLoader fonts={config.fonts} />
      <OffthreadVideo src={staticFile(videoSrc)} />
      {title && (
        <AbsoluteFill style={{ zIndex: 2 }}>
          <StaticText
            currentSeconds={currentSeconds}
            text={title.text}
            startSec={0}
            endSec={durationSec}
            config={title.config}
          />
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ zIndex: 3 }}>
        <SubtitleWithWordTimings currentSeconds={currentSeconds} phrases={phrases} config={config} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
