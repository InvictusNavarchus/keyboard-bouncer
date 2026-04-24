export type EventKind = 'keydown' | 'keyup';

/** A single raw keyboard event as captured */
export interface KeyEventRecord {
  readonly id: string;
  readonly kind: EventKind;
  /** The logical key value, e.g. 'a', 'Enter', 'Shift' */
  readonly key: string;
  /** The physical key code, e.g. 'KeyA', 'Space' */
  readonly code: string;
  /** High-resolution timestamp via performance.now() */
  readonly timestamp: number;
  /** Wall-clock time via Date.now() */
  readonly wallTime: number;
  /**
   * Inter-key interval: ms since the previous keydown event.
   * null if this is the first keystroke, or if gap > PAUSE_THRESHOLD (session reset).
   */
  readonly iki: number | null;
  /**
   * For keyup events: ms from the paired keydown to this keyup (hold duration).
   * For keydown events: always null (filled in later on the char record).
   */
  readonly holdDuration: number | null;
  /**
   * True when keydown fires for this code while a previous keydown
   * for the same code has not yet received a keyup. This is the primary
   * hardware bounce / double-fire signal.
   */
  readonly isSameKeyDoubleDown: boolean;
  /**
   * Computed anomaly score, 0 (normal) → 1 (very suspicious).
   * Based on z-score distance below rolling IKI mean.
   */
  readonly suspicionScore: number;
  /** Index into charRecords if this event produced a visible character, else null */
  readonly charIndex: number | null;
}

/** A single typed character augmented with timing metadata */
export interface CharRecord {
  readonly id: string;
  readonly char: string;
  readonly charIndex: number;
  readonly keydownAt: number;
  keyupAt: number | null;         // mutable: filled in on keyup
  readonly iki: number | null;
  holdDuration: number | null;    // mutable: filled in on keyup
  readonly isSameKeyDoubleDown: boolean;
  readonly suspicionScore: number;
  /** True when iki is null (after a long pause or the first character typed) */
  readonly isAfterPause: boolean;
}

/** Rolling statistics over recent IKI samples */
export interface IKIStats {
  readonly mean: number;
  readonly stdev: number;
  readonly min: number;
  readonly max: number;
  readonly sampleCount: number;
  /** Estimated WPM derived from mean IKI (1 word = 5 chars) */
  readonly estimatedWPM: number;
  /** Lower bound below which a key is considered anomalously fast (mean - N*stdev) */
  readonly suspicionThreshold: number;
}

/**
 * A single event for a "watched" key — the key the user suspects of bouncing.
 * Tracks both keydown→keydown and keyup→keydown intervals for that specific key only.
 */
export interface WatchedKeyEvent {
  readonly id: string;
  readonly kind: 'keydown' | 'keyup';
  readonly timestamp: number;
  readonly wallTime: number;
  /**
   * ms since the previous keydown of this same key.
   * null on the very first recorded keydown for this key.
   */
  readonly kdToKd: number | null;
  /**
   * ms from the previous keyup of this same key to this keydown.
   * null for keyup events, and null on the first keydown (no prior keyup).
   * Very small values (<20ms) are a strong hardware-bounce indicator.
   */
  readonly kuToKd: number | null;
  /**
   * For keyup events: ms from the paired keydown to this keyup.
   * null for keydown events.
   */
  readonly holdDuration: number | null;
}
