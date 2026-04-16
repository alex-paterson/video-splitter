import { z } from "zod";
import fs from "fs";

export const WordsJsonWordSchema = z.object({
  start_s: z.number(),
  end_s: z.number(),
  word: z.string(),
  speaker: z.string().optional(),
});

export const WordsJsonSchema = z.object({
  source_mp4: z.string(),
  source_transcript: z.string().optional(),
  duration_s: z.number(),
  video_width: z.number().optional(),
  video_height: z.number().optional(),
  words: z.array(WordsJsonWordSchema),
});

export type WordsJsonWord = z.infer<typeof WordsJsonWordSchema>;
export type WordsJson = z.infer<typeof WordsJsonSchema>;

export function loadWordsJson(p: string): WordsJson {
  return WordsJsonSchema.parse(JSON.parse(fs.readFileSync(p, "utf-8")));
}

export function saveWordsJson(p: string, w: WordsJson): void {
  fs.writeFileSync(p, JSON.stringify(w, null, 2));
}
