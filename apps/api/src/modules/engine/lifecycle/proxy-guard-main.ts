import { createProxyGuard, proxyGuardOptionsFromEnv } from './proxy-guard.ts';

// Docker proxy guard entry point: `node proxy-guard-main.ts` (see proxy-guard.ts and
// deploy/engine/docker-socket-proxy.compose.yml).

const options = proxyGuardOptionsFromEnv(process.env);
const server = createProxyGuard({ ...options, log: (message) => console.warn(message) });
server.listen(options.port, '0.0.0.0', () => {
  console.log(`docker proxy guard on :${options.port} -> ${options.upstream}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
