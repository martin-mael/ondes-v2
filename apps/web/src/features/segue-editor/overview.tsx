import { cn } from 'cn';
import { useRef } from 'react';
import {
  sampleToX,
  useElementWidth,
  type WaveformView,
  xToSample,
} from '../cue-editor/waveform/index.ts';
import type { SegueT } from './messages.ts';
import { type Clip, clipEnd } from './model.ts';
import { type Bounds, formatOffset, ticks } from './view.ts';

// The ruler above the lanes and the overview bar of the whole transition (#58).

/** Seconds from A's end; click or drag to move the cursor. */
export function Ruler({
  view,
  width,
  cursor,
  t,
  onSeek,
}: {
  view: WaveformView;
  width: number;
  cursor: number;
  t: SegueT;
  onSeek(axis: number): void;
}) {
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(xToSample(view, width, e.clientX - rect.left));
  };
  return (
    <div
      role="slider"
      tabIndex={-1}
      aria-label={t('ruler.label')}
      aria-valuenow={cursor}
      aria-valuetext={formatOffset(cursor, 2)}
      className="relative h-6 cursor-text touch-none select-none border-b text-[10px] text-muted-foreground"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e);
      }}
    >
      {ticks(view, width).map((at) => (
        <span
          key={at}
          className={cn(
            'absolute bottom-0 h-2 border-l pl-1 leading-none',
            at === 0 && 'h-full border-foreground text-foreground',
          )}
          style={{ left: sampleToX(view, width, at) }}
        >
          <span className="absolute -top-3.5 left-1 whitespace-nowrap">{formatOffset(at)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The whole transition in one bar: each clip as a thin line in its lane's colour, the island
 * that will render, the cursor, and the visible window, which drags to scroll.
 */
export function Overview({
  bounds,
  clips,
  colors,
  island,
  view,
  cursor,
  t,
  onView,
}: {
  bounds: Bounds;
  clips: Clip[];
  colors: Record<string, string>;
  island: Bounds | null;
  view: WaveformView;
  cursor: number;
  t: SegueT;
  onView(view: WaveformView): void;
}) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const full: WaveformView = { fromSample: bounds.from, toSample: bounds.to };
  const x = (axis: number) => sampleToX(full, width, axis);
  const grab = useRef<{ x0: number; from0: number } | null>(null);
  const span = view.toSample - view.fromSample;
  const rowHeight = Math.max(3, Math.floor(28 / Math.max(1, clips.length)));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const at = xToSample(full, width, e.clientX - rect.left);
    // Outside the window: centre it there first, then drag from it.
    const from0 = at >= view.fromSample && at <= view.toSample ? view.fromSample : at - span / 2;
    if (from0 !== view.fromSample) onView({ fromSample: from0, toSample: from0 + span });
    grab.current = { x0: e.clientX, from0 };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    const delta = ((e.clientX - g.x0) / Math.max(1, width)) * (bounds.to - bounds.from);
    const from = g.from0 + delta;
    onView({ fromSample: from, toSample: from + span });
  };

  return (
    <div
      ref={box}
      role="scrollbar"
      aria-orientation="horizontal"
      aria-controls="segue-lanes"
      aria-label={t('overview.label')}
      aria-valuenow={Math.round(view.fromSample)}
      tabIndex={-1}
      className="relative h-9 cursor-pointer touch-none select-none overflow-hidden rounded-md border bg-muted/30"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        grab.current = null;
      }}
      onPointerCancel={() => {
        grab.current = null;
      }}
    >
      {island && (
        <div
          className="absolute inset-y-0 bg-primary/10"
          style={{ left: x(island.from), width: x(island.to) - x(island.from) }}
        />
      )}
      <div
        className="absolute left-0 h-full border-l border-foreground/40"
        style={{ left: x(0) }}
      />
      {clips.map((c, i) => (
        <div
          key={c.key}
          className={cn('absolute rounded-full', colors[c.key] ?? 'bg-foreground')}
          style={{
            left: x(c.at),
            width: Math.max(2, x(clipEnd(c)) - x(c.at)),
            top: 4 + i * rowHeight,
            height: Math.max(2, rowHeight - 2),
          }}
        />
      ))}
      <div className="absolute inset-y-0 w-px bg-destructive" style={{ left: x(cursor) }} />
      <div
        className="absolute inset-y-0 rounded-sm border-2 border-primary/70 bg-primary/5"
        style={{
          left: x(view.fromSample),
          width: Math.max(4, x(view.toSample) - x(view.fromSample)),
        }}
      />
    </div>
  );
}
