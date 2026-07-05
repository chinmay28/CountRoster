import { useEffect, useRef, useState } from 'react';
import * as Plot from '@observablehq/plot';

interface PlotFigureProps {
  /**
   * A memoized Plot spec (the object passed to `Plot.plot`). **Memoize it**
   * (`useMemo`) in the caller — this component re-renders the figure whenever
   * the spec identity changes.
   */
  options: Plot.PlotOptions;
  /** Accessible label for the rendered figure. */
  ariaLabel: string;
  className?: string;
  /**
   * When true (default), the figure is sized to its container width so it
   * stays readable on a phone. Set false for intrinsically-wide charts that
   * should scroll horizontally instead of squish.
   */
  responsive?: boolean;
}

/**
 * Render an Observable Plot figure into the React tree. Plot produces a DOM
 * node imperatively, so we append it in an effect and replace it whenever the
 * spec (or measured width) changes — the standard Plot + React integration,
 * with a ResizeObserver so charts fit small screens.
 */
export function PlotFigure({
  options,
  ariaLabel,
  className,
  responsive = true,
}: PlotFigureProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);

  // Track the container width so the figure can fill it on mobile.
  useEffect(() => {
    if (!responsive) return;
    const host = ref.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [responsive]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const spec: Plot.PlotOptions = {
      ...options,
      ...(responsive && width ? { width } : {}),
      // Inherit the app's text color so axes/labels are visible in dark mode
      // (Plot defaults to a white background and black text).
      style: {
        background: 'transparent',
        color: 'currentColor',
        ...(typeof options.style === 'object' ? options.style : {}),
      },
    };
    const figure = Plot.plot(spec);
    host.append(figure);
    return () => figure.remove();
  }, [options, width, responsive]);

  return (
    <div ref={ref} className={className} role="img" aria-label={ariaLabel} />
  );
}
