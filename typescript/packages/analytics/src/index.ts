import type { AnalyticsEvent, AnalyticsProvider } from '@builtbyfriends/realtime';

type AnalyticsEngineDataset = {
  writeDataPoint(point: { indexes?: Array<string>; blobs?: Array<string | null>; doubles?: Array<number> }): void;
};

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
    track(e: AnalyticsEvent, env: any) {
      const dataset = env?.[options.binding] as AnalyticsEngineDataset | undefined;
      if (!dataset?.writeDataPoint) {throw new Error(`analyticsEngine: env.${options.binding} is not an Analytics Engine binding`);}
      dataset.writeDataPoint({
        indexes: [e.procedure],
        blobs: [e.event, e.procedure, e.surface, e.outcome, e.code ?? '', e.actorId ?? '', JSON.stringify(e.props)],
        doubles: [e.status, e.durationMs],
      });
    },
  };
}

/** PostHog capture API over fetch. Anonymous calls are sent without a person profile. */
export function posthog(options: {
  apiKey: string | ((env: any) => string);
  /** Default https://us.i.posthog.com */
  host?: string;
  fetch?: typeof fetch;
}): AnalyticsProvider {
  const host = (options.host ?? 'https://us.i.posthog.com').replace(/\/$/, '');
  return {
    name: 'posthog',
    async track(e: AnalyticsEvent, env: any) {
      const apiKey = typeof options.apiKey === 'function' ? options.apiKey(env) : options.apiKey;
      const res = await (options.fetch ?? fetch)(`${host}/i/v0/e/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          event: e.event,
          distinct_id: e.actorId ?? 'anonymous',
          timestamp: new Date().toISOString(),
          properties: {
            ...e.props,
            procedure: e.procedure,
            surface: e.surface,
            outcome: e.outcome,
            status: e.status,
            duration_ms: e.durationMs,
            ...(e.code ? { error_code: e.code } : {}),
            ...(e.actorId ? {} : { $process_person_profile: false }),
          },
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
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length) {throw new AggregateError(failed.map((f) => f.reason), 'analytics provider failed');}
    },
  };
}

/** Keeps events in memory, for tests. */
export function memoryAnalytics(): AnalyticsProvider & { events: Array<AnalyticsEvent> } {
  const events: Array<AnalyticsEvent> = [];
  return { name: 'memory', events, track: (e) => void events.push(e) };
}
