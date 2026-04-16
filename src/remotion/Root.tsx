import React from "react";
import { Composition, getInputProps } from "remotion";
import { CaptionComposition } from "./CaptionComposition.js";
import { DEFAULT_CONFIG, type CaptionCompositionProps } from "./lib/types.js";

export const Root: React.FC = () => {
  const props = getInputProps() as Partial<CaptionCompositionProps>;
  const fps = props.config?.fps ?? DEFAULT_CONFIG.fps;
  const width = props.videoWidth ?? 1080;
  const height = props.videoHeight ?? 1920;
  const durationSec = props.durationSec ?? 10;

  return (
    <Composition
      id="Captions"
      component={CaptionComposition as unknown as React.FC<Record<string, unknown>>}
      width={width}
      height={height}
      fps={fps}
      durationInFrames={Math.max(1, Math.round(durationSec * fps))}
      defaultProps={{
        videoSrc: "",
        videoWidth: width,
        videoHeight: height,
        durationSec,
        phrases: [],
        config: DEFAULT_CONFIG,
      } as unknown as Record<string, unknown>}
    />
  );
};
