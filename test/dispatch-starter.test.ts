/**
 * The starter only starts tasks. It holds no fire: each call asks whether a
 * fire waits on the lane and whether a dispatcher task runs, and starts one
 * when a fire waits and none runs. The task takes the fires itself
 * (dispatch/lane.mjs). Three things call it: the receiver after it queues a
 * fire, every task's stop event, and a schedule every minute as a backstop.
 *
 * Every I/O is injected; the real ones (ECS, SQS) live in
 * dispatch/webhook/starter-handler.mjs, which a merge-gate test never imports.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_START_ATTEMPTS, START_GRACE_MS, attemptFrom, callerOf, startNext, startedByFor } from '../dispatch/webhook/starter.mjs';

const RUNNING = 'arn:aws:ecs:us-east-1:123456789012:task/governor/running';
const STARTED = 'arn:aws:ecs:us-east-1:123456789012:task/governor/new';
const STOPPED = 'arn:aws:ecs:us-east-1:123456789012:task/governor/stopped';

const harness = (over: Record<string, unknown> = {}) => {
  const startedBy: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const clock = { at: 1_000_000 };
  const deps = {
    memory: {},
    now: () => clock.at,
    running: async () => {
      asked.push('running');
      return [] as string[];
    },
    waiting: async () => {
      asked.push('waiting');
      return 1;
    },
    runTask: async (by: string) => {
      startedBy.push(by);
      return STARTED;
    },
    log: (event: string, context: Record<string, unknown> = {}) => {
      logged.push({ event, ...context });
    },
    ...over,
  };
  return { deps, startedBy, logged, asked, clock };
};

const poke = { caller: 'receiver', messageIds: ['m1'] };
const backstop = { caller: 'backstop' };
const stop = (detail: Record<string, unknown>) => ({ source: 'aws.ecs', 'detail-type': 'ECS Task State Change', detail: { taskArn: STOPPED, lastStatus: 'STOPPED', ...detail } });
const ran = stop({ stopCode: 'EssentialContainerExited', startedBy: startedByFor(1) });
const failedToStart = (attempt: number) => stop({ stopCode: 'TaskFailedToStart', startedBy: startedByFor(attempt), stoppedReason: 'CannotPullContainerError: not found' });

describe('callerOf', () => {
  test('tells the receiver, a stop and the backstop apart, and nothing else', () => {
    assert.equal(callerOf(poke), 'receiver');
    assert.equal(callerOf(backstop), 'backstop');
    assert.equal(callerOf(ran), 'stop');
    assert.equal(callerOf({}), undefined);
    assert.equal(callerOf({ Records: [] }), undefined);
  });
});

describe('startNext', () => {
  test('starts a task when a fire waits and none runs, and logs it with what called it', async () => {
    for (const event of [backstop, ran]) {
      const { deps, startedBy, logged } = harness();
      assert.equal(await startNext(event, deps), STARTED);
      assert.deepEqual(startedBy, [startedByFor(1)]);
      assert.equal(logged.length, 1);
      assert.equal(logged[0]?.event, 'task-started');
      assert.equal(logged[0]?.taskArn, STARTED);
      assert.equal(logged[0]?.caller, callerOf(event));
      assert.equal(logged[0]?.attempt, 1);
    }
  });

  test('starts nothing while a task runs: that task takes the fire', async () => {
    for (const event of [poke, backstop, ran]) {
      const { deps, startedBy, logged } = harness({ running: async () => [RUNNING] });
      assert.equal(await startNext(event, deps), undefined);
      assert.deepEqual(startedBy, []);
      assert.deepEqual(logged, [], 'doing nothing is the usual answer, and not worth a line');
    }
  });

  test('starts nothing when no fire waits', async () => {
    for (const event of [backstop, ran]) {
      const { deps, startedBy, logged } = harness({ waiting: async () => 0 });
      assert.equal(await startNext(event, deps), undefined);
      assert.deepEqual(startedBy, []);
      assert.deepEqual(logged, []);
    }
  });

  // The queue's counts are approximate and may lag a send. The receiver only
  // calls after the lane took its fire, so its call is a fire waiting.
  test('the receiver\'s call counts as a fire waiting, without asking the lane', async () => {
    const { deps, startedBy, asked } = harness({ waiting: async () => 0 });
    assert.equal(await startNext(poke, deps), STARTED);
    assert.deepEqual(startedBy, [startedByFor(1)]);
    assert.deepEqual(asked, ['running']);
  });

  test('asks whether a task runs before it counts the lane', async () => {
    const { deps, asked } = harness();
    await startNext(backstop, deps);
    assert.deepEqual(asked, ['running', 'waiting']);
  });

  test('a task that failed to start is followed by the next attempt, up to MAX_START_ATTEMPTS in a row', async () => {
    for (let attempt = 1; attempt < MAX_START_ATTEMPTS; attempt += 1) {
      const { deps, startedBy, logged } = harness();
      assert.equal(await startNext(failedToStart(attempt), deps), STARTED);
      assert.deepEqual(startedBy, [startedByFor(attempt + 1)]);
      assert.equal(logged[0]?.attempt, attempt + 1);
      assert.equal(logged[0]?.stopped, STOPPED);
      assert.match(String(logged[0]?.stoppedReason), /CannotPullContainerError/);
    }
  });

  test('past MAX_START_ATTEMPTS it starts nothing more for the chain and logs at error, which pages', async () => {
    const { deps, startedBy, logged, asked } = harness();
    assert.equal(await startNext(failedToStart(MAX_START_ATTEMPTS), deps), undefined);
    assert.deepEqual(startedBy, []);
    assert.deepEqual(asked, []);
    assert.equal(logged[0]?.event, 'start-gave-up');
    assert.equal(logged[0]?.level, 'error');
    assert.equal(logged[0]?.attempts, MAX_START_ATTEMPTS);
    assert.ok(MAX_START_ATTEMPTS >= 2 && MAX_START_ATTEMPTS <= 5);
  });

  test('after it gives up, the next poke or the backstop begins a new chain', async () => {
    for (const next of [poke, backstop]) {
      const { deps, startedBy } = harness();
      await startNext(backstop, deps);
      await startNext(stop({ taskArn: STARTED, stopCode: 'TaskFailedToStart', startedBy: startedByFor(MAX_START_ATTEMPTS) }), deps);
      await startNext(next, deps);
      assert.deepEqual(startedBy, [startedByFor(1), startedByFor(1)]);
    }
  });

  // A probe, or a task run by hand, carries no attempt of the starter's.
  test('a task the starter did not start that failed to start begins a chain of its own', async () => {
    const { deps, startedBy } = harness();
    await startNext(stop({ stopCode: 'TaskFailedToStart', startedBy: 'someone' }), deps);
    assert.deepEqual(startedBy, [startedByFor(1)]);
  });

  test('a call it does not recognise starts nothing and says so', async () => {
    const { deps, startedBy, logged } = harness();
    assert.equal(await startNext({ Records: [] }, deps), undefined);
    assert.deepEqual(startedBy, []);
    assert.equal(logged[0]?.event, 'start-ignored');
  });

  // Nothing is lost: the fire never left the lane, and the backstop calls
  // again within a minute. A throw would only be Lambda retrying the same call.
  test('a call to ECS or the lane that fails is logged at error, not thrown', async () => {
    for (const over of [
      { running: async () => { throw new Error('ThrottlingException'); } },
      { waiting: async () => { throw new Error('AccessDenied'); } },
      { runTask: async () => { throw new Error('RunTask placed nothing: [{"reason":"RESOURCE:ENI"}]'); } },
    ]) {
      const { deps, logged } = harness(over);
      assert.equal(await startNext(backstop, deps), undefined);
      assert.equal(logged[0]?.event, 'start-failed');
      assert.equal(logged[0]?.level, 'error');
      assert.equal(logged[0]?.caller, 'backstop');
    }
  });
});

describe('attemptFrom', () => {
  test('reads back the attempt the starter set, and nothing else', () => {
    assert.equal(attemptFrom(startedByFor(2)), 2);
    assert.equal(attemptFrom('governor-starter/attempt-x'), undefined);
    assert.equal(attemptFrom(undefined), undefined);
    assert.match(startedByFor(1), /^[A-Za-z0-9_/-]{1,128}$/, 'ECS takes letters, digits, hyphens, underscores and slashes');
  });
});

/**
 * ECS's API is eventually consistent: ListTasks may not show a task for a
 * few seconds after RunTask started it. Two calls that close together would
 * both see no task and start two, and two turns would refresh one login. So
 * the starter counts the task it last started as running until that task's
 * stop event arrives, or START_GRACE_MS passes.
 */
describe('startNext: the task it just started', () => {
  test('a second call while ListTasks does not yet show the new task starts nothing', async () => {
    const { deps, startedBy } = harness();
    assert.equal(await startNext(poke, deps), STARTED);
    assert.equal(await startNext(poke, deps), undefined);
    assert.equal(await startNext(backstop, deps), undefined);
    assert.deepEqual(startedBy, [startedByFor(1)]);
  });

  test('that task\'s stop event forgets it, so the next fire starts a task at once', async () => {
    const { deps, startedBy } = harness();
    await startNext(poke, deps);
    await startNext(stop({ taskArn: STARTED, stopCode: 'EssentialContainerExited', startedBy: startedByFor(1) }), deps);
    assert.deepEqual(startedBy, [startedByFor(1), startedByFor(1)]);
  });

  test('a failed start\'s stop forgets it too, so the next attempt starts', async () => {
    const { deps, startedBy } = harness();
    await startNext(poke, deps);
    await startNext(stop({ taskArn: STARTED, stopCode: 'TaskFailedToStart', startedBy: startedByFor(1) }), deps);
    assert.deepEqual(startedBy, [startedByFor(1), startedByFor(2)]);
  });

  test('another task\'s stop leaves it remembered', async () => {
    const { deps, startedBy } = harness();
    await startNext(poke, deps);
    await startNext(ran, deps);
    assert.deepEqual(startedBy, [startedByFor(1)]);
  });

  test('past START_GRACE_MS, ListTasks alone answers, so a lost stop event holds nothing for long', async () => {
    const { deps, startedBy, clock } = harness();
    await startNext(poke, deps);
    clock.at += START_GRACE_MS;
    await startNext(backstop, deps);
    assert.deepEqual(startedBy, [startedByFor(1), startedByFor(1)]);
    assert.ok(START_GRACE_MS >= 60_000 && START_GRACE_MS <= 5 * 60_000);
  });
});
