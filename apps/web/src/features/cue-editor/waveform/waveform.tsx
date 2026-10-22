import type { DecodedPeaks } from '@ondes/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/ui/lib/utils';
import { drawPeaks } from './draw.ts';

// A draw-only waveform (#24): the window `[fromSample, toSample)` of an asset's peaks, across
// the width of its container. Overlays (markers, cursors, envelopes) go on top, outside it.

/** Width of an element in CSS pixels, kept up to date (ResizeObserver). */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export interface WaveformProps {
  peaks: DecodedPeaks;
  /** First sample of the window; may be negative (nothing is drawn before the asset). */
  fromSample: number;
  /** End of the window (exclusive); may be past the asset's end. */
  toSample: number;
  /** Height in CSS pixels. */
  height: number;
  /** Bar colour (any CSS colour). Default: the element's text colour (`text-*` classes). */
  color?: string;
  className?: string;
}

export function Waveform({ peaks, fromSample, toSample, height, color, className }: WaveformProps) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el || width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    el.width = Math.round(width * ratio);
    el.height = Math.round(height * ratio);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const fill = color ?? getComputedStyle(el).color;
    drawPeaks(ctx, peaks, { fromSample, toSample }, width, height, { color: fill }, ratio);
  }, [peaks, fromSample, toSample, width, height, color]);

  return (
    <div ref={box} className={cn('w-full text-primary', className)} style={{ height }}>
      <canvas ref={canvas} aria-hidden className="block" style={{ width, height }} />
    </div>
  );
}
