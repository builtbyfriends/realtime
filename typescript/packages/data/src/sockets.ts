import type { Change, ChangeBatch, PullResult } from './changes.js';

/**
 * Devices hold a hibernating WebSocket on the data object itself. Each socket's attachment says who it is and which
 * sync groups it reads, so a commit goes straight to the sockets that should see it, filtered per socket, with the
 * changed documents in the message. A sleeping socket bills nothing, and outgoing messages are free.
 *
 * The door (the Worker in front) decides who the caller is, and can hand it groups it may read. A device can also ask
 * to watch more groups as it moves around. The object checks those itself (`access`), since it holds the data.
 *
 * Wire format, JSON text frames:
 *   device → object  {"type":"pull","after":12,"id":1}
 *   object → device  {"type":"pull","id":1,"seq":40,"changes":[...],"more":false}
 *   device → object  {"type":"watch","groups":["channel:x"],"after":38,"id":2}   `after` is optional
 *   object → device  {"type":"watching","id":2,"groups":["channel:x"],"denied":[],"seq":40,"changes":[...],"more":false}
 *   device → object  {"type":"unwatch","groups":["channel:x"]}
 *   object → device  {"type":"changes","seq":41,"changes":[...]}   after each commit that touches its groups
 *   object → device  {"type":"groups","added":["team:x"],"removed":["team:y"]}   drop what's in removed
 *   device → object  {"type":"listen","topics":["pins:channel:x"],"id":3}
 *   object → device  {"type":"listening","id":3,"topics":["pins:channel:x"],"denied":[]}
 *   device → object  {"type":"unlisten","topics":["pins:channel:x"]}
 *   object → device  {"type":"topics","topics":["pins:channel:x"]}   after a commit that touched them: refetch
 *   object → device  {"type":"unheard","topics":["pins:channel:x"]}   no longer allowed: hear it some other way
 *   device → object  {"type":"query","id":"q1","name":"pins.list","input":{"channelId":"x"},"topics":["pins:channel:x"]}
 *   object → device  {"type":"result","id":"q1","value":{...}}   now, and again after a commit that touched its topics
 *   object → device  {"type":"result","id":"q1","denied":true}   refused or no longer allowed: fetch it some other way
 *   object → device  {"type":"result","id":"q1","error":"Forbidden"}   the query threw
 *   device → object  {"type":"unquery","ids":["q1"]}
 *
 * `watching` and `pull` answers carry `epoch`. A position only means something within its epoch, so a device that sees a
 * new one drops its positions and loads its groups again.
 */
export type SocketIdentity = { actor: string; groups: string[]; topics?: string[]; queries?: LiveQuery[] };

type LiveQuery = { id: string; name: string; input: unknown; topics: string[] };

/** A live query's answer: its value, or the error it threw. */
export type QueryAnswer = { value: unknown } | { error: string };

type Socket = {
  send(message: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

type State = {
  acceptWebSocket(ws: unknown, tags?: string[]): void;
  getWebSockets(tag?: string): Socket[];
};

/** What the sockets need from the data object. */
export type SyncHooks = {
  pull(actor: string, groups: string[], after: number, limit?: number): PullResult;
  /** The changes as this actor sees them. Leave it out to send them as they are. */
  view?(actor: string, changes: Change[]): Change[];
  /** The groups out of `groups` this actor may read. Leave it out to refuse every watch. */
  access?(actor: string, groups: string[]): string[];
  /** The live topics out of `topics` this actor may hear. Leave it out to refuse every listen. */
  topicAccess?(actor: string, topics: string[]): string[];
  /** Answers live query `name` for `actor`. Null refuses it. Leave it out to refuse every query. */
  query?(actor: string, name: string, input: unknown): QueryAnswer | null | Promise<QueryAnswer | null>;
  /** This storage's epoch, sent with positions. */
  epoch?(): string;
};

// Decision: socket attachments hold at most 16 KiB, so stay under that.
const MAX_ATTACHMENT = 16_000;
// Decision: a WebSocket message holds at most 1 MiB. A bigger answer is sent as an error, and the device fetches it.
const MAX_RESULT = 900_000;

export class SyncSockets {
  private readonly hooks: SyncHooks;
  // Decision: what each query last sent and its latest run, in memory only. After the object wakes, the next answer goes out
  // even if it hasn't changed, which costs bytes and nothing else.
  private readonly sent = new WeakMap<Socket, Map<string, { json?: string; run: number }>>();
  private pending = new Set<string>();
  private flushing = false;

  constructor(
    private readonly state: State,
    hooks: SyncHooks | ((groups: string[], after: number, limit?: number) => PullResult),
  ) {
    this.hooks = typeof hooks === 'function' ? { pull: (_actor, groups, after, limit) => hooks(groups, after, limit) } : hooks;
  }

  /** Accepts the server end of a WebSocketPair for this caller. */
  accept(ws: Socket, who: SocketIdentity): void {
    const attachment: SocketIdentity = { actor: who.actor, groups: [...new Set(who.groups)], topics: [] };
    if (JSON.stringify(attachment).length > MAX_ATTACHMENT) throw new Error('too many sync groups for one socket');
    this.state.acceptWebSocket(ws, [`actor:${who.actor}`]);
    ws.serializeAttachment(attachment);
  }

  /** Sends a commit to the sockets whose groups it touches, each with only its own groups' documents. */
  broadcast(batch: ChangeBatch): void {
    const groups = new Set(batch.changes.map((c) => c.group));
    for (const ws of this.state.getWebSockets()) {
      const who = identity(ws);
      if (!who || !who.groups.some((g) => groups.has(g))) continue;
      const mine = new Set(who.groups);
      const changes = this.see(who.actor, batch.changes.filter((c) => mine.has(c.group)));
      if (changes.length) trySend(ws, { type: 'changes', seq: batch.seq, changes });
    }
  }

  /** Answers a device's message. Returns false when it isn't a sync message, so the object can handle it. */
  message(ws: Socket, raw: string | ArrayBuffer): boolean {
    if (typeof raw !== 'string') return false;
    let msg: { type?: string; after?: number; id?: unknown; limit?: number; groups?: unknown; topics?: unknown; name?: unknown; input?: unknown; ids?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!['pull', 'watch', 'unwatch', 'listen', 'unlisten', 'query', 'unquery'].includes(msg.type ?? '')) return false;
    const who = identity(ws);
    if (!who) return true;
    const after = Number.isFinite(msg.after) && msg.after! >= 0 ? msg.after! : 0;
    if (msg.type === 'pull') {
      trySend(ws, { type: 'pull', id: msg.id, epoch: this.epoch(), ...this.pulled(who.actor, who.groups, after, msg.limit) });
      return true;
    }
    if (msg.type === 'query') {
      this.subscribe(ws, who, msg);
      return true;
    }
    if (msg.type === 'unquery') {
      const ids = strings(msg.ids);
      this.save(ws, { ...who, queries: (who.queries ?? []).filter((q) => !ids.includes(q.id)) });
      const mine = this.sent.get(ws);
      for (const id of ids) mine?.delete(id);
      return true;
    }
    if (msg.type === 'listen' || msg.type === 'unlisten') {
      const topics = strings(msg.topics);
      const mine = who.topics ?? [];
      if (msg.type === 'unlisten') {
        this.save(ws, { ...who, topics: mine.filter((t) => !topics.includes(t)) });
        return true;
      }
      const allowed = topics.length && this.hooks.topicAccess ? this.hooks.topicAccess(who.actor, topics) : [];
      const saved = this.save(ws, { ...who, topics: [...new Set([...mine, ...allowed])] });
      const heard = saved ? allowed : [];
      trySend(ws, { type: 'listening', id: msg.id, topics: heard, denied: topics.filter((t) => !heard.includes(t)) });
      return true;
    }
    const asked = strings(msg.groups);
    if (msg.type === 'unwatch') {
      this.save(ws, { ...who, groups: who.groups.filter((g) => !asked.includes(g)) });
      return true;
    }
    const allowed = asked.length && this.hooks.access ? this.hooks.access(who.actor, asked) : [];
    const denied = asked.filter((g) => !allowed.includes(g));
    const next = { ...who, groups: [...new Set([...who.groups, ...allowed])] };
    if (!this.save(ws, next)) {
      trySend(ws, { type: 'watching', id: msg.id, epoch: this.epoch(), groups: [], denied: asked, seq: 0, changes: [], more: false });
      return true;
    }
    // Decision: without `after`, answer only the position. The device loads the groups through queries, which reads less than a pull from 0.
    const caught = msg.after === undefined ? { ...this.hooks.pull(who.actor, [], 0), more: false } : this.pulled(who.actor, allowed, after, msg.limit);
    trySend(ws, { type: 'watching', id: msg.id, epoch: this.epoch(), groups: allowed, denied, ...caught });
    return true;
  }

  /**
   * Changes the groups an actor's sockets may read, after they join or leave something. Each socket is told what was
   * added (pull it from 0) and what was removed (drop it from the device).
   */
  regroup(actor: string, groups: string[]): void {
    const next = [...new Set(groups)];
    for (const ws of this.state.getWebSockets(`actor:${actor}`)) {
      const who = identity(ws);
      if (!who) continue;
      const added = next.filter((g) => !who.groups.includes(g));
      const removed = who.groups.filter((g) => !next.includes(g));
      if (!added.length && !removed.length) continue;
      ws.serializeAttachment({ ...who, groups: next });
      trySend(ws, { type: 'groups', added, removed });
    }
  }

  /**
   * Checks every socket's groups again, after a commit that may have changed who can read what (someone left, a channel
   * went private). Each socket is told what it lost.
   */
  recheck(): void {
    const { access, topicAccess } = this.hooks;
    for (const ws of this.state.getWebSockets()) {
      const who = identity(ws);
      if (!who) continue;
      const topics = who.topics ?? [];
      const kept = who.groups.length && access ? access(who.actor, who.groups) : [];
      const heard = topics.length && topicAccess ? topicAccess(who.actor, topics) : [];
      const queries = who.queries ?? [];
      const asked = [...new Set(queries.flatMap((q) => q.topics))];
      const allowed = new Set(asked.length && topicAccess ? topicAccess(who.actor, asked) : []);
      const dropped = queries.filter((q) => !q.topics.every((t) => allowed.has(t)));
      const removed = who.groups.filter((g) => !kept.includes(g));
      const deaf = topics.filter((t) => !heard.includes(t));
      if (!removed.length && !deaf.length && !dropped.length) continue;
      ws.serializeAttachment({ ...who, groups: who.groups.filter((g) => kept.includes(g)), topics: topics.filter((t) => heard.includes(t)), queries: queries.filter((q) => !dropped.includes(q)) });
      if (removed.length) trySend(ws, { type: 'groups', added: [], removed });
      if (deaf.length) trySend(ws, { type: 'unheard', topics: deaf });
      for (const q of dropped) {
        this.sent.get(ws)?.delete(q.id);
        trySend(ws, { type: 'result', id: q.id, denied: true });
      }
    }
  }

  /**
   * Tells each socket listening to one of these topics that it changed, so the device refetches what reads it, and
   * answers again each live query that reads one.
   */
  publish(topics: string[]): void {
    if (!topics.length) return;
    const touched = new Set(topics);
    for (const ws of this.state.getWebSockets()) {
      const who = identity(ws);
      const hit = who?.topics?.filter((t) => touched.has(t));
      if (hit?.length) trySend(ws, { type: 'topics', topics: hit });
    }
    if (!this.hooks.query) return;
    for (const t of topics) this.pending.add(t);
    if (this.flushing) return;
    this.flushing = true;
    // Decision: commits that land in the same turn answer each query once, after the last of them.
    queueMicrotask(() => void this.flush());
  }

  /** Answers again the live queries that read topics touched since the last flush. Resolves once they're sent. */
  async flush(): Promise<void> {
    const touched = this.pending;
    this.pending = new Set();
    this.flushing = false;
    if (!touched.size) return;
    const runs: Promise<void>[] = [];
    for (const ws of this.state.getWebSockets()) {
      const who = identity(ws);
      for (const q of who?.queries ?? []) if (q.topics.some((t) => touched.has(t))) runs.push(this.answer(ws, who!.actor, q));
    }
    await Promise.all(runs);
  }

  private subscribe(ws: Socket, who: SocketIdentity, msg: { id?: unknown; name?: unknown; input?: unknown; topics?: unknown }): void {
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? String(msg.id) : null;
    if (id === null) return;
    const name = typeof msg.name === 'string' ? msg.name : '';
    const topics = strings(msg.topics);
    const allowed = name && this.hooks.query && this.hooks.topicAccess ? this.hooks.topicAccess(who.actor, topics) : [];
    const ok = allowed.length === topics.length;
    const query: LiveQuery = { id, name, input: msg.input ?? null, topics };
    if (!ok || !this.save(ws, { ...who, queries: [...(who.queries ?? []).filter((q) => q.id !== id), query] })) {
      trySend(ws, { type: 'result', id, denied: true });
      return;
    }
    void this.answer(ws, who.actor, query);
  }

  private async answer(ws: Socket, actor: string, q: LiveQuery): Promise<void> {
    let mine = this.sent.get(ws);
    if (!mine) this.sent.set(ws, (mine = new Map()));
    const slot = mine.get(q.id) ?? { run: 0 };
    const run = ++slot.run;
    mine.set(q.id, slot);
    let answer: QueryAnswer | null;
    try {
      answer = await this.hooks.query!(actor, q.name, q.input);
    } catch (e) {
      answer = { error: e instanceof Error ? e.message : String(e) };
    }
    // Decision: a later run started while this one waited, so its answer is the newer one.
    if (slot.run !== run || mine.get(q.id) !== slot) return;
    if (!answer) {
      this.drop(ws, q.id);
      trySend(ws, { type: 'result', id: q.id, denied: true });
      return;
    }
    const json = JSON.stringify({ type: 'result', id: q.id, ...answer });
    if (json === slot.json) return;
    slot.json = json;
    if (json.length > MAX_RESULT) trySendRaw(ws, JSON.stringify({ type: 'result', id: q.id, error: 'too large' }));
    else trySendRaw(ws, json);
  }

  private drop(ws: Socket, id: string): void {
    const who = identity(ws);
    if (who) this.save(ws, { ...who, queries: (who.queries ?? []).filter((q) => q.id !== id) });
    this.sent.get(ws)?.delete(id);
  }

  private epoch(): string | undefined {
    return this.hooks.epoch?.();
  }

  private pulled(actor: string, groups: string[], after: number, limit?: number): PullResult {
    const result = this.hooks.pull(actor, groups, after, limit);
    return { ...result, changes: this.see(actor, result.changes) };
  }

  private see(actor: string, changes: Change[]): Change[] {
    return this.hooks.view ? this.hooks.view(actor, changes) : changes;
  }

  private save(ws: Socket, who: SocketIdentity): boolean {
    if (JSON.stringify(who).length > MAX_ATTACHMENT) return false;
    ws.serializeAttachment(who);
    return true;
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
}

function identity(ws: Socket): SocketIdentity | null {
  const v = ws.deserializeAttachment() as SocketIdentity | null;
  return v && typeof v.actor === 'string' && Array.isArray(v.groups) ? v : null;
}

function trySend(ws: Socket, message: unknown): void {
  trySendRaw(ws, JSON.stringify(message));
}

function trySendRaw(ws: Socket, message: string): void {
  try {
    ws.send(message);
  } catch {
    // Decision: the socket closed between the commit and the send. The device pulls on reconnect.
  }
}
