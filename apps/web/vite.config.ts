import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Dev: Vite proxies /api to the api (API_PORT from the repo's .env, default 3000), so the
// session cookie stays same-origin. VITE_API_PROXY overrides the target. Production serving
// (Caddy: static files + /api reverse proxy) is the installer's job (#84).
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, resolve(import.meta.dirname, '../..'), ''), ...process.env };
  const apiTarget = env.VITE_API_PROXY ?? `http://127.0.0.1:${env.API_PORT ?? 3000}`;
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': resolve(import.meta.dirname, './src') },
    },
    server: {
      port: 5173,
      // SSE included: http-proxy streams responses as they come.
      proxy: { '/api': { target: apiTarget } },
    },
  };
});
