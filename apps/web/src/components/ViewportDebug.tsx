import { useEffect, useRef, useState } from 'react';

/**
 * Temporary on-device viewport diagnostic. Renders a live readout of every
 * height signal we might use to size the mobile shell, so we can see *which*
 * one is wrong (and in which direction) when the tab bar leaves a gap — instead
 * of guessing. Toggle it by tapping the "CountRoster" title 5× (see AppLayout);
 * the choice is persisted in localStorage so a reload can capture first-load
 * values too. Remove once the gap bug is fixed.
 */

type Metrics = Record<string, string | number>;

/** Measure a CSS length (e.g. "100dvh", "env(safe-area-inset-bottom)") in px. */
function probe(cssHeight: string): number {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:-9999px;top:0;width:1px;height:${cssHeight};`;
  document.body.appendChild(el);
  const h = el.getBoundingClientRect().height;
  el.remove();
  return Math.round(h);
}

function displayMode(): string {
  for (const m of ['standalone', 'fullscreen', 'minimal-ui', 'browser']) {
    if (window.matchMedia(`(display-mode: ${m})`).matches) return m;
  }
  return 'unknown';
}

function collect(): Metrics {
  const vv = window.visualViewport;
  const docEl = document.documentElement;
  const app = document.querySelector('.app')?.getBoundingClientRect();
  const bar = document.querySelector('.tab-bar')?.getBoundingClientRect();
  const appHeightVar = getComputedStyle(docEl).getPropertyValue('--app-height').trim();
  const innerH = window.innerHeight;
  const vvH = vv ? Math.round(vv.height) : 0;
  const barBottom = bar ? Math.round(bar.bottom) : 0;
  return {
    mode: displayMode(),
    innerH,
    'vv.height': vvH,
    'vv.offsetTop': vv ? Math.round(vv.offsetTop) : 0,
    'vv.pageTop': vv ? Math.round(vv.pageTop) : 0,
    'vv.scale': vv ? +vv.scale.toFixed(2) : 0,
    'docEl.clientH': docEl.clientHeight,
    'screen.availH': window.screen.availHeight,
    '100dvh': probe('100dvh'),
    '100svh': probe('100svh'),
    '100lvh': probe('100lvh'),
    '100vh': probe('100vh'),
    safeBottom: probe('env(safe-area-inset-bottom)'),
    '--app-height': appHeightVar || '(unset)',
    scrollY: Math.round(window.scrollY),
    'app.height': app ? Math.round(app.height) : 0,
    'tabBar.bottom': barBottom,
    'GAP(inner-bar)': innerH - barBottom,
    'GAP(vv-bar)': vvH - barBottom,
  };
}

export function ViewportDebug() {
  const [metrics, setMetrics] = useState<Metrics>({});
  const [snapshot, setSnapshot] = useState<Metrics | null>(null);
  const raf = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = (t: number) => {
      if (!alive) return;
      // ~6 Hz is plenty and keeps the readout legible.
      if (t - last.current > 160) {
        last.current = t;
        setMetrics(collect());
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    const onEvt = () => setMetrics(collect());
    window.addEventListener('resize', onEvt);
    window.addEventListener('scroll', onEvt, true);
    window.visualViewport?.addEventListener('resize', onEvt);
    window.visualViewport?.addEventListener('scroll', onEvt);
    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
      window.removeEventListener('resize', onEvt);
      window.removeEventListener('scroll', onEvt, true);
      window.visualViewport?.removeEventListener('resize', onEvt);
      window.visualViewport?.removeEventListener('scroll', onEvt);
    };
  }, []);

  const rows = Object.entries(snapshot ?? metrics);
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.86)',
        color: '#7CFC9A',
        font: '11px/1.35 ui-monospace, Menlo, monospace',
        padding: '6px 8px 8px',
        pointerEvents: 'auto',
        maxHeight: '52vh',
        overflow: 'auto',
        borderBottom: '1px solid #2a2a2a',
      }}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 4, alignItems: 'center' }}>
        <strong style={{ color: '#fff' }}>viewport debug</strong>
        <button
          onClick={() => setSnapshot(snapshot ? null : collect())}
          style={{ font: 'inherit', padding: '2px 6px' }}
        >
          {snapshot ? 'resume live' : 'freeze'}
        </button>
        <input
          placeholder="tap to open keyboard"
          style={{ font: 'inherit', flex: 1, minWidth: 0 }}
        />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto 1fr',
          gap: '0 10px',
        }}
      >
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ color: '#9aa' }}>{k}</span>
            <span style={{ color: '#fff', textAlign: 'right' }}>{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
