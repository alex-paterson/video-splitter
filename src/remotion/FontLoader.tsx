import React from "react";
import { continueRender, delayRender, staticFile } from "remotion";

interface Props { fonts?: { family: string; url: string }[]; }

export const FontLoader: React.FC<Props> = ({ fonts }) => {
  const handle = React.useRef<number | null>(null);
  const [, force] = React.useState(0);

  React.useEffect(() => {
    if (!fonts || fonts.length === 0) return;
    handle.current = delayRender("Loading fonts");
    Promise.all(
      fonts.map((f) => {
        const ext = f.url.split(".").pop()?.toLowerCase();
        const fmt = ext === "woff2" ? "woff2" : ext === "woff" ? "woff" : ext === "otf" ? "opentype" : "truetype";
        const face = new FontFace(f.family, `url('${staticFile(f.url)}') format('${fmt}')`);
        return face.load().then((loaded) => { document.fonts.add(loaded); });
      }),
    )
      .then(() => { if (handle.current !== null) continueRender(handle.current); })
      .catch((err) => { console.error("font load failed", err); if (handle.current !== null) continueRender(handle.current); })
      .finally(() => force((n) => n + 1));
  }, [fonts]);

  return null;
};
