import type { LogItem, LogItemKind } from '@ondes/shared';
import { ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { useTimelineT } from './messages.ts';
import { endMs, type ShowBlock, startMs } from './model.ts';
import { formatClock, formatDuration, HOUR_MS, type HourSlot } from './time.ts';

// The day as a horizontal, zoomable strip (#51): one block per item, show blocks banded on
// top, hour ticks and the live "now" line. Clicking a block selects the item in the list.

const ZOOMS_PX_PER_HOUR = [48, 96, 192, 480, 1200] as const;

export const KIND_COLORS: Record<LogItemKind, string> = {
  song: 'bg-sky-500/70',
  vt: 'bg-amber-500/80',
  jingle: 'bg-fuchsia-500/70',
  bed: 'bg-teal-500/60',
  episode: 'bg-indigo-500/70',
  live_slot: 'bg-rose-500/70',
  marker: 'bg-foreground',
  fill: 'bg-teal-500/40',
  segment: 'bg-orange-500/70',
};

export function DayStrip({
  items,
  hours,
  dayStart,
  dayEnd,
  now,
  timeZone,
  onAirId,
  blocks,
  onSelect,
}: {
  items: readonly LogItem[];
  hours: readonly HourSlot[];
  dayStart: number;
  dayEnd: number;
  now: number;
  timeZone: string;
  onAirId: string | null;
  blocks: ReadonlyMap<string, ShowBlock>;
  onSelect(item: LogItem): void;
}) {
  const t = useTimelineT();
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const px = ZOOMS_PX_PER_HOUR[zoom] ?? 96;
  const x = (at: number) => ((at - dayStart) / HOUR_MS) * px;
  const width = x(dayEnd);
  const nowVisible = now >= dayStart && now < dayEnd;
  const nowRef = useRef(now);
  nowRef.current = now;

  // Bring "now" (or the start of the day) into view on a new day or zoom, not on every tick.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const at = nowRef.current;
    const target = at >= dayStart && at < dayEnd ? ((at - dayStart) / HOUR_MS) * px : 0;
    el.scrollLeft = Math.max(0, target - el.clientWidth / 2);
  }, [px, dayStart, dayEnd]);

  return (
    <section aria-label={t('strip.label')} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={t('strip.zoomOut')}
          disabled={zoom === 0}
          onClick={() => setZoom((z) => Math.max(0, z - 1))}
        >
          <ZoomOutIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={t('strip.zoomIn')}
          disabled={zoom === ZOOMS_PX_PER_HOUR.length - 1}
          onClick={() => setZoom((z) => Math.min(ZOOMS_PX_PER_HOUR.length - 1, z + 1))}
        >
          <ZoomInIcon />
        </Button>
      </div>
      <div
        ref={scroller}
        // Its content is the whole day: keep it from widening the page.
        className="overflow-x-auto rounded-md border bg-muted/30 contain-inline-size"
      >
        <div className="relative h-20" style={{ width }}>
          {hours.map((h) => (
            <div
              key={h.start}
              className="absolute inset-y-0 border-l border-border/70"
              style={{ left: x(h.start) }}
            >
              <span className="absolute top-0.5 left-1 text-[0.625rem] text-muted-foreground tabular-nums whitespace-nowrap">
                {h.label}
              </span>
            </div>
          ))}
          {items.map((item) => {
            const block = blocks.get(item.id);
            const left = x(Math.max(startMs(item), dayStart));
            const w = Math.max(2, x(Math.min(endMs(item), dayEnd)) - left);
            const label = item.asset?.title ?? item.title ?? item.kind;
            return (
              <button
                type="button"
                key={item.id}
                title={`${formatClock(item.plannedStart, timeZone)} · ${label} · ${formatDuration(item.plannedDurationMs)}`}
                aria-label={`${formatClock(item.plannedStart, timeZone)} ${label}`}
                onClick={() => onSelect(item)}
                className={`absolute top-8 h-9 overflow-hidden rounded-[2px] border-r border-background text-left text-[0.625rem] leading-9 text-white hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring ${KIND_COLORS[item.kind]} ${item.id === onAirId ? 'ring-2 ring-primary ring-offset-1' : ''}`}
                style={{ left, width: w }}
              >
                {block && (
                  <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-indigo-700" />
                )}
                {w > 40 && <span className="px-1">{label}</span>}
              </button>
            );
          })}
          {nowVisible && (
            <div
              title={t('strip.now')}
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-destructive"
              style={{ left: x(now) }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
