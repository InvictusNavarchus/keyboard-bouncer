/** Arithmetic mean of a non-empty array */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

/** Sample standard deviation (Bessel's correction) */
export function stdev(values: readonly number[], mu?: number): number {
  if (values.length < 2) return 0;
  const m = mu ?? mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Compute suspicion score in [0, 1].
 *
 * Detection hierarchy:
 *  1. Hard floor: anything < HARD_MIN_MS is always 1.0
 *  2. Same-key double-down below DOUBLE_DOWN_MS: always ≥ 0.85
 *  3. Z-score: how many stdevs below the rolling mean?
 *     – z < THRESHOLD_Z → 0 (normal)
 *     – z ≥ MAX_Z       → 1 (definite anomaly)
 *     – linear interpolation between
 */
export function computeSuspicionScore(opts: {
  iki: number;
  meanIKI: number;
  stdevIKI: number;
  isSameKeyDoubleDown: boolean;
  hasSufficientSamples: boolean;
}): number {
  const { iki, meanIKI, stdevIKI, isSameKeyDoubleDown, hasSufficientSamples } = opts;

  // Hard floor — no matter what, these are immediately suspicious
  const HARD_MIN_MS = 25;
  if (iki < HARD_MIN_MS) return 1.0;

  // Same-key double-down with short interval → very high score
  const DOUBLE_DOWN_MS = 120;
  if (isSameKeyDoubleDown && iki < DOUBLE_DOWN_MS) {
    return clamp(1 - (iki - HARD_MIN_MS) / (DOUBLE_DOWN_MS - HARD_MIN_MS) * 0.15, 0.85, 1.0);
  }

  // Not enough data to compute z-score yet
  if (!hasSufficientSamples || stdevIKI < 1 || meanIKI < 1) return 0;

  const THRESHOLD_Z = 1.8; // z-scores below this → normal
  const MAX_Z = 4.0;       // z-scores at/above this → score 1.0

  const z = (meanIKI - iki) / stdevIKI;
  if (z < THRESHOLD_Z) return 0;
  if (z >= MAX_Z) return 1;
  return clamp((z - THRESHOLD_Z) / (MAX_Z - THRESHOLD_Z), 0, 1);
}

/** Convert mean IKI (ms per keystroke) to estimated WPM (1 word = 5 chars) */
export function ikiToWPM(meanIKI: number): number {
  if (meanIKI <= 0) return 0;
  return Math.round(60_000 / (meanIKI * 5));
}
