import { dbToAmplitude, type Envelope, envelopeGainAt } from '@ondes/shared';
import { cn } from 'cn';
import { useRef } from 'react';
import {
  sampleToX,
  usePeaks,
  Waveform,
  type WaveformView,
  xToSample,
} from '../cue-editor/waveform/index.ts';
import type { SegueT } from './messages.ts';
import {
  addPoint,
  type Clip,
  clipEnd,
  DISPLAY_MAX_DB,
  fileSample,
  gainToY,
  movePoint,
  yToGain,
} from './model.ts';
import { formatOffset } from './view.ts';

// One lane of the segue editor (#58): a clip's waveform where it plays on the axis, its gain
// envelope on top, and the pointer handling: drag the clip (B and voices) to move it, drag a
// point to shape the envelope, double-click to add a point, click to move the cursor. Pointer
// events, so a trackpad, a mouse and a pen all work the same.

/** Pixels a press may wander and still count as a click. */
const CLICK_SLOP_PX = 3;
/** A dragged clip snaps to A's end (0) within this many pixels. */
const SNAP_PX = 6;
const POINT_RADIUS = 5;

export interface LaneStyle {
  /** Accent strip (`bg-*`). */
  accent: string;
  /** Waveform colour (`text-*`). */
  wave: string;
  /** Envelope line and points (`stroke-*` / `fill-*`). */
  line: string;
  point: string;
}

export interface LaneProps {
  stationId: string;
  clip: Clip;
  title: string;
  view: WaveformView;
  width: number;
  height: number;
  style: LaneStyle;
  t: SegueT;
  /** B and voices move; A doesn't. */
  movable: boolean;
  /** Envelopes can be edited (`voice_track:write`); readers only seek and select. */
  editable: boolean;
  selected: boolean;
  selectedPoint: number | null;
  onSelect(point: number | null): void;
  onSeek(axis: number): void;
  /** A drag starts (one undo step), moves, ends. */
  onBegin(): void;
  onEnd(): void;
  onMove(start: number): void;
  onEnvelope(envelope: Envelope): void;
}

type Drag =
  | { kind: 'press'; x0: number; start0: number; moved: boolean }
  | { kind: 'point'; index: number };

export function Lane(props: LaneProps) {
  const { stationId, clip, view, width, height, style, t, movable, selected } = props;
  const peaks = usePeaks(stationId, clip.media.assetId);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const x = (axis: number) => sampleToX(view, width, axis);
  const end = clipEnd(clip);
  // The clip's visible part, in axis samples and pixels.
  const visFrom = Math.max(view.fromSample, clip.at);
  const visTo = Math.min(view.toSample, end);
  const visible = visTo > visFrom;
  const left = x(visFrom);
  const boxWidth = Math.max(0, x(visTo) - left);

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = (track.current as HTMLDivElement).getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };
  const axisAt = (px: number) => xToSample(view, width, px);
  const gainAt = (py: number) => yToGain(1 - py / height);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const index = target.getAttribute('data-point');
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (index !== null && props.editable) {
      props.onSelect(Number(index));
      props.onBegin();
      drag.current = { kind: 'point', index: Number(index) };
      return;
    }
    drag.current = { kind: 'press', x0: e.clientX, start0: clip.at, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { px, py } = local(e);
    if (d.kind === 'point') {
      props.onEnvelope(movePoint(clip.envelope, d.index, { at: axisAt(px), gainDb: gainAt(py) }));
      return;
    }
    if (!movable) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < CLICK_SLOP_PX) return;
    if (!d.moved) {
      d.moved = true;
      props.onBegin();
    }
    const spp = (view.toSample - view.fromSample) / Math.max(1, width);
    let start = Math.round(d.start0 + dx * spp);
    if (Math.abs(start) < SNAP_PX * spp) start = 0;
    props.onMove(start);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'point' || d.moved) {
      props.onEnd();
      return;
    }
    // A click: select the lane and move the cursor there.
    props.onSelect(null);
    props.onSeek(axisAt(local(e).px));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!props.editable || (e.target as Element).getAttribute('data-point') !== null) return;
    const { px, py } = local(e);
    const at = axisAt(px);
    const next = addPoint(clip.envelope, { at, gainDb: gainAt(py) });
    props.onEnvelope(next);
    props.onSelect(next.findIndex((p) => p.at === at));
  };

  // The envelope across the lane: straight segments (linear in amplitude = linear in y).
  const yOf = (amp: number) => height - (amp / dbToAmplitude(DISPLAY_MAX_DB)) * height;
  const env = clip.envelope;
  const path: [number, number][] = [[0, yOf(envelopeGainAt(env, view.fromSample))]];
  for (const p of env) {
    if (p.at > view.fromSample && p.at < view.toSample) {
      path.push([x(p.at), height - gainToY(p.gainDb) * height]);
    }
  }
  path.push([width, yOf(envelopeGainAt(env, view.toSample))]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer editing; the keyboard edits the selected lane through the page's keys (arrows, Delete).
    <div
      ref={track}
      className={cn(
        'relative touch-none select-none overflow-hidden bg-muted/30',
        movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-text',
      )}
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {visible && (
        <div
          className={cn(
            'absolute inset-y-1 overflow-hidden rounded-[4px] bg-background',
            selected && 'ring-2 ring-ring',
          )}
          style={{ left, width: boxWidth }}
        >
          {/* Pinned to the box's left edge, which is the clip's start or the view's edge. */}
          <span className={cn('absolute inset-y-0 left-0 z-10 w-1', style.accent)} />
          {peaks.data ? (
            <Waveform
              peaks={peaks.data}
              fromSample={fileSample(clip, visFrom)}
              toSample={fileSample(clip, visTo)}
              height={height - 8}
              className={cn('opacity-70', style.wave)}
            />
          ) : (
            peaks.isError && (
              <span className="absolute inset-0 flex items-center pl-3 text-xs text-muted-foreground">
                {t('lane.noPeaks')}
              </span>
            )
          )}
        </div>
      )}
      <svg
        className="pointer-events-none absolute inset-0"
        width={width}
        height={height}
        aria-hidden
      >
        <polyline
          points={path.map(([px, py]) => `${px},${py}`).join(' ')}
          className={cn('fill-none', style.line)}
          strokeWidth={1.5}
        />
        {env.map((p, i) =>
          p.at >= view.fromSample && p.at <= view.toSample ? (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: points are addressed by index.
              key={i}
              data-point={i}
              cx={x(p.at)}
              cy={height - gainToY(p.gainDb) * height}
              r={props.selectedPoint === i ? POINT_RADIUS + 1.5 : POINT_RADIUS}
              className={cn('pointer-events-auto cursor-move stroke-background', style.point)}
              strokeWidth={1.5}
            >
              <title>
                {t('lane.point', {
                  time: formatOffset(p.at, 2),
                  gain: p.gainDb <= -90 ? '−∞ dB' : `${p.gainDb.toFixed(1)} dB`,
                })}
              </title>
            </circle>
          ) : null,
        )}
      </svg>
    </div>
  );
}
