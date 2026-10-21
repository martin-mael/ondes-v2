import { randomUUID } from 'node:crypto';
import { logItemInputSchema, realtimeEventSchema } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { buildFixtureDay, FIXTURE_LIBRARY, type FixtureAsset } from './fixture.ts';
import { addDays, localDateOf, localDayBounds } from './time.ts';
import { retime, type TimedItem } from './timing.ts';

const PARIS = 'Europe/Paris';

describe('localDayBounds', () => {
  it('gives 24 h on a normal day, 23 h and 25 h on the DST days (Europe/Paris)', () => {
    expect(localDayBounds('2026-10-21', PARIS)).toEqual({
      startsAt: new Date('2026-10-20T22:00:00Z'),
      endsAt: new Date('2026-10-21T22:00:00Z'),
    });
    // Last Sunday of March: 02:00 → 03:00.
    expect(localDayBounds('2026-03-29', PARIS)).toEqual({
      startsAt: new Date('2026-03-28T23:00:00Z'),
      endsAt: new Date('2026-03-29T22:00:00Z'),
    });
    // Last Sunday of October: 03:00 → 02:00.
    expect(localDayBounds('2026-10-25', PARIS)).toEqual({
      startsAt: new Date('2026-10-24T22:00:00Z'),
      endsAt: new Date('2026-10-25T23:00:00Z'),
    });
  });

  it('maps instants back to their local date', () => {
    expect(localDateOf(new Date('2026-10-24T22:00:00Z'), PARIS)).toBe('2026-10-25');
    expect(localDateOf(new Date('2026-10-24T21:59:59Z'), PARIS)).toBe('2026-10-24');
    expect(localDateOf(new Date('2026-10-25T22:30:00Z'), PARIS)).toBe('2026-10-25');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

const item = (over: Partial<TimedItem> & { plannedDurationMs: number }): TimedItem => ({
  id: randomUUID(),
  kind: 'song',
  timing: 'flow',
  anchorAt: null,
  segmentId: null,
  ...over,
});

describe('retime', () => {
  const day = new Date('2026-10-21T00:00:00Z');
  const at = (s: number) => new Date(day.getTime() + s * 1000);

  it('chains flow items and honours anchors', () => {
    const items = [
      item({ plannedDurationMs: 10_000 }),
      item({ plannedDurationMs: 5_000 }),
      // hard: at its anchor even though the previous item ends at 15 s.
      item({ plannedDurationMs: 1_000, timing: 'hard', anchorAt: at(20) }),
      // not_before: anchor earlier than the cursor, so it follows.
      item({ plannedDurationMs: 1_000, timing: 'not_before', anchorAt: at(10) }),
      // not_before: anchor later than the cursor, so it waits.
      item({ plannedDurationMs: 0, kind: 'marker', timing: 'not_before', anchorAt: at(30) }),
      item({ plannedDurationMs: 2_000 }),
    ];
    expect(retime(items, day).map((t) => t.plannedStart)).toEqual([
      at(0),
      at(10),
      at(20),
      at(21),
      at(30),
      at(30),
    ]);
  });

  it('sizes a segment from its parts and lays the parts inside it', () => {
    const seg = item({ kind: 'segment', plannedDurationMs: 0 });
    const parts = [1_000, 2_500, 500].map((ms) =>
      item({ plannedDurationMs: ms, segmentId: seg.id }),
    );
    const after = item({ plannedDurationMs: 1_000 });
    const timed = retime([seg, ...parts, after], day);
    expect(timed.map((t) => [t.plannedStart, t.plannedDurationMs])).toEqual([
      [at(0), 4_000],
      [at(0), 1_000],
      [at(1), 2_500],
      [at(3.5), 500],
      [at(4), 1_000],
    ]);
  });

  it('refuses a part that is not right after its segment', () => {
    expect(() => retime([item({ plannedDurationMs: 1, segmentId: randomUUID() })], day)).toThrow();
  });
});

describe('logItemInputSchema', () => {
  const assetId = randomUUID();

  it('requires anchors exactly for anchored timings', () => {
    expect(logItemInputSchema.safeParse({ kind: 'marker', timing: 'hard' }).success).toBe(false);
    expect(
      logItemInputSchema.safeParse({
        kind: 'song',
        assetId,
        plannedDurationMs: 1,
        anchorAt: '2026-10-21T10:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      logItemInputSchema.safeParse({
        kind: 'marker',
        timing: 'soft',
        anchorAt: '2026-10-21T10:00:00Z',
        capMs: 30_000,
      }).success,
    ).toBe(true);
    expect(
      logItemInputSchema.safeParse({
        kind: 'marker',
        timing: 'hard',
        anchorAt: '2026-10-21T10:00:00Z',
        capMs: 30_000,
      }).success,
    ).toBe(false);
  });

  it('checks assets, markers and segments per kind', () => {
    expect(logItemInputSchema.safeParse({ kind: 'song', plannedDurationMs: 1 }).success).toBe(
      false,
    );
    expect(logItemInputSchema.safeParse({ kind: 'marker', plannedDurationMs: 5 }).success).toBe(
      false,
    );
    const part = { kind: 'song', assetId, plannedDurationMs: 1_000 };
    expect(logItemInputSchema.safeParse({ kind: 'segment', parts: [part] }).success).toBe(false);
    expect(logItemInputSchema.safeParse({ kind: 'segment', parts: [part, part] }).success).toBe(
      true,
    );
    expect(
      logItemInputSchema.safeParse({ kind: 'song', assetId, plannedDurationMs: 1, parts: [] })
        .success,
    ).toBe(false);
  });

  it('needs a sample rate with sample positions', () => {
    const base = { kind: 'song', assetId, plannedDurationMs: 1 };
    expect(logItemInputSchema.safeParse({ ...base, cueOverrides: { cueIn: 10 } }).success).toBe(
      false,
    );
    expect(
      logItemInputSchema.safeParse({ ...base, cueOverrides: { sampleRate: 44_100, cueIn: 10 } })
        .success,
    ).toBe(true);
  });
});

describe('log events', () => {
  it('are part of the real-time union', () => {
    const event = {
      id: randomUUID(),
      stationId: randomUUID(),
      at: '2026-10-21T10:00:00.000Z',
      type: 'log.updated',
      data: {
        from: '2026-10-21T10:00:00.000Z',
        to: '2026-10-21T11:00:00.000Z',
        days: [{ logDayId: randomUUID(), localDate: '2026-10-21', version: 3 }],
        cause: 'edit',
      },
    };
    expect(realtimeEventSchema.parse(event)).toEqual(event);
  });
});

describe('buildFixtureDay', () => {
  const assets: FixtureAsset[] = FIXTURE_LIBRARY.map((a) => ({ ...a, id: randomUUID() }));

  for (const [localDate, hours] of [
    ['2026-10-21', 24],
    ['2026-03-29', 23],
    ['2026-10-25', 25],
  ] as const) {
    it(`fills ${localDate} (${hours} h) with valid items, end to end`, () => {
      const items = buildFixtureDay(localDate, PARIS, assets);
      for (const i of items) logItemInputSchema.parse(i);
      const rows: TimedItem[] = [];
      for (const i of items) {
        const parsed = logItemInputSchema.parse(i);
        const id = randomUUID();
        rows.push({
          id,
          ...parsed,
          anchorAt: parsed.anchorAt ? new Date(parsed.anchorAt) : null,
          segmentId: null,
        });
        for (const p of parsed.parts ?? []) {
          rows.push({ ...p, id: randomUUID(), timing: 'flow', anchorAt: null, segmentId: id });
        }
      }
      const { startsAt, endsAt } = localDayBounds(localDate, PARIS);
      const timed = retime(rows, startsAt);
      const tops = timed.filter((_, i) => rows[i]?.segmentId === null);
      // Back to back: every top-level item starts where the one before ends.
      for (let i = 1; i < tops.length; i++) {
        const prev = tops[i - 1];
        const cur = tops[i];
        if (!prev || !cur) continue;
        expect(cur.plannedStart.getTime()).toBe(
          prev.plannedStart.getTime() + prev.plannedDurationMs,
        );
      }
      const last = tops.at(-1);
      expect(last && last.plannedStart.getTime() + last.plannedDurationMs).toBe(endsAt.getTime());
      expect((endsAt.getTime() - startsAt.getTime()) / 3_600_000).toBe(hours);
      expect(items.filter((i) => i.kind === 'episode')).toHaveLength(1);
      expect(items.filter((i) => i.kind === 'live_slot')).toHaveLength(1);
      expect(items.filter((i) => i.kind === 'segment').length).toBeGreaterThan(15);
    });
  }
});
