import { defineLiveStream } from '@builtbyfriends/bwf/live';
import { denied } from './access';

export const live = defineLiveStream({
  id: 'app',
  allowAnonymousControl: true,
  identifyConnection: () => 'tester',
  onSubscribe: (ctx) => (denied.has(ctx.topic) ? new Response('Forbidden', { status: 403 }) : undefined),
});
