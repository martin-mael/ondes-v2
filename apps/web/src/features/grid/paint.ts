import type { GridCell } from '@ondes/shared';

// The grid editor's draft: one clock id per painted hour, keyed `weekday:hour`. Unpainted hours
// air the default clock. Pure, so painting is tested without a pointer.

export type Draft = ReadonlyMap<string, string>;

export const cellKey = (weekday: number, hour: number) => `${weekday}:${hour}`;

export function toDraft(cells: readonly GridCell[]): Draft {
  return new Map(cells.map((c) => [cellKey(c.weekday, c.hour), c.clockId]));
}

export function toCells(draft: Draft): GridCell[] {
  return [...draft]
    .map(([key, clockId]) => {
      const [weekday, hour] = key.split(':').map(Number) as [number, number];
      return { weekday, hour, clockId };
    })
    .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
}

/** `draft` with `cells` painted with `clockId`, or cleared back to the default (`null`). */
export function paint(
  draft: Draft,
  cells: readonly { weekday: number; hour: number }[],
  clockId: string | null,
): Draft {
  const next = new Map(draft);
  for (const { weekday, hour } of cells) {
    if (clockId) next.set(cellKey(weekday, hour), clockId);
    else next.delete(cellKey(weekday, hour));
  }
  return next;
}

/** Every cell of the rectangle between two corners (shift-click). */
export function rectangle(
  a: { weekday: number; hour: number },
  b: { weekday: number; hour: number },
): { weekday: number; hour: number }[] {
  const out: { weekday: number; hour: number }[] = [];
  for (
    let weekday = Math.min(a.weekday, b.weekday);
    weekday <= Math.max(a.weekday, b.weekday);
    weekday++
  ) {
    for (let hour = Math.min(a.hour, b.hour); hour <= Math.max(a.hour, b.hour); hour++) {
      out.push({ weekday, hour });
    }
  }
  return out;
}

export function sameDraft(a: Draft, b: Draft): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

const FALLBACK_COLORS = ['#64748b', '#78716c', '#6b7280', '#71717a'];

/** A clock's colour, or a neutral one picked from its id when it has none. */
export function clockColor(clock: { id: string; color: string | null }): string {
  if (clock.color) return clock.color;
  let hash = 0;
  for (const ch of clock.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] as string;
}

/** Black or white, whichever reads better on `hex`. */
export function textOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0a0a0a' : '#ffffff';
}
