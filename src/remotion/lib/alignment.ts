import type { HorizontalAlignment, VerticalAlignment } from "./types.js";

export const horizontalAlignmentToFlex: Record<HorizontalAlignment, "flex-start" | "center" | "flex-end"> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

export const verticalAlignmentToFlex: Record<VerticalAlignment, "flex-start" | "center" | "flex-end"> = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
};
