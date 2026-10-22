import type { DecodedPeaks } from '@ondes/shared';
import { useEffect, useRef } from 'react';
import { cn } from '@/ui/lib/utils';
import { sampleToX, scrollView, type WaveformView, xToSample, zoomView } from './view.ts';
import { useElementWidth, Waveform } from './waveform.tsx';

// An interactive waveform (#24): the draw-only `Waveform` plus wheel zoom and scroll, a
// playhead, and generic draggable markers and shaded regions. It knows nothing about cues: the
// caller maps its own points to markers and clamps them in `onMarkerChange`.
//
// - Wheel (or pinch): zooms around the pointer. Shift + wheel, or a horizontal swipe: scrolls.
// - Click on the waveform: `onSeek(sample)`.
// - Drag a marker's handle, or focus it and use ←/→ (Shift: ×10): `onMarkerChange(id, sample)`
//   while moving, `onMarkerCommit(id, sample)` once released.

export interface WaveformMarker {
  id: string;
  sample: number;
  /** Short text on the handle. */
  label: string;
  /** Any CSS colour (e.g. `var(--chart-1)`). */
  color: string;
  /** Accessible name and tooltip; default `label`. */
  title?: string;
  /** Default true. */
  draggable?: boolean;
}

export interface WaveformRegion {
  id: string;
  fromSample: number;
  toSample: number;
  /** Any CSS colour; drawn translucent. */
  color: string;
}

export interface WaveformEditorProps {
  peaks: DecodedPeaks;
  view: WaveformView;
  onViewChange: (view: WaveformView) => void;
  height?: number;
  markers?: readonly WaveformMarker[];
  regions?: readonly WaveformRegion[];
  /** Playback position, if any. */
  playhead?: number | null;
  onSeek?: (sample: number) => void;
  onMarkerChange?: (id: string, sample: number) => void;
  onMarkerCommit?: (id: string, sample: number) => void;
  /** Samples one arrow key press moves a marker; default 10 ms. */
  keyStep?: number;
  /** Formats a sample position for screen readers (aria-valuetext). */
  formatSample?: (sample: number) => string;
  'aria-label'?: string;
  className?: string;
}

const ZOOM_PER_WHEEL_PIXEL = 1.002;

export function WaveformEditor({
  peaks,
  view,
  onViewChange,
  height = 128,
  markers = [],
  regions = [],
  playhead,
  onSeek,
  onMarkerChange,
  onMarkerCommit,
  keyStep,
  formatSample,
  'aria-label': ariaLabel,
  className,
}: WaveformEditorProps) {
  const [box, width] = useElementWidth<HTMLElement>();
  const length = peaks.lengthSamples;
  const step = keyStep ?? Math.max(1, Math.round(peaks.sampleRate / 100));
  // The wheel listener is registered once; it reads the latest props from here.
  const latest = useRef({ view, onViewChange, width, length });
  latest.current = { view, onViewChange, width, length };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const { view, onViewChange, width, length } = latest.current;
      if (width <= 0) return;
      event.preventDefault();
      const dx = event.deltaX || 0;
      const dy = event.deltaY || 0;
      const horizontal = event.shiftKey || Math.abs(dx) > Math.abs(dy);
      if (horizontal) {
        const delta = event.shiftKey && dx === 0 ? dy : dx;
        onViewChange(scrollView(view, (delta / width) * (view.toSample - view.fromSample), length));
      } else {
        // Some environments (happy-dom) leave clientX unset on wheel events: zoom on the centre.
        const x = Number.isFinite(event.clientX)
          ? event.clientX - el.getBoundingClientRect().left
          : width / 2;
        const anchor = xToSample(view, width, x);
        onViewChange(zoomView(view, ZOOM_PER_WHEEL_PIXEL ** -dy, anchor, length));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [box]);

  const sampleAt = (clientX: number) => {
    const el = box.current;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left;
    return Math.min(length, Math.max(0, xToSample(view, width, x)));
  };
  const visible = (sample: number) => sample >= view.fromSample && sample <= view.toSample;
  const x = (sample: number) => sampleToX(view, width, sample);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: seeking by pointer; the markers and the caller's transport have keys
    <section
      ref={box}
      data-waveform
      aria-label={ariaLabel}
      className={cn('relative w-full touch-none overflow-hidden select-none', className)}
      style={{ height }}
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target instanceof HTMLCanvasElement) {
          onSeek?.(sampleAt(event.clientX));
        }
      }}
    >
      {width > 0 && (
        <Waveform
          peaks={peaks}
          fromSample={view.fromSample}
          toSample={view.toSample}
          height={height}
          className="pointer-events-none absolute inset-0"
        />
      )}
      {width > 0 &&
        regions.map((region) => {
          const left = Math.max(0, x(region.fromSample));
          const right = Math.min(width, x(region.toSample));
          if (right <= left) return null;
          return (
            <div
              key={region.id}
              aria-hidden
              data-region={region.id}
              className="pointer-events-none absolute inset-y-0 opacity-15"
              style={{ left, width: right - left, background: region.color }}
            />
          );
        })}
      {width > 0 && playhead != null && visible(playhead) && (
        <div
          aria-hidden
          data-playhead
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground"
          style={{ left: x(playhead) }}
        />
      )}
      {width > 0 &&
        markers.map((marker) =>
          visible(marker.sample) ? (
            <Marker
              key={marker.id}
              marker={marker}
              left={x(marker.sample)}
              length={length}
              step={step}
              sampleAt={sampleAt}
              formatSample={formatSample}
              onChange={onMarkerChange}
              onCommit={onMarkerCommit}
            />
          ) : null,
        )}
    </section>
  );
}

function Marker({
  marker,
  left,
  length,
  step,
  sampleAt,
  formatSample,
  onChange,
  onCommit,
}: {
  marker: WaveformMarker;
  left: number;
  length: number;
  step: number;
  sampleAt: (clientX: number) => number;
  formatSample?: (sample: number) => string;
  onChange?: (id: string, sample: number) => void;
  onCommit?: (id: string, sample: number) => void;
}) {
  const draggable = marker.draggable !== false && onChange !== undefined;
  const dragging = useRef(false);
  const last = useRef(marker.sample);
  last.current = marker.sample;
  const move = (sample: number) => {
    const clamped = Math.min(length, Math.max(0, Math.round(sample)));
    last.current = clamped;
    onChange?.(marker.id, clamped);
  };
  const title = marker.title ?? marker.label;

  return (
    <div
      className="pointer-events-none absolute inset-y-0"
      style={{ left }}
      data-marker={marker.id}
    >
      <div className="absolute inset-y-0 w-px" style={{ background: marker.color }} />
      <div
        role="slider"
        tabIndex={draggable ? 0 : -1}
        aria-label={title}
        aria-disabled={!draggable}
        aria-valuemin={0}
        aria-valuemax={length}
        aria-valuenow={marker.sample}
        aria-valuetext={formatSample?.(marker.sample)}
        title={title}
        className={cn(
          'pointer-events-auto absolute top-0 rounded-r-[4px] px-1 text-[0.625rem] leading-4 font-medium whitespace-nowrap text-white outline-none focus-visible:ring-2 focus-visible:ring-ring',
          draggable && 'cursor-ew-resize',
        )}
        style={{ background: marker.color }}
        onPointerDown={(event) => {
          if (!draggable) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          dragging.current = true;
        }}
        onPointerMove={(event) => {
          if (dragging.current) move(sampleAt(event.clientX));
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          onCommit?.(marker.id, last.current);
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (!draggable) return;
          const by = event.shiftKey ? step * 10 : step;
          let next: number | undefined;
          if (event.key === 'ArrowLeft') next = marker.sample - by;
          else if (event.key === 'ArrowRight') next = marker.sample + by;
          if (next === undefined) return;
          event.preventDefault();
          move(next);
          onCommit?.(marker.id, last.current);
        }}
      >
        {marker.label}
      </div>
    </div>
  );
}
