type Publisher = { withEnv(env: any): { publish(topic: string, data: unknown, options?: { type?: string; eventId?: string }): Promise<void> } };

/**
 * `onCommit` for `defineData`: publishes a `changed` event on every topic a mutation touched.
 * The payload is empty on purpose. Delivery is at most once, so clients refetch instead of
 * applying events. It runs inside the Durable Object, which has no request, hence `withEnv`.
 *
 *   defineData({ ..., onCommit: publishTopics(live) })
 *
 * Each topic is its own Durable Object, and a mutation touches `table` and `table:<id>` for
 * every row it writes. When no rule lets a client subscribe to those, pass `only` to skip
 * them, so a new row doesn't start a Durable Object that has nobody to tell:
 *
 *   const policy = topicPolicy(rules);
 *   defineData({ ..., onCommit: publishTopics(live, { only: policy.subscribable }) })
 */
export function publishTopics(live: Publisher, options: { only?: (topic: string) => boolean } = {}) {
  return async (topics: string[], env: unknown) => {
    const wanted = options.only ? topics.filter(options.only) : topics;
    if (!wanted.length) return;
    const stream = live.withEnv(env);
    await Promise.all(wanted.map((topic) => stream.publish(topic, null, { type: 'changed' })));
  };
}

export type TopicContext = { topic: string; user: unknown; owner: string | null; env: any; request: Request };
export type TopicRule = {
  /** Matched against the whole topic. Capture groups are passed to `allow`. */
  pattern: RegExp;
  allow: (match: string[], ctx: TopicContext) => boolean | Promise<boolean>;
};

/**
 * `onSubscribe` for `defineLiveStream`: allow a topic only when a rule matches and agrees.
 * A topic no rule matches is refused, because without this any signed-in user could listen
 * to any topic.
 *
 *   defineLiveStream({ id: 'app', onSubscribe: topicPolicy([
 *     { pattern: /^messages:channel:(.+)$/, allow: ([, channel], ctx) => canRead(ctx.user, channel) },
 *   ]) })
 */
export function topicPolicy(rules: TopicRule[]) {
  const matches = (pattern: RegExp, topic: string) => {
    // Decision: a fresh copy without g, y or m, so lastIndex never carries over between calls and a line break can't stand in for an end. It is anchored at both ends, so
    // a rule has to cover the whole topic, and an alternation can't stop at a shorter branch.
    return new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gym]/g, '')).exec(topic);
  };
  const policy = async (ctx: TopicContext): Promise<Response | void> => {
    for (const { pattern, allow } of rules) {
      const m = matches(pattern, ctx.topic);
      if (m && (await allow([...m], ctx))) return;
    }
    return new Response('Forbidden', { status: 403 });
  };
  /** Whether some rule's pattern matches `topic`, so a client could ever subscribe to it. Pass to `publishTopics`' `only`. */
  const subscribable = (topic: string) => rules.some(({ pattern }) => matches(pattern, topic) !== null);
  return Object.assign(policy, { subscribable });
}
