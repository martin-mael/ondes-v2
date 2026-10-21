import { type ClockEstimate, type ClockSlot, slotCategoryId } from '@ondes/shared';
import { cn } from '@/ui/lib/utils';
import { formatMs } from './format.ts';
import { useClockT } from './messages.ts';

// The clock as a horizontal bar: one segment per slot, as wide as its estimated length, in its
// category's colour (or its kind's); markers are ticks at their time; the target length is
// the bar's end mark when the clock runs over.

const kindClass: Record<ClockSlot['kind'], string> = {
  category: 'bg-primary/70',
  asset: 'bg-slate-500',
  vt: 'bg-violet-500',
  jingle: 'bg-amber-500',
  marker: '',
  fill: 'bg-muted-foreground/30 bg-[repeating-linear-gradient(45deg,transparent_0_4px,rgb(255_255_255/0.3)_4px_8px)]',
  live: 'bg-rose-500',
};

export function ClockTimeline({
  slots,
  estimate,
  colors,
  names,
  compact = false,
  highlight,
}: {
  slots: readonly ClockSlot[];
  estimate: ClockEstimate;
  /** Category colours by id. */
  colors?: ReadonlyMap<string, string | null>;
  /** Slot labels for tooltips. */
  names?: (slot: ClockSlot, index: number) => string;
  compact?: boolean;
  highlight?: number | null;
}) {
  const t = useClockT();
  const span = Math.max(estimate.totalMs, estimate.targetMs, 1);
  const pct = (ms: number) => `${(ms / span) * 100}%`;
  const minutes = Math.floor(span / 60_000);
  const ticks = Array.from({ length: Math.floor(minutes / 15) + 1 }, (_, i) => i * 15 * 60_000);

  return (
    <div className="flex flex-col gap-1">
      <div
        role="img"
        aria-label={t('timeline.label')}
        className={cn(
          'relative w-full overflow-hidden rounded-md bg-muted',
          compact ? 'h-3' : 'h-8',
        )}
      >
        {slots.map((slot, i) => {
          const est = estimate.slots[i];
          if (!est) return null;
          const title = `${names?.(slot, i) ?? t(`kind.${slot.kind}`)} · ${formatMs(est.startMs)}`;
          if (slot.kind === 'marker') {
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: slots have no id; the index is the slot.
                key={i}
                title={title}
                className="absolute inset-y-0 w-0.5 bg-foreground"
                style={{ left: pct(est.startMs) }}
              />
            );
          }
          const categoryId = slotCategoryId(slot);
          const color = categoryId ? colors?.get(categoryId) : null;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: slots have no id; the index is the slot.
              key={i}
              title={`${title} (${formatMs(est.durationMs)})`}
              className={cn(
                'absolute inset-y-0 border-r border-background/60',
                !color && kindClass[slot.kind],
                highlight === i && 'ring-2 ring-ring ring-inset',
              )}
              style={{
                left: pct(est.startMs),
                width: pct(est.durationMs),
                ...(color ? { backgroundColor: color } : {}),
              }}
            />
          );
        })}
        {estimate.totalMs > estimate.targetMs && (
          <div
            className="absolute inset-y-0 right-0 bg-destructive/30"
            style={{ left: pct(estimate.targetMs) }}
          />
        )}
      </div>
      {!compact && (
        <div className="relative h-4 text-xs text-muted-foreground tabular-nums">
          {ticks.map((ms) => (
            <span
              key={ms}
              className="absolute -translate-x-1/2 first:translate-x-0"
              style={{ left: pct(ms) }}
            >
              {`:${String((ms / 60_000) % 60).padStart(2, '0')}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
