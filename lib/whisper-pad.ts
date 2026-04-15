// Whisper consistently truncates segment end timestamps by ~0.3s (the model
// emits the end-of-segment token at the start of trailing silence). Pad every
// clip's tail by this amount before cutting to recover the lost audio.
export const TAIL_PAD_S = 0.3;
