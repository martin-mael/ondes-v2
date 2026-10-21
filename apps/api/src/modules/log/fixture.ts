import { type AssetType, type LocalDate, PLAYOUT_SAMPLE_RATE } from '@ondes/shared';
import type { LogDayItemInput } from './repo.ts';
import { localDayBounds, zonedParts } from './time.ts';

// A hand-made log day for development (#100), before the generator (#50) exists. Pure: given
// the station's fixture assets it returns the items of one local day, back-timed by hand so
// every hour ends exactly on the hour. `deploy/dev/seed/log-fixture.ts` writes it.
//
// Each hour: a station-ID jingle soft-timed at HH:00 (60 s cap), songs, a voice-tracked island
// segment (song → VT → song) around half past, more songs, and a fill bed sized to the second
// before the next hour. 12:00 is a pre-recorded episode (hard start), 19:00–21:00 a live slot
// (hard start), 18:30 an agenda jingle (not before 18:30), each full hour also gets a marker.
// DST days come out 23 or 25 hours long.

export interface FixtureAsset {
  id: string;
  type: AssetType;
  title: string;
  durationMs: number;
}

/** The library the fixture needs. `deploy/dev/seed/log-fixture.ts` creates it. */
export const FIXTURE_LIBRARY: readonly {
  type: AssetType;
  title: string;
  artists: string[];
  durationMs: number;
}[] = [
  ...[
    ['Rue Mercière', 'Les Traboules', 214_000],
    ['Fourvière by Night', 'Quai Perrache', 251_000],
    ['Saône Drift', 'Marie Lumière', 198_500],
    ['Croix-Rousse Stairs', 'Canut Collective', 236_200],
    ['Presqu’île', 'Les Traboules', 187_300],
    ['Confluence', 'Bellecour Sound System', 263_800],
    ['Pentes', 'Marie Lumière', 205_100],
    ['Gerland Lights', 'Quai Perrache', 229_900],
    ['Vieux Lyon', 'Canut Collective', 244_400],
    ['Part-Dieu Rush', 'Bellecour Sound System', 192_700],
    ['Brouillard', 'Lune Rhodanienne', 271_000],
    ['Monplaisir', 'Lune Rhodanienne', 218_600],
    ['Bouchon', 'Les Gones', 201_200],
    ['Villeurbanne Blues', 'Les Gones', 255_300],
    ['Guillotière', 'Jeanne Rhône', 223_400],
    ['Tête d’Or', 'Jeanne Rhône', 238_800],
    ['Ainay', 'Pierre Scize', 209_000],
    ['Rive Gauche', 'Pierre Scize', 247_700],
    ['Fête des Lumières', 'Bellecour Sound System', 282_100],
    ['Ficelle', 'Marie Lumière', 196_400],
  ].map(([title, artist, durationMs]) => ({
    type: 'song' as const,
    title: title as string,
    artists: [artist as string],
    durationMs: durationMs as number,
  })),
  { type: 'jingle', title: 'Station ID: Vandale Radio', artists: [], durationMs: 8_200 },
  { type: 'jingle', title: 'Station ID: Lyon, 24/7', artists: [], durationMs: 6_700 },
  { type: 'jingle', title: 'Agenda culturel', artists: [], durationMs: 12_400 },
  { type: 'vt', title: 'VT: la suite tout de suite', artists: ['Dev Admin'], durationMs: 14_300 },
  { type: 'vt', title: 'VT: vous écoutez Vandale', artists: ['Dev Admin'], durationMs: 21_800 },
  { type: 'vt', title: 'VT: le point concerts', artists: ['Dev Admin'], durationMs: 32_500 },
  { type: 'bed', title: 'Bed: Nappe Rhône (10 min)', artists: [], durationMs: 600_000 },
  {
    type: 'episode',
    title: 'Le Midi Vandale (episode)',
    artists: ['Vandale Radio'],
    durationMs: 3_420_000,
  },
];

/** Crossfade into the next song, and the +20 ms per transition of ADR 0003. */
const SONG_OVERLAP_MS = 2_000;
const TRANSITION_MS = 20;
const HOUR_MS = 3_600_000;

/** Slot length of an asset in the log: what it plays, minus its overlap, plus a frame. */
function slot(a: FixtureAsset, overlapMs = 0) {
  return a.durationMs - overlapMs + TRANSITION_MS;
}

export function buildFixtureDay(
  localDate: LocalDate,
  timeZone: string,
  assets: readonly FixtureAsset[],
): LogDayItemInput[] {
  const of = (type: AssetType) => assets.filter((a) => a.type === type);
  const songs = of('song');
  const [stationId, stationId2, agenda] = of('jingle');
  const vts = of('vt');
  const [bed] = of('bed');
  const [episode] = of('episode');
  if (!songs.length || !stationId || !stationId2 || !agenda || !vts.length || !bed || !episode) {
    throw new Error('fixture library is incomplete: run the seed to create it');
  }

  const { startsAt, endsAt } = localDayBounds(localDate, timeZone);
  const items: LogDayItemInput[] = [];
  let songIndex = (Number(localDate.slice(-2)) * 7) % songs.length;
  const nextSong = () => songs[songIndex++ % songs.length] as FixtureAsset;
  const song = (a: FixtureAsset, slotIndex: number): LogDayItemInput => ({
    kind: 'song',
    assetId: a.id,
    plannedDurationMs: slot(a, SONG_OVERLAP_MS),
    cueOverrides: { crossOutMs: SONG_OVERLAP_MS },
    origin: { type: 'clock', clockId: null, slotIndex },
  });

  let liveUntil = 0;
  for (let hourStart = startsAt.getTime(); hourStart < endsAt.getTime(); hourStart += HOUR_MS) {
    const hourEnd = Math.min(hourStart + HOUR_MS, endsAt.getTime());
    const local = zonedParts(new Date(hourStart), timeZone);
    const label = `${String(local.hour).padStart(2, '0')}:00`;
    const anchorAt = new Date(hourStart).toISOString();
    if (hourStart < liveUntil) continue;

    if (local.hour === 19) {
      // Live from 19:00 to 21:00 (two hours, whatever the DST day does to the clock).
      liveUntil = Math.min(hourStart + 2 * HOUR_MS, endsAt.getTime());
      items.push({
        kind: 'live_slot',
        title: 'Live: Vandale Night',
        plannedDurationMs: liveUntil - hourStart,
        timing: 'hard',
        anchorAt,
        origin: { type: 'show', showSlotId: null },
      });
      continue;
    }

    items.push({
      kind: 'marker',
      title: `Top of hour ${label}`,
      plannedDurationMs: 0,
      timing: 'soft',
      anchorAt,
      capMs: 60_000,
      origin: { type: 'clock', clockId: null, slotIndex: 0 },
    });
    let used = 0;
    let slotIndex = 1;
    const push = (item: LogDayItemInput) => {
      items.push(item);
      used += item.kind === 'segment' ? 0 : (item.plannedDurationMs ?? 0);
    };

    if (local.hour === 12) {
      push({
        kind: 'episode',
        assetId: episode.id,
        title: episode.title,
        plannedDurationMs: slot(episode),
        timing: 'hard',
        anchorAt,
        origin: { type: 'show', showSlotId: null },
      });
    } else {
      const id = local.hour % 2 === 0 ? stationId : stationId2;
      push({
        kind: 'jingle',
        assetId: id.id,
        plannedDurationMs: slot(id),
        origin: { type: 'clock', clockId: null, slotIndex: slotIndex++ },
      });
    }

    const budget = hourEnd - hourStart;
    let islandDone = local.hour === 12;
    let agendaDone = local.hour !== 18;
    for (;;) {
      if (!agendaDone && used >= 30 * 60_000) {
        agendaDone = true;
        push({
          kind: 'jingle',
          assetId: agenda.id,
          plannedDurationMs: slot(agenda),
          timing: 'not_before',
          anchorAt: new Date(hourStart + 30 * 60_000).toISOString(),
          origin: { type: 'clock', clockId: null, slotIndex: slotIndex++ },
        });
        continue;
      }
      if (!islandDone && used >= 25 * 60_000) {
        islandDone = true;
        const a = nextSong();
        const vt = vts[local.hour % vts.length] as FixtureAsset;
        const b = nextSong();
        // Parts splice sample-exactly: no overlap between them, the VT over a cut point.
        const parts = [
          { kind: 'song' as const, assetId: a.id, plannedDurationMs: a.durationMs },
          { kind: 'vt' as const, assetId: vt.id, plannedDurationMs: vt.durationMs },
          { kind: 'song' as const, assetId: b.id, plannedDurationMs: b.durationMs },
        ];
        const total = parts.reduce((n, p) => n + p.plannedDurationMs, 0);
        if (used + total + TRANSITION_MS > budget) continue;
        items.push({
          kind: 'segment',
          title: `Island: ${a.title} → ${vt.title} → ${b.title}`,
          parts,
          origin: { type: 'clock', clockId: null, slotIndex: slotIndex++ },
        });
        used += total;
        continue;
      }
      const s = songs[songIndex % songs.length] as FixtureAsset;
      if (used + slot(s, SONG_OVERLAP_MS) > budget) break;
      push(song(nextSong(), slotIndex++));
    }

    const remaining = budget - used;
    if (remaining > 0) {
      push({
        kind: 'fill',
        assetId: bed.id,
        title: 'Fill to the hour',
        plannedDurationMs: remaining,
        cueOverrides: {
          sampleRate: PLAYOUT_SAMPLE_RATE,
          cueIn: 0,
          cueOut: Math.round((remaining * PLAYOUT_SAMPLE_RATE) / 1000),
        },
        origin: { type: 'clock', clockId: null, slotIndex: slotIndex++ },
      });
    }
  }
  return items;
}
