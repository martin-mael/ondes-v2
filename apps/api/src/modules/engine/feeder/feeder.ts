import { createHash } from 'node:crypto';
import type { StationScope } from '@ondes/db';
import {
  alertTypes,
  type EnginePushItem,
  type EnginePushSegment,
  type EngineSegmentPart,
  type EngineState,
  type FeederItemPassedOverEvent,
  type FeederPushPart,
  type LogItem,
  type LogSegmentPart,
  type PlayoutGainStation,
  type RaiseAlert,
  type RealtimeEvent,
} from '@ondes/shared';
import type { EngineAdapter } from '../adapter/adapter.ts';
import { EngineNotQueuedError, EngineUnresolvableError } from '../adapter/errors.ts';
import { type Logger, silentLogger } from '../adapter/logger.ts';
import { type FeedChain, type FeedOverlay, type IslandLayout, layoutIslands } from './islands.ts';
import {
  DEFAULT_PLAN_OPTIONS,
  diffQueue,
  type FeedEntry,
  type FeedPlan,
  isFlexibleKind,
  type PlannedEntry,
  type PlanOptions,
  planFeed,
  type QueuedEntry,
  type SkipReason,
} from './plan.ts';
import {
  buildPushChain,
  buildPushItem,
  buildPushSegment,
  type ChainSource,
  chainCrossOutMs,
  crossOutMsOf,
  type FeedMedia,
  type PushSource,
  playLengthMs,
  type SegmentSource,
  segmentCrossOutMs,
} from './push.ts';
import type { FeedIslands, FeedWindow } from './repo.ts';

/**
 * Just-in-time feeder of one station (#29, ADR 0002/0003): keeps the engine queue a few items
 * ahead of air, following the log.
 *
 * It holds no plan between runs. Each `sync()` reads the engine state and the log around now,
 * plans (plan.ts), compares the plan with the engine queue and fixes the difference: remove
 * from the first queued entry that differs (the log changed, an anchor trims the tail, a file
 * went missing), then push what's missing. Removals and pushes never touch the item on air.
 * After a removal it re-reads the state before pushing, in case the head went on air
 * meanwhile. Runs are serialised; a `poke()` during a run triggers one more run after it.
 *
 * Triggers: a timer (the service), engine events (track started or ended, a new boot, engine
 * up) and log changes. All of them only call `poke()`: the state and the log are the truth.
 */
export type FeederEngine = Pick<
  EngineAdapter,
  'state' | 'push' | 'pushSegment' | 'remove' | 'clear'
>;

export type FeederOptions = Partial<PlanOptions> & {
  /** How far back the log is read, to find the item on air. Default 3 h. */
  lookbackMs?: number;
  /** Shortest a flexible item may be trimmed to. Default 30 s. */
  minKeepMs?: number;
  /** A queued entry whose trim differs by less than this is kept. Default 250 ms. */
  trimToleranceMs?: number;
  /** A file the engine refused is skipped this long before being tried again. Default 60 s. */
  unresolvableRetryMs?: number;
  /** Urgent fetches and sync requests for one file or station at most this often. Default 60 s. */
  requestCooldownMs?: number;
  /** Engine-side cache root. Default `/cache` (ADR 0004). */
  engineRoot?: string;
};

export type FeederDeps = {
  scope: StationScope;
  /** The station's engine adapter, from any replica (`engineLifecycle.adapterFor`). */
  engine(): Promise<FeederEngine | undefined>;
  /** The log around now and its media (repo.ts `loadFeedWindow`). */
  load(range: { from: Date; to: Date }): Promise<FeedWindow>;
  /**
   * The islands the segues of these items call for now, with their render's cache state
   * (repo.ts `loadFeedIslands`, #57). Without it every transition airs as a plain crossfade.
   */
  islands?(itemIds: readonly string[]): Promise<FeedIslands>;
  cache: {
    requestUrgentFetch(scope: StationScope, assetFileId: string): Promise<void>;
    requestSync(scope: StationScope): Promise<void>;
  };
  alerts: {
    raise(scope: StationScope, input: RaiseAlert): Promise<unknown>;
    resolve(
      scope: StationScope,
      dedupeKey: string,
      options?: { reason?: string },
    ): Promise<unknown>;
    /** Dedupe keys of the station's open feeder alerts, read once so a boot resolves nothing. */
    openKeys?(scope: StationScope): Promise<ReadonlySet<string>>;
  };
  /** Real-time events (`feeder.item.passed_over`). */
  publish?(event: FeederItemPassedOverEvent): Promise<void>;
  /** Still the station's only feeder? Checked before every change to the engine queue. */
  owns?(): Promise<boolean>;
  /**
   * What was pushed during each boot (repo.ts `createFeederPushStore`), so a feeder taking over
   * the station resumes: same trims, no re-push of a queue that already matches.
   */
  store?: FeederPushStore;
  now?(): number;
  logger?: Logger;
  options?: FeederOptions;
};

/** Persisted record of the entries pushed to one engine boot. */
export type FeederPushStore = {
  load(bootId: string): Promise<
    {
      entryId: string;
      fingerprint: string;
      trimMs: number;
      aired: boolean;
      parts?: FeederPushPart[] | null;
      itemIds?: string[] | null;
    }[]
  >;
  save(
    bootId: string,
    entryId: string,
    push: {
      fingerprint: string;
      trimMs: number;
      parts?: FeederPushPart[] | null;
      itemIds?: string[] | null;
    },
  ): Promise<void>;
  remove(bootId: string, entryIds: readonly string[]): Promise<void>;
  markAired(bootId: string, entryIds: readonly string[]): Promise<void>;
  /** Drops the records of other boots (and very old ones). */
  prune(bootId: string): Promise<void>;
};

export type SyncResult = {
  plan: FeedPlan | null;
  removed: string[];
  pushed: string[];
};

type Built =
  | { kind: 'item'; source: PushSource }
  | { kind: 'segment'; source: SegmentSource }
  | { kind: 'chain'; source: ChainSource; chain: FeedChain }
  /** The island chain on air, as it was pushed: never pushed again, only planned around. */
  | { kind: 'on_air_chain'; source: null };

type BuiltEntry = Built & {
  /** Asset files it plays, for urgent fetches and 422s. */
  fileIds: string[];
  /** Voices over its transition out (island fallback, #57). */
  overlay: FeedOverlay | null;
  crossOutMs: number | undefined;
  /** The log items it covers (more than one for an island chain). */
  itemIds: string[];
};

/** What the feeder remembers of an entry it pushed during this boot. */
type PushRecord = {
  fingerprint: string;
  trimMs: number;
  parts?: FeederPushPart[] | null;
  /** Every log item an island chain covers, absorbed ones included. */
  itemIds?: string[] | null;
};

export class FeederNotOwnerError extends Error {}

export function createStationFeeder(deps: FeederDeps) {
  const { scope } = deps;
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;
  const opts = deps.options ?? {};
  const planOptions: Partial<PlanOptions> = opts;
  const lookaheadMs = opts.lookaheadMs ?? DEFAULT_PLAN_OPTIONS.lookaheadMs;
  const lookbackMs = opts.lookbackMs ?? 3 * 3_600_000;
  const minKeepMs = opts.minKeepMs ?? 30_000;
  const trimToleranceMs = opts.trimToleranceMs ?? 250;
  const unresolvableRetryMs = opts.unresolvableRetryMs ?? 60_000;
  const requestCooldownMs = opts.requestCooldownMs ?? 60_000;

  /** What this feeder pushed during the current boot: body fingerprint and trim. */
  let bootId: string | null = null;
  const pushed = new Map<string, PushRecord>();
  /** Log items (and segments) that went on air during this boot. */
  const aired = new Set<string>();
  /** Items planned but passed over, until a later item airs (then `feeder.item.passed_over`). */
  const pendingSkips = new Map<string, { reason: SkipReason | 'dropped'; item: LogItem }>();
  const reported = new Set<string>();
  /** Asset files the engine refused (422), until when they're skipped. */
  const unresolvable = new Map<string, number>();
  const requested = new Map<string, number>();
  const alertState: { skipped: string | null | undefined; empty: boolean | undefined } = {
    skipped: undefined,
    empty: undefined,
  };

  let running: Promise<SyncResult> | null = null;
  let again = false;
  let stopped = false;

  /** A new engine boot (or a feeder taking over): its queue, from the store. */
  async function enterBoot(id: string) {
    pushed.clear();
    aired.clear();
    reported.clear();
    bootId = id;
    if (!deps.store) return;
    try {
      for (const row of await deps.store.load(id)) {
        if (row.fingerprint) pushed.set(row.entryId, row);
        if (row.aired) aired.add(row.entryId);
      }
      await deps.store.prune(id);
    } catch (err) {
      logger.warn({ err, stationId: scope.stationId }, 'Loading what the feeder pushed failed');
    }
  }

  /** Store writes are best-effort: memory stays right for this process. */
  function persist(what: string, write: (store: FeederPushStore, boot: string) => Promise<void>) {
    if (!deps.store || !bootId) return Promise.resolve();
    return write(deps.store, bootId).catch((err: unknown) => {
      logger.warn({ err, stationId: scope.stationId }, `Recording ${what} failed`);
    });
  }

  async function noteAired(ids: (string | null | undefined)[]) {
    // An island's engine id (`island:<hash>`) is no log item.
    const fresh = ids.filter(
      (id): id is string => !!id && !id.startsWith('island:') && !aired.has(id),
    );
    if (!fresh.length) return;
    for (const id of fresh) aired.add(id);
    await persist('what aired', (store, boot) => store.markAired(boot, fresh));
  }

  /** Whether `key` may be requested again, and records it. */
  function cooldown(key: string): boolean {
    const at = requested.get(key);
    if (at !== undefined && now() - at < requestCooldownMs) return false;
    requested.set(key, now());
    return true;
  }

  function mediaReason(media: FeedMedia | undefined): SkipReason | null {
    if (!media) return 'no_media_file';
    const until = unresolvable.get(media.fileId);
    if (until !== undefined && until > now()) return 'unresolvable';
    if (!media.cached) return 'not_cached';
    return null;
  }

  function partSource(p: LogSegmentPart | LogItem, media: FeedMedia): PushSource {
    return { itemId: p.id, title: p.title, cueOverrides: p.cueOverrides, media };
  }

  /** The planner's view of an item that plays one asset or a log segment; null otherwise. */
  function plainEntry(item: LogItem, window: FeedWindow, layout: IslandLayout | null) {
    let unplayable: SkipReason | null = null;
    let flexMs = 0;
    let b: BuiltEntry | null = null;
    const overlay = layout?.overlays.get(item.id) ?? null;
    if (item.kind === 'segment') {
      const parts: PushSource[] = [];
      for (const part of item.parts) {
        const media = part.assetId ? window.media.get(part.assetId) : undefined;
        unplayable ??= mediaReason(media);
        if (media) parts.push(partSource(part, media));
      }
      if (item.parts.length < 2) unplayable ??= 'no_media_file';
      const source = { segmentId: item.id, cueOverrides: item.cueOverrides, parts };
      b = {
        kind: 'segment',
        source,
        fileIds: parts.map((p) => p.media.fileId),
        overlay,
        crossOutMs: segmentCrossOutMs(source),
        itemIds: [item.id],
      };
    } else if (isMediaKind(item.kind)) {
      const media = item.assetId ? window.media.get(item.assetId) : undefined;
      unplayable = mediaReason(media);
      if (media) {
        const source = partSource(item, media);
        b = {
          kind: 'item',
          source,
          fileIds: [media.fileId],
          overlay,
          crossOutMs: crossOutMsOf(source),
          itemIds: [item.id],
        };
        if (isFlexibleKind(item.kind)) {
          const length = Math.min(item.plannedDurationMs, playLengthMs(source) ?? Infinity);
          flexMs = Math.max(0, length - minKeepMs);
        }
      }
    }
    const entry: FeedEntry = {
      id: item.id,
      kind: item.kind,
      plannedStartMs: Date.parse(item.plannedStart),
      slotMs: item.plannedDurationMs,
      timing: item.timing,
      anchorAtMs: item.anchorAt ? Date.parse(item.anchorAt) : null,
      capMs: item.capMs,
      parts: item.parts.map((p) => ({ id: p.id, durationMs: p.plannedDurationMs })),
      unplayable,
      flexMs,
    };
    return { entry, built: b };
  }

  /**
   * One entry for log items that air as one island chain (#57): at the head's time and anchor,
   * over the slots of every item it covers. Never trimmed: its joins are planned to the sample.
   */
  function chainEntry(covered: LogItem[], parts: { id: string; durationMs: number }[]): FeedEntry {
    const head = covered[0] as LogItem;
    return {
      id: head.id,
      kind: 'segment',
      plannedStartMs: Date.parse(head.plannedStart),
      slotMs: covered.reduce((sum, i) => sum + i.plannedDurationMs, 0),
      timing: head.timing,
      anchorAtMs: head.anchorAt ? Date.parse(head.anchorAt) : null,
      capMs: head.capMs,
      parts,
      unplayable: null,
      flexMs: 0,
    };
  }

  /**
   * The island chain on air, if any: the items it covers and its parts, as pushed. It keeps
   * that shape whatever the islands say now (an edit can't reshape what is airing). Without
   * our record of the push (another feeder's, lost), its items are guessed from the island on
   * air or from the head to the item on air, so none of them is pushed a second time.
   */
  function onAirChain(
    onAir: EngineState['on_air'] | null,
    window: FeedWindow,
    islands: FeedIslands | null,
  ): { covered: LogItem[]; parts: { id: string; durationMs: number }[] } | null {
    const segmentId = onAir?.segment_id;
    if (!segmentId) return null;
    const headIndex = window.items.findIndex((i) => i.id === segmentId);
    const head = window.items[headIndex];
    if (!head || head.kind === 'segment') return null;
    const record = pushed.get(segmentId);
    let ids: string[];
    let parts: { id: string; durationMs: number }[] | null = null;
    if (record?.itemIds?.length) {
      // Every item it covers, items rendered whole into an island included.
      ids = record.itemIds;
      parts = (record.parts ?? []).map((p) => ({ id: p.itemId, durationMs: p.expectedMs ?? 0 }));
    } else {
      // Another feeder's push, record lost: the islands from the head on, joined like a chain.
      ids = [segmentId];
      for (let grew = true; grew; ) {
        grew = false;
        const next = islands?.islands.find((i) => i.plan.head.itemId === ids.at(-1));
        if (next && next.plan.itemIds.length > 1) {
          ids = [...ids, ...next.plan.itemIds.slice(1)];
          grew = true;
        }
      }
      if (ids.length < 2) {
        // No island known: at least the head up to the item on air.
        const until = window.items.findIndex((i) => i.id === onAir?.item_id);
        ids = window.items.slice(headIndex, Math.max(headIndex, until) + 1).map((i) => i.id);
      }
    }
    const wanted = new Set(ids);
    const covered: LogItem[] = [];
    for (const item of window.items.slice(headIndex)) {
      if (!wanted.has(item.id)) break;
      covered.push(item);
    }
    if (covered.length < 2) return null;
    if (!parts?.length) parts = covered.map((i) => ({ id: i.id, durationMs: i.plannedDurationMs }));
    return { covered, parts };
  }

  /** The planner's view of each item, and what pushing it takes. */
  function toEntries(
    window: FeedWindow,
    layout: IslandLayout | null,
    onAir: ReturnType<typeof onAirChain>,
  ) {
    const entries: FeedEntry[] = [];
    const built = new Map<string, BuiltEntry>();
    const byId = new Map(window.items.map((i) => [i.id, i]));
    const inChain = new Set<string>();
    const mediaOf = (item: LogItem | undefined) =>
      item?.assetId ? window.media.get(item.assetId) : undefined;
    const tailCrossOut = (item: LogItem | undefined) => {
      const media = mediaOf(item);
      return item && media ? crossOutMsOf(partSource(item, media)) : undefined;
    };
    for (const item of window.items) {
      if (inChain.has(item.id)) continue;
      if (onAir && item.id === onAir.covered[0]?.id) {
        for (const i of onAir.covered) inChain.add(i.id);
        entries.push(chainEntry(onAir.covered, onAir.parts));
        built.set(item.id, {
          kind: 'on_air_chain',
          source: null,
          fileIds: [],
          overlay: null,
          crossOutMs: tailCrossOut(onAir.covered.at(-1)),
          itemIds: onAir.covered.map((i) => i.id),
        });
        continue;
      }
      const chain = layout?.chains.get(item.id);
      if (chain) {
        const covered = chain.itemIds.map((id) => byId.get(id) as LogItem);
        for (const i of covered) inChain.add(i.id);
        entries.push(chainEntry(covered, chain.parts));
        built.set(item.id, {
          kind: 'chain',
          source: chain.source,
          chain,
          fileIds: chain.fileIds,
          overlay: layout?.overlays.get(chain.itemIds.at(-1) as string) ?? null,
          crossOutMs: chainCrossOutMs(chain.source),
          itemIds: chain.itemIds,
        });
        continue;
      }
      const { entry, built: b } = plainEntry(item, window, layout);
      entries.push(entry);
      if (b) built.set(item.id, b);
    }
    return { entries, built };
  }

  function body(
    b: BuiltEntry,
    station: PlayoutGainStation,
    crossInMs: number | undefined,
    trimMs: number,
  ): EnginePushItem | EnginePushSegment {
    const ctx = {
      station,
      crossInMs,
      trimMs,
      engineRoot: opts.engineRoot,
      overlay: b.overlay?.voices,
    };
    switch (b.kind) {
      case 'chain':
        return buildPushChain(b.source, ctx);
      case 'segment':
        return buildPushSegment(b.source, ctx);
      case 'item':
        return buildPushItem(b.source, ctx);
      case 'on_air_chain':
        throw new Error('the island chain on air is never pushed');
    }
  }

  /**
   * What the as-run needs to know about a push (store `parts`): each part's length inside an
   * island chain and the transitions it carries. Null for a plain entry.
   */
  function partsOf(
    b: BuiltEntry,
    payload: EnginePushItem | EnginePushSegment,
  ): FeederPushPart[] | null {
    const lengths =
      b.kind === 'chain' ? new Map(b.chain.parts.map((p) => [p.id, p.durationMs])) : null;
    if (!lengths && !b.overlay) return null;
    const requests: EngineSegmentPart[] = 'parts' in payload ? payload.parts : [payload];
    const overlay = b.overlay
      ? {
          ...b.overlay.transition,
          voices: b.overlay.transition.voices.map((v, i) => ({
            ...v,
            offsetMs: Math.round((payload.overlay?.[i]?.at ?? 0) * 1000),
          })),
        }
      : null;
    return requests.map((r, i) => ({
      itemId: r.item_id,
      expectedMs: lengths?.get(r.item_id) ?? null,
      transition:
        (b.kind === 'chain' ? b.chain.transitions.get(r.item_id) : undefined) ??
        (i === requests.length - 1 ? overlay : null),
    }));
  }

  /** The engine queue, segment parts collapsed, with what we know we pushed. */
  function queuedOf(state: EngineState): QueuedEntry[] {
    const out: QueuedEntry[] = [];
    for (const r of state.queue) {
      const id = r.segment_id ?? r.item_id;
      if (!id || out.at(-1)?.id === id) continue;
      const known = pushed.get(id);
      out.push({ id, fingerprint: known?.fingerprint ?? null, trimMs: known?.trimMs ?? 0 });
    }
    return out;
  }

  /** Before every engine mutation: stopped, or no longer the station's feeder, aborts the run. */
  async function assertOwner() {
    if (stopped || (deps.owns && !(await deps.owns()))) {
      throw new FeederNotOwnerError(scope.stationId);
    }
  }

  async function requestFetches(
    plan: FeedPlan,
    built: Map<string, BuiltEntry>,
    extra: readonly string[],
  ) {
    const fileIds = new Set(extra);
    for (const { entry, reason } of plan.skipped) {
      if (reason !== 'not_cached' && reason !== 'unresolvable') continue;
      for (const fileId of built.get(entry.id)?.fileIds ?? []) fileIds.add(fileId);
    }
    for (const fileId of fileIds) {
      if (!cooldown(`fetch:${fileId}`)) continue;
      await deps.cache.requestUrgentFetch(scope, fileId).catch((err: unknown) => {
        logger.warn({ err, stationId: scope.stationId, fileId }, 'Urgent cache fetch failed');
      });
    }
  }

  /**
   * Before the first evaluation: which feeder alerts are open (an earlier feeder may have raised
   * them), so a boot neither re-raises nor resolves for nothing. Without a reader, the first
   * evaluation raises or resolves both (a resolve with nothing open is a no-op).
   */
  async function knownAlerts() {
    if (!deps.alerts.openKeys) return;
    if (alertState.skipped !== undefined && alertState.empty !== undefined) return;
    const open = await deps.alerts.openKeys(scope);
    // `?`: open, raised earlier: the first evaluation raises the current list or resolves it.
    alertState.skipped ??= open.has(alertTypes.feederItemsSkipped) ? '?' : null;
    alertState.empty ??= open.has(alertTypes.feederLogEmpty);
  }

  async function updateAlerts(plan: FeedPlan, state: EngineState, items: Map<string, LogItem>) {
    await knownAlerts();
    const skipped = plan.skipped.filter((s) => s.reason !== 'dropped');
    const key = skipped.length
      ? skipped
          .map((s) => `${s.entry.id}:${s.reason}`)
          .sort()
          .join(',')
      : null;
    if (key !== alertState.skipped) {
      if (key) {
        await deps.alerts.raise(scope, {
          type: alertTypes.feederItemsSkipped,
          severity: 'warning',
          dedupeKey: alertTypes.feederItemsSkipped,
          title: `${skipped.length} log item(s) can't be played and will be skipped`,
          message:
            'They are not in the playout cache, or the engine refused their file. An urgent fetch was requested.',
          details: {
            items: skipped.map((s) => ({
              itemId: s.entry.id,
              plannedStart: new Date(s.entry.plannedStartMs).toISOString(),
              title: items.get(s.entry.id)?.asset?.title ?? items.get(s.entry.id)?.title ?? null,
              reason: s.reason,
            })),
          },
        });
      } else {
        await deps.alerts.resolve(scope, alertTypes.feederItemsSkipped, { reason: 'feeder_ok' });
      }
      alertState.skipped = key;
    }

    // Dry: nothing from the log queued, nothing to push, nothing waiting for its anchor.
    const empty = plan.wanted.length === 0 && plan.hold === null && state.queue.length === 0;
    if (empty !== alertState.empty) {
      if (empty) {
        await deps.alerts.raise(scope, {
          type: alertTypes.feederLogEmpty,
          severity: 'warning',
          dedupeKey: alertTypes.feederLogEmpty,
          title: 'The log has nothing left to play',
          message:
            'No published log item can be queued: the safety playlist is (or will soon be) on air.',
          escalate: { afterSeconds: 900, to: 'critical' },
        });
      } else {
        await deps.alerts.resolve(scope, alertTypes.feederLogEmpty, { reason: 'feeder_ok' });
      }
      alertState.empty = empty;
    }
  }

  /** `feeder.item.passed_over` for passed-over items once a later item is on air. */
  async function reportSkips(
    plan: FeedPlan,
    entries: FeedEntry[],
    items: Map<string, LogItem>,
    built: Map<string, BuiltEntry>,
  ) {
    for (const { entry, reason } of plan.skipped) {
      const item = items.get(entry.id);
      if (item && !pendingSkips.has(entry.id)) pendingSkips.set(entry.id, { reason, item });
    }
    if (plan.onAirIndex === null) return;
    const before = new Set(entries.slice(0, plan.onAirIndex).map((e) => e.id));
    for (const [id, { reason, item }] of pendingSkips) {
      if (!before.has(id)) {
        // Out of the window or back in the plan: forget it.
        if (!entries.some((e) => e.id === id)) pendingSkips.delete(id);
        continue;
      }
      pendingSkips.delete(id);
      if (aired.has(id) || reported.has(id) || !deps.publish) continue;
      reported.add(id);
      const ids =
        item.kind === 'segment' ? item.parts.map((p) => p.id) : (built.get(id)?.itemIds ?? [id]);
      for (const itemId of ids) {
        await deps
          .publish({
            id: eventId(scope.stationId, itemId, bootId),
            stationId: scope.stationId,
            at: new Date(now()).toISOString(),
            type: 'feeder.item.passed_over',
            data: {
              itemId,
              logDayId: item.logDayId,
              segmentId: item.kind === 'segment' ? item.id : null,
              plannedStart: item.plannedStart,
              reason,
              bootId,
            },
          })
          .catch((err: unknown) => {
            logger.warn({ err, stationId: scope.stationId, itemId }, 'Publishing a skip failed');
          });
      }
    }
  }

  /**
   * The islands of the items from a little before now to the end of the window. A failure
   * only costs the islands: every transition then airs as a plain crossfade.
   */
  /** The last islands loaded: what a sync uses when loading them fails. */
  let lastIslands: FeedIslands | null = null;

  /**
   * The islands of the items from a little before now to the end of the window. When loading
   * fails, the last ones loaded stand in (a render they name is still the right audio: islands
   * are content-addressed); `failed` when there are none yet.
   */
  async function loadIslands(
    window: FeedWindow,
    at: number,
  ): Promise<FeedIslands | null | 'failed'> {
    if (!deps.islands) return null;
    const since = at - 30 * 60_000;
    const ids = window.items
      .filter(
        (i) => isMediaKind(i.kind) && Date.parse(i.plannedStart) + i.plannedDurationMs > since,
      )
      .map((i) => i.id);
    if (!ids.length) return null;
    try {
      lastIslands = await deps.islands(ids);
      return lastIslands;
    } catch (err) {
      logger.warn({ err, stationId: scope.stationId }, 'Loading islands failed');
      return lastIslands ?? 'failed';
    }
  }

  /** The engine queue holds an island chain this boot's feeders pushed. */
  function hasQueuedChain(state: EngineState): boolean {
    return queuedOf(state).some((q) => (pushed.get(q.id)?.itemIds?.length ?? 0) > 1);
  }

  async function runOnce(): Promise<SyncResult> {
    const result: SyncResult = { plan: null, removed: [], pushed: [] };
    const engine = await deps.engine();
    if (!engine) return result;

    for (let round = 0; round < 4; round++) {
      const state = await engine.state();
      if (state.boot_id !== bootId) await enterBoot(state.boot_id);
      const onAirId = state.on_air.source === 'queue' ? state.on_air : null;
      await noteAired([onAirId?.item_id, onAirId?.segment_id]);

      const at = now();
      const window = await deps.load({
        from: new Date(at - lookbackMs),
        to: new Date(at + lookaheadMs + 3_600_000),
      });
      const loaded = await loadIslands(window, at);
      if (loaded === 'failed' && hasQueuedChain(state)) {
        // Without the islands every queued chain would look changed and be torn down into
        // crossfades: keep the queue as it is and try again next tick.
        logger.warn({ stationId: scope.stationId }, 'Islands unavailable: queue left as it is');
        return result;
      }
      const islands = loaded === 'failed' ? null : loaded;
      const chainOnAir = onAirChain(onAirId, window, islands);
      // A chain on air airs all its items: none of them may be planned again in this boot,
      // whether it has a request of its own (B) or was rendered whole into an island.
      if (chainOnAir) await noteAired(chainOnAir.covered.map((i) => i.id));
      const locked = new Set([...aired, ...(chainOnAir?.covered.map((i) => i.id) ?? [])]);
      for (const id of [onAirId?.item_id, onAirId?.segment_id]) if (id) locked.add(id);
      const layout = islands
        ? layoutIslands({
            items: window.items,
            media: window.media,
            islands: islands.islands,
            islandMedia: islands.media,
            reason: mediaReason,
            refused: (sha) => (unresolvable.get(`island:${sha}`) ?? 0) > now(),
            locked,
            engineRoot: opts.engineRoot,
          })
        : null;
      const { entries, built } = toEntries(window, layout, chainOnAir);
      const items = new Map(window.items.map((i) => [i.id, i]));
      const onAirKey = onAirId ? (onAirId.segment_id ?? onAirId.item_id ?? null) : null;
      const plan = planFeed({
        nowMs: at,
        onAir: onAirId
          ? {
              itemId: onAirId.item_id ?? null,
              segmentId: onAirId.segment_id ?? null,
              source: 'queue',
              elapsedMs: Math.max(0, (onAirId.elapsed ?? 0) * 1000),
              trimMs: onAirKey ? pushed.get(onAirKey)?.trimMs : undefined,
            }
          : null,
        entries,
        aired,
        options: planOptions,
      });
      result.plan = plan;

      // Bodies chain: each entry's cross_in is the previous one's cross_out.
      let previousCross =
        plan.onAirIndex === null
          ? undefined
          : built.get(entries[plan.onAirIndex]?.id ?? '')?.crossOutMs;
      const wanted = plan.wanted.map((w: PlannedEntry) => {
        const b = built.get(w.entry.id) as BuiltEntry;
        const crossInMs = previousCross;
        previousCross = b.crossOutMs;
        return {
          id: w.entry.id,
          trimMs: w.trimMs,
          built: b,
          crossInMs,
          fingerprint: fingerprintOf(body(b, window.station, crossInMs, 0)),
        };
      });
      const actions = diffQueue(queuedOf(state), wanted, plan.need, trimToleranceMs);

      if (actions.remove.length) {
        if (actions.remove.length === queuedOf(state).length) {
          await assertOwner();
          await engine.clear();
        } else {
          for (const id of actions.remove) {
            await assertOwner();
            await engine.remove(id).catch((error: unknown) => {
              // Already on air or gone: the next round sees it.
              if (!(error instanceof EngineNotQueuedError)) throw error;
            });
          }
        }
        for (const id of actions.remove) pushed.delete(id);
        await persist('removals', (store, boot) => store.remove(boot, actions.remove));
        result.removed.push(...actions.remove);
        continue;
      }

      let refused = false;
      for (const index of actions.push) {
        const w = wanted[index];
        if (!w) break;
        await assertOwner();
        const payload = body(w.built, window.station, w.crossInMs, w.trimMs);
        try {
          if ('parts' in payload) await engine.pushSegment(payload);
          else await engine.push(payload as EnginePushItem);
        } catch (error) {
          if (!(error instanceof EngineUnresolvableError)) throw error;
          // The cache table said ready, the engine's disk disagrees (ADR 0004): skip the file
          // for a while, fetch it now, and reconcile the table with the disk.
          logger.warn(
            { stationId: scope.stationId, itemId: w.id, err: error },
            'Engine refused a file: skipping it',
          );
          for (const fileId of w.built.fileIds)
            unresolvable.set(fileId, now() + unresolvableRetryMs);
          // An island file the engine can't read: its transition airs as the fallback.
          if (w.built.kind === 'chain') {
            for (const step of w.built.source.steps) {
              if (step.kind === 'island')
                unresolvable.set(`island:${step.sha256}`, now() + unresolvableRetryMs);
            }
          }
          if (cooldown('sync')) {
            await deps.cache.requestSync(scope).catch((err: unknown) => {
              logger.warn({ err, stationId: scope.stationId }, 'Cache sync request failed');
            });
          }
          refused = true;
          break;
        }
        const record = {
          fingerprint: w.fingerprint,
          trimMs: w.trimMs,
          parts: partsOf(w.built, payload),
          itemIds: w.built.kind === 'chain' ? w.built.itemIds : null,
        };
        pushed.set(w.id, record);
        await persist('a push', (store, boot) => store.save(boot, w.id, record));
        result.pushed.push(w.id);
      }
      if (refused) continue;

      await requestFetches(plan, built, layout?.missingFiles ?? []);
      await updateAlerts(plan, state, items);
      await reportSkips(plan, entries, items, built);
      if (plan.late.length) {
        logger.info(
          { stationId: scope.stationId, late: plan.late },
          'Anchors the tail cannot meet',
        );
      }
      // Forget what's out of the window.
      for (const id of [...unresolvable.keys()]) {
        if ((unresolvable.get(id) ?? 0) <= now()) unresolvable.delete(id);
      }
      return result;
    }
    logger.warn({ stationId: scope.stationId }, 'Feeder did not converge; retrying next tick');
    return result;
  }

  /** Brings the engine queue in line with the log. Concurrent calls share one run. */
  function sync(): Promise<SyncResult> {
    if (stopped) return Promise.resolve({ plan: null, removed: [], pushed: [] });
    if (running) {
      again = true;
      return running;
    }
    const run = async (): Promise<SyncResult> => {
      try {
        let result = await runOnce();
        while (again && !stopped) {
          again = false;
          result = await runOnce();
        }
        return result;
      } finally {
        running = null;
      }
    };
    running = run();
    return running;
  }

  return {
    stationId: scope.stationId,
    sync,

    /** Engine and log events: note what aired, then re-sync. */
    onEvent(event: RealtimeEvent): void {
      if (event.stationId !== scope.stationId) return;
      switch (event.type) {
        case 'engine.booted':
          // The next run enters the new boot (and loads what was pushed to it, if anything).
          if (event.data.bootId !== bootId) bootId = null;
          break;
        case 'engine.track.started':
          if (event.data.bootId === bootId) {
            void noteAired([event.data.itemId, event.data.segmentId]);
          }
          break;
        case 'engine.up':
        case 'engine.track.ended':
        case 'log.updated':
          break;
        default:
          return;
      }
      void sync().catch((err: unknown) => {
        logger.warn({ err, stationId: scope.stationId }, 'Feeder sync failed');
      });
    },

    stop(): void {
      stopped = true;
    },
  };
}

export type StationFeeder = ReturnType<typeof createStationFeeder>;

function isMediaKind(kind: LogItem['kind']): boolean {
  return ['song', 'vt', 'jingle', 'bed', 'episode', 'fill'].includes(kind);
}

function fingerprintOf(body: EnginePushItem | EnginePushSegment): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22);
}

/** Deterministic uuid (v4 layout) from the skipped item and the boot. */
function eventId(stationId: string, itemId: string, bootId: string | null): string {
  const h = createHash('sha256')
    .update(`feeder.item.passed_over:${stationId}:${itemId}:${bootId ?? ''}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((Number.parseInt(h[16] as string, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
