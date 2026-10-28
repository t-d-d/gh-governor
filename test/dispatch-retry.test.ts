/**
 * The retrier: a dispatcher task that stopped without running its container
 * (a pull that came back "not found", no placement, an ENI that would not
 * attach) dropped its fire, since the starter was done with the message once
 * RunTask succeeded. The ECS stop event carries the fire, on the
 * container override, and the attempt, on the task's startedBy; the retrier
 * puts the fire back on the lane until the attempts run out, then onto the
 * dead-letter queue, whose tripwire pages.
 *
 * Every I/O is injected; the real ones (SQS) live in
 * dispatch/webhook/retry-handler.mjs, which a merge-gate test never imports.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_START_ATTEMPTS, retryFire } from '../dispatch/webhook/retry.mjs';
import { attemptFrom, startedByFor } from '../dispatch/webhook/starter.mjs';

const TASK = 'arn:aws:ecs:us-east-1:1:task/governor/a6202835d81d463781a90d316c4cb79a';
const PULL = 'CannotPullContainerError: failed to resolve ref …/governor@sha256:841abe76… for schema1 conversion: not found';
const review = { kind: 'review', pr: 4403, headSha: 'b167c3a5'.padEnd(40, '0'), repo: 'acme/factory' };

/** The ECS Task State Change event the not-run rule matches, as EventBridge delivers it. */
const stopped = (over: { startedBy?: string | undefined, fire?: unknown, stoppedReason?: string } = {}) => ({
  source: 'aws.ecs',
  'detail-type': 'ECS Task State Change',
  detail: {
    taskArn: TASK,
    lastStatus: 'STOPPED',
    stopCode: 'TaskFailedToStart',
    stoppedReason: over.stoppedReason ?? PULL,
    // An explicit undefined is a task with no startedBy at all.
    ...('startedBy' in over && over.startedBy === undefined ? {} : { startedBy: over.startedBy ?? startedByFor(1) }),
    overrides: {
      containerOverrides: [{
        name: 'dispatch',
        environment: [{ name: 'DISPATCH_EVENT', value: JSON.stringify('fire' in over ? over.fire : review) }],
      }],
    },
  },
});

const harness = (over: Record<string, unknown> = {}) => {
  const requeued: Array<[Record<string, unknown>, string]> = [];
  const dead: Array<[Record<string, unknown>, string]> = [];
  const logged: Array<Record<string, unknown>> = [];
  const deps = {
    requeue: async (message: Record<string, unknown>, dedupId: string) => { requeued.push([message, dedupId]); },
    deadLetter: async (message: Record<string, unknown>, dedupId: string) => { dead.push([message, dedupId]); },
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    ...over,
  };
  return { deps, requeued, dead, logged };
};

describe('the attempt a task carries', () => {
  // startedBy is the one field RunTask sets that the stop event hands back
  // untouched; ECS takes letters, digits, hyphens, underscores and slashes.
  test('round-trips through startedBy, within what ECS accepts there', () => {
    for (const n of [1, 2, MAX_START_ATTEMPTS, 17]) {
      assert.match(startedByFor(n), /^[A-Za-z0-9_/-]{1,128}$/);
      assert.equal(attemptFrom(startedByFor(n)), n);
    }
  });

  test('is none for a task the starter did not start (a probe, a task run by hand)', () => {
    assert.equal(attemptFrom(undefined), undefined);
    assert.equal(attemptFrom(''), undefined);
    assert.equal(attemptFrom('ecs-svc/123'), undefined);
  });
});

describe('retryFire', () => {
  test('puts the fire of a task that failed to start back on the lane, as the next attempt', async () => {
    const { deps, requeued, dead, logged } = harness();
    await retryFire(stopped(), deps);
    assert.equal(requeued.length, 1);
    const [message] = requeued[0]!;
    assert.deepEqual(message.fire, review);
    assert.equal(message.attempt, 2);
    assert.equal(message.retryOf, TASK);
    assert.match(String(message.reason), /attempt 2/);
    assert.deepEqual(dead, []);
    assert.ok(logged.some((l) => l.event === 'fire-retried' && l.attempt === 2 && l.taskArn === TASK && l.stoppedReason === PULL), JSON.stringify(logged));
  });

  // EventBridge retries a delivery the retrier threw on, and may deliver an
  // event twice; the lane deduplicates on the failed task, so one stop is
  // one retry. A retry's body also differs from the fire's first, so
  // content-based deduplication never swallows it.
  test('deduplicates on the failed task, so a redelivered stop is not a second retry', async () => {
    const { deps, requeued } = harness();
    await retryFire(stopped(), deps);
    await retryFire(stopped(), deps);
    const ids = requeued.map(([, id]) => id);
    assert.equal(new Set(ids).size, 1);
    assert.ok(ids[0]!.length <= 128, 'SQS takes 128 characters of deduplication id');
    assert.ok(ids[0]!.includes('a6202835d81d463781a90d316c4cb79a'));
  });

  test('a fire the lane retried is retried again, until the attempts run out', async () => {
    const { deps, requeued } = harness();
    await retryFire(stopped({ startedBy: startedByFor(MAX_START_ATTEMPTS - 1) }), deps);
    assert.equal(requeued[0]![0].attempt, MAX_START_ATTEMPTS);
  });

  // A persistent fault (an image deleted, a subnet gone) fails every
  // attempt; the dead-letter queue's tripwire is what pages it, and a
  // redrive gives the fire a fresh set of attempts.
  test('gives the fire to the dead-letter queue once the last attempt failed to start', async () => {
    const { deps, requeued, dead, logged } = harness();
    await retryFire(stopped({ startedBy: startedByFor(MAX_START_ATTEMPTS) }), deps);
    assert.deepEqual(requeued, []);
    assert.equal(dead.length, 1);
    const [message, id] = dead[0]!;
    assert.deepEqual(message.fire, review);
    assert.equal(message.attempt, undefined, 'a redriven fire starts its attempts afresh');
    assert.equal(message.stoppedReason, PULL);
    assert.ok(id.includes('a6202835d81d463781a90d316c4cb79a'));
    assert.ok(logged.some((l) => l.event === 'fire-gave-up' && l.attempts === MAX_START_ATTEMPTS), JSON.stringify(logged));
  });

  test('the bound is a few attempts: enough for a transient pull, few enough to page within the half hour', () => {
    assert.ok(MAX_START_ATTEMPTS >= 2 && MAX_START_ATTEMPTS <= 5, String(MAX_START_ATTEMPTS));
  });

  // A probe is started outside the lane, by the deploy or an operator who
  // is watching it; the not-run tripwire still counts its stop.
  test('leaves a task the starter did not start alone', async () => {
    const { deps, requeued, dead, logged } = harness();
    await retryFire(stopped({ startedBy: undefined }), deps);
    await retryFire(stopped({ startedBy: 'someone-else' }), deps);
    assert.deepEqual(requeued, []);
    assert.deepEqual(dead, []);
    assert.equal(logged.filter((l) => l.event === 'retry-skipped').length, 2);
  });

  // A starter task always carries its fire; one that does not is a broken
  // invariant, and a throw is the retrier's errors tripwire, whose
  // description sends the operator to the retry-failed line.
  test('throws on a starter task that carries no fire, rather than dropping it in silence', async () => {
    const { deps, logged } = harness();
    await assert.rejects(retryFire(stopped({ fire: undefined }), deps), /DISPATCH_EVENT/);
    const bare = stopped();
    bare.detail.overrides.containerOverrides = [];
    await assert.rejects(retryFire(bare, deps), /DISPATCH_EVENT/);
    const failed = logged.filter((l) => l.event === 'retry-failed');
    assert.equal(failed.length, 2, JSON.stringify(logged));
    assert.ok(failed.every((l) => l.taskArn === TASK && l.stoppedReason === PULL && /DISPATCH_EVENT/.test(String(l.error))), JSON.stringify(failed));
  });

  // The retrier reads the fire with the task's parser (dispatch/webhook/fire.mjs):
  // a fire the task would refuse would fail every attempt it was given, so it
  // goes straight to the dead-letter queue, whose tripwire pages.
  test('gives a fire the task would refuse to the dead-letter queue, not the lane', async () => {
    const { deps, requeued, dead, logged } = harness();
    await retryFire(stopped({ fire: { kind: 'review', headSha: 'main' } }), deps);
    assert.deepEqual(requeued, []);
    assert.equal(dead.length, 1);
    const [message] = dead[0]!;
    assert.deepEqual(message.fire, { kind: 'review', headSha: 'main' });
    assert.match(String(message.reason), /headSha/);
    assert.ok(logged.some((l) => l.event === 'fire-refused' && /headSha/.test(String(l.error))), JSON.stringify(logged));
  });

  // The lane's starter refuses a fire with no kind, which would hold the
  // FIFO lane; the parsed fire always has one.
  test('requeues the fire as the task reads it, so the starter can start it', async () => {
    const { deps, requeued } = harness();
    await retryFire(stopped({ fire: { source: 'aws.events', 'detail-type': 'Scheduled Event' } }), deps);
    assert.deepEqual(requeued[0]![0].fire, { kind: 'schedule' });
  });

  // A throw is what Lambda's async retries and the retrier's tripwire hear;
  // a caught SendMessage failure would be the lost fire again.
  test('a lane that refused the retry is logged and rethrown', async () => {
    const { deps, logged } = harness({ requeue: async () => { throw new Error('ThrottlingException'); } });
    await assert.rejects(retryFire(stopped(), deps), /Throttling/);
    assert.ok(logged.some((l) => l.event === 'retry-failed' && /Throttling/.test(String(l.error))));
  });
});
