import { describe, expect, it } from 'vitest';
import {
  ISLAND_HANDLE_SAMPLES,
  type IslandSpec,
  islandSpecSchema,
  islandStorageKey,
} from '../contracts/segues.ts';
import {
  checkSegue,
  clipEnvelope,
  deriveIslands,
  envelopeGainAt,
  type IslandMedia,
  type IslandPlan,
  type IslandSegueInput,
  islandHash,
} from './island.ts';
import { sha256Hex } from './sha256.ts';

const SR = 44_100;
const s = (seconds: number) => Math.round(seconds * SR);
const H = ISLAND_HANDLE_SAMPLES;

function media(name: string, seconds: number, extra: Partial<IslandMedia> = {}): IslandMedia {
  const sha256 = sha256Hex(name);
  return {
    assetId: `00000000-0000-4000-8000-${sha256.slice(0, 12)}`,
    sha256,
    storageKey: `org/o/sha256/${sha256}.flac`,
    sampleRate: SR,
    durationSamples: s(seconds),
    flacBlockSize: 1024,
    gainDb: -2,
    cueIn: 0,
    cueOut: s(seconds),
    ...extra,
  };
}

const A = media('A', 180, { gainDb: -3.5 });
const B = media('B', 200, { gainDb: -1.5 });
const C = media('C', 150);
const VT1 = media('VT1', 5, { gainDb: 1 });
const VT2 = media('VT2', 4);

/** A ducks under a 5 s voice that starts 3 s before its end; B comes in under the voice. */
function segue(
  id: string,
  from: [string, IslandMedia],
  to: [string, IslandMedia],
  voice: IslandMedia,
  overrides: Partial<IslandSegueInput> = {},
): IslandSegueInput {
  return {
    segueId: id,
    fromItemId: from[0],
    toItemId: to[0],
    from: from[1],
    to: to[1],
    out: {
      envelope: [
        { at: s(-3.5), gainDb: 0 },
        { at: s(-3), gainDb: -12 },
      ],
    },
    in: {
      start: s(-0.5),
      envelope: [
        { at: s(2), gainDb: -12 },
        { at: s(2.5), gainDb: 0 },
      ],
    },
    voices: [{ assetId: voice.assetId, start: s(-3), gainDb: 0, envelope: [], media: voice }],
    ...overrides,
  };
}

const ID = {
  a: '10000000-0000-4000-8000-00000000000a',
  b: '10000000-0000-4000-8000-00000000000b',
  c: '10000000-0000-4000-8000-00000000000c',
  s1: '20000000-0000-4000-8000-000000000001',
  s2: '20000000-0000-4000-8000-000000000002',
};

describe('envelopes', () => {
  it('interpolates linearly in amplitude and holds at both ends', () => {
    const e = [
      { at: 0, gainDb: 0 },
      { at: 100, gainDb: -90 },
    ];
    expect(envelopeGainAt([], 5)).toBe(1);
    expect(envelopeGainAt(e, -10)).toBe(1);
    expect(envelopeGainAt(e, 50)).toBeCloseTo(0.5, 12);
    expect(envelopeGainAt(e, 100)).toBe(0);
    expect(envelopeGainAt(e, 1000)).toBe(0);
    expect(envelopeGainAt([{ at: 0, gainDb: -6 }], 10)).toBeCloseTo(0.501187, 6);
  });

  it('clips to the island, dropping flat stretches', () => {
    expect(
      clipEnvelope(
        [
          { at: -50, gainDb: 0 },
          { at: 10, gainDb: -12 },
          { at: 20, gainDb: -12 },
        ],
        0,
        100,
      ),
    ).toEqual([
      { at: 0, gainDb: expect.closeTo(-8.496462, 5) },
      { at: 10, gainDb: -12 },
      { at: 100, gainDb: -12 },
    ]);
    expect(clipEnvelope([{ at: 500, gainDb: -12 }], -1000, 100)).toEqual([
      { at: 0, gainDb: -12 },
      { at: 100, gainDb: -12 },
    ]);
    expect(clipEnvelope([{ at: -5, gainDb: 0 }], 0, 100)).toEqual([]);
  });
});

describe('deriveIslands: one segue', () => {
  const input = segue(ID.s1, [ID.a, A], [ID.b, B], VT1);
  const [plan] = deriveIslands([input]);
  if (!plan) throw new Error('no island');

  it('runs from a handle before A ducks to a handle after B is alone, B snapped to its grid', () => {
    // First deviation: A's ramp starts at −3.5 s. B is alone at +2.5 s (the voice ends at +2 s).
    const start = s(-3.5) - H;
    expect(plan.head).toEqual({
      itemId: ID.a,
      assetId: A.assetId,
      joinSample: A.cueOut + start,
      hasBody: true,
    });
    const rawTail = s(2.5) + H - s(-0.5);
    const tail = Math.ceil(rawTail / 1024) * 1024;
    expect(plan.tail).toEqual({
      itemId: ID.b,
      assetId: B.assetId,
      joinSample: tail,
      hasBody: true,
    });
    expect(plan.tail.joinSample % 1024).toBe(0);
    expect(plan.spec.lengthSamples).toBe(tail + s(-0.5) - start);
    expect(plan.segueIds).toEqual([ID.s1]);
    expect(plan.itemIds).toEqual([ID.a, ID.b]);
  });

  it('places each source on the island timeline with its playout gain', () => {
    const start = s(-3.5) - H;
    const [a, vt, b] = plan.spec.sources;
    expect(a).toMatchObject({
      sha256: A.sha256,
      from: plan.head.joinSample,
      to: A.cueOut,
      at: 0,
    });
    expect(a?.gainDb).toBe(-3.5);
    expect(a?.envelopes).toEqual([
      [
        { at: 0, gainDb: 0 },
        { at: H, gainDb: 0 },
        { at: s(-3) - start, gainDb: -12 },
        { at: plan.spec.lengthSamples, gainDb: -12 },
      ],
    ]);
    expect(vt).toMatchObject({ sha256: VT1.sha256, from: 0, to: VT1.cueOut, at: s(-3) - start });
    expect(vt?.envelopes).toEqual([]);
    expect(b).toMatchObject({ from: 0, to: plan.tail.joinSample, at: s(-0.5) - start });
    // The tail of the island is pure B: its envelope is back at 0 dB.
    const bEnv = b?.envelopes[0] ?? [];
    expect(envelopeGainAt(bEnv, plan.spec.lengthSamples - H)).toBe(1);
    // B's last island sample is followed by its body: the source reaches the island's end.
    expect((b?.at ?? 0) + (b?.to ?? 0) - (b?.from ?? 0)).toBe(plan.spec.lengthSamples);
    expect(() => islandSpecSchema.parse(plan.spec)).not.toThrow();
  });

  it('hashes the spec deterministically, ignoring changes outside the island', () => {
    const hash = islandHash(plan.spec);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Same audio, another key order and another transition id: same hash.
    const reordered = JSON.parse(JSON.stringify(plan.spec)) as IslandSpec;
    expect(islandHash(reordered)).toBe(hash);
    const elsewhere = deriveIslands([{ ...input, segueId: ID.s2, fromItemId: ID.c }])[0];
    expect(elsewhere && islandHash(elsewhere.spec)).toBe(hash);
    // A 0 dB point a minute before the transition changes nothing audible.
    const noop = deriveIslands([
      { ...input, out: { envelope: [{ at: s(-60), gainDb: 0 }, ...input.out.envelope] } },
    ])[0];
    expect(noop && islandHash(noop.spec)).toBe(hash);
    // Moving the voice by one sample does.
    const moved = deriveIslands([
      { ...input, voices: input.voices.map((v) => ({ ...v, start: v.start + 1 })) },
    ])[0];
    expect(moved && islandHash(moved.spec)).not.toBe(hash);
    // So does a new playout gain.
    const louder = deriveIslands([{ ...input, from: { ...A, gainDb: -3 } }])[0];
    expect(louder && islandHash(louder.spec)).not.toBe(hash);
    expect(islandStorageKey('org-1', hash)).toBe(`org/org-1/islands/v1/${hash}.flac`);
  });

  it('changes the hash with every envelope and every source file', () => {
    const hash = islandHash(plan.spec);
    const variants: IslandSegueInput[] = [
      // A ducks deeper, B rises later, the voice gets a fade.
      {
        ...input,
        out: { envelope: input.out.envelope.map((p, i) => (i ? { ...p, gainDb: -13 } : p)) },
      },
      {
        ...input,
        in: { ...input.in, envelope: input.in.envelope.map((p) => ({ ...p, at: p.at + 10 })) },
      },
      {
        ...input,
        voices: input.voices.map((v) => ({
          ...v,
          envelope: [
            { at: s(0), gainDb: 0 },
            { at: s(1), gainDb: -90 },
          ],
        })),
      },
      // Another playout copy of A, of B, of the voice (same lengths and gains).
      { ...input, from: { ...A, sha256: sha256Hex('A, re-encoded') } },
      { ...input, to: { ...B, sha256: sha256Hex('B, re-encoded') } },
      {
        ...input,
        voices: input.voices.map((v) => ({
          ...v,
          media: { ...v.media, sha256: sha256Hex('VT1, re-recorded') },
        })),
      },
    ];
    const hashes = variants.map((v) => islandHash((deriveIslands([v])[0] as IslandPlan).spec));
    for (const h of hashes) expect(h).not.toBe(hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('keeps the hash for the same audio from other assets, keys or lane order', () => {
    const hash = islandHash(plan.spec);
    const otherAssets = deriveIslands([
      {
        ...input,
        from: { ...A, assetId: ID.s2, storageKey: 'org/other/sha256/a.flac' },
        voices: input.voices.map((v) => ({
          ...v,
          assetId: ID.c,
          media: { ...v.media, assetId: ID.c },
        })),
      },
    ])[0] as IslandPlan;
    expect(islandHash(otherAssets.spec)).toBe(hash);
    expect(otherAssets.files[A.sha256]).toEqual({
      storageKey: 'org/other/sha256/a.flac',
      assetId: ID.s2,
    });
    expect(plan.files[VT1.sha256]).toEqual({ storageKey: VT1.storageKey, assetId: VT1.assetId });

    // Two voices at the same position: listing them the other way round changes nothing.
    const two = (order: number[]) =>
      deriveIslands([
        {
          ...input,
          voices: order.map((gainDb) => ({
            assetId: VT1.assetId,
            start: s(-3),
            gainDb,
            envelope: [],
            media: VT1,
          })),
        },
      ])[0] as IslandPlan;
    expect(islandHash(two([0, -6]).spec)).toBe(islandHash(two([-6, 0]).spec));
  });
});

describe('deriveIslands: edges', () => {
  it('snaps B on its own grid when B has a cue-in', () => {
    const b = { ...B, cueIn: 30_001 };
    const [plan] = deriveIslands([segue(ID.s1, [ID.a, A], [ID.b, b], VT1)]);
    expect((plan?.tail.joinSample ?? 1) % 1024).toBe(0);
    expect(plan?.spec.sources.find((x) => x.sha256 === B.sha256)?.from).toBe(30_001);
  });

  it('starts at A when A is shaped from its first sample, and when A would keep a stub', () => {
    const shaped = deriveIslands([
      segue(ID.s1, [ID.a, A], [ID.b, B], VT1, { out: { envelope: [{ at: 0, gainDb: -6 }] } }),
    ])[0];
    expect(shaped?.head).toMatchObject({ joinSample: 0, hasBody: false });
    // A 4 s jingle: the body before the island would be under a second.
    const jingle = media('J', 4);
    const short = deriveIslands([segue(ID.s1, [ID.a, jingle], [ID.b, B], VT1)])[0];
    expect(short?.head).toMatchObject({ joinSample: 0, hasBody: false });
    expect(short?.spec.sources[0]).toMatchObject({ from: 0, at: 0 });
  });

  it('runs to B’s end when B never settles at 0 dB or is too short to resume', () => {
    const ducked = deriveIslands([
      segue(ID.s1, [ID.a, A], [ID.b, B], VT1, {
        in: { start: s(-0.5), envelope: [{ at: s(2), gainDb: -3 }] },
      }),
    ])[0];
    expect(ducked?.tail).toMatchObject({ joinSample: B.cueOut, hasBody: false });
    const short = media('Bs', 3.5);
    const tiny = deriveIslands([segue(ID.s1, [ID.a, A], [ID.b, short], VT1)])[0];
    expect(tiny?.tail).toMatchObject({ joinSample: short.cueOut, hasBody: false });
  });

  it('covers a gap after A when B starts late', () => {
    const plan = deriveIslands([
      segue(ID.s1, [ID.a, A], [ID.b, B], VT1, {
        out: { envelope: [] },
        in: { start: s(2.5), envelope: [] },
        voices: [{ assetId: VT1.assetId, start: 0, gainDb: 0, envelope: [], media: VT1 }],
      }),
    ])[0];
    // Nothing deviates before A's end: the island starts a handle before it.
    expect(plan?.head.joinSample).toBe(A.cueOut - H);
    // The voice (5 s) outlasts B's start: B is alone after it.
    const vt = plan?.spec.sources.find((x) => x.sha256 === VT1.sha256);
    expect(vt?.at).toBe(H);
  });

  it('applies a voice lane’s trim and gain', () => {
    const plan = deriveIslands([
      segue(ID.s1, [ID.a, A], [ID.b, B], VT1, {
        voices: [
          {
            assetId: VT1.assetId,
            start: s(-3),
            cueIn: 1000,
            cueOut: s(4),
            gainDb: 2,
            envelope: [],
            media: VT1,
          },
        ],
      }),
    ])[0];
    expect(plan?.spec.sources.find((x) => x.sha256 === VT1.sha256)).toMatchObject({
      from: 1000,
      to: s(4),
      gainDb: 3,
    });
  });
});

describe('deriveIslands: chains', () => {
  it('merges overlapping islands: A > VT1 > B(short) > VT2 > C', () => {
    const shortB = media('B-short', 6);
    const s1 = segue(ID.s1, [ID.a, A], [ID.b, shortB], VT1);
    // VT2 starts 2.5 s before B's end, B ducks from 3 s before it.
    const s2 = segue(ID.s2, [ID.b, shortB], [ID.c, C], VT2, {
      out: {
        envelope: [
          { at: s(-3), gainDb: 0 },
          { at: s(-2.5), gainDb: -10 },
        ],
      },
      voices: [{ assetId: VT2.assetId, start: s(-2.5), gainDb: 0, envelope: [], media: VT2 }],
    });
    const plans = deriveIslands([s1, s2]);
    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan?.segueIds).toEqual([ID.s1, ID.s2]);
    expect(plan?.itemIds).toEqual([ID.a, ID.b, ID.c]);
    expect(plan?.head.itemId).toBe(ID.a);
    expect(plan?.tail.itemId).toBe(ID.c);
    expect((plan?.tail.joinSample ?? 1) % 1024).toBe(0);

    const sources = plan?.spec.sources ?? [];
    expect(sources.map((x) => x.sha256)).toEqual([
      A.sha256,
      VT1.sha256,
      shortB.sha256,
      VT2.sha256,
      C.sha256,
    ]);
    // B plays whole, under B's incoming envelope and its outgoing one.
    const b = sources[2];
    expect(b).toMatchObject({ from: 0, to: shortB.cueOut });
    expect(b?.envelopes).toHaveLength(2);
    // Segue 2's axis starts where B ends: VT2 sits 2.5 s before B's last sample.
    const bEnd = (b?.at ?? 0) + shortB.cueOut;
    expect(sources[3]?.at).toBe(bEnd - s(2.5));
    // C enters at segue 2's in.start on that axis and reaches the island's end.
    const c = sources[4];
    expect(c?.at).toBe(bEnd + s(-0.5));
    expect((c?.at ?? 0) + (c?.to ?? 0)).toBe(plan?.spec.lengthSamples);
    expect(() => islandSpecSchema.parse(plan?.spec)).not.toThrow();
  });

  it('keeps two islands when B plays long enough between them', () => {
    const s1 = segue(ID.s1, [ID.a, A], [ID.b, B], VT1);
    const s2 = segue(ID.s2, [ID.b, B], [ID.c, C], VT2, {
      voices: [{ assetId: VT2.assetId, start: s(-3), gainDb: 0, envelope: [], media: VT2 }],
    });
    const plans = deriveIslands([s1, s2]);
    expect(plans.map((p) => p.segueIds)).toEqual([[ID.s1], [ID.s2]]);
    const [first, second] = plans;
    expect(first?.tail.itemId).toBe(ID.b);
    expect(second?.head.itemId).toBe(ID.b);
    expect((second?.head.joinSample ?? 0) - (first?.tail.joinSample ?? 0)).toBeGreaterThan(SR);
    // Each island is the same as derived alone.
    expect(islandHash(first?.spec as IslandSpec)).toBe(
      islandHash((deriveIslands([s1])[0] as { spec: IslandSpec }).spec),
    );
  });

  it('refuses segues that are not consecutive', () => {
    const s1 = segue(ID.s1, [ID.a, A], [ID.b, B], VT1);
    const s2 = segue(ID.s2, [ID.c, C], [ID.a, A], VT2);
    expect(() => deriveIslands([s1, s2])).toThrow(/consecutive/);
  });
});

describe('checkSegue', () => {
  const ok = segue(ID.s1, [ID.a, A], [ID.b, B], VT1);

  it('accepts a valid segue', () => {
    expect(checkSegue(ok)).toBeNull();
  });

  it('refuses B or a voice before A, a voice after B, bad media', () => {
    expect(checkSegue({ ...ok, in: { start: -A.cueOut - 1, envelope: [] } })?.code).toBe(
      'out_of_range',
    );
    expect(
      checkSegue({ ...ok, voices: ok.voices.map((v) => ({ ...v, start: -A.cueOut - 1 })) })
        ?.message,
    ).toMatch(/starts before A/);
    const shortB = media('B-tiny', 2);
    expect(checkSegue({ ...ok, to: shortB })?.message).toMatch(/ends after B/);
    expect(checkSegue({ ...ok, from: { ...A, sampleRate: 48_000 } })?.code).toBe(
      'unsupported_media',
    );
    expect(
      checkSegue({ ...ok, voices: ok.voices.map((v) => ({ ...v, cueOut: VT1.cueOut + 1 })) })
        ?.message,
    ).toMatch(/outside the file/);
  });
});

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });
});
