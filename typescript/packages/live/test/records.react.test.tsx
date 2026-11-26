// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordsProvider, eq, useLiveQuery, useRecords, useView } from '../src/records-react.js';
import { noteRecords, notesWorld } from './fixtures/notes.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const wait = (ms = 20) => act(() => new Promise((r) => setTimeout(r, ms)));

function Screen() {
  const { collections, commands } = useRecords(noteRecords);
  const list = useLiveQuery({ query: (q) => q.from({ n: collections.Note }).where(({ n }) => eq(n.boardId, 'b-1')), gcTime: 1 });
  const one = useLiveQuery({ query: (q) => q.from({ n: collections.Note }).where(({ n }) => eq(n.id, 'n-1')), gcTime: 1 });
  const can = useView(noteRecords, 'can', { id: 'n-1' });

  return (
    <div>
      <p data-testid="list">{list.data.map((n) => n.title).join(',')}</p>
      <p data-testid="one">{one.data.map((n) => n.title).join(',')}</p>
      <p data-testid="can">{can.data ? String(can.data.rename) : 'unknown'}</p>
      <button type="button" onClick={() => void commands.rename({ id: 'n-1', title: 'Renamed' })}>rename</button>
    </div>
  );
}

describe('records in React', () => {
  it('draws a list, a single view and a view of what may be done from the provider, and leaves no listener once unmounted', async () => {
    const world = notesWorld();
    world.store.add('n-1', 'b-1', 'First');
    const { backend } = world;

    const { unmount } = render(
      <RecordsProvider client={backend.client} transport={backend.transport}>
        <Screen />
      </RecordsProvider>,
    );

    await wait();
    expect(screen.getByTestId('list').textContent).toBe('First');
    expect(screen.getByTestId('one').textContent).toBe('First');
    expect(screen.getByTestId('can').textContent).toBe('true');
    expect(backend.listenerCount()).toBeGreaterThan(0);

    await act(async () => screen.getByText('rename').click());
    expect(screen.getByTestId('list').textContent).toBe('Renamed');
    expect(screen.getByTestId('one').textContent).toBe('Renamed');
    await wait();
    expect(world.store.notes.get('n-1')?.title).toBe('Renamed');

    unmount();
    await wait(50);
    expect(backend.listenerCount()).toBe(0);
  });

  it('calls the latest onRefused of the provider, without making the records again', async () => {
    const world = notesWorld();
    world.store.add('n-1', 'b-1', 'First');
    const first = vi.fn();
    const second = vi.fn();

    const tree = (onRefused: () => void) => (
      <RecordsProvider client={world.backend.client} transport={world.backend.transport} onRefused={onRefused}>
        <Screen />
      </RecordsProvider>
    );

    const { rerender } = render(tree(first));
    await wait();
    rerender(tree(second));
    await wait();
    expect(screen.getByTestId('one').textContent).toBe('First');
    act(() => world.backend.refuse('notes:n-1'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[0]).toMatchObject({ name: 'notes.Note', topic: 'notes:n-1' });
    expect(screen.getByTestId('can').textContent).toBe('true');
  });

  it('asks for a provider when there is none', () => {
    const spy = (message: string) => message;
    expect(() => render(<Screen />)).toThrow(/RecordsProvider/);
    spy('');
  });
});
