import { MAX_WORD_ANIMATION_DURATION } from "./constants.js";
import type { Phrase } from "./types.js";

/** Returns 0..1 for how far the phrase animation has played at currentSeconds. */
export function getPhraseProgressDecimal(
  oneWordAtATime: boolean,
  phrase: Phrase,
  currentSeconds: number,
): number {
  if (oneWordAtATime) return 1;
  const phraseDuration = phrase.end - phrase.start;
  if (phraseDuration <= 0) return 1;
  const phraseAnimationSeconds = Math.min(MAX_WORD_ANIMATION_DURATION, phraseDuration);
  const elapsed = currentSeconds - phrase.start;
  return Math.max(0, Math.min(1, elapsed / phraseAnimationSeconds));
}
