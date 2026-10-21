import {
  type AsRunEntry,
  type AssetType,
  asRunListSchema,
  assetDetailSchema,
  assetPageSchema,
  assetTypeSchema,
  categoryListSchema,
  type InsertLogItem,
  type ListAssetsQuery,
  type LocalDate,
  type LogDayStatus,
  type LogPlacement,
  logDayResponseSchema,
  logEditResultSchema,
  logRangeResponseSchema,
  type ReplaceLogItem,
  relaxedRuleSchema,
  uuidSchema,
} from '@ondes/shared';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { API_BASE, request } from '../../app/api/client.ts';
import { dayBounds } from './time.ts';

// The calls the timeline makes (#51): the log range and edits (#100), the as-run of the day
// (#30), library search for inserts and replacements, asset cues and audio for previews.

const station = (stationId: string) => `/stations/${encodeURIComponent(stationId)}`;

// The two calls below belong to work landing in the same wave as this screen. Their contracts
// aren't on main yet, so these are the subsets read here, mirroring them field for field:
// - `pickResponseSchema` (packages/shared/src/contracts/rotation-rules.ts, #38);
// - `librarySearchPageSchema` (packages/shared/src/contracts/library-search.ts, #23).
// Swap them for the imports once both are merged. A 404 means the route isn't there (yet):
// callers fall back to the plain library list.

const ruleViolationWire = z.object({ ruleId: z.string(), kind: z.string(), detail: z.string() });
const pickWire = z.object({
  picks: z.array(
    z.object({
      asset: z
        .object({
          id: uuidSchema,
          title: z.string(),
          artists: z.array(z.string()),
          durationMs: z.int().nullable(),
        })
        .nullable(),
      relaxed: z.array(relaxedRuleSchema),
      candidates: z.int(),
      ranked: z
        .array(
          z.object({
            assetId: uuidSchema,
            title: z.string(),
            artists: z.array(z.string()),
            position: z.int(),
            violations: z.array(ruleViolationWire),
            picked: z.boolean(),
          }),
        )
        .optional(),
    }),
  ),
});
export type RulePick = z.infer<typeof pickWire>['picks'][number];
export type RankedCandidate = NonNullable<RulePick['ranked']>[number];

const librarySearchWire = z.object({
  items: z.array(
    z.object({
      id: uuidSchema,
      type: assetTypeSchema,
      title: z.string(),
      artists: z.array(z.string()),
      durationMs: z.int().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type LibraryHit = z.infer<typeof librarySearchWire>['items'][number];

const params = (query: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
};

export const timelineApi = {
  range: (stationId: string, from: string, to: string, signal?: AbortSignal) =>
    request(`${station(stationId)}/log?${params({ from, to })}`, {
      schema: logRangeResponseSchema,
      signal,
    }),
  insert: (stationId: string, body: InsertLogItem) =>
    request(`${station(stationId)}/log/items`, { body, schema: logEditResultSchema }),
  replace: (stationId: string, itemId: string, body: ReplaceLogItem) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}`, {
      method: 'PUT',
      body,
      schema: logEditResultSchema,
    }),
  move: (stationId: string, itemId: string, placement: LogPlacement) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}/move`, {
      body: { placement },
      schema: logEditResultSchema,
    }),
  lock: (stationId: string, itemId: string, locked: boolean) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}/lock`, {
      method: 'PUT',
      body: { locked },
      schema: logEditResultSchema,
    }),
  remove: (stationId: string, itemId: string) =>
    request(`${station(stationId)}/log/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      schema: logEditResultSchema,
    }),
  setStatus: (stationId: string, date: LocalDate, status: LogDayStatus) =>
    request(`${station(stationId)}/log/days/${date}/status`, {
      method: 'PUT',
      body: { status },
      schema: logDayResponseSchema,
    }),
  /** Every as-run entry of the station-local day, in air order. */
  asRun: async (stationId: string, date: LocalDate, signal?: AbortSignal) => {
    const items: AsRunEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await request(
        `${station(stationId)}/asrun?${params({ date, limit: 500, cursor })}`,
        { schema: asRunListSchema, signal },
      );
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  },
  categories: (stationId: string, signal?: AbortSignal) =>
    request(`${station(stationId)}/categories`, { schema: categoryListSchema, signal }),
  /** #38: the rules engine's pick for one slot, with every candidate's verdicts. */
  pick: async (
    stationId: string,
    slot: { categoryId: string; at: string },
    ignoreLogItemIds: string[] = [],
  ) => {
    const { picks } = await request(`${station(stationId)}/rotation/pick`, {
      // `ignoreLogItemIds`: leave the item being replaced out of the history, so its own song
      // and artist don't count against the candidates (#38's `pickRequestSchema`).
      body: { slots: [slot], explain: true, ignoreLogItemIds },
      schema: pickWire,
    });
    const pick = picks[0];
    if (!pick) throw new Error('empty pick response');
    return pick;
  },
  /**
   * #23: assets of `type` whose length is in `[minMs, maxMs]`, over the whole library, shortest
   * first (the caller ranks them by distance to its target).
   */
  searchByDuration: (
    stationId: string,
    query: { type: AssetType; q?: string; minMs: number; maxMs: number },
    signal?: AbortSignal,
  ) =>
    request(`${station(stationId)}/library/search`, {
      body: {
        filter: {
          types: [query.type],
          ...(query.q ? { q: query.q } : {}),
          durationMs: { min: Math.max(0, query.minMs), max: query.maxMs },
        },
        sort: 'duration',
        direction: 'asc',
        limit: 200,
      },
      schema: librarySearchWire,
      signal,
    }),
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

/**
 * Where an `<audio>` element plays an asset from (a redirect to its playout copy). With the
 * playout copy's sha256 the URL names that version: a replaced file gets a new URL.
 */
export const assetAudioUrl = (stationId: string, assetId: string, playoutSha256?: string) =>
  `${API_BASE}${station(stationId)}/assets/${encodeURIComponent(assetId)}/audio${
    playoutSha256 ? `?v=${playoutSha256}` : ''
  }`;

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
