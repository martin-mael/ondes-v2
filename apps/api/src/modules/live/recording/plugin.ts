import { randomUUID } from 'node:crypto';
import {
  attachLiveRecording,
  episode,
  getEpisodeLiveRecording,
  getLiveRecordingSettings,
  type LiveRecordingRow,
  LiveRecordingStateError,
  listLiveRecordingParts,
  requestLiveRecordingRebuild,
  type StationScope,
  toLiveRecording,
  updateLiveRecordingSettings,
  whereStation,
} from '@ondes/db';
import { consumeEventsDurable, type EventSubscription } from '@ondes/queue';
import {
  episodeLiveRecordingSchema,
  liveRecordingSchema,
  liveRecordingSettingsSchema,
  type RealtimeEvent,
  realtimeEventSchema,
  updateLiveRecordingSettingsSchema,
  uuidSchema,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, stationScopeOf } from '../../../plugins/auth.ts';
import { HttpError } from '../../../plugins/errors.ts';
import { createLiveRecordingRecorder, recordingUpdatedEvent } from './recorder.ts';

// Live recording (#67, ADR 0039), under /api/v1/stations/:stationId:
// - `GET  …/live/recording/settings` (`live:read`), `PUT` (`live:manage`, audited);
// - `GET  …/shows/:showId/episodes/:episodeId/recording` (`show:read`): the episode's
//   recording, its parts and status, or null;
// - `POST …/live/recordings/:recordingId/rebuild` (`live:manage`, audited): build it again
//   (after a failure, or to redo a ready one); 409 while it records or builds, or once expired;
// - `POST …/live/recordings/:recordingId/attach` (`live:manage`, audited): make a ready
//   recording its episode's audio, over the other audio a build found there and left alone.
// With RabbitMQ, it also records the engine's `live.recording.*` events from the durable
// `live-recording` queue (recorder.ts).

/** Name of the durable event queue the recorder reads (ADR 0006). */
export const LIVE_RECORDING_EVENT_QUEUE = 'live-recording';

export type LiveRecordingPluginOptions = {
  /** Durable queue name (tests use their own). Default `live-recording`. */
  eventQueue?: string;
};

const stationParams = z.object({ stationId: z.string() });
const episodeParams = stationParams.extend({ showId: uuidSchema, episodeId: uuidSchema });
const recordingParams = stationParams.extend({ recordingId: uuidSchema });

export const liveRecordingPlugin = fp(
  async (app: FastifyInstance, options: LiveRecordingPluginOptions) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const liveRead = app.requirePermission('live', 'read');
    const liveManage = app.requirePermission('live', 'manage');
    const showRead = app.requirePermission('show', 'read');
    const rabbit = app.hasDecorator('rabbit') ? app.rabbit : undefined;
    const publish = rabbit
      ? (event: RealtimeEvent) => rabbit.events.publish(event)
      : async (_event: RealtimeEvent) => {};
    const ctx = (request: FastifyRequest) => ({
      actor: actorOf(request),
      scope: stationScopeOf(request),
    });

    r.get(
      '/api/v1/stations/:stationId/live/recording/settings',
      {
        preHandler: liveRead,
        schema: { params: stationParams, response: { 200: liveRecordingSettingsSchema } },
      },
      (request) => getLiveRecordingSettings(app.db, stationScopeOf(request)),
    );

    r.put(
      '/api/v1/stations/:stationId/live/recording/settings',
      {
        preHandler: liveManage,
        schema: {
          params: stationParams,
          body: updateLiveRecordingSettingsSchema,
          response: { 200: liveRecordingSettingsSchema },
        },
      },
      (request) => updateLiveRecordingSettings(app.db, ctx(request), request.body),
    );

    r.get(
      '/api/v1/stations/:stationId/shows/:showId/episodes/:episodeId/recording',
      {
        preHandler: showRead,
        schema: { params: episodeParams, response: { 200: episodeLiveRecordingSchema } },
      },
      async (request) => {
        const scope = stationScopeOf(request);
        const recording = await getEpisodeLiveRecording(app.db, scope, request.params.episodeId);
        // Another show's episode id in the path reads as no recording, like a missing one.
        const ownShow =
          recording && (await showOf(scope, request.params.episodeId)) === request.params.showId;
        return { recording: ownShow ? recording : null };
      },
    );

    r.post(
      '/api/v1/stations/:stationId/live/recordings/:recordingId/rebuild',
      {
        preHandler: liveManage,
        schema: { params: recordingParams, response: { 202: liveRecordingSchema } },
      },
      async (request, reply) => {
        const row = await stateChecked(() =>
          requestLiveRecordingRebuild(app.db, ctx(request), request.params.recordingId),
        );
        await publish(recordingUpdatedEvent(randomUUID(), new Date().toISOString(), row));
        return reply.code(202).send(await dto(stationScopeOf(request), row));
      },
    );

    r.post(
      '/api/v1/stations/:stationId/live/recordings/:recordingId/attach',
      {
        preHandler: liveManage,
        schema: { params: recordingParams, response: { 200: liveRecordingSchema } },
      },
      async (request) => {
        const row = await stateChecked(() =>
          attachLiveRecording(app.db, ctx(request), request.params.recordingId),
        );
        await publish(recordingUpdatedEvent(randomUUID(), new Date().toISOString(), row));
        return dto(stationScopeOf(request), row);
      },
    );

    async function stateChecked(fn: () => Promise<LiveRecordingRow>) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof LiveRecordingStateError) {
          throw new HttpError(409, 'live_recording_state', err.message, { status: err.status });
        }
        throw err;
      }
    }

    async function dto(scope: StationScope, row: LiveRecordingRow) {
      const parts = await listLiveRecordingParts(app.db, scope, row.id);
      const settings = await getLiveRecordingSettings(app.db, scope);
      return toLiveRecording(row, parts, settings);
    }

    async function showOf(scope: StationScope, episodeId: string): Promise<string | null> {
      const [row] = await app.db
        .select({ showId: episode.showId })
        .from(episode)
        .where(and(eq(episode.id, episodeId), whereStation(episode, scope)));
      return row?.showId ?? null;
    }

    if (!rabbit) return;
    const recorder = createLiveRecordingRecorder({ db: app.db, publish, logger: app.log });
    let consumer: EventSubscription | undefined;
    app.addHook('onReady', async () => {
      const { rabbit: connection, topology } = rabbit.queue;
      consumer = consumeEventsDurable(
        connection,
        topology,
        options.eventQueue ?? LIVE_RECORDING_EVENT_QUEUE,
        realtimeEventSchema,
        (event) => recorder.handle(event),
        {
          keyOf: (event: RealtimeEvent) => event.stationId,
          onError: (error, event) => {
            if (!event) app.log.debug({ err: error }, 'Live recording consumer skipped a message');
            else app.log.error({ err: error, type: event.type }, 'Live recording failed');
          },
        },
      );
      await consumer.ready;
    });
    app.addHook('onClose', async () => {
      await consumer?.close();
    });
  },
  { name: 'live-recording', dependencies: ['db', 'auth'] },
);
