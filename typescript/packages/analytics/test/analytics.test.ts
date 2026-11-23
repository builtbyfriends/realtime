import { describe, expect, it, vi } from 'vitest';
import { analyticsEngine, fanOut, posthog } from '@builtbyfriends/realtime-analytics';
import type { AnalyticsEvent } from '@builtbyfriends/realtime';

const event: AnalyticsEvent = {
  event: 'contact.viewed', procedure: 'contacts.get', surface: 'mcp', outcome: 'error', code: 'NOT_FOUND',
  status: 404, durationMs: 3, actorId: 'u1', props: { orgId: 'o1' },
};

describe('analytics providers', () => {
  it('writes a fixed column layout to Analytics Engine', async () => {
    const writeDataPoint = vi.fn();
    await analyticsEngine({ binding: 'AE' }).track(event, { AE: { writeDataPoint } });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['contacts.get'],
      blobs: ['contact.viewed', 'contacts.get', 'mcp', 'error', 'NOT_FOUND', 'u1', '{"orgId":"o1"}'],
      doubles: [404, 3],
    });
    expect(() => analyticsEngine({ binding: 'AE' }).track(event, {})).toThrow(/env.AE is not an Analytics Engine binding/);
  });

  it('captures to PostHog, without person profiles for anonymous calls', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}'));
    await posthog({ apiKey: (env: { KEY: string }) => env.KEY, fetch }).track({ ...event, actorId: undefined }, { KEY: 'phc_x' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      api_key: 'phc_x', event: 'contact.viewed', distinct_id: 'anonymous',
      properties: { orgId: 'o1', procedure: 'contacts.get', error_code: 'NOT_FOUND', $process_person_profile: false },
    });
  });

  it('fans out and reports failures without stopping other providers', async () => {
    const ok = { name: 'ok', track: vi.fn() };
    const bad = { name: 'bad', track: () => { throw new Error('down'); } };
    await expect(fanOut(bad, ok).track(event, {})).rejects.toThrow('analytics provider failed');
    expect(ok.track).toHaveBeenCalled();
  });
});
