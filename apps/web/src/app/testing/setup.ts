import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { FakeEventSource } from './fake-event-source.ts';

// happy-dom has no EventSource; the fake lets tests drive the SSE stream.
vi.stubGlobal('EventSource', FakeEventSource);

// The sidebar and some primitives ask for media queries and observers happy-dom lacks.
if (!window.matchMedia) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances.length = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal('EventSource', FakeEventSource);
});
