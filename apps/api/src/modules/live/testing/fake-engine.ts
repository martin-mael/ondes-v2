import type { EngineState } from '@ondes/shared';

// An in-memory station engine with a pool of two harbor inputs (#64): who is connected where,
// the gate, and what Node asked. For the live switching tests (switching, live slots).

type Input = { connected: boolean; ready: boolean; streamer_id: string | null };

/** The engine side of the pool: who is connected where, the gate, what Node asked. */
export function fakeEngine() {
  const engine = {
    inputs: [
      { connected: false, ready: false, streamer_id: null },
      { connected: false, ready: false, streamer_id: null },
    ] as Input[],
    enabled: false,
    selected: null as number | null,
    sessionId: null as string | null,
    commands: [] as string[],
    connect(input: number, streamerId: string | null) {
      engine.inputs[input - 1] = { connected: true, ready: true, streamer_id: streamerId };
    },
    hangUp(input: number) {
      engine.inputs[input - 1] = { connected: false, ready: false, streamer_id: null };
    },
    onAir(): number | null {
      if (!engine.enabled || engine.selected === null) return null;
      return engine.inputs[engine.selected - 1]?.ready ? engine.selected : null;
    },
    async state(): Promise<EngineState> {
      return {
        boot_id: 'b1',
        station_id: 'x',
        version: '2.4.6',
        uptime: 1,
        seq: 1,
        on_air: {},
        queue: [],
        blank: false,
        output_db: null,
        live: {
          enabled: engine.enabled,
          connected: engine.inputs.some((i) => i.connected),
          ready: engine.inputs.some((i) => i.ready),
          selected: engine.selected,
          on_air: engine.onAir(),
          session_id: engine.sessionId,
          inputs: engine.inputs.map((i, n) => ({
            input: n + 1,
            mount: n === 0 ? 'live' : `live-${n + 1}`,
            ...i,
          })),
        },
      };
    },
    async setLive(enabled: boolean, options: { input?: number; sessionId?: string } = {}) {
      engine.commands.push(enabled ? `open ${options.input}` : 'close');
      if (enabled) {
        engine.selected = options.input ?? null;
        engine.sessionId = options.sessionId ?? null;
      }
      engine.enabled = enabled;
    },
    async disconnectLive(input: number) {
      engine.commands.push(`hang up ${input}`);
      const was = engine.inputs[input - 1]?.connected ?? false;
      engine.hangUp(input);
      return was;
    },
  };
  return engine;
}
