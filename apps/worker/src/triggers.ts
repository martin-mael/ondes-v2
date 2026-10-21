import {
  consumeEventsDurable,
  type EventSubscription,
  type JobPublisher,
  type QueueConnection,
} from '@ondes/queue';
import { realtimeEventSchema } from '@ondes/shared';
import type { JobTrigger } from './registry.ts';

/**
 * Runs each job trigger on its own durable event queue (ADR 0006 "Event transport"): one worker
 * replica at a time handles an event, in order per station, and events published while no
 * worker runs wait in the queue. Returns the consumers, to await `ready` and close them.
 */
export function startJobTriggers(
  queue: Pick<QueueConnection, 'rabbit' | 'topology'>,
  triggers: readonly JobTrigger[],
  jobs: JobPublisher,
  log: (entry: Record<string, unknown>) => void = (entry) => console.error(JSON.stringify(entry)),
): EventSubscription[] {
  return triggers.map((trigger) =>
    consumeEventsDurable(
      queue.rabbit,
      queue.topology,
      trigger.queue,
      realtimeEventSchema,
      (event) => trigger.onEvent(event, jobs),
      {
        keyOf: (event) => event.stationId,
        onError: (err, event) => {
          // Events this worker's contracts don't know (a newer api) are skipped, not errors.
          if (!event) return;
          log({
            level: 'error',
            msg: 'job trigger failed',
            queue: trigger.queue,
            type: event.type,
            err: String(err),
          });
        },
      },
    ),
  );
}
