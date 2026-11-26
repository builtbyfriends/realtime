import type { LiveTransport } from '@builtbyfriends/realtime-live';
export { fetchEventSource, type FetchEventSourceConstructor, type FetchEventSourceOptions } from './fetch-event-source.js';
import { fetchEventSource } from './fetch-event-source.js';

/** The part of bwf's `@builtbyfriends/bwf/live/client` this adapter uses. Pass `connectLiveStream` itself. */
export type ConnectLiveStream = (
  url: string | URL,
  options?: {
    withCredentials?: boolean;
    keepOpen?: boolean;
    retryDelay?: number;
    headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
    fetch?: typeof fetch;
    // oxlint-disable-next-line typescript/no-explicit-any -- stands in for the host's own EventSource type, which this package can't import
    eventSource?: new (url: string, init?: { withCredentials?: boolean }) => any;
    onError?: (error: unknown) => void;
  },
) => {
  subscribe(options: {
    id: string;
    topic: string;
    onEvent?: (event: unknown) => void;
    onRevoked?: (event: { subscriptionId: string; topic: string; reason?: string }) => void;
  }): Promise<() => Promise<void>>;
  close(): void;
};

type StreamSource = { addEventListener(type: string, listener: () => void): void };
type StreamSourceConstructor = new (url: string, init?: { withCredentials?: boolean }) => StreamSource;

type Envelope = { subscriptionId: string; topic?: string; type?: string; data?: unknown };

function isEnvelope(event: unknown): event is Envelope {
  return typeof event === 'object' && event !== null && 'subscriptionId' in event && 'data' in event;
}

function isPublished(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'payload' in data &&
    (('name' in data && typeof data.name === 'string') || ('event' in data && typeof data.event === 'string'))
  );
}

// Decision: bwf wraps what a module publishes in an envelope ({ subscriptionId, topic, type, data }), and records want
// what was published: a module event, or, when a publisher sent only the payload, the envelope's type as the event
// name. Anything that isn't an envelope passes as it is.
function unwrap(event: unknown): unknown {
  if (!isEnvelope(event)) {return event;}

  const { data, type, topic } = event;

  if (isPublished(data)) {return data;}

  if (typeof data !== 'object' || data === null) {return event;}

  return typeof type === 'string' ? { name: type, topic, payload: data } : event;
}

export type BwfTransportOptions = {
  /** `connectLiveStream` from `@builtbyfriends/bwf/live/client`. */
  connect: ConnectLiveStream;
  /** The route that exports `live.connect` and `live.control`. Default "/live". */
  url?: string;
  /** Default true, so the session cookie rides along. */
  withCredentials?: boolean;
  retryDelay?: number;
  /**
   * Headers for the stream and for its subscribe requests, for apps that sign in with a bearer
   * token (`{ authorization: 'Bearer …' }`) instead of a cookie. Pass a function to read a fresh
   * token each time. Setting this swaps the browser's `EventSource`, which can't send headers,
   * for a `fetch` based one, and turns off `withCredentials` unless you set it.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** The `fetch` to use with `headers`. Defaults to the global one. */
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
};

/**
 * A `LiveTransport` over bwf's SSE live stream. One connection serves every query.
 *
 * bwf delivers at most once and replays nothing, so a reconnect is how this learns it may
 * have missed events: the stream is kept open (`keepOpen`), and every `open` after the first
 * is reported to the store, which refetches the queries being watched.
 */
export function bwfTransport(options: BwfTransportOptions): LiveTransport {
  const reconnects = new Set<(event?: unknown) => void>();
  let stream: ReturnType<ConnectLiveStream> | undefined;
  let opens = 0;

  function open() {
    if (stream) {return stream;}
    const Native: StreamSourceConstructor | undefined = options.headers
      ? fetchEventSource({ headers: options.headers, fetch: options.fetch })
      : globalThis.EventSource;
    if (!Native) {throw new Error('EventSource is not available here; live queries need a browser (or a polyfill)');}
    // Decision: bwf opens a fresh EventSource for each reconnect, so count `open` events across all of them.
    class Watching extends Native {
      constructor(url: string, init?: { withCredentials?: boolean }) {
        super(url, init);
        this.addEventListener('open', () => {
          if (++opens > 1) {
            // oxlint-disable-next-line unicorn/no-useless-spread -- a callback may unsubscribe while the loop runs, so it walks a copy
            for (const cb of [...reconnects]) {cb();}
          }
        });
      }
    }
    stream = options.connect(options.url ?? '/live', {
      withCredentials: options.withCredentials ?? !options.headers,
      headers: options.headers,
      fetch: options.fetch,
      keepOpen: true,
      retryDelay: options.retryDelay,
      eventSource: Watching,
      onError: options.onError,
    });
    return stream;
  }

  type Entry = {
    listeners: Set<(event?: unknown) => void>;
    refusals: Set<(error: Error) => void>;
    stop: Promise<() => Promise<void>>;
    renewing: boolean;
  };

  /**
   * One bwf subscription per topic, shared by every query listening to it. bwf allows a limited
   * number of subscriptions per topic and per connection (256 by default), and a page often has
   * many queries on the same topic, so one subscription each would run out.
   */
  const topics = new Map<string, Entry>();

  const unsubscribing = new Map<string, Promise<void>>();

  function release(topic: string, entry: Entry) {
    if (entry.listeners.size || topics.get(topic) !== entry) {return;}
    topics.delete(topic);
    const done = entry.stop.then((stop) => stop()).catch(() => {});
    unsubscribing.set(topic, done);
    void done.then(() => {
      if (unsubscribing.get(topic) === done) {unsubscribing.delete(topic);}
    });
  }

  function ask(topic: string, entry: Entry) {
    return open().subscribe({
      id: topic,
      topic,
      onEvent: (event) => {
        // oxlint-disable-next-line unicorn/no-useless-spread -- listeners may unsubscribe while being called
        for (const listener of [...entry.listeners]) {listener(unwrap(event));}
      },
      onRevoked: () => renew(topic, entry),
    });
  }

  let renewals = 0;
  let renewed = false;

  // Decision: when the app ends a subscription (bwf's `stream.revoke`), the helper doesn't send it again, and bwf's answer to
  // a new subscribe is what says whether the person still has access. So this asks once. If it's accepted, the events published
  // in between are lost, so the queries load again, once after all the renewals that were running. If it's refused, the
  // listeners are told once and the topic is dropped, and nothing asks again until a listener subscribes to it anew.
  function renew(topic: string, entry: Entry) {
    if (topics.get(topic) !== entry || entry.renewing) {return;}

    entry.renewing = true;
    renewals += 1;
    const next = ask(topic, entry);
    entry.stop = next;

    void next
      .then(
        () => {
          renewed = true;
        },
        (error: unknown) => {
          if (topics.get(topic) === entry) {topics.delete(topic);}

          // oxlint-disable-next-line unicorn/no-useless-spread -- a callback may stop listening while the loop runs
          for (const refused of [...entry.refusals]) {refused(error instanceof Error ? error : new Error(String(error)));}
        },
      )
      .finally(() => {
        entry.renewing = false;
        renewals -= 1;

        if (renewals === 0 && renewed) {
          renewed = false;

          // oxlint-disable-next-line unicorn/no-useless-spread -- a callback may unsubscribe while the loop runs
          for (const cb of [...reconnects]) {cb();}
        }
      });
  }

  return {
    async subscribe(topic, onEvent, onRefused) {
      let entry = topics.get(topic);

      if (!entry) {
        const made: Entry = { listeners: new Set(), refusals: new Set(), stop: Promise.resolve(async () => {}), renewing: false };
        // Decision: a subscribe with a used id replaces it on the server, so wait for the queued unsubscribe of this topic first.
        const pending = unsubscribing.get(topic);
        const stop = pending ? pending.then(() => ask(topic, made)) : ask(topic, made);
        made.stop = stop;
        entry = made;
        topics.set(topic, made);

        stop.catch(() => {
          if (topics.get(topic) === made) {topics.delete(topic);}
        });
      }

      const listener = (event?: unknown) => onEvent(event);
      entry.listeners.add(listener);

      if (onRefused) {entry.refusals.add(onRefused);}

      try {
        await entry.stop;
      } catch (error) {
        entry.listeners.delete(listener);

        if (onRefused) {entry.refusals.delete(onRefused);}

        throw error;
      }

      const current = entry;

      return () => {
        current.listeners.delete(listener);

        if (onRefused) {current.refusals.delete(onRefused);}

        release(topic, current);
      };
    },
    onReconnect(callback) {
      reconnects.add(callback);
      return () => void reconnects.delete(callback);
    },
  };
}
