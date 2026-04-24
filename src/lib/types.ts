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
   * ms since the previous keydown of this same physical key.
   */
  readonly kdToKd: number | null;
  /**
   * ms from the previous keyup of this same physical key to this keydown.
   */
  readonly kuToKd: number | null;
  /**
   * For keyup events: ms from the paired keydown to this keyup (hold duration).
   * For keydown events: always null (filled in later on the char record).
   */
  readonly holdDuration: number | null;
  /**
   * True if kdToKd or kuToKd triggers bounce thresholds, or if a double-fire occurs.
   */
  readonly isBounce: boolean;
  /** True if this is a keydown and the global gap since last keydown > PAUSE_THRESHOLD */
  readonly isAfterPause: boolean;
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
  readonly kdToKd: number | null;
  readonly kuToKd: number | null;
  holdDuration: number | null;    // mutable: filled in on keyup
  readonly isBounce: boolean;
  /** True when kdToKd is null or gap since last global keydown > PAUSE_THRESHOLD */
  readonly isAfterPause: boolean;
}

