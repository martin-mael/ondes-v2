import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JobDefinition } from '@ondes/queue';

/**
 * Job registry by convention: every `jobs/<job>/index.ts` default-exports a `defineJob(...)`
 * whose name is the folder name. Adding a job means adding a folder, never editing a shared
 * list, so parallel PRs don't conflict.
 */
export async function discoverJobs(jobsDir: string): Promise<JobDefinition[]> {
  const entries = await readdir(jobsDir, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const jobs: JobDefinition[] = [];
  for (const folder of folders) {
    const entry = join(jobsDir, folder, 'index.ts');
    const mod: { default?: unknown } = await import(pathToFileURL(entry).href);
    const job = mod.default;
    if (!isJobDefinition(job)) {
      throw new Error(`${entry} must default-export defineJob(...)`);
    }
    if (job.name !== folder) {
      throw new Error(`${entry} defines job "${job.name}"; it must match its folder "${folder}"`);
    }
    jobs.push(job);
  }
  return jobs;
}

function isJobDefinition(value: unknown): value is JobDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.handler === 'function' && !!v.schema;
}
