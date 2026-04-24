import type { CharRecord, IKIStats, KeyEventRecord } from './types.js';
import { mean, stdev, ikiToWPM } from './stats.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Gaps longer than this (ms) are treated as a typing session reset */
export const PAUSE_THRESHOLD_MS = 500;

/** Hardware bounce interval threshold (ms) for kuToKd */
export const BOUNCE_THRESHOLD_MS = 25;

/** Hardware chatter interval threshold (ms) for kdToKd */
export const CHATTER_THRESHOLD_MS = 50;

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

  // Remove watched concepts entirely
  // watchedKeyCode = $state<string | null>(null);
  // watchedKeyEvents = $state<WatchedKeyEvent[]>([]);

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
    this.events.filter(e => e.kind === 'keydown' && e.isBounce).length,
  );

  doubleFireCount = $derived.by(() =>
    this.events.filter(e => e.kind === 'keydown' && e.isBounce).length,
  );

  // ── Private internal state (non-reactive) ────────────────────────────────

  #activeKeys = new Map<string, ActiveKeyInfo>();
  #lastReleaseTimes = new Map<string, number>();
  #lastPressTimes = new Map<string, number>();

  #lastKeydownTime: number | null = null;
  #charCounter = 0;
  #eventCounter = 0;

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

    // ── Bounce computation ───────────────────────────────────────────────
    const lastPress = this.#lastPressTimes.get(ev.code) ?? null;
    const lastRelease = this.#lastReleaseTimes.get(ev.code) ?? null;

    // Gap since same key was pressed
    const kdToKd = lastPress !== null ? now - lastPress : null;
    
    // Gap since same key was released 
    // ONLY valid if the release actually happened AFTER the previous press.
    const isDoubleFire = this.#activeKeys.has(ev.code);
    const kuToKd = (!isDoubleFire && lastRelease !== null && lastPress !== null && lastRelease > lastPress)
      ? now - lastRelease
      : null;

    // Determine bounce rigidly
    const isBounce = isDoubleFire || 
                     (kuToKd !== null && kuToKd < BOUNCE_THRESHOLD_MS) || 
                     (kdToKd !== null && kdToKd < CHATTER_THRESHOLD_MS);

    this.#lastPressTimes.set(ev.code, now);

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
          this.#makeCharRecord('\n', charIndex, now, kdToKd, kuToKd, isBounce, isAfterPause),
        );
      } else if (producesChar && ev.key.length === 1) {
        charIndex = this.#charCounter++;
        this.typedText += ev.key;
        this.charRecords.push(
          this.#makeCharRecord(ev.key, charIndex, now, kdToKd, kuToKd, isBounce, isAfterPause),
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
      kdToKd,
      kuToKd,
      holdDuration: null,
      isBounce,
      charIndex,
    });

    // ── Update tracking state ─────────────────────────────────────────────
    this.#activeKeys.set(ev.code, { keydownTimestamp: now, charIndex });
    if (producesChar) {
      this.#lastKeydownTime = now;
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

    // ── Update tracking state ─────────────────────────────────────────────
    this.#lastReleaseTimes.set(ev.code, now);

    // Record the keyup event
    this.events.push({
      id: `ku-${this.#eventCounter++}`,
      kind: 'keyup',
      key: ev.key,
      code: ev.code,
      timestamp: now,
      wallTime: Date.now(),
      kdToKd: null,
      kuToKd: null,
      holdDuration,
      isBounce: false,
      charIndex: active.charIndex,
    });
  }

  clear(): void {
    this.events = [];
    this.charRecords = [];
    this.typedText = '';
    this.ikiWindow = [];
    this.ikiWindowByCode.clear();

    this.#lastPressTimes.clear();
    this.#lastReleaseTimes.clear();

    this.#activeKeys.clear();
    this.#lastKeydownTime = null;
    this.#charCounter = 0;
    // Note: #eventCounter intentionally not reset — IDs stay unique across sessions
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  #makeCharRecord(
    char: string,
    charIndex: number,
    keydownAt: number,
    kdToKd: number | null,
    kuToKd: number | null,
    isBounce: boolean,
    isAfterPause: boolean,
  ): CharRecord {
    return {
      id: `chr-${charIndex}`,
      char,
      charIndex,
      keydownAt,
      keyupAt: null,
      kdToKd,
      kuToKd,
      holdDuration: null,
      isBounce,
      isAfterPause,
    };
  }
}
