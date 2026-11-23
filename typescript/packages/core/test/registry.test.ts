import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { object, string } from 'valibot';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { defineRegistry, procedure } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { getContact, ping, purge } from './fixtures.js';

const R = (why: string) => ({ reason: why });
// Decision: built with plain strings, the way untyped JS would.
const full = (name: string, overrides: (b: any) => any = (b) => b) =>
  overrides(
    (procedure(name) as any)
      .noAuth(R('Public data with no user context'))
      .noAuthz(R('Anyone may read public data'))
      .noErrors(R('Nothing here can fail on purpose'))
      .noAnalytics(R('Not worth tracking at this volume'))
      .noCli(R('Not useful from a terminal')),
  );
const finish = (b: any, output: any = z.object({})) => b.output(output).handler(() => ({}));

describe('registry load-time checks (the deploy gate)', () => {
  it('accepts complete procedures', () => {
    expect(() => defineRegistry([getContact, purge, ping], { analytics: memoryAnalytics() })).not.toThrow();
  });

  it('lists every undecided concern when types were bypassed', () => {
    const half = (procedure('half').noAuth({ reason: 'Public data with no user context' }) as any).output(z.object({})).handler(() => ({}));
    expect(() => defineRegistry([half])).toThrow(/"half": undecided: authz, input, errors, analytics, mcp, cli, aiTool/);
  });

  it('rejects things that are not finished procedures', () => {
    const builder = procedure('unfinished').noInput();
    expect(() => defineRegistry([builder as any])).toThrow(/"unfinished": not finished; decide every concern and call .handler\(fn\)/);
  });

  it('rejects placeholder and short opt-out reasons, even computed ones', () => {
    const junk = finish(full('a').noInput().noMcp(R('n/a')).noAiTool(R('TODO')));
    const short = finish(full('b').noInput().noMcp(R('not now')).noAiTool(R('Agents have no use for it')));
    expect(() => defineRegistry([junk, short])).toThrow(
      /"a": mcp opt-out: "n\/a" is a placeholder[\s\S]*"a": aiTool opt-out: "TODO" is a placeholder[\s\S]*"b": mcp opt-out: "not now" is too short/,
    );
  });

  it('collects all problems in one error', () => {
    const one = finish(full('dup').noInput().noMcp(R('x')).noAiTool(R('Agents have no use for it')));
    try {
      defineRegistry([one, one, ping, ping]);
      expect.unreachable();
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toMatch(/problem\(s\)/);
      expect(msg).toContain('"dup": mcp opt-out');
      expect(msg).toContain('"ping": registered twice');
    }
  });

  it('requires an analytics provider when a procedure tracks events', () => {
    expect(() => defineRegistry([getContact])).toThrow(/"contacts.get": uses analytics, but the registry has no analytics provider/);
  });

  it('rejects reserved and malformed error codes', () => {
    const p = finish((procedure('e') as any)
      .noAuth(R('Public data with no user context')).noAuthz(R('Anyone may read public data')).noInput()
      .errors({ FORBIDDEN: { status: 403, message: 'x' }, lower: { status: 200, message: '' } })
      .noAnalytics(R('Not worth tracking at this volume')).noMcp(R('Not useful to agents')).noCli(R('Not useful from a terminal')).noAiTool(R('Not useful to agents')));
    expect(() => defineRegistry([p])).toThrow(/FORBIDDEN is reserved[\s\S]*lower must be UPPER_SNAKE_CASE[\s\S]*error lower needs an HTTP status/);
  });

  it('converts JSON Schema at load, so unsupported schemas fail the deploy', () => {
    const exposed = (input: any) =>
      finish(full('tool.x').input(input).mcp({ description: 'A tool', effect: 'read' }).noAiTool(R('Agents use MCP for this')));
    expect(() => defineRegistry([exposed(object({ q: string() }))])).toThrow(/does not implement Standard JSON Schema[\s\S]*toStandardJsonSchema/);
    const ok = finish(full('tool.y').input(toStandardJsonSchema(object({ q: string() }))).mcp({ description: 'A tool', effect: 'read' }).noAiTool(R('Agents use MCP for this')), toStandardJsonSchema(object({})));
    expect(() => defineRegistry([ok])).not.toThrow();
    expect(() => defineRegistry([exposed(z.string())])).toThrow(/must be an object schema/);
    expect(() => defineRegistry([exposed(z.object({ when: z.date() }))])).toThrow(/input schema/);
  });

  it('allows any Standard Schema when nothing needs JSON Schema', () => {
    const hidden = finish(full('hidden').input(object({ q: string() })).noMcp(R('Not useful to agents')).noAiTool(R('Not useful to agents')), object({}));
    expect(() => defineRegistry([hidden])).not.toThrow();
  });

  it('rejects duplicate CLI commands and bad names', () => {
    const a = finish(full('a', (b) => b).noInput().noMcp(R('Not useful to agents')).noAiTool(R('Not useful to agents')));
    const cli = (name: string) => finish((procedure(name) as any)
      .noAuth(R('Public data with no user context')).noAuthz(R('Anyone may read public data')).noInput().noErrors(R('Nothing here can fail on purpose'))
      .noAnalytics(R('Not worth tracking at this volume')).noMcp(R('Not useful to agents')).cli({ command: 'same', description: 'd' }).noAiTool(R('Not useful to agents')));
    expect(() => defineRegistry([a, cli('x.one'), cli('x.two'), cli('Bad-Name')])).toThrow(/cli command "same" is also used by "x.one"[\s\S]*"Bad-Name": name must look like/);
  });

  it('keeps builders immutable, so a shared partial chain cannot leak decisions', () => {
    const base = procedure('shared').noAuth({ reason: 'Public data with no user context' });
    const a = base.noInput();
    const b = base.input(z.object({ q: z.string() }));
    expect(() => (a as any).input(z.object({}))).toThrow(/input is already decided/);
    expect(() => b.noAuthz({ reason: 'Anyone may search public data' })).not.toThrow();
    expect(() => (base as any).noAuth({ reason: 'Public data with no user context' })).toThrow(/authn is already decided/);
    expect(b).not.toBe(a);
  });

  it('throws at definition time when a profile and a procedure decide the same concern', () => {
    const p = (procedure('x') as any).noCli(R('Not useful from a terminal'));
    const prof = (procedure as any) && { '~realtime': 'profile', name: 'p', decisions: { cli: { kind: 'none', reason: 'Not useful from a terminal' } } };
    expect(() => p.use(prof)).toThrow(/cli is decided here and in profile "p"/);
  });
});

describe('audit', () => {
  it('prints one row per procedure that a PR diff will show', () => {
    const registry = defineRegistry([getContact, purge, ping], { analytics: memoryAnalytics() });
    expect(registry.auditTable()).toMatchInlineSnapshot(`
      "| procedure | profiles | authn | authz | input | output | errors | analytics | mcp | cli | aiTool |
      | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
      | cache.purge | admin-only | auth(api-token) [admin-only] | policy(admin) [admin-only] | none | schema(zod) | none: Purging is idempotent and cannot fail | none: Purges are logged by the CDN already | tool(destructive) | none: Admin actions ship through the dashboard [admin-only] | tool(needs approval) |
      | contacts.get | - | auth(api-token) | policy(same-org) | schema(zod) | schema(zod) | GONE NOT_FOUND | event(contact.viewed) | tool(read) | command(contacts get) | tool(no approval) |
      | ping | - | none: Uptime checks run without credentials | none: Anyone may check whether we are up | none | schema(zod) | none: Ping always answers when the Worker runs | none: Health checks would drown real events | none: Agents have no use for an uptime probe | command(ping) | none: Agents have no use for an uptime probe |
      "
    `);
  });

  it('builds a manifest of CLI commands only', () => {
    const registry = defineRegistry([getContact, purge, ping], { analytics: memoryAnalytics() });
    expect(registry.manifest().procedures.map((p) => p.cli?.command)).toEqual(['contacts get', 'ping']);
  });
});

describe('withProcedureName', () => {
  it('names an unnamed procedure and keeps an explicit name', async () => {
    const { procedure, withProcedureName } = await import('../src/index.js');
    expect(withProcedureName(procedure(), 'drafts.save')).toMatchObject({ name: 'drafts.save' });
    expect(withProcedureName(procedure('own'), 'drafts.save')).toMatchObject({ name: 'own' });
  });
});
