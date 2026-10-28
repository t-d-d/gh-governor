/**
 * The starter: one fire off the queue, one dispatcher task, never beside a
 * running one. A dispatcher turn refreshes the stored login, and two turns
 * refreshing one login leave one of them dead, so a fire that finds a task
 * running is handed straight back to the queue, asked to re-offer it in
 * DEFER_SECONDS: the queue paces the retry, and no Lambda sits idle
 * waiting. After the attempts run out the fire is dead-lettered and a
 * tripwire says so.
 *
 * Every I/O is injected; the real ones (ECS, SQS) live in
 * dispatch/webhook/starter-handler.mjs, which a merge-gate test never imports.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFER_SECONDS, attemptFrom, handleRecords, startFire } from '../dispatch/webhook/starter.mjs';

const RUNNING = 'arn:aws:ecs:us-east-1:1:task/governor/running';
const STARTED = 'arn:aws:ecs:us-east-1:1:task/governor/new';

const harness = (over: Record<string, unknown> = {}) => {
  const started: unknown[] = [];
  const startedBy: string[] = [];
  const deferred: Array<[string, number]> = [];
  const logged: Array<Record<string, unknown>> = [];
  const deps = {
    running: async () => [] as string[],
    runTask: async (fire: unknown, by: string) => {
      started.push(fire);
      startedBy.push(by);
      return STARTED;
    },
    defer: async (receiptHandle: string, seconds: number) => {
      deferred.push([receiptHandle, seconds]);
    },
    log: (event: string, context: Record<string, unknown> = {}) => {
      logged.push({ event, ...context });
    },
    ...over,
  };
  return { deps, started, startedBy, deferred, logged };
};

const schedule = { fire: { kind: 'schedule' as const }, reason: 'schedule fire' };
const mention = { fire: { kind: 'dispatch' as const, prompt: 'A comment mentioned @claude…', sessionName: '@claude #717' }, reason: 'comment 77 on #717 mentioned @claude', delivery: 'd-1' };

describe('startFire', () => {
  test('starts the task at once when none is running, with the fire as the task\'s event', async () => {
    const { deps, started, logged } = harness();
    const arn = await startFire(mention, deps);
    assert.equal(arn, STARTED);
    assert.deepEqual(started, [mention.fire]);
    assert.ok(logged.some((l) => l.event === 'fire-started' && l.taskArn === STARTED && l.delivery === 'd-1'), JSON.stringify(logged));
  });

  // The stop event hands startedBy back, which is how the retrier knows a
  // task that failed to start was the lane's, and how many tries it had
  // (dispatch/webhook/retry.mjs).
  test('marks the task with the fire\'s attempt: the first, or the one the retrier queued', async () => {
    const { deps, startedBy, logged } = harness();
    await startFire(mention, deps);
    await startFire({ ...schedule, attempt: 3, retryOf: 'arn:…/old' }, deps);
    assert.deepEqual(startedBy.map(attemptFrom), [1, 3]);
    assert.ok(logged.some((l) => l.event === 'fire-started' && l.attempt === 3), JSON.stringify(logged));
  });

  // A deferral is as designed, not an error: it resolves rather than throws,
  // so the Lambda Errors metric and the account-wide safety net never see
  // it.
  test('defers the fire when a task is running, without throwing', async () => {
    const { deps, started, logged } = harness({ running: async () => [RUNNING] });
    assert.equal(await startFire(schedule, deps), undefined);
    assert.deepEqual(started, []);
    assert.ok(logged.some((l) => l.event === 'fire-deferred' && String(l.running).includes('running')), JSON.stringify(logged));
  });

  // startFire throws every failure; handleRecords is what turns a throw into
  // a fire handed back, and what logs it.
  test('a RunTask that throws is rethrown', async () => {
    const { deps } = harness({ runTask: async () => { throw new Error('RESOURCE:VCPU'); } });
    await assert.rejects(startFire(schedule, deps), /VCPU/);
  });

  // Undefined is what a deferral resolves to, so a RunTask that resolved
  // with no ARN must not read as one: that would re-offer a started fire.
  test('a RunTask that resolves with no task ARN is a failure, not a deferral', async () => {
    const { deps } = harness({ runTask: async () => '' });
    await assert.rejects(startFire(schedule, deps), /no task/);
  });

  test('refuses a message that carries no fire rather than starting a task with nothing to do', async () => {
    const { deps, started } = harness();
    await assert.rejects(startFire({ reason: 'empty' } as never, deps), /fire/);
    await assert.rejects(startFire({ fire: { kind: 'dispatch' }, reason: 'no prompt' } as never, deps), /prompt/);
    await assert.rejects(startFire({ fire: { kind: 'message', text: 'hi' }, reason: 'no session' } as never, deps), /session/);
    await assert.rejects(startFire({ fire: { kind: 'message', session: 'session_01ABC', text: ' ' }, reason: 'no text' } as never, deps), /text/);
    assert.deepEqual(started, []);
  });

  // A PR naming no session: the task finds the session on its head branch.
  test('starts a message that names the PR its head branch\'s session is found by in place of a session', async () => {
    const { deps, started } = harness();
    await startFire({ fire: { kind: 'message', byBranch: true, on: 4492, text: 'hi' }, reason: 'by branch' } as never, deps);
    assert.equal(started.length, 1);
  });
});

describe('handleRecords', () => {
  const record = (messageId: string, message: unknown) => ({ messageId, receiptHandle: `rh-${messageId}`, body: JSON.stringify(message) });

  test('starts the fire each SQS record carries, in order, and hands none back', async () => {
    const { deps, started } = harness();
    const result = await handleRecords([record('m-1', schedule), record('m-2', mention)], deps);
    assert.deepEqual(started, [schedule.fire, mention.fire]);
    assert.deepEqual(result, { batchItemFailures: [] });
  });

  // The queue re-offers a batch item failure after its visibility timeout
  // and counts the receive toward the dead-letter queue, as it did a throw.
  // The lane is FIFO, so nothing behind a deferred fire is started first.
  test('hands a deferred fire back to the queue as a batch item failure, with every record behind it', async () => {
    const { deps, started } = harness({ running: async () => [RUNNING] });
    const result = await handleRecords([record('m-1', schedule), record('m-2', mention)], deps);
    assert.deepEqual(started, []);
    assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm-1' }, { itemIdentifier: 'm-2' }] });
  });

  // The queue's own visibility timeout is how long an invocation may hold
  // a fire, a minute; left to it, the lane ran one fire a minute however
  // short the task (2026-09-26: thirteen fires ahead, fourteen minutes to
  // the session). The deferred fire is asked back sooner, by its receipt
  // handle; the records behind it wait the full timeout, since the lane is
  // FIFO and they are behind it either way.
  test('asks the queue to re-offer the deferred fire in seconds, the pace of the lane', async () => {
    const { deps, deferred } = harness({ running: async () => [RUNNING] });
    await handleRecords([record('m-1', schedule), record('m-2', mention)], deps);
    assert.deepEqual(deferred, [['rh-m-1', DEFER_SECONDS]]);
    assert.ok(DEFER_SECONDS <= 10, `a deferred fire idles ${DEFER_SECONDS}s past the end of the task before it`);
  });

  test('a fire started at once is not asked back', async () => {
    const { deps, deferred } = harness();
    await handleRecords([record('m-1', schedule)], deps);
    assert.deepEqual(deferred, []);
  });

  // A refused ChangeMessageVisibility costs the fire the full visibility
  // timeout, nothing more: it is still handed back. A throw here would be a
  // Lambda error, paging the account-wide safety net for a slower re-offer.
  test('a re-offer the queue refused is logged, and the fire is still handed back', async () => {
    const { deps, logged } = harness({ running: async () => [RUNNING], defer: async () => { throw new Error('ReceiptHandleIsInvalid'); } });
    const result = await handleRecords([record('m-1', schedule)], deps);
    assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm-1' }] });
    assert.ok(logged.some((l) => l.event === 'fire-defer-failed' && l.messageId === 'm-1' && /ReceiptHandle/.test(String(l.error))), JSON.stringify(logged));
  });

  test('a fire started before the deferral is not handed back: only the deferred one and those behind it are', async () => {
    let checks = 0;
    const { deps, started } = harness({ running: async () => (checks++ === 0 ? [] : [RUNNING]) });
    const result = await handleRecords([record('m-1', schedule), record('m-2', mention), record('m-3', schedule)], deps);
    assert.deepEqual(started, [schedule.fire]);
    assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm-2' }, { itemIdentifier: 'm-3' }] });
  });

  // A fire that fails is handed back at the deferral's pace, not thrown. A
  // throw came back after the queue's minute of visibility, so the 180
  // receives sized for the ten-second pace held the single-group lane for
  // three hours before the dead-letter tripwire; re-offered in seconds, a
  // throw was six Lambda errors a minute, the burst that paged the
  // account-wide safety net.
  // Handed back at the same pace, it spends the same half hour a deferral
  // does and counts toward no Errors metric.
  for (const [name, over, body, error] of [
    ['a RunTask that throws', { runTask: async () => { throw new Error('RESOURCE:VCPU'); } }, JSON.stringify(schedule), /VCPU/],
    ['a running-task check that throws', { running: async () => { throw new Error('ThrottlingException'); } }, JSON.stringify(schedule), /Throttling/],
    ['a message that carries no fire', {}, JSON.stringify({ reason: 'empty' }), /fire/],
    ['a body that is not JSON', {}, '{not json', /JSON/],
  ] as const) {
    test(`${name} is logged and handed back at the deferral's pace, not thrown`, async () => {
      const { deps, deferred, logged, started } = harness(over);
      const result = await handleRecords([{ messageId: 'm-1', receiptHandle: 'rh-m-1', body }, record('m-2', mention)], deps);
      assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm-1' }, { itemIdentifier: 'm-2' }] });
      assert.deepEqual(deferred, [['rh-m-1', DEFER_SECONDS]]);
      assert.ok(!started.includes(mention.fire), 'nothing behind the failed fire is started');
      assert.ok(logged.some((l) => l.event === 'fire-failed' && l.messageId === 'm-1' && error.test(String(l.error))), JSON.stringify(logged));
    });
  }

  // The dead-letter tripwire sends the operator to the starter's log for
  // why, so a failure names the fire it failed: its kind and its delivery.
  test('a fire that fails is logged with the fire it was', async () => {
    const { deps, logged } = harness({ runTask: async () => { throw new Error('RESOURCE:VCPU'); } });
    await handleRecords([record('m-1', mention)], deps);
    assert.ok(logged.some((l) => l.event === 'fire-failed' && l.kind === 'dispatch' && l.delivery === 'd-1' && l.reason === mention.reason), JSON.stringify(logged));
  });
});
