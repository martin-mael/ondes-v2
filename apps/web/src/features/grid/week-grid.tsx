import { cn } from 'cn';
import { useEffect, useRef } from 'react';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { formatHour, useGridT, weekdayNames } from './messages.ts';
import { cellKey, clockColor, type Draft, textOn } from './paint.ts';

// The 7 × 24 grid: days across, hours down, each hour filled with its clock's colour. Painting
// works with a mouse, a trackpad (press and drag, or a three-finger drag) and touch: the press
// picks the stroke (paint the brush, or clear back to the default when the hour already has
// it), then every hour the pointer passes over joins the stroke. The pointer is found with
// `elementFromPoint`, so a captured pointer (touch) paints too. Shift-click fills the rectangle
// from the last hour clicked; Enter or Space paints the focused hour.

export interface GridClock {
  id: string;
  name: string;
  color: string | null;
}

type Cell = { weekday: number; hour: number };

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

export function WeekGrid({
  draft,
  clocks,
  defaultClockId,
  readOnly,
  onStroke,
  onRectangle,
}: {
  draft: Draft;
  clocks: ReadonlyMap<string, GridClock>;
  defaultClockId: string | null;
  readOnly: boolean;
  /** A stroke starts (`first`) or goes on over `cell`. */
  onStroke(cell: Cell, first: boolean): void;
  /** Shift-click from `from` to `to`. */
  onRectangle(from: Cell, to: Cell): void;
}) {
  const t = useGridT();
  const { locale } = useI18n();
  const days = weekdayNames(locale);
  const longDays = weekdayNames(locale, 'long');
  const painting = useRef(false);
  const last = useRef<string | null>(null);
  const anchor = useRef<Cell | null>(null);

  useEffect(() => {
    const stop = () => {
      painting.current = false;
      last.current = null;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const cellAt = (x: number, y: number): Cell | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-weekday]');
    if (!el) return null;
    return { weekday: Number(el.dataset.weekday), hour: Number(el.dataset.hour) };
  };

  const start = (event: React.PointerEvent, cell: Cell) => {
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    if (event.shiftKey && anchor.current) {
      onRectangle(anchor.current, cell);
      anchor.current = cell;
      return;
    }
    anchor.current = cell;
    painting.current = true;
    last.current = cellKey(cell.weekday, cell.hour);
    onStroke(cell, true);
  };

  const move = (event: React.PointerEvent) => {
    if (!painting.current) return;
    const cell = cellAt(event.clientX, event.clientY);
    if (!cell) return;
    const key = cellKey(cell.weekday, cell.hour);
    if (key === last.current) return;
    last.current = key;
    onStroke(cell, false);
  };

  const fallback = defaultClockId ? clocks.get(defaultClockId) : undefined;

  return (
    <div className="overflow-x-auto">
      <div
        className={cn(
          'grid min-w-[560px] select-none grid-cols-[3rem_repeat(7,minmax(0,1fr))] gap-px',
          !readOnly && 'touch-none',
        )}
        onPointerMove={move}
      >
        <div className="contents">
          <div />
          {days.map((day, i) => (
            <div key={day} className="pb-1 text-center text-sm font-medium" title={longDays[i]}>
              {day}
            </div>
          ))}
        </div>
        {HOURS.map((hour) => (
          <div key={hour} className="contents">
            <div
              aria-hidden
              className="pr-2 text-right text-xs leading-6 text-muted-foreground tabular-nums"
            >
              {formatHour(hour)}
            </div>
            {WEEKDAYS.map((weekday) => {
              const painted = draft.get(cellKey(weekday, hour));
              const clock = painted ? clocks.get(painted) : fallback;
              const color = clock ? clockColor(clock) : null;
              const above = hour > 0 ? draft.get(cellKey(weekday, hour - 1)) : undefined;
              // The name shows on the first hour of a run.
              const showName = clock && (hour === 0 || above !== painted);
              const name = clock
                ? painted
                  ? clock.name
                  : t('cell.default', { clock: clock.name })
                : t('cell.none');
              const cell = { weekday, hour };
              return (
                <button
                  type="button"
                  key={weekday}
                  data-weekday={weekday}
                  data-hour={hour}
                  data-clock={painted ?? ''}
                  disabled={readOnly}
                  aria-label={t('cell.label', {
                    day: longDays[weekday - 1] ?? '',
                    hour: formatHour(hour),
                    clock: name,
                  })}
                  className={cn(
                    'relative h-6 min-w-0 overflow-hidden rounded-[2px] px-1 text-left text-[11px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
                    !color && 'bg-muted',
                    !readOnly && 'cursor-crosshair',
                  )}
                  style={
                    color
                      ? {
                          backgroundColor: color,
                          color: textOn(color),
                          // Default hours are a paler wash of the default clock's colour.
                          opacity: painted ? 1 : 0.35,
                        }
                      : undefined
                  }
                  onPointerDown={(event) => start(event, cell)}
                  onKeyDown={(event) => {
                    if (readOnly || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    if (event.shiftKey && anchor.current) onRectangle(anchor.current, cell);
                    else onStroke(cell, true);
                    anchor.current = cell;
                  }}
                >
                  {showName && painted ? <span className="truncate">{clock?.name}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
