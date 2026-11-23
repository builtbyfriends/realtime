import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import type { InputOf, OutputOf } from '@builtbyfriends/realtime';
import { stableKey } from './index.js';
import type { Live, MutateOptions, Procs, QueryOptions, QueryState, Typed } from './index.js';

export type UseQueryResult<T> = QueryState<T> & {
  /** `status === 'loading'`, for the first load only. Later refetches keep the old data. */
  loading: boolean;
  refetch: () => Promise<void>;
};

/**
 * Hooks over a `createLive(...)` instance:
 *
 *   const { useQuery, useMutation } = createLiveHooks(live);
 *   const messages = useQuery('messages.list', { channel });   // refetches when its topics fire
 *   const send = useMutation('messages.send');
 *   send.mutate({ channel, body }, {
 *     optimistic: (store) => store.update('messages.list', { channel }, (list) => [...list, { _id: 'pending', _creationTime: Date.now(), channel, body }]),
 *   });
 */
export function createLiveHooks<R extends Typed>(live: Live<R>) {
  function useQuery<N extends keyof Procs<R> & string>(
    name: N,
    input: InputOf<Procs<R>[N]>,
    options: QueryOptions = {},
  ): UseQueryResult<OutputOf<Procs<R>[N]>> {
    // Decision: the input and topics are compared by value with sorted keys, so an inline object, or
    // the same object with its keys in another order, doesn't resubscribe.
    const key = `${stableKey(input)}:${stableKey(options.topics ?? null)}:${String(options.enabled)}`;
    const [kept, setKept] = useState({ key, input, options });
    if (kept.key !== key) {setKept({ key, input, options });}
    const handle = useMemo(() => live.query(name, kept.input, kept.options), [name, kept]);
    const state = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
    return { ...state, loading: state.status === 'loading', refetch: handle.refetch };
  }

  function useMutation<N extends keyof Procs<R> & string>(name: N) {
    const [pending, setPending] = useState(0);
    const [error, setError] = useState<Error | undefined>();
    const mutate = useCallback(
      async (input: InputOf<Procs<R>[N]>, options?: MutateOptions<R>) => {
        setPending((n) => n + 1);
        setError(undefined);
        try {
          return await live.mutate(name, input, options);
        } catch (error_) {
          const err = error_ instanceof Error ? error_ : new Error(String(error_));
          setError(err);
          throw err;
        } finally {
          setPending((n) => n - 1);
        }
      },
      [name],
    );
    return { mutate, pending: pending > 0, error };
  }

  return { useQuery, useMutation };
}
