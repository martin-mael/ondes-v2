import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JobDefinition, JobPublisher } from '@ondes/queue';
import type { RealtimeEvent } from '@ondes/shared';

/**
 * Job registry by convention: every `jobs/<job>/index.ts` default-exports a `defineJob(...)`
 * whose name is the folder name. Adding a job means adding a folder, never editing a shared
 * list, so parallel PRs don't conflict.
 */
export async function discoverJobs(jobsDir: string): Promise<JobDefinition[]> {
  return (await loadJobModules(jobsDir)).map((m) => m.job);
}

/**
 * Turns events into jobs: e.g. `asset.ingested` → a `loudness` job. A job folder declares its
 * own as `export const triggers: JobTrigger[]` next to its default export; the worker runs
 * each on a durable event queue (`consumeEventsDurable`, ADR 0006 "Event transport"), so an
 * event is handled once across worker replicas and isn't lost while the worker is down.
 * Delivery is at least once: enqueue with an explicit idempotency key.
 */
export interface JobTrigger {
  /** Durable event queue name, unique across triggers, e.g. `worker.loudness`. */
  queue: string;
  /** Enqueues the jobs an event calls for; ignores the events it doesn't care about. */
  onEvent(event: RealtimeEvent, jobs: JobPublisher): Promise<void>;
}

/** The triggers of every job folder (see {@link JobTrigger}). */
export async function discoverTriggers(jobsDir: string): Promise<JobTrigger[]> {
  const triggers = (await loadJobModules(jobsDir)).flatMap((m) => m.triggers);
  const queues = new Set<string>();
  for (const trigger of triggers) {
    if (queues.has(trigger.queue)) throw new Error(`Duplicate trigger queue "${trigger.queue}"`);
    queues.add(trigger.queue);
  }
  return triggers;
}

async function loadJobModules(
  jobsDir: string,
): Promise<{ job: JobDefinition; triggers: JobTrigger[] }[]> {
  const entries = await readdir(jobsDir, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const modules: { job: JobDefinition; triggers: JobTrigger[] }[] = [];
  for (const folder of folders) {
    const entry = join(jobsDir, folder, 'index.ts');
    const mod: { default?: unknown; triggers?: unknown } = await import(pathToFileURL(entry).href);
    const job = mod.default;
    if (!isJobDefinition(job)) {
      throw new Error(`${entry} must default-export defineJob(...)`);
    }
    if (job.name !== folder) {
      throw new Error(`${entry} defines job "${job.name}"; it must match its folder "${folder}"`);
    }
    const triggers = mod.triggers ?? [];
    if (!Array.isArray(triggers) || !triggers.every(isJobTrigger)) {
      throw new Error(`${entry}: \`triggers\` must be an array of { queue, onEvent }`);
    }
    modules.push({ job, triggers });
  }
  return modules;
}

function isJobDefinition(value: unknown): value is JobDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.handler === 'function' && !!v.schema;
}

function isJobTrigger(value: unknown): value is JobTrigger {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.queue === 'string' && typeof v.onEvent === 'function';
}
