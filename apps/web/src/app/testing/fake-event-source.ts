/** Stand-in for the browser's EventSource in tests. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  static last(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error('no EventSource opened');
    return source;
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  emit(data: unknown, id = '') {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId: id });
  }

  /** The server refused the stream: the browser gives up. */
  refuse() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
