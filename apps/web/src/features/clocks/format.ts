// Clock times: durations and offsets as `m:ss` (or `h:mm:ss`), parsed back from the same.

/** `3:05`, `1:02:09`; `–` when unknown. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * `m:ss`, `h:mm:ss` or plain seconds to milliseconds; `null` for an empty string, `undefined`
 * when it doesn't parse.
 */
export function parseTime(input: string): number | null | undefined {
  const value = input.trim();
  if (value === '') return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(value)) return undefined;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}
