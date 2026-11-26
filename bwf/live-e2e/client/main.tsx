import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { connectLiveStream } from '@builtbyfriends/bwf/live/client';
import { bwfTransport } from '@builtbyfriends/realtime-bwf/live';
import type { RecordsClient } from '@builtbyfriends/realtime-live/records';
import { RecordsProvider, eq, useLiveQuery, useRecords } from '@builtbyfriends/realtime-live/records/react';
import { noteRecords } from '../../../typescript/packages/live/test/fixtures/notes';

const client: RecordsClient = {
  async call(name, input) {
    const res = await fetch('/call', { method: 'POST', headers: { authorization: 'Bearer ok', 'content-type': 'application/json' }, body: JSON.stringify({ name, input }) });
    // Decision: /call answers with the shape below; the harness has no schema for it.
    const body = (await res.json()) as { ok: boolean; value?: unknown; code?: string; message?: string; status?: number };

    if (body.ok) {return body.value;}

    throw Object.assign(new Error(body.message), { code: body.code, status: body.status });
  },
};

const errors: Array<string> = [];
const events: Array<unknown> = [];
const refusals: Array<{ name: string; topic: string; code: string | undefined; message: string }> = [];
const inner = bwfTransport({ connect: connectLiveStream, url: '/live', retryDelay: 200, onError: (error) => void errors.push(String(error)) });

const transport: typeof inner = {
  subscribe: (topic, onEvent, onRefused) =>
    inner.subscribe(
      topic,
      (event) => {
        events.push(event);
        onEvent(event);
      },
      onRefused,
    ),
  onReconnect: (callback) => inner.onReconnect(callback),
};

function One(props: { id: string }) {
  const { collections } = useRecords(noteRecords);
  const found = useLiveQuery({ query: (q) => q.from({ n: collections.Note }).where(({ n }) => eq(n.id, props.id)) });

  return <div data-view="one" data-id={props.id}>{found.data[0]?.title ?? ''}</div>;
}

function List(props: { boardId: string }) {
  const { collections } = useRecords(noteRecords);
  const found = useLiveQuery({ query: (q) => q.from({ n: collections.Note }).where(({ n }) => eq(n.boardId, props.boardId)) });

  return <div data-view="list" data-count={found.data.length}>{found.data.map((n) => `${n.id}=${n.title}`).join('|')}</div>;
}

let rename: ((id: string, title: string) => Promise<{ ok: boolean }>) | undefined;

function Expose() {
  const found = useRecords(noteRecords);

  useEffect(() => {
    rename = (id, title) => found.commands.rename({ id, title }).result;
  }, [found]);

  return null;
}

function App(props: { ids: ReadonlyArray<string>; list: boolean }) {
  return (
    <RecordsProvider
      client={client}
      transport={transport}
      onRefused={({ name, topic, error }) => void refusals.push({ name, topic, code: 'code' in error ? String(error.code) : undefined, message: error.message })}
    >
      <Expose />
      {props.list ? <List boardId="b-1" /> : null}
      {props.ids.map((id, i) => (
        <One key={`${id}-${i}`} id={id} />
      ))}
    </RecordsProvider>
  );
}

let root: Root | undefined;

const harness = {
  mount(ids: Array<string>, list = false) {
    // Decision: the page the backend serves holds a #root.
    root ??= createRoot(document.getElementById('root') as HTMLElement);
    root.render(<App ids={ids} list={list} />);
  },
  unmount() {
    root?.unmount();
    root = undefined;
  },
  titles: () => Object.fromEntries([...document.querySelectorAll('[data-view="one"]')].map((el, i) => [`${el.getAttribute('data-id')}#${i}`, el.textContent])),
  list: () => document.querySelector('[data-view="list"]')?.textContent ?? null,
  rename: (id: string, title: string) => rename?.(id, title),
  errors,
  events,
  refusals,
};

Object.assign(window, { harness });
