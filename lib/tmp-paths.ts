import path from "path";
import fs from "fs";

/** Absolute path to <repo>/tmp, created on demand. */
export function repoTmpDir(): string {
  const repoRoot = path.resolve(new URL("../", import.meta.url).pathname);
  const dir = path.join(repoRoot, "tmp");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * If `p` lives in <repo>/out, redirect to <repo>/tmp with the same basename.
 * Otherwise return `p` unchanged. Only out/ is treated as a publish surface;
 * everything else (tmp/ or user dirs) is left alone. Use this on DEFAULT
 * output paths so tools never accidentally write sidecars to out/.
 */
export function redirectOutToTmp(p: string): string {
  const resolved = path.resolve(p);
  const tmp = repoTmpDir();
  const out = path.resolve(tmp, "..", "out");
  const relToOut = path.relative(out, resolved);
  if (!relToOut.startsWith("..") && !path.isAbsolute(relToOut)) {
    return path.join(tmp, path.basename(resolved));
  }
  return resolved;
}
