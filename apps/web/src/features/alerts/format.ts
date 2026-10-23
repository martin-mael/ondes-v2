import type { Alert } from '@ondes/shared';
import type { Locale } from '../../app/i18n/messages.ts';
import { type AlertT, isAlertMessageKey } from './messages.ts';

// How an alert reads in the viewer's language, and its times on the station's clock (never the
// browser's). The api's title and message are English; `details.i18n` (`{ key, params }`, #47's
// missing episodes, #101's generation issues) is rendered here instead, and known types get a
// translated title.

/** `Thu 23 Oct, 14:05` on the station's clock (time only when it is today there). */
export function formatStationTime(
  instant: Date,
  timeZone: string,
  locale: Locale,
  now = new Date(),
): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const sameDay = day(instant) === day(now);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    ...(sameDay ? {} : { weekday: 'short', day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/** A station-local calendar date (`YYYY-MM-DD`): `Sat 24 Oct`, no timezone shift. */
function formatLocalDate(date: string, locale: Locale): string {
  const noon = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(noon.getTime())) return date;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(noon);
}

/** The type's label, or the raw type for one this app doesn't know yet. */
export function alertTypeLabel(type: string, t: AlertT): string {
  const key = `type.${type}`;
  return isAlertMessageKey(key) ? t(key) : type;
}

type I18n = { key: string; params: Record<string, unknown> };

function i18nOf(alert: Pick<Alert, 'details'>): I18n | null {
  const raw = alert.details.i18n;
  if (!raw || typeof raw !== 'object') return null;
  const { key, params } = raw as { key?: unknown; params?: unknown };
  if (typeof key !== 'string') return null;
  return { key, params: params && typeof params === 'object' ? (params as I18n['params']) : {} };
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** An instant from details: an ISO string, or a `Date` (the api client revives `…At` keys). */
function instantOf(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One sub-key of the strings, or '' when the api sent a value this app doesn't know. */
function sub(t: AlertT, prefix: string, value: unknown): string {
  const key = `${prefix}.${str(value)}`;
  return isAlertMessageKey(key) ? t(key) : '';
}

export type AlertText = { title: string; message: string | null };

export function alertText(
  alert: Pick<Alert, 'type' | 'title' | 'message' | 'details'>,
  t: AlertT,
  timeZone: string,
  locale: Locale,
): AlertText {
  const i18n = i18nOf(alert);
  if (i18n && isAlertMessageKey(i18n.key) && i18n.key.startsWith('episodeMissing.')) {
    const p = i18n.params;
    const show = str(p.show) || alertTypeLabel(alert.type, t);
    const startsAt = instantOf(p.startsAt);
    const when = startsAt ? formatStationTime(startsAt, timeZone, locale) : '';
    const parts = {
      show,
      when,
      next: sub(t, 'episodeMissing.next', p.policy),
      fallback: sub(t, 'episodeMissing.fallback', p.fallback),
      reason: sub(t, 'episodeMissing.reason', p.reason),
    };
    // A value this app doesn't know yet: the api's English sentence rather than a hole.
    const known =
      i18n.key === 'episodeMissing.ahead'
        ? true
        : i18n.key === 'episodeMissing.fallback'
          ? parts.fallback !== ''
          : parts.reason !== '';
    return {
      title: t('episodeMissing.title', { show }),
      message: known ? t(i18n.key, parts).trim() : alert.message,
    };
  }
  if (i18n?.key === 'logRegen.issues' && typeof i18n.params.localDate === 'string') {
    const date = formatLocalDate(i18n.params.localDate, locale);
    const total = typeof i18n.params.total === 'number' ? i18n.params.total : 0;
    return { title: alertTypeLabel(alert.type, t), message: t('logRegen.issues', { date, total }) };
  }
  // The api's sentences are English: a French viewer gets the type's French label as title
  // (the message stays English until its producer sends `details.i18n`).
  if (locale !== 'en' && isAlertMessageKey(`type.${alert.type}`)) {
    return { title: alertTypeLabel(alert.type, t), message: alert.message };
  }
  return { title: alert.title, message: alert.message };
}
