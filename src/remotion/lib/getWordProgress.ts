import { MAX_WORD_ANIMATION_DURATION } from "./constants.js";
import type { Phrase } from "./types.js";

export function getWordProgressDecimal(
  wordIndex: number,
  oneWordAtATime: boolean,
  phrase: Phrase,
  currentSeconds: number,
): { wordProgressDecimal: number; shouldRenderHighlight: boolean } {
  const wordStartTime = phrase.start + phrase.words[wordIndex].start;
  const nextWord = phrase.words[wordIndex + 1];
  const nextWordStartTime = nextWord ? phrase.start + nextWord.start : Infinity;

  if (!oneWordAtATime) {
    const shouldRenderHighlight = currentSeconds >= wordStartTime && currentSeconds < nextWordStartTime;
    return { wordProgressDecimal: 1, shouldRenderHighlight };
  }

  const wordEndTime = Math.min(wordStartTime + MAX_WORD_ANIMATION_DURATION, phrase.end);
  const span = wordEndTime - wordStartTime;
  const wordProgressDecimal = span <= 0 ? 1 : Math.max(0, Math.min(1, (currentSeconds - wordStartTime) / span));
  const shouldRenderHighlight = currentSeconds >= wordStartTime && currentSeconds < nextWordStartTime;
  return { wordProgressDecimal, shouldRenderHighlight };
}
