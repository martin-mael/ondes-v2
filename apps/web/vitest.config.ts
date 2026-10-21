import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Web tests run in happy-dom with the app's Vite config (aliases, React). The root
// vitest.config.ts lists this file as a project, so `pnpm test` runs them with the rest.
export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      name: 'web',
      environment: 'happy-dom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/app/testing/setup.ts'],
    },
  }),
);
