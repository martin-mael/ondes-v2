import { type StreamEvent, type StreamEventType, streamEventSchema } from '@ondes/shared';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { API_BASE, isApiError, request } from '../api/client.ts';
import { reportApiError } from '../errors.ts';

// Real-time events (#9): one EventSource per open station on
// `GET /api/v1/stations/:stationId/events` (apps/api/src/plugins/sse.ts), shared by every
// component through <SseProvider>. The browser reconnects on its own and sends
// `Last-Event-ID`; when the server refuses the stream (401/403/404) we read why and report it
// like any api error.

export type SseStatus = 'connecting' | 'open' | 'closed';
type Listener = (event: StreamEvent) => void;

export interface SseConnection {
  status(): SseStatus;
  subscribe(listener: Listener): () => void;
  onStatus(listener: () => void): () => void;
  /** Server time minus local time, in ms, from the last `server.clock` (0 before). */
  clockOffset(): number;
  close(): void;
}

/** Factory for tests. */
export type EventSourceFactory = (url: string) => EventSource;

const MAX_RETRY_MS = 30_000;

export function connectSse(
  stationId: string,
  createSource: EventSourceFactory = (url) => new EventSource(url, { withCredentials: true }),
): SseConnection {
  const url = `${API_BASE}/stations/${encodeURIComponent(stationId)}/events`;
  const listeners = new Set<Listener>();
  const statusListeners = new Set<() => void>();
  let status: SseStatus = 'connecting';
  let offset = 0;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let closed = false;
  /** Last event id seen, for reconnects we make ourselves (the browser's own send the header). */
  let lastEventId = '';

  const setStatus = (next: SseStatus) => {
    if (next === status) return;
    status = next;
    for (const listener of statusListeners) listener();
  };

  const open = () => {
    if (closed) return;
    setStatus('connecting');
    const es = createSource(
      lastEventId ? `${url}?lastEventId=${encodeURIComponent(lastEventId)}` : url,
    );
    source = es;
    es.onopen = () => {
      attempts = 0;
      setStatus('open');
    };
    es.onmessage = (message: MessageEvent<string>) => {
      if (message.lastEventId) lastEventId = message.lastEventId;
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = streamEventSchema.safeParse(data);
      // Events this build doesn't know yet (a newer api) are skipped, not fatal.
      if (!parsed.success) return;
      if (parsed.data.type === 'server.clock') offset = Date.parse(parsed.data.at) - Date.now();
      for (const listener of listeners) listener(parsed.data);
    };
    es.onerror = () => {
      // CONNECTING: the browser retries by itself. CLOSED: it gave up (non-200 answer).
      if (es.readyState !== EventSource.CLOSED) {
        setStatus('connecting');
        return;
      }
      es.close();
      setStatus('closed');
      void diagnose().then((fatal) => {
        if (fatal || closed) return;
        const delay = Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempts++);
        retryTimer = setTimeout(open, delay);
      });
    };
  };

  /**
   * Asks the api why the stream was refused, through the stream's access check (which opens
   * no stream). True when retrying won't help.
   */
  const diagnose = async (): Promise<boolean> => {
    try {
      await request(`/stations/${encodeURIComponent(stationId)}/events/access`);
      return false;
    } catch (error) {
      if (!isApiError(error) || error.status === 0) return false;
      reportApiError(error);
      return error.status === 401 || error.status === 403 || error.status === 404;
    }
  };

  open();
  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    clockOffset: () => offset,
    close() {
      closed = true;
      clearTimeout(retryTimer);
      source?.close();
      listeners.clear();
      statusListeners.clear();
    },
  };
}

const SseContext = createContext<SseConnection | null>(null);

/** Opens the station's stream for everything below. Remount (key) it to switch station. */
export function SseProvider({
  stationId,
  children,
  createSource,
}: {
  stationId: string;
  children: ReactNode;
  createSource?: EventSourceFactory;
}) {
  const [connection, setConnection] = useState<SseConnection | null>(null);
  useEffect(() => {
    const next = connectSse(stationId, createSource);
    setConnection(next);
    return () => next.close();
  }, [stationId, createSource]);
  return <SseContext.Provider value={connection}>{children}</SseContext.Provider>;
}

function useConnection(): SseConnection | null {
  return useContext(SseContext);
}

/** Calls `listener` for every event of the open station. */
export function useSse(listener: Listener): void {
  const connection = useConnection();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => connection?.subscribe((event) => ref.current(event)), [connection]);
}

/** Calls `listener` for one event type, typed by the shared contract. */
export function useSseEvent<T extends StreamEventType>(
  type: T,
  listener: (event: Extract<StreamEvent, { type: T }>) => void,
): void {
  useSse((event) => {
    if (event.type === type) listener(event as Extract<StreamEvent, { type: T }>);
  });
}

export function useSseStatus(): SseStatus {
  const connection = useConnection();
  return useSyncExternalStore(
    (onChange) => connection?.onStatus(onChange) ?? (() => {}),
    () => connection?.status() ?? 'connecting',
  );
}

/**
 * The api's clock, ticking every second: local time corrected by the offset of the last
 * `server.clock` event. `null` until the first one arrives.
 */
export function useServerClock(): Date | null {
  const connection = useConnection();
  const [syncedWith, setSyncedWith] = useState<SseConnection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useSseEvent('server.clock', () => setSyncedWith(connection));
  const synced = connection !== null && syncedWith === connection;
  useEffect(() => {
    if (!synced) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [synced]);
  if (!synced) return null;
  return new Date(now + connection.clockOffset());
}
