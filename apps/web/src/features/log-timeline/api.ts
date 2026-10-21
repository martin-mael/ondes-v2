import {
  type AsRunEntry,
  asRunListSchema,
  assetDetailSchema,
  assetPageSchema,
  type InsertLogItem,
  type ListAssetsQuery,
  type LocalDate,
  type LogDayStatus,
  type LogPlacement,
  logDayResponseSchema,
  logEditResultSchema,
  logRangeResponseSchema,
  type ReplaceLogItem,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { API_BASE, request } from '../../app/api/client.ts';
import { dayBounds } from './time.ts';

// The calls the timeline makes (#51): the log range and edits (#100), the as-run of the day
// (#30), library search for inserts and replacements, asset cues and audio for previews.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;

/**
 * The api client revives `…At` strings as `Date` (for the contracts typed with `z.date()`),
 * but the log and as-run contracts keep ISO strings (`startsAt`, `anchorAt`, `startedAt`):
 * turn them back before validating.
 */
function datesToIso(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(datesToIso);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, datesToIso(v)]));
  }
  return value;
}
const isoWire = <S extends z.ZodType>(schema: S) => z.preprocess(datesToIso, schema);

const logRangeWire = isoWire(logRangeResponseSchema);
const editWire = isoWire(logEditResultSchema);
const dayWire = isoWire(logDayResponseSchema);
const asRunWire = isoWire(asRunListSchema);

const params = (query: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
};

export const timelineApi = {
  range: (stationId: string, from: string, to: string, signal?: AbortSignal) =>
    request(`${station(stationId)}/log?${params({ from, to })}`, { schema: logRangeWire, signal }),
  insert: (stationId: string, body: InsertLogItem) =>
    request(`${station(stationId)}/log/items`, { body, schema: editWire }),
  replace: (stationId: string, itemId: string, body: ReplaceLogItem) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}`, {
      method: 'PUT',
      body,
      schema: editWire,
    }),
  move: (stationId: string, itemId: string, placement: LogPlacement) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}/move`, {
      body: { placement },
      schema: editWire,
    }),
  lock: (stationId: string, itemId: string, locked: boolean) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}/lock`, {
      method: 'PUT',
      body: { locked },
      schema: editWire,
    }),
  remove: (stationId: string, itemId: string) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      schema: editWire,
    }),
  setStatus: (stationId: string, date: LocalDate, status: LogDayStatus) =>
    request(`${station(stationId)}/log/days/${date}/status`, {
      method: 'PUT',
      body: { status },
      schema: dayWire,
    }),
  /** Every as-run entry of the station-local day, in air order. */
  asRun: async (stationId: string, date: LocalDate, signal?: AbortSignal) => {
    const items: AsRunEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await request(
        `${station(stationId)}/asrun?${params({ date, limit: 500, cursor })}`,
        { schema: asRunWire, signal },
      );
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  },
  searchAssets: (stationId: string, query: ListAssetsQuery, signal?: AbortSignal) =>
    request(
      `${station(stationId)}/assets?${params(query as Record<string, string | number | undefined>)}`,
      { schema: assetPageSchema, signal },
    ),
  asset: (stationId: string, assetId: string, signal?: AbortSignal) =>
    request(`${station(stationId)}/assets/${encodeURIComponent(assetId)}`, {
      schema: assetDetailSchema,
      signal,
    }),
};

/** Where an `<audio>` element plays an asset from (a redirect to its playout copy). */
export const assetAudioUrl = (stationId: string, assetId: string) =>
  `${API_BASE}${station(stationId)}/assets/${encodeURIComponent(assetId)}/audio`;

export const logKey = (stationId: string) => ['stations', stationId, 'log'] as const;

/** The log of one station-local day. */
export const logDayQuery = (stationId: string, date: LocalDate, timeZone: string) =>
  queryOptions({
    queryKey: [...logKey(stationId), date],
    queryFn: ({ signal }) => {
      const { start, end } = dayBounds(date, timeZone);
      return timelineApi.range(
        stationId,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        signal,
      );
    },
  });

export const asRunDayQuery = (stationId: string, date: LocalDate) =>
  queryOptions({
    queryKey: ['stations', stationId, 'asrun', date],
    queryFn: ({ signal }) => timelineApi.asRun(stationId, date, signal),
  });

export const assetDetailQuery = (stationId: string, assetId: string) =>
  queryOptions({
    queryKey: ['stations', stationId, 'assets', assetId],
    queryFn: ({ signal }) => timelineApi.asset(stationId, assetId, signal),
    staleTime: 60_000,
  });
