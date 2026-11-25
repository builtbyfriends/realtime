import { describe, expect, it } from 'vitest';
import { anthropicTools } from '@builtbyfriends/realtime-ai';
import { registry } from '../src/worker.js';

describe('the contract is the one source for each surface', () => {
  it('gives each command a command line entry unless it says why not', () => {
    expect(registry.manifest().procedures.map((p) => p.cli?.command)).toEqual([
      'tasks create',
      'tasks get',
      'tasks list',
      'tasks start',
      'tasks finish',
      'tasks reopen',
      'tasks remove',
    ]);
  });

  it('gives bots the commands marked as tools, with approval where the contract asks', () => {
    expect(anthropicTools(registry).map((t) => t.name)).toEqual([
      'tasks_create',
      'tasks_get',
      'tasks_list',
      'tasks_start',
      'tasks_finish',
      'tasks_reopen',
    ]);
    expect([...registry.procedures.values()].flatMap((p) => (p.decisions.aiTool.kind === 'tool' && p.decisions.aiTool.needsApproval ? [p.name] : []))).toEqual(['tasks.reopen']);
  });

  it('adds requestId to the input schema of each write', () => {
    expect(registry.procedures.get('tasks.start')?.jsonSchema.input).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, requestId: { type: 'string' } },
      required: ['id', 'requestId'],
    });
    expect(registry.procedures.get('tasks.get')?.jsonSchema.input).not.toHaveProperty('properties.requestId');
  });
});
