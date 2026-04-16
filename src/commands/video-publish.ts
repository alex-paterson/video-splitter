#!/usr/bin/env tsx
/**
 * video-publish — Copy the FINAL MP4 into <repo>/out/.
 *
 * Usage: tsx src/commands/video-publish.ts <input-mp4> [--replace <prior-path>]
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";

const program = new Command();

program
  .name("video-publish")
  .description("Publish a final MP4 to <repo>/out/")
  .argument("<input>", "Path to the final MP4 (usually in tmp/)")
  .option("--replace <path>", "Prior published filename to remove before copying")
  .parse(process.argv);

const opts = program.opts<{ replace?: string }>();
const input = program.args[0];
const absInput = path.resolve(input);

if (!fs.existsSync(absInput)) {
  process.stderr.write(`ERROR: not found: ${absInput}\n`);
  process.exit(1);
}

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const publishDir = path.join(repoRoot, "out");
fs.mkdirSync(publishDir, { recursive: true });

if (opts.replace) {
  const priorDest = path.join(publishDir, path.basename(opts.replace));
  if (fs.existsSync(priorDest)) {
    fs.unlinkSync(priorDest);
    process.stderr.write(`Unpublished: ${priorDest}\n`);
  }
}

const dest = nextAvailablePath(path.join(publishDir, path.basename(absInput)));
fs.copyFileSync(absInput, dest);
process.stderr.write(`Published: ${dest}\n`);
process.stdout.write(dest + "\n");

function nextAvailablePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  const match = stem.match(/^(.*)-(\d+)$/);
  let base = stem;
  let n = 1;
  if (match) {
    base = match[1];
    n = parseInt(match[2], 10) + 1;
  }
  while (true) {
    const candidate = path.join(dir, `${base}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}
