import type { AnalyticsEvent, AnalyticsProps, AnalyticsProvider } from '@builtbyfriends/realtime';

type AnalyticsEngineDataset = {
  writeDataPoint(point: { indexes?: Array<string>; blobs?: Array<string | null>; doubles?: Array<number> }): void;
};

function isDataset(value: unknown): value is AnalyticsEngineDataset {
  return typeof value === 'object' && value !== null && 'writeDataPoint' in value && typeof value.writeDataPoint === 'function';
}

function findDataset(env: unknown, binding: string): AnalyticsEngineDataset | undefined {
  if (typeof env !== 'object' || env === null) {return undefined;}
  const candidate: unknown = Object.entries(env).find(([key]) => key === binding)?.[1];
  return isDataset(candidate) ? candidate : undefined;
}

/**
 * Workers Analytics Engine, through a binding: no dependency, no network call.
 *
 * Column layout, for the SQL API:
 *   index1 = procedure
 *   blob1 = event, blob2 = procedure, blob3 = surface, blob4 = outcome,
 *   blob5 = error code, blob6 = actor id, blob7 = props as JSON
 *   double1 = HTTP status, double2 = handler duration in ms
 *
 * wrangler.jsonc: "analytics_engine_datasets": [{ "binding": "ANALYTICS", "dataset": "realtime_events" }]
 */
export function analyticsEngine(options: { binding: string }): AnalyticsProvider {
  return {
    name: 'workers-analytics-engine',
    track(e: AnalyticsEvent, env: unknown) {
      const dataset = findDataset(env, options.binding);
      if (!dataset) {throw new Error(`analyticsEngine: env.${options.binding} is not an Analytics Engine binding`);}
      dataset.writeDataPoint({
        indexes: [e.procedure],
        blobs: [e.event, e.procedure, e.surface, e.outcome, e.code ?? '', e.actorId ?? '', JSON.stringify(e.props)],
        doubles: [e.status, e.durationMs],
      });
    },
  };
}

/** PostHog capture API over fetch. Anonymous calls are sent without a person profile. */
export function posthog<Env = unknown>(options: {
  apiKey: string | ((env: Env) => string);
  /** Default https://us.i.posthog.com */
  host?: string;
  fetch?: typeof fetch;
}): AnalyticsProvider<Env> {
  const host = (options.host ?? 'https://us.i.posthog.com').replace(/\/$/, '');
  return {
    name: 'posthog',
    async track(e: AnalyticsEvent, env: Env) {
      const apiKey = typeof options.apiKey === 'function' ? options.apiKey(env) : options.apiKey;
      const properties: AnalyticsProps = {
        ...e.props,
        procedure: e.procedure,
        surface: e.surface,
        outcome: e.outcome,
        status: e.status,
        duration_ms: e.durationMs,
      };
      if (e.code) {properties.error_code = e.code;}
      if (!e.actorId) {properties.$process_person_profile = false;}
      const res = await (options.fetch ?? fetch)(`${host}/i/v0/e/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          event: e.event,
          distinct_id: e.actorId ?? 'anonymous',
          timestamp: new Date().toISOString(),
          properties,
        }),
      });
      if (!res.ok) {throw new Error(`posthog: capture failed with HTTP ${res.status}`);}
    },
  };
}

/** Sends each event to every provider. A failing provider does not stop the others. */
export function fanOut(...providers: Array<AnalyticsProvider>): AnalyticsProvider {
  return {
    name: providers.map((p) => p.name).join('+'),
    async track(e, env) {
      const results = await Promise.allSettled(providers.map((p) => Promise.resolve().then(() => p.track(e, env))));
      const reasons: Array<unknown> = [];
      for (const result of results) {
        if (result.status === 'rejected') {reasons.push(result.reason);}
      }
      if (reasons.length) {throw new AggregateError(reasons, 'analytics provider failed');}
    },
  };
}

/** Keeps events in memory, for tests. */
export function memoryAnalytics(): AnalyticsProvider & { events: Array<AnalyticsEvent> } {
  const events: Array<AnalyticsEvent> = [];
  return { name: 'memory', events, track: (e) => void events.push(e) };
}
