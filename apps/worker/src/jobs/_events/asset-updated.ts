import { randomUUID } from 'node:crypto';
import { connectQueue, createEventPublisher } from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';

// `asset.updated` for the analysis jobs (#55): an asset's cues or loudness were stored, so
// the islands that play it re-derive. Not a job folder (`_` prefix): the registry skips it.

export type PublishEvent = (event: RealtimeEvent) => Promise<void>;

export function assetUpdatedEvent(
  stationId: string,
  assetId: string,
  changes: ('cues' | 'loudness')[],
): RealtimeEvent {
  return realtimeEventSchema.parse({
    id: randomUUID(),
    stationId,
    at: new Date().toISOString(),
    type: 'asset.updated',
    data: { assetId, changes },
  });
}

/** An event publisher from `RABBITMQ_URL`, or undefined without it (nothing is published). */
export async function eventPublisherFromEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<PublishEvent | undefined> {
  if (!env.RABBITMQ_URL) return undefined;
  const queue = await connectQueue(env.RABBITMQ_URL, { connectionName: name });
  const events = createEventPublisher(queue.rabbit, queue.topology, realtimeEventSchema);
  return (event) => events.publish(event);
}

/** Publishes after the store committed; a failed publish is logged, not retried as the job. */
export async function announce(
  publish: PublishEvent | undefined,
  event: RealtimeEvent,
  log?: (entry: Record<string, unknown>) => void,
) {
  if (!publish) return;
  try {
    await publish(event);
  } catch (error) {
    log?.({ level: 'error', msg: 'event publish failed', type: event.type, err: String(error) });
  }
}
