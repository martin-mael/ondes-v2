import {
  type Db,
  episodeCheckSlots,
  episodeCheckState,
  episodeCheckStations,
  type NewEpisodeCheck,
  recordEpisodeChecks,
  type StationScope,
} from '@ondes/db';
import { expandSlots, type SlotException } from '@ondes/scheduling';
import { addDays, type EpisodeCheckStep, localDateOf } from '@ondes/shared';
import { CHECK_HORIZON_MS, dueSteps } from './plan.ts';

// One pass of the missing-episode check over a station (#47, ADR 0022): expand its
// pre-recorded slots over the next 48 h in the station's time zone, find the occurrences whose
// premiere has no audio, and record the steps that are due in `episode_check`. Recording is
// idempotent (unique per occurrence and step); the api does the rest (alerts, emails, the
// fallback). Live slots need no file, and reruns (#48) air an episode that already has one.

/** A margin past the horizon, so an occurrence is seen on the pass before its 48 h step. */
const MARGIN_MS = 10 * 60 * 1000;

export type RecordedStep = { slotId: string; occurrenceDate: string; step: EpisodeCheckStep };
export type CheckReport = { occurrences: number; recorded: RecordedStep[] };

export async function runEpisodeCheck(
  db: Db,
  scope: StationScope,
  now = new Date(),
): Promise<CheckReport> {
  const range = { from: now, to: new Date(now.getTime() + CHECK_HORIZON_MS + MARGIN_MS) };
  // Slot rows that can reach the range (a moved occurrence lands at most 7 days away).
  const inputs = await episodeCheckSlots(db, scope, (timezone) => ({
    first: addDays(localDateOf(range.from, timezone), -9),
    last: addDays(localDateOf(range.to, timezone), 8),
  }));
  if (!inputs?.slots.length) return { occurrences: 0, recorded: [] };
  const occurrences = expandSlots(
    inputs.slots.map((slot) => ({
      ...slot,
      exceptions: slot.exceptions.map(
        (e): SlotException =>
          e.kind === 'cancelled'
            ? { date: e.date, kind: 'cancelled' }
            : {
                date: e.date,
                kind: 'moved',
                startDate: e.startDate ?? e.date,
                startTime: e.startTime ?? '00:00',
                durationMs: e.durationMs,
              },
      ),
    })),
    range,
    inputs.timezone,
  );
  if (!occurrences.length) return { occurrences: 0, recorded: [] };

  const { premieres, recorded } = await episodeCheckState(
    db,
    scope,
    [...new Set(occurrences.map((o) => o.slot.id))],
    [...new Set(occurrences.map((o) => o.date))],
  );
  const rows: NewEpisodeCheck[] = [];
  for (const o of occurrences) {
    const key = `${o.slot.id}:${o.date}`;
    const premiere = premieres.get(key);
    const occurrence = {
      slotId: o.slot.id,
      date: o.date,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      hasAudio: premiere?.hasAudio ?? false,
    };
    for (const step of dueSteps(occurrence, now, recorded.get(key))) {
      rows.push({
        showId: o.slot.showId,
        slotId: o.slot.id,
        occurrenceDate: o.date,
        step,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        episodeId: premiere?.episodeId ?? null,
      });
    }
  }
  return { occurrences: occurrences.length, recorded: await recordEpisodeChecks(db, scope, rows) };
}

/** Stations with a pre-recorded slot that may still air: the sweep enqueues a pass for each. */
export function listCheckedStations(db: Db, now = new Date()) {
  // `ends_on` is a local date; a day of slack covers every time zone.
  return episodeCheckStations(db, addDays(now.toISOString().slice(0, 10), -1));
}
