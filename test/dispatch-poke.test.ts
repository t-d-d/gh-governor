/**
 * The receiver calls the starter once a request has queued its fires, so a
 * fire starts its task in seconds rather than at the backstop's next minute.
 * A failed call loses nothing: the fire is on the lane, and the backstop
 * starts it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { poking } from '../dispatch/webhook/poke.mjs';

const harness = (over: { invoke?: (payload: unknown) => Promise<void>; enqueue?: (message: unknown, dedupId?: string) => Promise<string> } = {}) => {
  const invoked: unknown[] = [];
  const logged: Array<Record<string, unknown>> = [];
  let n = 0;
  const base = {
    enqueue: over.enqueue ?? (async () => `m${++n}`),
    log: (event: string, context: Record<string, unknown> = {}) => {
      logged.push({ event, ...context });
    },
  };
  const invoke = over.invoke ?? (async (payload: unknown) => {
    invoked.push(payload);
  });
  return { base, invoke, invoked, logged };
};

describe('poking', () => {
  test('one call to the starter for every fire the request queued, after they are queued', async () => {
    const { base, invoke, invoked } = harness();
    const { deps, poke } = poking(base, invoke);
    assert.equal(await deps.enqueue({ fire: { kind: 'schedule' } }, 'd1'), 'm1');
    assert.equal(await deps.enqueue({ fire: { kind: 'schedule' } }, 'd2'), 'm2');
    assert.deepEqual(invoked, [], 'the starter is called once the fires are on the lane, not before');
    await poke();
    assert.deepEqual(invoked, [{ caller: 'receiver', messageIds: ['m1', 'm2'] }]);
  });

  test('a request that queued nothing calls nobody', async () => {
    const { base, invoke, invoked } = harness();
    await poking(base, invoke).poke();
    assert.deepEqual(invoked, []);
  });

  test('a fire the lane refused is not counted, and its error is the request\'s, as before', async () => {
    const { base, invoke, invoked } = harness({ enqueue: async () => { throw new Error('throttled'); } });
    const { deps, poke } = poking(base, invoke);
    await assert.rejects(deps.enqueue({ fire: { kind: 'schedule' } }), /throttled/);
    await poke();
    assert.deepEqual(invoked, []);
  });

  test('a call that failed is logged at error, and not thrown: the fire is stored, and the backstop starts it', async () => {
    const { base, logged } = harness();
    const { deps, poke } = poking(base, async () => { throw new Error('TooManyRequestsException'); });
    await deps.enqueue({ fire: { kind: 'schedule' } });
    await poke();
    assert.equal(logged[0]?.event, 'starter-poke-failed');
    assert.equal(logged[0]?.level, 'error');
    assert.deepEqual(logged[0]?.messageIds, ['m1']);
    assert.match(String(logged[0]?.error), /TooManyRequests/);
  });
});
