import type { Locale } from '../../app/i18n/messages.ts';

// Display formats for the library: durations, sample positions, sizes, dates, decibels.

/** `3:07`, `1:02:45`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A sample position as `m:ss.mmm`. */
export function formatSamples(samples: number, sampleRate: number): string {
  const ms = Math.round((samples / sampleRate) * 1000);
  const m = Math.floor(ms / 60_000);
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  return `${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
}

/** Parses `3:07`, `187` or `1:02:45` into seconds; `undefined` when empty or invalid. */
export function parseDuration(value: string): number | undefined {
  const parts = value.trim().split(':');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    return undefined;
  }
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

export function formatBytes(bytes: number, locale: Locale): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}

export function formatDate(date: Date | null | undefined, locale: Locale): string {
  if (!date) return '';
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(date: Date | null | undefined, locale: Locale): string {
  if (!date) return '';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** `+1.5 dB`, `−3.0 dB`. */
export function formatDb(db: number | null | undefined, unit = 'dB'): string {
  if (db === null || db === undefined) return '';
  const sign = db > 0 ? '+' : db < 0 ? '−' : '';
  return `${sign}${Math.abs(db).toFixed(1)} ${unit}`;
}

export const formatNumber = (n: number, locale: Locale) => n.toLocaleString(locale);

/** `<input type="datetime-local">` value of a date, in the browser's time zone. */
export function toLocalInput(date: Date | null | undefined): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
