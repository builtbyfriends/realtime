import { EventSourceParserStream } from 'eventsource-parser/stream';

/**
 * An `EventSource` that can send headers, built on `fetch`.
 *
 * The browser's `EventSource` can't set an `Authorization` header, so it only works with cookie
 * sessions. This stand-in takes the same constructor shape and the same three events
 * (`open`, `message`, `error`), so it drops into bwf's `connectLiveStream` as `eventSource`.
 * It doesn't reconnect: bwf's client closes a failed source and opens a new one itself.
 */
export type FetchEventSourceOptions = {
  /** Headers for each stream request. Called every time a stream opens, so a token can be refreshed. */
  headers: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
};

type StreamEvent = { type: string; data?: string; error?: unknown };
type Listener = (event: StreamEvent) => void;

export type FetchEventSourceConstructor = new (
  url: string,
  init?: unknown,
) => {
  readonly url: string;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  close(): void;
};

export function fetchEventSource(options: FetchEventSourceOptions): FetchEventSourceConstructor {
  return class FetchEventSource {
    #listeners = new Map<string, Set<Listener>>();
    #abort = new AbortController();
    #closed = false;

    constructor(readonly url: string, _init?: unknown) {
      void this.#run();
    }

    addEventListener(type: string, listener: Listener) {
      let listeners = this.#listeners.get(type);
      if (!listeners) {
        listeners = new Set();
        this.#listeners.set(type, listeners);
      }
      listeners.add(listener);
    }

    removeEventListener(type: string, listener: Listener) {
      this.#listeners.get(type)?.delete(listener);
    }

    close() {
      this.#closed = true;
      this.#abort.abort();
    }

    #emit(type: string, event: { data?: string; error?: unknown } = {}) {
      if (this.#closed) {return;}
      // oxlint-disable-next-line unicorn/no-useless-spread -- a listener may remove itself while the loop runs, so it walks a copy
      for (const listener of [...(this.#listeners.get(type) ?? [])]) {listener({ type, ...event });}
    }

    async #run() {
      try {
        const headers = new Headers(typeof options.headers === 'function' ? await options.headers() : options.headers);
        headers.set('accept', 'text/event-stream');
        const response = await (options.fetch ?? fetch)(this.url, { headers, signal: this.#abort.signal, cache: 'no-store' });
        if (!response.ok || !response.body) {throw new Error(`live: stream answered ${response.status}`);}
        this.#emit('open');
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream())
          .getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {break;}
          this.#emit(value.event || 'message', { data: value.data });
        }
        this.#emit('error');
      } catch (error) {
        this.#emit('error', { error });
      }
    }
  };
}
