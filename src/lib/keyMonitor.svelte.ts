import type { CharRecord, IKIStats, KeyEventRecord, WatchedKeyEvent } from './types.js';
import { mean, stdev, computeSuspicionScore, ikiToWPM } from './stats.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Gaps longer than this (ms) are treated as a typing session reset */
export const PAUSE_THRESHOLD_MS = 500;

/** Rolling IKI window size — how many recent keystrokes to use for stats */
const IKI_WINDOW_SIZE = 60;

/** Minimum samples before the adaptive detector kicks in */
const MIN_SAMPLES = 8;

/** Z-score boundary for suspicion threshold display (mean - N*σ) */
const THRESHOLD_STDEVS = 1.8;

/**
 * Keys that don't produce characters and should be excluded from the IKI
 * speed window (modifier keys, function keys, navigation, etc.)
 */
const NON_CHAR_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'AltGraph',
  'CapsLock', 'NumLock', 'ScrollLock',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'PrintScreen', 'Pause',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'Escape', 'ContextMenu', 'Dead',
]);

// ─── Internal tracking ───────────────────────────────────────────────────────

interface ActiveKeyInfo {
  readonly keydownTimestamp: number;
  readonly charIndex: number | null;
}

// ─── KeyMonitor class ────────────────────────────────────────────────────────

export class KeyMonitor {
  // ── Public reactive state ────────────────────────────────────────────────

  /** All captured keyboard events (keydown + keyup) */
  events = $state<KeyEventRecord[]>([]);

  /** One record per visible character typed */
  charRecords = $state<CharRecord[]>([]);

  /** The raw string the user has typed */
  typedText = $state<string>('');

  /**
   * Rolling window of recent IKI values (ms) from character-producing keydowns.
   * Only intervals ≤ PAUSE_THRESHOLD_MS are included.
   */
  ikiWindow = $state<number[]>([]);

  /**
   * Per-key rolling windows of IKI values (ms).
   * Each key code (e.g., 'KeyA', 'Space') has its own history.
   */
  ikiWindowByCode = $state<Map<string, number[]>>(new Map());

  /** The key code currently being watched (e.g. 'Space', 'KeyA'), or null if none. */
  watchedKeyCode = $state<string | null>(null);

  /** All events recorded for the watched key, in chronological order. */
  watchedKeyEvents = $state<WatchedKeyEvent[]>([]);

  // ── Derived stats ────────────────────────────────────────────────────────

  /**
   * Global IKI stats across all keys (for WPM display / chart).
   */
  globalIKIStats = $derived.by<IKIStats | null>(() => {
    const w = this.ikiWindow;
    if (w.length < MIN_SAMPLES) return null;
    const m = mean(w);
    const s = stdev(w, m);
    const threshold = Math.max(m - THRESHOLD_STDEVS * s, 0);
    return {
      mean: m,
      stdev: s,
      min: Math.min(...w),
      max: Math.max(...w),
      sampleCount: w.length,
      estimatedWPM: ikiToWPM(m),
      suspicionThreshold: threshold,
    };
  });

  ikiStats = $derived.by(() => this.globalIKIStats);

  suspiciousCount = $derived.by(() =>
    this.events.filter(e => e.kind === 'keydown' && e.suspicionScore >= 0.5).length,
  );

  doubleFireCount = $derived.by(() =>
    this.events.filter(e => e.isSameKeyDoubleDown).length,
  );

  // ── Private internal state (non-reactive) ────────────────────────────────

  #activeKeys = new Map<string, ActiveKeyInfo>();
  #lastKeydownTime: number | null = null;
  #charCounter = 0;
  #eventCounter = 0;
  #watchedLastKeydownTime: number | null = null;
  #watchedLastKeyupTime: number | null = null;
  #watchedEventCounter = 0;

  // ── Public methods ────────────────────────────────────────────────────────

  handleKeydown(ev: KeyboardEvent): void {
    if (ev.repeat) return;
    const now = performance.now();
    const isModified = ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey;
    const isNonChar = NON_CHAR_KEYS.has(ev.key);
    const producesChar = !isModified && !isNonChar && ev.key !== 'Backspace' && ev.key !== 'Tab';

    // ── IKI calculation ──────────────────────────────────────────────────
    let iki: number | null = null;
    let isAfterPause = true;

    if (this.#lastKeydownTime !== null) {
      const delta = now - this.#lastKeydownTime;
      if (delta <= PAUSE_THRESHOLD_MS) {
        iki = delta;
        isAfterPause = false;
      }
    }

    // Only include char-producing key intervals in the speed window
    if (iki !== null && producesChar) {
      // Global window (for WPM display)
      this.ikiWindow.push(iki);
      if (this.ikiWindow.length > IKI_WINDOW_SIZE) {
        this.ikiWindow.shift();
      }
      
      // Per-key window (for per-key suspicion scoring)
      const bucket = this.ikiWindowByCode.get(ev.code) ?? [];
      bucket.push(iki);
      if (bucket.length > IKI_WINDOW_SIZE) {
        bucket.shift();
      }
      this.ikiWindowByCode.set(ev.code, bucket);
    }

    // ── Same-key double-down detection ───────────────────────────────────
    const isSameKeyDoubleDown = this.#activeKeys.has(ev.code);

    // ── Suspicion score ───────────────────────────────────────────────────
    const perKeyStats = this.#getPerKeyStats(ev.code);
    const suspicionScore =
      isSameKeyDoubleDown
        ? Math.max(
            computeSuspicionScore({
              iki: iki ?? 0,
              meanIKI: perKeyStats.mean,
              stdevIKI: perKeyStats.stdev,
              isSameKeyDoubleDown,
              hasSufficientSamples: perKeyStats.sampleCount >= MIN_SAMPLES,
            }),
            0.85,
          )
        : iki !== null
          ? computeSuspicionScore({
              iki,
              meanIKI: perKeyStats.mean,
              stdevIKI: perKeyStats.stdev,
              isSameKeyDoubleDown,
              hasSufficientSamples: perKeyStats.sampleCount >= MIN_SAMPLES,
            })
          : 0;

    // ── Handle text editing ───────────────────────────────────────────────
    let charIndex: number | null = null;

    if (!isModified) {
      if (ev.key === 'Backspace') {
        if (this.typedText.length > 0) {
          this.typedText = this.typedText.slice(0, -1);
          this.charRecords.pop();
        }
      } else if (ev.key === 'Enter' && !isNonChar) {
        charIndex = this.#charCounter++;
        this.typedText += '\n';
        this.charRecords.push(
          this.#makeCharRecord('\n', charIndex, now, iki, isSameKeyDoubleDown, suspicionScore, isAfterPause),
        );
      } else if (producesChar && ev.key.length === 1) {
        charIndex = this.#charCounter++;
        this.typedText += ev.key;
        this.charRecords.push(
          this.#makeCharRecord(ev.key, charIndex, now, iki, isSameKeyDoubleDown, suspicionScore, isAfterPause),
        );
      }
    }

    // ── Record the event ──────────────────────────────────────────────────
    this.events.push({
      id: `kd-${this.#eventCounter++}`,
      kind: 'keydown',
      key: ev.key,
      code: ev.code,
      timestamp: now,
      wallTime: Date.now(),
      iki,
      holdDuration: null,
      isSameKeyDoubleDown,
      suspicionScore,
      charIndex,
    });

    // ── Update tracking state ─────────────────────────────────────────────
    this.#activeKeys.set(ev.code, { keydownTimestamp: now, charIndex });
    if (producesChar) {
      this.#lastKeydownTime = now;
    }

    // ── Watched key tracking ──────────────────────────────────────────────
    if (this.watchedKeyCode !== null && ev.code === this.watchedKeyCode) {
      const kdToKd = this.#watchedLastKeydownTime !== null
        ? now - this.#watchedLastKeydownTime
        : null;
      const kuToKd = this.#watchedLastKeyupTime !== null
        ? now - this.#watchedLastKeyupTime
        : null;
      this.watchedKeyEvents.push({
        id: `w-kd-${this.#watchedEventCounter++}`,
        kind: 'keydown',
        timestamp: now,
        wallTime: Date.now(),
        kdToKd,
        kuToKd,
        holdDuration: null,
      });
      this.#watchedLastKeydownTime = now;
    }
  }

  handleKeyup(ev: KeyboardEvent): void {
    const now = performance.now();
    const active = this.#activeKeys.get(ev.code);

    if (!active) return; // orphaned keyup (e.g. focus was elsewhere on keydown)

    const holdDuration = now - active.keydownTimestamp;
    this.#activeKeys.delete(ev.code);

    // Update the paired char record with keyup timing
    if (active.charIndex !== null) {
      const idx = this.charRecords.findIndex(r => r.charIndex === active.charIndex);
      if (idx !== -1) {
        const r = this.charRecords[idx]!;
        r.keyupAt = now;
        r.holdDuration = holdDuration;
      }
    }

    // Record the keyup event
    this.events.push({
      id: `ku-${this.#eventCounter++}`,
      kind: 'keyup',
      key: ev.key,
      code: ev.code,
      timestamp: now,
      wallTime: Date.now(),
      iki: null,
      holdDuration,
      isSameKeyDoubleDown: false,
      suspicionScore: 0,
      charIndex: active.charIndex,
    });

    // ── Watched key tracking ──────────────────────────────────────────────
    if (this.watchedKeyCode !== null && ev.code === this.watchedKeyCode) {
      this.watchedKeyEvents.push({
        id: `w-ku-${this.#watchedEventCounter++}`,
        kind: 'keyup',
        timestamp: now,
        wallTime: Date.now(),
        kdToKd: null,
        kuToKd: null,
        holdDuration,
      });
      this.#watchedLastKeyupTime = now;
    }
  }

  clear(): void {
    this.events = [];
    this.charRecords = [];
    this.typedText = '';
    this.ikiWindow = [];
    this.ikiWindowByCode.clear();
    this.watchedKeyEvents = [];
    this.#watchedLastKeydownTime = null;
    this.#watchedLastKeyupTime = null;
    // Note: watchedKeyCode intentionally not reset — user keeps their watch across session clears
    this.#activeKeys.clear();
    this.#lastKeydownTime = null;
    this.#charCounter = 0;
    // Note: #eventCounter intentionally not reset — IDs stay unique across sessions
  }

  /** Start watching a specific key by its code (e.g. 'Space', 'KeyA'). Clears prior watch data. */
  setWatchedKey(code: string): void {
    this.watchedKeyCode = code;
    this.watchedKeyEvents = [];
    this.#watchedLastKeydownTime = null;
    this.#watchedLastKeyupTime = null;
  }

  /** Stop watching and discard all watch data. */
  clearWatchedKey(): void {
    this.watchedKeyCode = null;
    this.watchedKeyEvents = [];
    this.#watchedLastKeydownTime = null;
    this.#watchedLastKeyupTime = null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Compute per-key IKI stats. Returns mean, stdev, and sampleCount for the given key code.
   * Used for per-key suspicion scoring.
   */
  #getPerKeyStats(keyCode: string): { mean: number; stdev: number; sampleCount: number } {
    const w = this.ikiWindowByCode.get(keyCode);
    if (!w || w.length < MIN_SAMPLES) {
      // Fall back to global stats when per-key sample is insufficient
      const global = this.globalIKIStats;
      return {
        mean: global?.mean ?? 0,
        stdev: global?.stdev ?? 0,
        sampleCount: global?.sampleCount ?? 0,
      };
    }
    const m = mean(w);
    const s = stdev(w, m);
    return {
      mean: m,
      stdev: s,
      sampleCount: w.length,
    };
  }

  #makeCharRecord(
    char: string,
    charIndex: number,
    keydownAt: number,
    iki: number | null,
    isSameKeyDoubleDown: boolean,
    suspicionScore: number,
    isAfterPause: boolean,
  ): CharRecord {
    return {
      id: `chr-${charIndex}`,
      char,
      charIndex,
      keydownAt,
      keyupAt: null,
      iki,
      holdDuration: null,
      isSameKeyDoubleDown,
      suspicionScore,
      isAfterPause,
    };
  }
}
