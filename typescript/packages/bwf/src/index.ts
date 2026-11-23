import { bearerAuth, createProcedures, type Registry } from '@builtbyfriends/realtime';

declare global {
  // Decision: empty here. bwf fills it in from bwf.config.ts and your imports (.bwf/bindings.d.ts).
  interface BwfGeneratedEnvBindings {}
}

/** The Worker env as bwf types it. No generic to pass. */
export type BwfEnv = BwfGeneratedEnvBindings;

export const { procedure, profile } = createProcedures<BwfEnv>();

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * API tokens for the CLI, agents and scripts: `Authorization: Bearer <token>`. Only a
 * SHA-256 hash is stored. `lookup` gets the hash and returns the caller or null.
 */
export function apiTokens<User extends { id: string }>(lookup: (hash: string) => Promise<User | null | undefined> | User | null | undefined) {
  return bearerAuth<User, BwfEnv>({
    name: 'api-token',
    verify: async (token) => lookup(await sha256(token)),
    actorId: (u) => u.id,
  });
}

export { anyOf, bearerAuth } from '@builtbyfriends/realtime';

let current: Registry | undefined;
/** @internal The realtime middleware calls this when the Worker starts. */
export function setAppRegistry(registry: Registry) {
  current = registry;
}

/**
 * The app's registry, for code that runs agents inside the Worker: pass it to
 * anthropicTools() and runTool() from @builtbyfriends/realtime-ai.
 */
export function appRegistry(): Registry {
  if (!current) throw new Error('appRegistry() is only available inside a request, after the realtime middleware has loaded');
  return current;
}

/** One AI tool call that came in over HTTP (`POST <basePath>/ai/run`) for a tool that needs approval. */
export type AiRunCall = { request: Request; env: BwfEnv; tool: string; input: unknown };

let approval: ((call: AiRunCall) => boolean | Promise<boolean>) | undefined;

/**
 * Decides whether a person approved an AI tool call that came in over HTTP. Call it once when the Worker starts, for
 * example from a middleware file. Answer from something the caller can't write itself, such as an approval a person
 * stored through your app. Without it, a tool that needs approval stays held over HTTP. The request body can't approve
 * a call.
 */
export function approveAiRuns(decide: (call: AiRunCall) => boolean | Promise<boolean>): void {
  approval = decide;
}

/** @internal The realtime middleware asks this for each held call. A decision that throws counts as no. */
export async function aiRunApproved(call: AiRunCall): Promise<boolean> {
  if (!approval) return false;
  try {
    return (await approval(call)) === true;
  } catch (e) {
    console.error('approveAiRuns failed', e);
    return false;
  }
}
