<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { KeyMonitor, PAUSE_THRESHOLD_MS } from './lib/keyMonitor.svelte.js';
  import type { CharRecord, KeyEventRecord, WatchedKeyEvent } from './lib/types.js';

  // ─── State ─────────────────────────────────────────────────────────────────

  const monitor = new KeyMonitor();

  let isFocused = $state(false);
  let showKeyups = $state(false);
  let suspiciousOnly = $state(false);

  let logScrollEl = $state<HTMLElement | undefined>(undefined);
  let watchScrollEl = $state<HTMLElement | undefined>(undefined);
  let typingEl = $state<HTMLElement | undefined>(undefined);

  let watchCapturing = $state(false);

  // ─── Derived display data ───────────────────────────────────────────────────

  const visibleEvents = $derived(
    monitor.events.filter(ev => {
      if (!showKeyups && ev.kind === 'keyup') return false;
      if (suspiciousOnly && ev.suspicionScore < 0.5 && !ev.isSameKeyDoubleDown) return false;
      return true;
    }),
  );

  // Auto-scroll log on new events
  $effect(() => {
    void monitor.events.length; // reactive dependency
    tick().then(() => {
      if (logScrollEl) {
        logScrollEl.scrollTop = logScrollEl.scrollHeight;
      }
    });
  });

  // Auto-scroll watch log on new events
  $effect(() => {
    void monitor.watchedKeyEvents.length;
    tick().then(() => {
      if (watchScrollEl) {
        watchScrollEl.scrollTop = watchScrollEl.scrollHeight;
      }
    });
  });

  // ─── Char coloring ──────────────────────────────────────────────────────────

  function getCharStyle(r: CharRecord): string {
    if (r.isAfterPause) {
      return 'color: var(--pause);';
    }
    if (r.isSameKeyDoubleDown && r.suspicionScore >= 0.8) {
      return [
        'color: var(--danger);',
        'text-shadow: 0 0 12px rgba(255,51,85,0.7), 0 0 24px rgba(255,51,85,0.3);',
        'font-weight: 700;',
      ].join(' ');
    }
    const score = r.suspicionScore;
    if (score <= 0.02) return 'color: var(--text-soft);';

    // Interpolate: amber (40°) → orange (20°) → red (0°)
    const h = Math.round(40 * (1 - score));
    const s = Math.round(75 + 20 * score);
    const l = Math.round(62 - 8 * score);
    const glowStrength = score > 0.5 ? Math.round(4 + score * 10) : 0;
    const glow = glowStrength > 0
      ? ` text-shadow: 0 0 ${glowStrength}px hsl(${h}, ${s}%, ${Math.round(l * 0.75)}%);`
      : '';
    return `color: hsl(${h}, ${s}%, ${l}%);${glow}`;
  }

  function getCharTitle(r: CharRecord): string {
    const parts: string[] = [];
    if (r.iki !== null) parts.push(`IKI: ${r.iki.toFixed(1)}ms`);
    else parts.push('First keystroke / after pause');
    parts.push(`Score: ${(r.suspicionScore * 100).toFixed(0)}%`);
    if (r.isSameKeyDoubleDown) parts.push('⚡ SAME-KEY DOUBLE-DOWN');
    if (r.holdDuration !== null) parts.push(`Hold: ${r.holdDuration.toFixed(1)}ms`);
    return parts.join(' · ');
  }

  // ─── Log row styling ────────────────────────────────────────────────────────

  type LogClass = 'normal' | 'keyup' | 'pause' | 'warn' | 'danger';

  function getLogClass(ev: KeyEventRecord): LogClass {
    if (ev.isSameKeyDoubleDown) return 'danger';
    if (ev.suspicionScore >= 0.7) return 'danger';
    if (ev.suspicionScore >= 0.35) return 'warn';
    if (ev.kind === 'keyup') return 'keyup';
    if (ev.iki === null && ev.kind === 'keydown') return 'pause';
    return 'normal';
  }

  function getSuspicionLabel(ev: KeyEventRecord): string {
    if (ev.isSameKeyDoubleDown) return '⚡ DOUBLE FIRE';
    if (ev.suspicionScore >= 0.7) return '⚠ BOUNCE?';
    if (ev.suspicionScore >= 0.35) return '~ fast';
    if (ev.iki === null && ev.kind === 'keydown') return '↵ new session';
    return '';
  }

  // ─── Formatting helpers ─────────────────────────────────────────────────────

  function fmtMS(ms: number | null, dp = 1): string {
    if (ms === null) return '—';
    return `${ms.toFixed(dp)}`;
  }

  function fmtWallTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function fmtKey(key: string): string {
    if (key === ' ') return '␣';
    if (key === 'Enter') return '↵';
    if (key === 'Backspace') return '⌫';
    if (key === 'Tab') return '⇥';
    if (key.length > 1) return `[${key}]`;
    return key;
  }

  // ─── IKI Chart ──────────────────────────────────────────────────────────────

  const CHART_W = 700;
  const CHART_H = 54;
  const BAR_SLOTS = 70;
  const BAR_GAP = 1;
  const BAR_W = CHART_W / BAR_SLOTS - BAR_GAP;

  function getBarFill(iki: number, mean: number, stdev: number): string {
    if (stdev === 0) return 'rgba(68,102,255,0.5)';
    const z = (mean - iki) / stdev;
    if (z < 1.5) return 'rgba(68,102,255,0.55)';
    if (z < 2.5) return 'rgba(255,170,34,0.70)';
    return 'rgba(255,51,85,0.80)';
  }

  // ─── Events ─────────────────────────────────────────────────────────────────

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Tab') e.preventDefault();
    monitor.handleKeydown(e);
  }

  // ─── Key watcher capture ────────────────────────────────────────────────────

  function startWatchCapture() {
    watchCapturing = true;
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          watchCapturing = false;
          tick().then(() => typingEl?.focus());
          return;
        }
        // Intercept during capture phase so the key isn't also typed into the textarea
        e.stopPropagation();
        monitor.setWatchedKey(e.code);
        watchCapturing = false;
        tick().then(() => typingEl?.focus());
      },
      { capture: true, once: true },
    );
  }

  // ─── Watch row helpers ──────────────────────────────────────────────────────

  function getWatchClass(ev: WatchedKeyEvent): string {
    if (ev.kind === 'keyup') return 'watch-keyup';
    if (ev.kuToKd !== null && ev.kuToKd < 20) return 'watch-bounce';
    if (ev.kuToKd !== null && ev.kuToKd < 50) return 'watch-warn';
    if (ev.kdToKd !== null && ev.kdToKd < 25) return 'watch-bounce';
    return 'watch-normal';
  }

  function fmtWatchFlag(ev: WatchedKeyEvent): string {
    if (ev.kind === 'keyup') return '';
    if (ev.kuToKd !== null && ev.kuToKd < 20) return '⚡ BOUNCE';
    if (ev.kuToKd !== null && ev.kuToKd < 50) return '~ suspicious';
    if (ev.kdToKd !== null && ev.kdToKd < 25) return '⚡ BOUNCE';
    return '';
  }

  let isCopied = $state(false);

  async function copyDataToClipboard() {
    const globalCsvLines = ['time,kind,key,code,iki_ms,hold_ms,flag'];
    for (const ev of monitor.events) {
      const time = fmtWallTime(ev.wallTime);
      const kind = ev.kind === 'keydown' ? 'DN' : 'UP';
      const key = fmtKey(ev.key).replace(/"/g, '""');
      const code = ev.code;
      const iki = ev.iki !== null ? ev.iki.toFixed(1) : '';
      const hold = ev.holdDuration !== null ? ev.holdDuration.toFixed(1) : '';
      const flag = getSuspicionLabel(ev).replace(/"/g, '""');
      globalCsvLines.push(`"${time}","${kind}","${key}","${code}","${iki}","${hold}","${flag}"`);
    }

    const watchedCsvLines = ['time,kind,kd_to_kd_ms,ku_to_kd_ms,hold_ms,flag'];
    for (const ev of monitor.watchedKeyEvents) {
      const time = fmtWallTime(ev.wallTime);
      const kind = ev.kind === 'keydown' ? 'DN' : 'UP';
      const kdToKd = ev.kdToKd !== null ? ev.kdToKd.toFixed(1) : '';
      const kuToKd = ev.kuToKd !== null ? ev.kuToKd.toFixed(1) : '';
      const hold = ev.holdDuration !== null ? ev.holdDuration.toFixed(1) : '';
      const flag = fmtWatchFlag(ev).replace(/"/g, '""');
      watchedCsvLines.push(`"${time}","${kind}","${kdToKd}","${kuToKd}","${hold}","${flag}"`);
    }

    const markdownParts = [
      '# Keyboard Bouncer Data Export',
      '',
      '## Global Event Log',
      '```csv',
      globalCsvLines.join('\n'),
      '```',
      ''
    ];

    if (monitor.watchedKeyCode) {
      markdownParts.push(
        `## Watched Key Event Log (${monitor.watchedKeyCode})`,
        '```csv',
        watchedCsvLines.join('\n'),
        '```',
        ''
      );
    } else {
      markdownParts.push(
        '## Watched Key Event Log',
        '*No key watch feature was active during this recording.*',
        ''
      );
    }

    const text = markdownParts.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      isCopied = true;
      setTimeout(() => (isCopied = false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
      alert('Failed to copy data to clipboard');
    }
  }

  onMount(() => {
    typingEl?.focus();
  });
</script>

<!-- ──────────────────────────────────────────────────────── MARKUP ────── -->

<div class="shell">

  <!-- ═══ HEADER ══════════════════════════════════════════════════════════ -->
  <header class="header">
    <div class="brand">
      <span class="brand-glyph">⌨</span>
      <div class="brand-text">
        <span class="brand-name">KeyBounce</span>
        <span class="brand-sub">Detector</span>
      </div>
    </div>

    <div class="stats-bar">
      {#if monitor.ikiStats}
        {@const s = monitor.ikiStats}
        <div class="stat-block accent">
          <span class="stat-val">{s.estimatedWPM}</span>
          <span class="stat-key">WPM</span>
        </div>
        <div class="stat-sep"></div>
        <div class="stat-block">
          <span class="stat-val">{s.mean.toFixed(1)}</span>
          <span class="stat-key">avg IKI ms</span>
        </div>
        <div class="stat-block">
          <span class="stat-val">{s.stdev.toFixed(1)}</span>
          <span class="stat-key">σ ms</span>
        </div>
        <div class="stat-block">
          <span class="stat-val" class:danger-val={s.min < s.suspicionThreshold}>
            {s.min.toFixed(1)}
          </span>
          <span class="stat-key">min IKI ms</span>
        </div>
        <div class="stat-block dimmer">
          <span class="stat-val">{s.suspicionThreshold.toFixed(1)}</span>
          <span class="stat-key">threshold ms</span>
        </div>
        <div class="stat-sep"></div>
      {:else}
        <div class="stat-block calibrating">
          <span class="stat-key">
            {#if monitor.ikiWindow.length === 0}
              click the typing area and start typing…
            {:else}
              calibrating… {monitor.ikiWindow.length}/8 keystrokes
            {/if}
          </span>
        </div>
      {/if}

      <div class="stat-block" class:warn-val-block={monitor.suspiciousCount > 0}>
        <span class="stat-val" class:warn-val={monitor.suspiciousCount > 0}>
          {monitor.suspiciousCount}
        </span>
        <span class="stat-key">suspicious</span>
      </div>
      <div class="stat-block" class:danger-val-block={monitor.doubleFireCount > 0}>
        <span class="stat-val" class:danger-val={monitor.doubleFireCount > 0}>
          {monitor.doubleFireCount}
        </span>
        <span class="stat-key">double-fire</span>
      </div>
      <div class="stat-block dimmer">
        <span class="stat-val">{monitor.events.length}</span>
        <span class="stat-key">events</span>
      </div>
    </div>

    <div class="header-actions">
      <button class="btn-copy" class:is-copied={isCopied} onclick={copyDataToClipboard}>
        {isCopied ? '✓ Copied' : '📋 Copy Data'}
      </button>
      <button class="btn-clear" onclick={() => monitor.clear()}>
        ⌫ Clear
      </button>
    </div>
  </header>

  <!-- ═══ MAIN ════════════════════════════════════════════════════════════ -->
  <div class="main">

    <!-- TYPING PANEL ─────────────────────────────────────────────────────── -->
    <div class="typing-panel" class:panel-focused={isFocused}>
      <div class="panel-head">
        <span class="panel-label">INPUT</span>
        {#if !isFocused && monitor.charRecords.length === 0}
          <span class="panel-hint">Click here and start typing</span>
        {:else if isFocused}
          <span class="panel-hint online">● RECORDING</span>
        {:else}
          <span class="panel-hint">{monitor.charRecords.length} chars · {monitor.typedText.split(/\s+/).filter(Boolean).length} words</span>
        {/if}
      </div>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        bind:this={typingEl}
        class="typing-area"
        tabindex="0"
        role="textbox"
        aria-multiline="true"
        aria-label="Typing area — click and start typing to detect key bounce"
        onkeydown={handleKeydown}
        onkeyup={e => monitor.handleKeyup(e)}
        onfocus={() => (isFocused = true)}
        onblur={() => (isFocused = false)}
      >
        {#if monitor.charRecords.length === 0}
          <span class="placeholder">
            Click here and start typing to begin keystroke analysis…
          </span>
        {:else}
          {#each monitor.charRecords as rec (rec.id)}
            {#if rec.char === '\n'}
              <br />
            {:else}
              <!-- svelte-ignore a11y_mouse_events_have_key_events -->
              <span
                class="char"
                class:char-suspicious={rec.suspicionScore >= 0.5}
                class:char-double={rec.isSameKeyDoubleDown}
                class:char-pause={rec.isAfterPause}
                style={getCharStyle(rec)}
                title={getCharTitle(rec)}
              >{rec.char}</span>
            {/if}
          {/each}
          <span class="caret" class:caret-blink={isFocused}>▌</span>
        {/if}
      </div>

      <!-- Legend -->
      <div class="legend">
        <span class="legend-item">
          <span class="swatch" style="color:var(--text-soft)">■</span>
          normal
        </span>
        <span class="legend-item">
          <span class="swatch" style="color:var(--pause)">■</span>
          after pause (&gt;{PAUSE_THRESHOLD_MS}ms)
        </span>
        <span class="legend-item">
          <span class="swatch" style="color:var(--warn)">■</span>
          fast / suspicious
        </span>
        <span class="legend-item">
          <span class="swatch" style="color:var(--danger)">■</span>
          double-fire / bounce
        </span>
        <span class="legend-item dimmer">
          hover a letter for IKI details
        </span>
      </div>
    </div>

    <!-- LOG PANEL ──────────────────────────────────────────────────────────── -->
    <div class="log-panel">
      <div class="panel-head log-head">
        <span class="panel-label">EVENT LOG</span>
        <span class="log-count">{monitor.events.length}</span>
        <div class="log-controls">
          <label class="toggle">
            <input type="checkbox" bind:checked={showKeyups} />
            <span>keyup</span>
          </label>
          <label class="toggle" class:toggle-active={suspiciousOnly}>
            <input type="checkbox" bind:checked={suspiciousOnly} />
            <span>⚠ only</span>
          </label>
        </div>
      </div>

      <div class="log-scroll" bind:this={logScrollEl}>
        {#if visibleEvents.length === 0}
          <div class="log-empty">
            {#if monitor.events.length === 0}
              No events yet.
            {:else}
              No events match the current filter.
            {/if}
          </div>
        {:else}
          {#each visibleEvents as ev (ev.id)}
            {@const cls = getLogClass(ev)}
            {@const label = getSuspicionLabel(ev)}
            <div
              class="log-row"
              class:log-normal={cls === 'normal'}
              class:log-keyup={cls === 'keyup'}
              class:log-pause={cls === 'pause'}
              class:log-warn={cls === 'warn'}
              class:log-danger={cls === 'danger'}
            >
              <span class="l-time">{fmtWallTime(ev.wallTime)}</span>
              <span class="l-arrow">{ev.kind === 'keydown' ? '↓' : '↑'}</span>
              <span class="l-kind">{ev.kind === 'keydown' ? 'DN' : 'UP'}</span>
              <span class="l-key">{fmtKey(ev.key)}</span>
              <span class="l-code">{ev.code}</span>
              {#if ev.kind === 'keydown'}
                <span class="l-iki">{fmtMS(ev.iki)}ms</span>
              {:else}
                <span class="l-hold">h:{fmtMS(ev.holdDuration)}ms</span>
              {/if}
              {#if label}
                <span class="l-flag">{label}</span>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>

  </div>

  <!-- ═══ CHART ════════════════════════════════════════════════════════════ -->
  <div class="chart-panel">
    <div class="chart-header">
      <span class="panel-label">IKI TIMELINE</span>
      <span class="chart-sub">
        last {Math.min(monitor.ikiWindow.length, BAR_SLOTS)} keystrokes ·
        <span style="color:var(--blue)">━</span> mean ·
        <span style="color:var(--danger)">╌</span> suspicion threshold
        {#if monitor.ikiStats}
          · bars: <span style="color:rgba(68,102,255,0.8)">■</span> normal
          <span style="color:rgba(255,170,34,0.85)">■</span> fast
          <span style="color:rgba(255,51,85,0.9)">■</span> bounce
        {/if}
      </span>
    </div>
    <svg
      class="iki-svg"
      viewBox="0 0 {CHART_W} {CHART_H}"
      preserveAspectRatio="none"
      aria-label="IKI timeline chart"
    >
      {#if monitor.ikiStats && monitor.ikiWindow.length > 0}
        {@const stats = monitor.ikiStats}
        {@const recent = monitor.ikiWindow.slice(-BAR_SLOTS)}
        {@const maxVal = Math.max(...recent, stats.mean + stats.stdev * 2.5, 80)}
        {@const pxPerMs = CHART_H / maxVal}
        {@const meanPx = CHART_H - stats.mean * pxPerMs}
        {@const threshPx = CHART_H - stats.suspicionThreshold * pxPerMs}

        <!-- Bars -->
        {#each recent as iki, i}
          {@const barH = Math.max(iki * pxPerMs, 2)}
          {@const barX = i * (BAR_W + BAR_GAP)}
          <rect
            x={barX}
            y={CHART_H - barH}
            width={BAR_W}
            height={barH}
            fill={getBarFill(iki, stats.mean, stats.stdev)}
            rx="1"
          >
            <title>{iki.toFixed(1)}ms</title>
          </rect>
        {/each}

        <!-- Mean line -->
        <line
          x1="0" y1={meanPx} x2={CHART_W} y2={meanPx}
          stroke="rgba(68,102,255,0.7)" stroke-width="1"
        />
        <text
          x="4" y={meanPx - 3}
          fill="rgba(68,102,255,0.6)" font-size="8"
          font-family="JetBrains Mono, monospace"
        >{stats.mean.toFixed(0)}ms</text>

        <!-- Suspicion threshold line -->
        {#if stats.suspicionThreshold > 0}
          <line
            x1="0" y1={threshPx} x2={CHART_W} y2={threshPx}
            stroke="rgba(255,51,85,0.65)" stroke-width="1"
            stroke-dasharray="5,3"
          />
          <text
            x="4" y={threshPx - 3}
            fill="rgba(255,51,85,0.55)" font-size="8"
            font-family="JetBrains Mono, monospace"
          >{stats.suspicionThreshold.toFixed(0)}ms</text>
        {/if}
      {:else}
        <text
          x={CHART_W / 2} y={CHART_H / 2 + 4}
          fill="var(--text-void)"
          font-size="11"
          font-family="JetBrains Mono, monospace"
          text-anchor="middle"
        >type to populate chart…</text>
      {/if}
    </svg>
  </div>

  <!-- ═══ KEY WATCHER ══════════════════════════════════════════════════════ -->
  <div class="watch-panel">
    <div class="panel-head watch-head">
      <span class="panel-label">KEY WATCHER</span>

      {#if monitor.watchedKeyCode}
        <span class="watch-badge">
          {monitor.watchedKeyCode}
          <button class="watch-badge-x" onclick={() => monitor.clearWatchedKey()}>×</button>
        </span>
      {/if}

      {#if watchCapturing}
        <span class="watch-capturing">press any key… (Esc to cancel)</span>
      {:else}
        <button class="btn-watch" onclick={startWatchCapture}>
          {monitor.watchedKeyCode ? '⊙ Change Key' : '⊙ Set Watch Key'}
        </button>
      {/if}

      {#if monitor.watchedKeyCode}
        <span class="watch-hint">
          KD→KD: keydown interval · KU→KD: release-to-refire gap · bounce if KU→KD &lt; 20ms
        </span>
      {/if}
    </div>

    {#if monitor.watchedKeyCode}
      <div class="watch-scroll" bind:this={watchScrollEl}>
        {#if monitor.watchedKeyEvents.length === 0}
          <div class="log-empty">
            Watching <strong>{monitor.watchedKeyCode}</strong> — press the key to record events…
          </div>
        {:else}
          <div class="watch-header-row">
            <span>Time</span>
            <span>↕</span>
            <span>KD→KD</span>
            <span>KU→KD</span>
            <span>Hold</span>
            <span></span>
          </div>
          {#each monitor.watchedKeyEvents as ev (ev.id)}
            {@const cls = getWatchClass(ev)}
            {@const flag = fmtWatchFlag(ev)}
            <div
              class="watch-row"
              class:watch-normal={cls === 'watch-normal'}
              class:watch-keyup={cls === 'watch-keyup'}
              class:watch-warn={cls === 'watch-warn'}
              class:watch-bounce={cls === 'watch-bounce'}
            >
              <span class="l-time">{fmtWallTime(ev.wallTime)}</span>
              <span class="l-arrow">{ev.kind === 'keydown' ? '↓' : '↑'}</span>
              <span class="w-kdkd">{ev.kdToKd !== null ? `${ev.kdToKd.toFixed(1)}ms` : '—'}</span>
              <span class="w-kukd">{ev.kuToKd !== null ? `${ev.kuToKd.toFixed(1)}ms` : '—'}</span>
              <span class="w-hold">{ev.holdDuration !== null ? `${ev.holdDuration.toFixed(1)}ms` : '—'}</span>
              {#if flag}
                <span class="l-flag">{flag}</span>
              {:else}
                <span></span>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="watch-empty">
        No key selected — click <strong>Set Watch Key</strong> then press the suspected key.
        Tracks KD→KD (keydown-to-keydown) and KU→KD (release-to-refire) timing for that key only.
      </div>
    {/if}
  </div>

</div>

<!-- ──────────────────────────────────────────────────────── STYLES ────── -->

<style>
  /* ── Shell ──────────────────────────────────────────────────────────── */
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: var(--bg-void);
  }

  /* ── Header ─────────────────────────────────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 20px;
    height: 52px;
    border-bottom: 1px solid var(--border-base);
    background: var(--bg-panel);
    flex-shrink: 0;
    position: relative;
    z-index: 10;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .brand-glyph {
    font-size: 20px;
    line-height: 1;
    opacity: 0.8;
  }

  .brand-text {
    display: flex;
    flex-direction: column;
    gap: 0;
    line-height: 1;
  }

  .brand-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-white);
    letter-spacing: 0.5px;
  }

  .brand-sub {
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .stats-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .stat-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 10px;
    border-radius: var(--radius);
    min-width: 52px;
    flex-shrink: 0;
  }

  .stat-block.calibrating {
    flex-direction: row;
    min-width: unset;
  }

  .stat-block.dimmer { opacity: 0.55; }
  .stat-block.accent .stat-val { color: var(--blue); }
  .stat-block.warn-val-block { background: var(--warn-dim); }
  .stat-block.danger-val-block { background: var(--danger-dim); }

  .stat-val {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-bright);
    line-height: 1.1;
    letter-spacing: -0.5px;
  }

  .stat-val.warn-val { color: var(--warn); }
  .stat-val.danger-val { color: var(--danger); }

  .stat-key {
    font-size: 8.5px;
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 1px;
    white-space: nowrap;
  }

  .stat-sep {
    width: 1px;
    height: 28px;
    background: var(--border-base);
    margin: 0 4px;
    flex-shrink: 0;
  }

  .btn-clear {
    flex-shrink: 0;
    padding: 5px 14px;
    background: transparent;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 11.5px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
    letter-spacing: 0.3px;
  }

  .btn-clear:hover {
    border-color: var(--danger-border);
    color: var(--danger);
    background: var(--danger-dim);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .btn-copy {
    flex-shrink: 0;
    padding: 5px 14px;
    background: transparent;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 11.5px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
    letter-spacing: 0.3px;
  }

  .btn-copy:hover {
    border-color: var(--blue-border, rgba(68,102,255,0.4));
    color: var(--blue, #4466ff);
    background: var(--blue-dim, rgba(68,102,255,0.1));
  }

  .btn-copy.is-copied {
    border-color: var(--green, #2ecc71);
    color: var(--green, #2ecc71);
    background: rgba(46, 204, 113, 0.1);
  }

  /* ── Main area ───────────────────────────────────────────────────────── */
  .main {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* ── Panel shared ────────────────────────────────────────────────────── */
  .panel-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 14px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-raised);
    flex-shrink: 0;
  }

  .panel-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .panel-hint {
    font-size: 10px;
    color: var(--text-dim);
    font-style: italic;
  }

  .panel-hint.online {
    color: var(--green);
    font-style: normal;
    font-weight: 600;
    animation: pulse-online 2s ease-in-out infinite;
  }

  @keyframes pulse-online {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* ── Typing panel ────────────────────────────────────────────────────── */
  .typing-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border-subtle);
    transition: border-color 0.25s;
    min-width: 0;
  }

  .typing-panel.panel-focused {
    border-right-color: var(--border-active);
  }

  .typing-area {
    flex: 1;
    padding: 28px 32px;
    font-size: 24px;
    line-height: 1.85;
    letter-spacing: 0.3px;
    word-break: break-all;
    overflow-y: auto;
    cursor: text;
    outline: none;
    white-space: pre-wrap;
    min-height: 0;
    background: var(--bg-input);
    transition: background 0.2s;
  }

  .typing-area:focus {
    background: var(--bg-base);
  }

  .placeholder {
    color: var(--text-void);
    font-style: italic;
    font-size: 16px;
    pointer-events: none;
    user-select: none;
  }

  .char {
    display: inline;
    position: relative;
    transition: color 0.08s;
  }

  .char-suspicious {
    text-decoration: underline wavy;
    text-decoration-color: currentColor;
    text-decoration-skip-ink: none;
    text-underline-offset: 3px;
  }

  .char-double {
    font-weight: 800;
  }

  .caret {
    display: inline;
    color: var(--blue);
    opacity: 0.3;
    margin-left: 1px;
  }

  .caret.caret-blink {
    animation: caret-blink 1.1s step-end infinite;
    opacity: 1;
  }

  @keyframes caret-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* Legend */
  .legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    padding: 7px 16px;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-raised);
    flex-shrink: 0;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .legend-item.dimmer { opacity: 0.6; font-style: italic; }

  .swatch {
    font-size: 11px;
    line-height: 1;
  }

  /* ── Log panel ───────────────────────────────────────────────────────── */
  .log-panel {
    width: var(--log-w);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-left: 1px solid var(--border-subtle);
    min-width: 0;
  }

  .log-head {
    gap: 6px;
  }

  .log-count {
    font-size: 10px;
    color: var(--text-dim);
    background: var(--border-base);
    padding: 1px 6px;
    border-radius: 10px;
  }

  .log-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 3px 8px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius);
    transition: all 0.15s;
    user-select: none;
  }

  .toggle:hover {
    border-color: var(--border-active);
    color: var(--text-bright);
  }

  .toggle-active {
    border-color: var(--warn-border);
    color: var(--warn);
    background: var(--warn-dim);
  }

  .toggle input {
    display: none;
  }

  .log-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .log-empty {
    padding: 24px 16px;
    color: var(--text-void);
    text-align: center;
    font-style: italic;
    font-size: 11px;
  }

  /* Log rows */
  .log-row {
    display: grid;
    grid-template-columns: 78px 12px 20px 20px 1fr 62px auto;
    align-items: center;
    gap: 5px;
    padding: 2px 10px 2px 8px;
    border-left: 2px solid transparent;
    border-bottom: 1px solid var(--bg-base);
    font-size: 10.5px;
    transition: background 0.1s;
    min-height: 22px;
  }

  .log-row:hover { background: rgba(255,255,255,0.015); }

  .log-normal  { border-left-color: transparent; }
  .log-keyup   { border-left-color: transparent; opacity: 0.35; }
  .log-pause   { border-left-color: var(--pause-border); background: var(--pause-dim); }
  .log-warn    { border-left-color: var(--warn-border);  background: var(--warn-dim); }
  .log-danger  { border-left-color: var(--danger-border); background: var(--danger-dim); }

  .l-time  { color: var(--text-dim); font-size: 9.5px; }
  .l-arrow { color: var(--text-muted); text-align: center; }
  .l-kind  { color: var(--text-dim); font-size: 9px; }
  .l-key   { color: var(--text-white); font-weight: 600; overflow: hidden; }
  .l-code  { color: var(--text-dim); font-size: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l-iki   { color: var(--text-muted); text-align: right; font-size: 10px; }
  .l-hold  { color: var(--text-dim); text-align: right; font-size: 9.5px; }
  .l-flag  { color: var(--danger); font-weight: 700; font-size: 9.5px; white-space: nowrap; }

  .log-warn  .l-flag { color: var(--warn); }
  .log-pause .l-flag { color: var(--pause); }

  /* ── Chart ───────────────────────────────────────────────────────────── */
  .chart-panel {
    border-top: 1px solid var(--border-base);
    background: var(--bg-panel);
    flex-shrink: 0;
    padding: 7px 16px 10px;
  }

  .chart-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }

  .chart-sub {
    font-size: 9.5px;
    color: var(--text-dim);
  }

  .iki-svg {
    width: 100%;
    height: 54px;
    display: block;
  }

  /* ── Key Watcher panel ───────────────────────────────────────────────── */
  .watch-panel {
    border-top: 1px solid var(--border-base);
    background: var(--bg-panel);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    max-height: 190px;
  }

  .watch-head {
    gap: 8px;
    flex-wrap: nowrap;
  }

  .watch-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--blue-dim);
    border: 1px solid rgba(68, 102, 255, 0.35);
    border-radius: var(--radius);
    padding: 1px 6px 1px 8px;
    font-size: 10px;
    color: var(--blue);
    font-weight: 700;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .watch-badge-x {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    transition: color 0.15s;
  }

  .watch-badge-x:hover { color: var(--danger); }

  .watch-capturing {
    font-size: 10px;
    color: var(--warn);
    font-weight: 600;
    animation: pulse-online 0.8s ease-in-out infinite;
    flex-shrink: 0;
  }

  .btn-watch {
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--border-base);
    border-radius: var(--radius);
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 10px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
    flex-shrink: 0;
  }

  .btn-watch:hover {
    border-color: var(--blue);
    color: var(--blue);
  }

  .watch-hint {
    font-size: 9px;
    color: var(--text-dim);
    margin-left: auto;
    font-style: italic;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .watch-empty {
    padding: 8px 16px;
    color: var(--text-void);
    font-size: 10.5px;
    font-style: italic;
  }

  .watch-empty strong { color: var(--text-dim); font-style: normal; }

  .watch-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .watch-header-row {
    display: grid;
    grid-template-columns: 82px 14px 78px 78px 72px 1fr;
    gap: 5px;
    padding: 3px 10px 3px 8px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 8.5px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 1px;
    background: var(--bg-raised);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .watch-row {
    display: grid;
    grid-template-columns: 82px 14px 78px 78px 72px 1fr;
    align-items: center;
    gap: 5px;
    padding: 2px 10px 2px 8px;
    border-left: 2px solid transparent;
    border-bottom: 1px solid var(--bg-base);
    font-size: 10.5px;
    min-height: 20px;
    transition: background 0.1s;
  }

  .watch-row:hover { background: rgba(255, 255, 255, 0.015); }

  .watch-normal { border-left-color: transparent; }
  .watch-keyup  { border-left-color: transparent; opacity: 0.38; }
  .watch-warn   { border-left-color: var(--warn-border);    background: var(--warn-dim); }
  .watch-bounce { border-left-color: var(--danger-border);  background: var(--danger-dim); }

  .w-kdkd { color: var(--text-muted); font-size: 10px; }
  .w-kukd { color: var(--text-bright); font-size: 10px; font-weight: 600; }
  .w-hold { color: var(--text-dim); font-size: 9.5px; }

  .watch-bounce .w-kukd { color: var(--danger); }
  .watch-warn   .w-kukd { color: var(--warn); }
</style>
