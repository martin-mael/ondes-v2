import { createHash } from 'node:crypto';
import type { StationScope } from '@ondes/db';
import {
  alertTypes,
  type EnginePushItem,
  type EnginePushSegment,
  type EngineState,
  type FeederItemPassedOverEvent,
  type LogItem,
  type LogSegmentPart,
  type PlayoutGainStation,
  type RaiseAlert,
  type RealtimeEvent,
} from '@ondes/shared';
import type { EngineAdapter } from '../adapter/adapter.ts';
import { EngineNotQueuedError, EngineUnresolvableError } from '../adapter/errors.ts';
import { type Logger, silentLogger } from '../adapter/logger.ts';
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
  buildPushItem,
  buildPushSegment,
  crossOutMsOf,
  type FeedMedia,
  type PushSource,
  playLengthMs,
  type SegmentSource,
  segmentCrossOutMs,
} from './push.ts';
import type { FeedWindow } from './repo.ts';

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
  };
  /** Real-time events (`feeder.item.passed_over`). */
  publish?(event: FeederItemPassedOverEvent): Promise<void>;
  /** Still the station's only feeder? Checked before every change to the engine queue. */
  owns?(): Promise<boolean>;
  now?(): number;
  logger?: Logger;
  options?: FeederOptions;
};

export type SyncResult = {
  plan: FeedPlan | null;
  removed: string[];
  pushed: string[];
};

type Built = {
  source: PushSource | SegmentSource;
  isSegment: boolean;
  /** Asset files it plays, for urgent fetches and 422s. */
  fileIds: string[];
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
  const pushed = new Map<string, { fingerprint: string; trimMs: number }>();
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

  function resetBoot(id: string) {
    bootId = id;
    pushed.clear();
    aired.clear();
    reported.clear();
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

  /** The planner's view of each item, and what pushing it takes. */
  function toEntries(window: FeedWindow) {
    const entries: FeedEntry[] = [];
    const built = new Map<string, Built>();
    for (const item of window.items) {
      let unplayable: SkipReason | null = null;
      let flexMs = 0;
      if (item.kind === 'segment') {
        const parts: PushSource[] = [];
        for (const part of item.parts) {
          const media = part.assetId ? window.media.get(part.assetId) : undefined;
          unplayable ??= mediaReason(media);
          if (media) parts.push(partSource(part, media));
        }
        if (item.parts.length < 2) unplayable ??= 'no_media_file';
        built.set(item.id, {
          source: { segmentId: item.id, cueOverrides: item.cueOverrides, parts },
          isSegment: true,
          fileIds: parts.map((p) => p.media.fileId),
        });
      } else if (isMediaKind(item.kind)) {
        const media = item.assetId ? window.media.get(item.assetId) : undefined;
        unplayable = mediaReason(media);
        if (media) {
          const source = partSource(item, media);
          built.set(item.id, { source, isSegment: false, fileIds: [media.fileId] });
          if (isFlexibleKind(item.kind)) {
            const length = Math.min(item.plannedDurationMs, playLengthMs(source) ?? Infinity);
            flexMs = Math.max(0, length - minKeepMs);
          }
        }
      }
      entries.push({
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
      });
    }
    return { entries, built };
  }

  function body(
    b: Built,
    station: PlayoutGainStation,
    crossInMs: number | undefined,
    trimMs: number,
  ): EnginePushItem | EnginePushSegment {
    const ctx = { station, crossInMs, trimMs, engineRoot: opts.engineRoot };
    return b.isSegment
      ? buildPushSegment(b.source as SegmentSource, ctx)
      : buildPushItem(b.source as PushSource, ctx);
  }

  function crossOut(b: Built | undefined): number | undefined {
    if (!b) return undefined;
    return b.isSegment
      ? segmentCrossOutMs(b.source as SegmentSource)
      : crossOutMsOf(b.source as PushSource);
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

  async function assertOwner() {
    if (deps.owns && !(await deps.owns())) throw new FeederNotOwnerError(scope.stationId);
  }

  async function requestFetches(plan: FeedPlan, built: Map<string, Built>) {
    for (const { entry, reason } of plan.skipped) {
      if (reason !== 'not_cached' && reason !== 'unresolvable') continue;
      for (const fileId of built.get(entry.id)?.fileIds ?? []) {
        if (!cooldown(`fetch:${fileId}`)) continue;
        await deps.cache.requestUrgentFetch(scope, fileId).catch((err: unknown) => {
          logger.warn({ err, stationId: scope.stationId, fileId }, 'Urgent cache fetch failed');
        });
      }
    }
  }

  async function updateAlerts(plan: FeedPlan, state: EngineState, items: Map<string, LogItem>) {
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
  async function reportSkips(plan: FeedPlan, entries: FeedEntry[], items: Map<string, LogItem>) {
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
      const ids = item.kind === 'segment' ? item.parts.map((p) => p.id) : [id];
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

  async function runOnce(): Promise<SyncResult> {
    const result: SyncResult = { plan: null, removed: [], pushed: [] };
    const engine = await deps.engine();
    if (!engine) return result;

    for (let round = 0; round < 4; round++) {
      const state = await engine.state();
      if (state.boot_id !== bootId) resetBoot(state.boot_id);
      const onAirId = state.on_air.source === 'queue' ? state.on_air : null;
      if (onAirId?.item_id) aired.add(onAirId.item_id);
      if (onAirId?.segment_id) aired.add(onAirId.segment_id);

      const at = now();
      const window = await deps.load({
        from: new Date(at - lookbackMs),
        to: new Date(at + lookaheadMs + 3_600_000),
      });
      const { entries, built } = toEntries(window);
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
          : crossOut(built.get(entries[plan.onAirIndex]?.id ?? ''));
      const wanted = plan.wanted.map((w: PlannedEntry) => {
        const b = built.get(w.entry.id) as Built;
        const crossInMs = previousCross;
        previousCross = crossOut(b);
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
        await assertOwner();
        if (actions.remove.length === queuedOf(state).length) {
          await engine.clear();
        } else {
          for (const id of actions.remove) {
            await engine.remove(id).catch((error: unknown) => {
              // Already on air or gone: the next round sees it.
              if (!(error instanceof EngineNotQueuedError)) throw error;
            });
          }
        }
        for (const id of actions.remove) pushed.delete(id);
        result.removed.push(...actions.remove);
        continue;
      }

      let refused = false;
      if (actions.push.length) await assertOwner();
      for (const index of actions.push) {
        const w = wanted[index];
        if (!w) break;
        const payload = body(w.built, window.station, w.crossInMs, w.trimMs);
        try {
          if (w.built.isSegment) await engine.pushSegment(payload as EnginePushSegment);
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
          if (cooldown('sync')) {
            await deps.cache.requestSync(scope).catch((err: unknown) => {
              logger.warn({ err, stationId: scope.stationId }, 'Cache sync request failed');
            });
          }
          refused = true;
          break;
        }
        pushed.set(w.id, { fingerprint: w.fingerprint, trimMs: w.trimMs });
        result.pushed.push(w.id);
      }
      if (refused) continue;

      await requestFetches(plan, built);
      await updateAlerts(plan, state, items);
      await reportSkips(plan, entries, items);
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
          if (event.data.bootId !== bootId) resetBoot(event.data.bootId);
          break;
        case 'engine.track.started':
          if (event.data.bootId === bootId) {
            if (event.data.itemId) aired.add(event.data.itemId);
            if (event.data.segmentId) aired.add(event.data.segmentId);
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
