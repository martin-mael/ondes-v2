import {
  asset,
  assetCues,
  assetFile,
  assetLoudness,
  type Executor,
  type IslandRow,
  island,
  logItem,
  type StationScope,
  segue,
  station,
  type Tx,
  whereStation,
} from '@ondes/db';
import {
  type CueOverrides,
  checkSegue,
  deriveIslands,
  getPlayoutGain,
  type IslandMedia,
  type IslandPlan,
  type IslandSegueInput,
  islandHash,
  type PlayoutGainAsset,
  type PlayoutGainStation,
  SEGMENT_PART_KINDS,
  type SegueProblem,
  type SegueStatus,
} from '@ondes/shared';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

// Island sync (#55, ADR 0017): keeps every segue's status and the station's islands in step
// with the log and the library. Runs inside the caller's transaction: after each segue write
// (audited by the caller), and from the event consumer when the log or an asset changes
// (`plugin.ts`). Re-deriving is cheap and idempotent: an island whose spec hash didn't change
// keeps its render; a new hash goes back to `pending` (or straight to `ready` when another
// island of the station already rendered the same audio).
//
// Steps: lock the station's segues, expand the seeds to whole chains (segues linked through a
// shared item), check each segue against the log (items exist, consecutive, same assets) and
// its media (playout copies, cue ranges), derive islands for each run of `ready` segues, then
// rewrite the chain's islands and drop the ones no segue points at.

export type SyncSeeds = {
  segueIds?: readonly string[];
  /** Segues touching these items (and their chains). */
  itemIds?: readonly string[];
  /** Segues whose A or B is in these log days. */
  logDayIds?: readonly string[];
  /** Segues playing these assets: A, B or a voice. */
  assetIds?: readonly string[];
  /** Segues that lost an item or an asset but aren't `detached` yet. */
  orphans?: boolean;
  /** Every segue of the station (a station setting that changes every gain changed). */
  all?: boolean;
  /** Islands to drop if no segue points at them any more (a deleted segue's). */
  islandIds?: readonly string[];
};

export type SegueSyncChange = {
  segueId: string;
  status: SegueStatus;
  problem: SegueProblem | null;
  islandId: string | null;
  fromItemId: string | null;
  toItemId: string | null;
};

type SegueRow = typeof segue.$inferSelect;

export type SyncResult = {
  /** Segues whose status, problem or island changed. */
  segues: SegueSyncChange[];
  /** Islands created or whose spec changed. */
  islands: IslandRow[];
  /** Islands deleted because no segue renders them any more. */
  removed: { id: string; hash: string }[];
};

/**
 * Serialises syncs of one station (the CRUD routes and the event consumer may race). Take it
 * **before any segue row lock**: the routes call it first thing in their transaction, so every
 * path locks in the same order (station, then rows) and can't deadlock.
 */
export async function lockStation(tx: Tx, scope: StationScope) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`segues:${scope.stationId}`}, 0))`,
  );
}

export async function syncSegues(
  tx: Tx,
  scope: StationScope,
  seeds: SyncSeeds,
): Promise<SyncResult> {
  await lockStation(tx, scope);
  const segues = await expandChains(tx, scope, await seedSegues(tx, scope, seeds));
  const result: SyncResult = { segues: [], islands: [], removed: [] };
  // Only islands these segues used (or the caller names) can have lost their last segue.
  const candidates = new Set(seeds.islandIds ?? []);
  for (const s of segues) if (s.islandId) candidates.add(s.islandId);
  if (segues.length) await syncChains(tx, scope, segues, result);
  if (candidates.size) {
    result.removed = await tx
      .delete(island)
      .where(
        and(
          whereStation(island, scope),
          inArray(island.id, [...candidates]),
          sql`not exists (select 1 from ${segue} where ${segue.islandId} = ${island.id})`,
        ),
      )
      .returning({ id: island.id, hash: island.hash });
  }
  return result;
}

async function seedSegues(
  tx: Executor,
  scope: StationScope,
  seeds: SyncSeeds,
): Promise<SegueRow[]> {
  if (seeds.all) return tx.select().from(segue).where(whereStation(segue, scope));
  const conditions = [];
  if (seeds.segueIds?.length) conditions.push(inArray(segue.id, [...seeds.segueIds]));
  if (seeds.itemIds?.length) {
    conditions.push(inArray(segue.fromItemId, [...seeds.itemIds]));
    conditions.push(inArray(segue.toItemId, [...seeds.itemIds]));
  }
  if (seeds.logDayIds?.length) {
    const inDays = tx
      .select({ id: logItem.id })
      .from(logItem)
      .where(and(whereStation(logItem, scope), inArray(logItem.logDayId, [...seeds.logDayIds])));
    conditions.push(inArray(segue.fromItemId, inDays));
    conditions.push(inArray(segue.toItemId, inDays));
  }
  if (seeds.assetIds?.length) {
    const ids = [...seeds.assetIds];
    conditions.push(inArray(segue.fromAssetId, ids));
    conditions.push(inArray(segue.toAssetId, ids));
    for (const id of ids) {
      conditions.push(sql`${segue.voices} @> ${JSON.stringify([{ assetId: id }])}::jsonb`);
    }
  }
  if (seeds.orphans) {
    conditions.push(
      and(
        or(
          isNull(segue.fromItemId),
          isNull(segue.toItemId),
          isNull(segue.fromAssetId),
          isNull(segue.toAssetId),
        ),
        ne(segue.status, 'detached'),
      ),
    );
  }
  if (!conditions.length) return [];
  return tx
    .select()
    .from(segue)
    .where(and(whereStation(segue, scope), or(...conditions)));
}

/** Adds every segue linked to the found ones through a shared item, until none is new. */
async function expandChains(
  tx: Executor,
  scope: StationScope,
  found: SegueRow[],
): Promise<SegueRow[]> {
  const byId = new Map(found.map((s) => [s.id, s]));
  let frontier = found;
  while (frontier.length) {
    const items = new Set<string>();
    for (const s of frontier) {
      if (s.fromItemId) items.add(s.fromItemId);
      if (s.toItemId) items.add(s.toItemId);
    }
    if (!items.size) break;
    const ids = [...items];
    const rows = await tx
      .select()
      .from(segue)
      .where(
        and(
          whereStation(segue, scope),
          or(inArray(segue.fromItemId, ids), inArray(segue.toItemId, ids)),
        ),
      );
    frontier = rows.filter((r) => !byId.has(r.id));
    for (const r of frontier) byId.set(r.id, r);
  }
  return [...byId.values()];
}

type ItemRow = {
  id: string;
  logDayId: string;
  kind: string;
  assetId: string | null;
  segmentId: string | null;
  cueOverrides: CueOverrides | null;
  /** The next top-level item of its day, in play order. */
  nextId: string | null;
};

async function loadItems(tx: Executor, scope: StationScope, ids: string[]) {
  const items = new Map<string, ItemRow>();
  if (!ids.length) return items;
  const days = tx
    .select({ id: logItem.logDayId })
    .from(logItem)
    .where(and(whereStation(logItem, scope), inArray(logItem.id, ids)));
  const rows = await tx
    .select({
      id: logItem.id,
      logDayId: logItem.logDayId,
      kind: logItem.kind,
      assetId: logItem.assetId,
      segmentId: logItem.segmentId,
      cueOverrides: logItem.cueOverrides,
      nextId: sql<
        string | null
      >`case when ${logItem.segmentId} is null then lead(${logItem.id}) over (
        partition by ${logItem.logDayId}, (${logItem.segmentId} is null) order by ${logItem.position}
      ) end`,
    })
    .from(logItem)
    .where(and(whereStation(logItem, scope), inArray(logItem.logDayId, days)));
  const wanted = new Set(ids);
  for (const r of rows) if (wanted.has(r.id)) items.set(r.id, r);
  return items;
}

/** What the media loader reads per asset; `IslandMedia` once an item's cues are applied. */
type AssetMedia = {
  assetId: string;
  sha256: string;
  storageKey: string;
  sampleRate: number | null;
  durationSamples: number | null;
  flacBlockSize: number | null;
  cues: { sampleRate: number; cueIn: number | null; cueOut: number | null } | null;
  gain: PlayoutGainAsset;
};

export async function loadAssetMedia(
  db: Executor,
  scope: StationScope,
  assetIds: readonly string[],
): Promise<Map<string, AssetMedia>> {
  const media = new Map<string, AssetMedia>();
  if (!assetIds.length) return media;
  const rows = await db
    .select({
      assetId: asset.id,
      normalizeLoudness: asset.normalizeLoudness,
      gainOverrideDb: asset.gainOverrideDb,
      sha256: assetFile.sha256,
      storageKey: assetFile.storageKey,
      sampleRate: assetFile.sampleRate,
      durationSamples: assetFile.durationSamples,
      flacBlockSize: assetFile.flacBlockSize,
      cueSampleRate: assetCues.sampleRate,
      cueIn: assetCues.cueIn,
      cueOut: assetCues.cueOut,
      integratedLufs: assetLoudness.integratedLufs,
      truePeakDbtp: assetLoudness.truePeakDbtp,
    })
    .from(asset)
    .innerJoin(
      assetFile,
      and(
        eq(assetFile.assetId, asset.id),
        eq(assetFile.stationId, asset.stationId),
        eq(assetFile.role, 'playout'),
      ),
    )
    .leftJoin(
      assetCues,
      and(eq(assetCues.assetId, asset.id), eq(assetCues.stationId, asset.stationId)),
    )
    .leftJoin(
      assetLoudness,
      and(eq(assetLoudness.assetId, asset.id), eq(assetLoudness.stationId, asset.stationId)),
    )
    .where(and(whereStation(asset, scope), inArray(asset.id, [...assetIds])));
  for (const r of rows) {
    media.set(r.assetId, {
      assetId: r.assetId,
      sha256: r.sha256,
      storageKey: r.storageKey,
      sampleRate: r.sampleRate,
      durationSamples: r.durationSamples,
      flacBlockSize: r.flacBlockSize,
      cues:
        r.cueSampleRate === null
          ? null
          : { sampleRate: r.cueSampleRate, cueIn: r.cueIn, cueOut: r.cueOut },
      gain: {
        normalizeLoudness: r.normalizeLoudness,
        gainOverrideDb: r.gainOverrideDb,
        loudness:
          r.integratedLufs === null
            ? null
            : { integratedLufs: r.integratedLufs, truePeakDbtp: r.truePeakDbtp },
      },
    });
  }
  return media;
}

/**
 * An asset's media as an island source plays it: cues from the log item's overrides, else the
 * asset's, else the whole file, at the playout copy's rate; the gain the feeder sends (#29: the
 * item's `gainDb` replaces the asset's, through the same ceiling). Null without a usable copy.
 */
export function resolveMedia(
  m: AssetMedia | undefined,
  stationGain: PlayoutGainStation,
  overrides: CueOverrides | null = null,
): IslandMedia | null {
  if (!m?.sampleRate || !m.durationSamples || !m.flacBlockSize) return null;
  const sr = m.sampleRate;
  const at = (n: number, rate: number) => (rate === sr ? n : Math.round((n * sr) / rate));
  const pick = (override: number | undefined, cue: number | null | undefined) => {
    if (override !== undefined && overrides?.sampleRate) return at(override, overrides.sampleRate);
    if (cue != null && m.cues) return at(cue, m.cues.sampleRate);
    return null;
  };
  const gainAsset =
    overrides?.gainDb === undefined
      ? m.gain
      : { ...m.gain, normalizeLoudness: true, gainOverrideDb: overrides.gainDb };
  return {
    assetId: m.assetId,
    sha256: m.sha256,
    storageKey: m.storageKey,
    sampleRate: sr,
    durationSamples: m.durationSamples,
    flacBlockSize: m.flacBlockSize,
    gainDb: getPlayoutGain(gainAsset, stationGain).gainDb,
    cueIn: pick(overrides?.cueIn, m.cues?.cueIn) ?? 0,
    cueOut: Math.min(
      pick(overrides?.cueOut, m.cues?.cueOut) ?? m.durationSamples,
      m.durationSamples,
    ),
  };
}

const partKinds = new Set<string>(SEGMENT_PART_KINDS);

type Checked =
  | { status: 'ready'; input: IslandSegueInput }
  | { status: Exclude<SegueStatus, 'ready'>; problem: SegueProblem };

/** What a segue needs from the database to be checked: its items, media, station gain. */
type Context = {
  items: Map<string, ItemRow>;
  media: Map<string, AssetMedia>;
  /** Assets that exist in the station (with or without a playout copy). */
  assets: Set<string>;
  stationGain: PlayoutGainStation;
};

/** A segue against the log and media as they are now. */
function checkOne(s: SegueRow, c: Context): Checked {
  const detached = (code: SegueProblem['code'], message: string): Checked => ({
    status: 'detached',
    problem: { code, message },
  });
  const a = s.fromItemId ? c.items.get(s.fromItemId) : undefined;
  const b = s.toItemId ? c.items.get(s.toItemId) : undefined;
  if (!a || !b) return detached('item_deleted', `${a ? 'B' : 'A'} was deleted from the log`);
  for (const [name, item] of [
    ['A', a],
    ['B', b],
  ] as const) {
    if (item.segmentId !== null || !partKinds.has(item.kind)) {
      return detached('unsupported_item', `${name} is a ${item.kind} item: it can't be spliced`);
    }
    if (!item.assetId) return detached('asset_changed', `${name}'s asset was deleted`);
  }
  if (a.logDayId !== b.logDayId || a.nextId !== b.id) {
    return detached('not_consecutive', 'B no longer follows A in the log');
  }
  if (a.assetId !== s.fromAssetId || b.assetId !== s.toAssetId) {
    return detached(
      'asset_changed',
      `${a.assetId !== s.fromAssetId ? 'A' : 'B'} now plays another asset`,
    );
  }
  const deleted = s.voices.findIndex((v) => !c.assets.has(v.assetId));
  if (deleted >= 0) {
    return {
      status: 'invalid',
      problem: { code: 'missing_media', message: `voice ${deleted + 1}'s asset was deleted` },
    };
  }
  const from = resolveMedia(c.media.get(a.assetId as string), c.stationGain, a.cueOverrides);
  const to = resolveMedia(c.media.get(b.assetId as string), c.stationGain, b.cueOverrides);
  const voices = s.voices.map((v) => ({
    ...v,
    media: resolveMedia(c.media.get(v.assetId), c.stationGain),
  }));
  const missing = !from ? 'A' : !to ? 'B' : voices.findIndex((v) => !v.media) + 1 || null;
  if (missing !== null) {
    const what = typeof missing === 'number' ? `voice ${missing}` : missing;
    return {
      status: 'waiting',
      problem: { code: 'missing_media', message: `${what} has no playout copy yet` },
    };
  }
  const input: IslandSegueInput = {
    segueId: s.id,
    fromItemId: a.id,
    toItemId: b.id,
    from: from as IslandMedia,
    to: to as IslandMedia,
    out: s.outLane,
    in: s.inLane,
    voices: voices as IslandSegueInput['voices'],
  };
  const problem = checkSegue(input);
  if (problem) {
    return problem.code === 'unsupported_media'
      ? { status: 'waiting', problem }
      : { status: 'invalid', problem };
  }
  return { status: 'ready', input };
}

/** Runs of `ready` segues in play order: each one's B is the next one's A. */
function runsOf(inputs: IslandSegueInput[]): IslandSegueInput[][] {
  const byFrom = new Map(inputs.map((i) => [i.fromItemId, i]));
  const tos = new Set(inputs.map((i) => i.toItemId));
  const runs: IslandSegueInput[][] = [];
  for (const start of inputs) {
    if (tos.has(start.fromItemId)) continue;
    const run = [start];
    for (let next = byFrom.get(start.toItemId); next; next = byFrom.get(next.toItemId)) {
      run.push(next);
    }
    runs.push(run);
  }
  return runs;
}

type Evaluation = {
  checked: Map<string, Checked>;
  plans: (IslandPlan & { hash: string })[];
};

/** Checks whole chains of segues and derives their islands. Reads only. */
async function evaluate(
  db: Executor,
  scope: StationScope,
  segues: SegueRow[],
): Promise<Evaluation> {
  const itemIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const s of segues) {
    if (s.fromItemId) itemIds.add(s.fromItemId);
    if (s.toItemId) itemIds.add(s.toItemId);
    for (const v of s.voices) assetIds.add(v.assetId);
  }
  const items = await loadItems(db, scope, [...itemIds]);
  for (const item of items.values()) if (item.assetId) assetIds.add(item.assetId);
  const media = await loadAssetMedia(db, scope, [...assetIds]);
  const existing = assetIds.size
    ? await db
        .select({ id: asset.id })
        .from(asset)
        .where(and(whereStation(asset, scope), inArray(asset.id, [...assetIds])))
    : [];
  const [stationGain] = await db
    .select({
      loudnessTargetLufs: station.loudnessTargetLufs,
      truePeakLimitDbtp: station.truePeakLimitDbtp,
    })
    .from(station)
    .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
  if (!stationGain) throw new Error(`station ${scope.stationId} not found`);
  const context: Context = {
    items,
    media,
    assets: new Set(existing.map((r) => r.id)),
    stationGain,
  };

  const checked = new Map(segues.map((s) => [s.id, checkOne(s, context)]));
  const ready = [...checked.values()].flatMap((c) => (c.status === 'ready' ? [c.input] : []));
  const plans = runsOf(ready)
    .flatMap((run) => deriveIslands(run))
    .map((plan) => ({ ...plan, hash: islandHash(plan.spec) }));
  return { checked, plans };
}

async function syncChains(tx: Tx, scope: StationScope, segues: SegueRow[], result: SyncResult) {
  const { checked, plans } = await evaluate(tx, scope, segues);

  const islandOf = new Map<string, string>();
  for (const plan of plans) {
    const row = await saveIsland(tx, scope, plan);
    if (row.changed) result.islands.push(row.island);
    for (const id of plan.segueIds) islandOf.set(id, row.island.id);
  }

  for (const s of segues) {
    const c = checked.get(s.id) as Checked;
    const problem = c.status === 'ready' ? null : c.problem;
    const islandId = islandOf.get(s.id) ?? null;
    const same =
      s.status === c.status &&
      s.problemCode === (problem?.code ?? null) &&
      s.problemMessage === (problem?.message ?? null) &&
      s.islandId === islandId;
    if (same) continue;
    await tx
      .update(segue)
      .set({
        status: c.status,
        problemCode: problem?.code ?? null,
        problemMessage: problem?.message ?? null,
        islandId,
      })
      .where(and(eq(segue.id, s.id), whereStation(segue, scope)));
    result.segues.push({
      segueId: s.id,
      status: c.status,
      problem,
      islandId,
      fromItemId: s.fromItemId,
      toItemId: s.toItemId,
    });
  }
}

/**
 * Writes one derived island, keyed by its head item. Unchanged hash: keeps the row and its
 * render. New hash: `pending`, unless the station already has the same audio rendered.
 */
async function saveIsland(
  tx: Tx,
  scope: StationScope,
  plan: IslandPlan & { hash: string },
): Promise<{ island: IslandRow; changed: boolean }> {
  const { hash } = plan;
  const placement = {
    headItemId: plan.head.itemId,
    headAssetId: plan.head.assetId,
    headJoinSample: plan.head.joinSample,
    headHasBody: plan.head.hasBody,
    tailItemId: plan.tail.itemId,
    tailAssetId: plan.tail.assetId,
    tailJoinSample: plan.tail.joinSample,
    tailHasBody: plan.tail.hasBody,
    itemIds: plan.itemIds,
    segueIds: plan.segueIds,
    files: plan.files,
  };
  const [existing] = await tx
    .select()
    .from(island)
    .where(and(whereStation(island, scope), eq(island.headItemId, plan.head.itemId)));
  if (existing && existing.hash === hash) {
    const [row] = await tx
      .update(island)
      .set(placement)
      .where(and(eq(island.id, existing.id), whereStation(island, scope)))
      .returning();
    return { island: row as IslandRow, changed: false };
  }
  const [rendered] = await tx
    .select({
      storageKey: island.storageKey,
      fileSha256: island.fileSha256,
      fileSizeBytes: island.fileSizeBytes,
      renderedAt: island.renderedAt,
    })
    .from(island)
    .where(and(whereStation(island, scope), eq(island.hash, hash), eq(island.status, 'ready')))
    .limit(1);
  const content = {
    ...placement,
    specVersion: plan.spec.version,
    spec: plan.spec,
    hash,
    lengthSamples: plan.spec.lengthSamples,
    status: rendered ? ('ready' as const) : ('pending' as const),
    storageKey: rendered?.storageKey ?? null,
    fileSha256: rendered?.fileSha256 ?? null,
    fileSizeBytes: rendered?.fileSizeBytes ?? null,
    renderedAt: rendered?.renderedAt ?? null,
    error: null,
  };
  const [row] = existing
    ? await tx
        .update(island)
        .set(content)
        .where(and(eq(island.id, existing.id), whereStation(island, scope)))
        .returning()
    : await tx
        .insert(island)
        .values({ ...content, orgId: scope.orgId, stationId: scope.stationId })
        .returning();
  return { island: row as IslandRow, changed: true };
}

// --- Read-only derivation (the feeder, #57) ------------------------------------------------

export type DerivedIsland = IslandPlan & {
  hash: string;
  /** A `ready` island of the station with this exact hash: what may air. Null otherwise. */
  rendered: {
    islandId: string;
    storageKey: string;
    /** The rendered file's hash and size: `playoutPath({ sha256, ext: 'flac' })` in the cache. */
    file: { sha256: string; sizeBytes: number } | null;
  } | null;
};

export type Derivation = {
  segues: { segueId: string; status: SegueStatus; problem: SegueProblem | null }[];
  islands: DerivedIsland[];
};

/**
 * The islands the segues touching `itemIds` (and their whole chains) call for **right now**,
 * from the log and media as they are, without writing or locking anything. The feeder (#57)
 * calls it at push time: it plays an island only when `rendered` is set (the stored render has
 * the hash the current inputs give), and falls back to a crossfade otherwise, so a change the
 * sync hasn't seen yet (a library edit in flight) can never air a stale render.
 */
export async function deriveIslandsFor(
  db: Executor,
  scope: StationScope,
  itemIds: readonly string[],
): Promise<Derivation> {
  if (!itemIds.length) return { segues: [], islands: [] };
  const segues = await expandChains(db, scope, await seedSegues(db, scope, { itemIds }));
  if (!segues.length) return { segues: [], islands: [] };
  const { checked, plans } = await evaluate(db, scope, segues);
  const hashes = [...new Set(plans.map((p) => p.hash))];
  const ready = hashes.length
    ? await db
        .select({
          id: island.id,
          hash: island.hash,
          storageKey: island.storageKey,
          fileSha256: island.fileSha256,
          fileSizeBytes: island.fileSizeBytes,
        })
        .from(island)
        .where(
          and(
            whereStation(island, scope),
            inArray(island.hash, hashes),
            eq(island.status, 'ready'),
          ),
        )
    : [];
  const byHash = new Map(ready.map((r) => [r.hash, r]));
  return {
    segues: segues.map((s) => {
      const c = checked.get(s.id) as Checked;
      return { segueId: s.id, status: c.status, problem: c.status === 'ready' ? null : c.problem };
    }),
    islands: plans.map((plan) => {
      const r = byHash.get(plan.hash);
      return {
        ...plan,
        rendered: r?.storageKey
          ? {
              islandId: r.id,
              storageKey: r.storageKey,
              file:
                r.fileSha256 && r.fileSizeBytes
                  ? { sha256: r.fileSha256, sizeBytes: r.fileSizeBytes }
                  : null,
            }
          : null,
      };
    }),
  };
}
