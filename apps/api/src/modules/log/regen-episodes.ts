import { randomUUID } from 'node:crypto';
import { attachEpisodeAudio, type Db, logDay, type StationScope, whereStation } from '@ondes/db';
import { type Actor, realtimeEventSchema } from '@ondes/shared';
import { and, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { LogEventSink } from './routes.ts';

// Late episode audio (ADR 0026's follow-up, wired by #101): when an episode gets its asset,
// the empty items the generator planned for it that haven't started take it
// (`attachEpisodeAudio`, which retimes their days), and `log.updated` says so.
//
// Runs after the episode update committed. A failure here doesn't fail the update: it's
// logged, and the regeneration the episode change sets off (its audit row, ADR 0030) plans the
// audio in anyway.

export async function attachEpisodeAudioAndAnnounce(
  deps: { db: Db; sink: LogEventSink | undefined; log: FastifyBaseLogger },
  ctx: { actor: Actor; scope: StationScope },
  episodeId: string,
): Promise<void> {
  try {
    await attachAndAnnounce(deps, ctx, episodeId);
  } catch (err) {
    deps.log.error({ err, episodeId }, 'attaching late episode audio failed');
  }
}

async function attachAndAnnounce(
  deps: { db: Db; sink: LogEventSink | undefined; log: FastifyBaseLogger },
  ctx: { actor: Actor; scope: StationScope },
  episodeId: string,
): Promise<void> {
  const days = await attachEpisodeAudio(deps.db, ctx, episodeId);
  if (days.length === 0 || !deps.sink) return;
  const bounds = await deps.db
    .select({ startsAt: logDay.startsAt, endsAt: logDay.endsAt })
    .from(logDay)
    .where(
      and(
        whereStation(logDay, ctx.scope),
        inArray(
          logDay.id,
          days.map((d) => d.logDayId),
        ),
      ),
    );
  if (bounds.length === 0) return;
  const from = Math.min(...bounds.map((b) => b.startsAt.getTime()));
  const to = Math.max(...bounds.map((b) => b.endsAt.getTime()));
  try {
    await deps.sink.publish(
      realtimeEventSchema.parse({
        id: randomUUID(),
        stationId: ctx.scope.stationId,
        at: new Date().toISOString(),
        type: 'log.updated',
        data: {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          days,
          cause: 'edit',
        },
      }),
    );
  } catch (err) {
    deps.log.error({ err, episodeId }, 'log event publish failed');
  }
}
