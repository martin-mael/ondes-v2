import { randomUUID } from 'node:crypto';
import {
  type ContainerCreateBody,
  type ContainerInfo,
  type DockerClient,
  DockerError,
} from '../docker.ts';

/**
 * An in-memory Docker for lifecycle tests: containers are records, nothing runs. `failStart`
 * makes the next start fail with that message (a port conflict, a dead daemon).
 */
export type FakeContainer = {
  id: string;
  name: string;
  body: ContainerCreateBody;
  running: boolean;
  /** Started at least once (a never-started container is `created`). */
  started: boolean;
  restartCount: number;
};

export type FakeDocker = DockerClient & {
  containers: Map<string, FakeContainer>;
  failStart: string | null;
  /** Makes every call fail, as if the Docker proxy were down. */
  down: boolean;
  calls: string[];
  byName(name: string): FakeContainer | undefined;
};

export function createFakeDocker(): FakeDocker {
  const containers = new Map<string, FakeContainer>();
  const calls: string[] = [];
  const find = (nameOrId: string) =>
    containers.get(nameOrId) ?? [...containers.values()].find((c) => c.name === nameOrId);
  const info = (c: FakeContainer): ContainerInfo => ({
    Id: c.id,
    Name: `/${c.name}`,
    RestartCount: c.restartCount,
    State: {
      Status: c.running ? 'running' : c.started ? 'exited' : 'created',
      Running: c.running,
      Restarting: false,
      ExitCode: 0,
    },
    Config: { Labels: c.body.Labels ?? {} },
    HostConfig: { RestartPolicy: c.body.HostConfig.RestartPolicy ?? null },
    NetworkSettings: {
      Ports: Object.fromEntries(
        Object.entries(c.body.HostConfig.PortBindings ?? {}).map(([port, bindings]) => [
          port,
          bindings.map((b) => ({ HostIp: b.HostIp ?? '', HostPort: b.HostPort || '49000' })),
        ]),
      ),
    },
  });

  const fake: FakeDocker = {
    containers,
    calls,
    failStart: null,
    down: false,
    byName: (name) => [...containers.values()].find((c) => c.name === name),
    async ping() {},
    async inspect(nameOrId) {
      const c = find(nameOrId);
      return c ? info(c) : null;
    },
    async list(labels) {
      return [...containers.values()]
        .filter((c) =>
          labels.every((l) => {
            const [k, v] = l.split('=');
            return (
              k !== undefined &&
              (v === undefined ? k in (c.body.Labels ?? {}) : c.body.Labels?.[k] === v)
            );
          }),
        )
        .map((c) => ({
          Id: c.id,
          Names: [`/${c.name}`],
          State: c.running ? 'running' : 'exited',
          Labels: c.body.Labels ?? {},
        }));
    },
    async create(name, body) {
      calls.push(`create ${name}`);
      if (find(name)) throw new Error(`conflict: ${name} exists`);
      const id = randomUUID().replaceAll('-', '');
      containers.set(id, { id, name, body, running: false, started: false, restartCount: 0 });
      return id;
    },
    async start(id) {
      calls.push('start');
      if (fake.failStart) {
        const message = fake.failStart;
        fake.failStart = null;
        throw new DockerError(500, `POST /containers/${id}/start: ${message}`);
      }
      const c = find(id);
      if (c) {
        c.running = true;
        c.started = true;
      }
    },
    async stop(id) {
      calls.push('stop');
      const c = find(id);
      if (c) c.running = false;
    },
    async remove(id) {
      calls.push('remove');
      const c = find(id);
      if (c) containers.delete(c.id);
    },
    async setRestartPolicy(id, policy) {
      calls.push(`restart-policy ${policy?.Name}`);
      const c = find(id);
      if (c) c.body.HostConfig.RestartPolicy = policy;
    },
    async ensureImage() {},
  };
  // `down`: every Docker call fails, as when the proxy is unreachable.
  for (const key of Object.keys(fake) as (keyof FakeDocker)[]) {
    const value = fake[key];
    if (typeof value !== 'function' || key === 'byName') continue;
    const method = value as (...args: unknown[]) => Promise<unknown>;
    (fake as Record<string, unknown>)[key] = (...args: unknown[]) =>
      fake.down
        ? Promise.reject(new DockerError(502, 'docker proxy unreachable'))
        : method(...args);
  }
  return fake;
}
