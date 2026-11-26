// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { eq, useLiveQuery } from '@tanstack/react-db';
import { describe, expect, it } from 'vitest';
import { createRecords } from '../src/records.js';
import { notes, notesWorld } from './fixtures/notes.js';

const spec = { key: 'id', version: 'updatedAt', reads: { list: { boardId: 'boardId' }, get: { id: 'id' } }, upserts: ['renamed'] } as const;

describe('records in React', () => {
  it('draws a list and a single view from one record, and renames both at once', async () => {
    const world = notesWorld();
    world.store.add('n-1', 'b-1', 'First');
    const records = createRecords({ contract: notes, client: world.client });
    const note = records.recordCollection('Note', spec);
    const rename = records.command('rename', { records: note, spec }, { optimistic: ({ id, title }) => note.collection.update(id, (d) => void (d.title = title)) });

    function Screen() {
      const list = useLiveQuery((q) => q.from({ n: note.collection }).where(({ n }) => eq(n.boardId, 'b-1')));
      const one = useLiveQuery((q) => q.from({ n: note.collection }).where(({ n }) => eq(n.id, 'n-1')));
      return (
        <div>
          <p data-testid="list">{list.data.map((n) => n.title).join(',')}</p>
          <p data-testid="one">{one.data.map((n) => n.title).join(',')}</p>
        </div>
      );
    }

    render(<Screen />);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByTestId('list').textContent).toBe('First');
    expect(screen.getByTestId('one').textContent).toBe('First');

    let intent!: ReturnType<typeof rename>;
    await act(async () => {
      intent = rename({ id: 'n-1', title: 'Renamed' });
    });
    expect(screen.getByTestId('list').textContent).toBe('Renamed');
    expect(screen.getByTestId('one').textContent).toBe('Renamed');
    await act(() => intent.settled);
    expect(screen.getByTestId('one').textContent).toBe('Renamed');
  });
});
