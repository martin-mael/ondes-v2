import { randomUUID } from 'node:crypto';
import type { ContainerCreateBody, ContainerInfo, DockerClient } from '../docker.ts';

/** An in-memory Docker for lifecycle tests: containers are records, nothing runs. */
export type FakeContainer = {
  id: string;
  name: string;
  body: ContainerCreateBody;
  running: boolean;
  restartCount: number;
  archives: { path: string; size: number }[];
};

export type FakeDocker = DockerClient & {
  containers: Map<string, FakeContainer>;
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
      Status: c.running ? 'running' : 'exited',
      Running: c.running,
      Restarting: false,
      ExitCode: 0,
    },
    Config: { Labels: c.body.Labels ?? {} },
    NetworkSettings: {
      Ports: Object.fromEntries(
        Object.entries(c.body.HostConfig.PortBindings ?? {}).map(([port, bindings]) => [
          port,
          bindings.map((b) => ({ HostIp: b.HostIp ?? '', HostPort: b.HostPort || '49000' })),
        ]),
      ),
    },
  });

  return {
    containers,
    calls,
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
      containers.set(id, { id, name, body, running: false, restartCount: 0, archives: [] });
      return id;
    },
    async putArchive(id, path, tar) {
      calls.push(`archive ${path}`);
      find(id)?.archives.push({ path, size: tar.length });
    },
    async start(id) {
      calls.push('start');
      const c = find(id);
      if (c) c.running = true;
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
}
