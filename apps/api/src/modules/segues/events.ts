import { randomUUID } from 'node:crypto';
import { islandUpdatedEvent, type StationScope } from '@ondes/db';
import {
  type RealtimeEvent,
  realtimeEventSchema,
  type SegueChange,
  type SegueStatus,
} from '@ondes/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { SyncResult } from './sync.ts';

export type EventSink = { publish(event: RealtimeEvent): Promise<void> };

type SegueEventData = {
  segueId: string;
  status: SegueStatus | null;
  problem: { code: string } | null;
  islandId: string | null;
  fromItemId: string | null;
  toItemId: string | null;
};

/**
 * The events of a committed write or sync: the written segue (`created`/`updated`/`deleted`),
 * then every segue the sync moved, every island to render and every island dropped.
 */
export function eventsOf(
  scope: StationScope,
  sync: SyncResult,
  written?: { change: SegueChange; segue: SegueEventData },
): RealtimeEvent[] {
  const at = new Date().toISOString();
  const envelope = () => ({ id: randomUUID(), stationId: scope.stationId, at });
  const segueEvent = (change: SegueChange, s: SegueEventData) =>
    realtimeEventSchema.parse({
      ...envelope(),
      type: 'segue.changed',
      data: {
        segueId: s.segueId,
        change,
        status: s.status,
        problem: s.problem?.code ?? null,
        islandId: s.islandId,
        fromItemId: s.fromItemId,
        toItemId: s.toItemId,
      },
    });
  const events: RealtimeEvent[] = [];
  if (written) events.push(segueEvent(written.change, written.segue));
  for (const s of sync.segues) {
    if (s.segueId !== written?.segue.segueId) events.push(segueEvent('synced', s));
  }
  for (const i of sync.islands) events.push(islandUpdatedEvent(i));
  for (const r of sync.removed) {
    events.push(
      realtimeEventSchema.parse({
        ...envelope(),
        type: 'island.removed',
        data: { islandId: r.id, hash: r.hash },
      }),
    );
  }
  return events;
}

/** Publishes after commit. A failed publish is only logged: the state is in the database. */
export async function publishAll(
  sink: EventSink | undefined,
  events: RealtimeEvent[],
  log: FastifyBaseLogger,
) {
  if (!sink) return;
  for (const event of events) {
    try {
      await sink.publish(event);
    } catch (error) {
      log.error({ err: error, type: event.type }, 'segue event publish failed');
    }
  }
}
