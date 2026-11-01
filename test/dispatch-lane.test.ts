/**
 * The task's lane: a dispatcher task takes fires off governor-fires.fifo one
 * at a time and runs each as its own turn, until the lane has been empty for
 * the idle grace, so a burst pays one cold start.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_GRACE_MS, RECEIVE_WAIT_SECONDS, TAKE_FIRES_FOR_MS, work } from '../dispatch/lane.mjs';

type Logged = { event: string; [key: string]: unknown };
type Message = { messageId: string; receiptHandle: string; body: string };

const fireMessage = (id: string, fire: unknown, reason = `reason ${id}`): Message => ({
  messageId: id,
  receiptHandle: `rh-${id}`,
  body: JSON.stringify({ fire, reason }),
});

/**
 * A fake lane. Each receive answers the next scripted message, or waits the
 * whole long poll and answers nothing; `clock` moves with every wait and
 * every turn.
 */
const harness = (script: Array<Message | null>, over: Record<string, unknown> = {}) => {
  const logged: Logged[] = [];
  const calls: string[] = [];
  const turns: Array<{ fire: unknown; messageId: string }> = [];
  const dead: Array<{ body: string; reason: string; messageId: string }> = [];
  const waits: number[] = [];
  const clock = { at: 1_000_000 };
  const deps = {
    receive: async (waitSeconds: number) => {
      waits.push(waitSeconds);
      calls.push('receive');
      const next = script.shift();
      if (next === undefined || next === null) {
        clock.at += waitSeconds * 1000;
        return null;
      }
      return next;
    },
    remove: async (receiptHandle: string) => {
      calls.push(`remove ${receiptHandle}`);
    },
    deadLetter: async (body: string, reason: string, messageId: string) => {
      calls.push(`dead ${messageId}`);
      dead.push({ body, reason, messageId });
    },
    reset: () => {
      calls.push('reset');
    },
    turn: async (fire: unknown, messageId: string) => {
      calls.push(`turn ${messageId}`);
      turns.push({ fire, messageId });
      clock.at += 25_000;
    },
    now: () => clock.at,
    log: (event: string, context: Record<string, unknown> = {}) => {
      logged.push({ event, ...context });
    },
    ...over,
  };
  return { deps, logged, calls, turns, dead, waits, clock };
};

describe('work', () => {
  test('runs two fires off the lane in lane order, each its own turn, deleting each as it takes it', async () => {
    const a = { kind: 'schedule' };
    const b = { kind: 'review', repo: 'acme/factory', pr: 12 };
    const { deps, calls, turns, logged } = harness([fireMessage('m1', a), fireMessage('m2', b)]);
    const code = await work(deps as never);
    assert.equal(code, 0);
    assert.deepEqual(turns, [{ fire: a, messageId: 'm1' }, { fire: b, messageId: 'm2' }]);
    // Deleted before the turn: a turn that fails is not retried, and a fire
    // still held would block the lane's one group behind it.
    assert.deepEqual(calls.slice(0, 7), ['receive', 'remove rh-m1', 'reset', 'turn m1', 'receive', 'remove rh-m2', 'reset']);
    const taken = logged.filter((l) => l.event === 'fire-taken');
    assert.deepEqual(taken, [
      { event: 'fire-taken', messageId: 'm1', kind: 'schedule', reason: 'reason m1' },
      { event: 'fire-taken', messageId: 'm2', kind: 'review', reason: 'reason m2' },
    ]);
  });

  test('never runs two turns at once', async () => {
    let inTurn = 0;
    let most = 0;
    const { deps } = harness([fireMessage('m1', { kind: 'schedule' }), fireMessage('m2', { kind: 'schedule' }), fireMessage('m3', { kind: 'schedule' })], {
      turn: async () => {
        inTurn += 1;
        most = Math.max(most, inTurn);
        await new Promise((settle) => setImmediate(settle));
        inTurn -= 1;
      },
    });
    await work(deps as never);
    assert.equal(most, 1);
  });

  test('exits once the lane has been empty for the whole idle grace after the last turn', async () => {
    const { deps, logged, waits, clock } = harness([fireMessage('m1', { kind: 'schedule' })]);
    const begun = clock.at;
    await work(deps as never);
    const idle = logged.at(-1);
    assert.equal(idle?.event, 'lane-idle');
    assert.equal(idle?.taken, 1);
    // One turn of 25 s, then long polls adding up to the grace exactly.
    assert.equal(clock.at - begun, 25_000 + IDLE_GRACE_MS);
    assert.ok(waits.every((w) => w >= 1 && w <= RECEIVE_WAIT_SECONDS), JSON.stringify(waits));
    assert.ok(RECEIVE_WAIT_SECONDS <= 20, 'SQS long-polls for 20 seconds at most');
  });

  test('a fire that lands during the grace is taken, and the grace starts again after its turn', async () => {
    const { deps, turns } = harness([null, fireMessage('m1', { kind: 'schedule' }), null, null, fireMessage('m2', { kind: 'schedule' })]);
    await work(deps as never);
    assert.deepEqual(turns.map((t) => t.messageId), ['m1', 'm2']);
  });

  test('an idle grace of 20 to 60 seconds', () => {
    assert.ok(IDLE_GRACE_MS >= 20_000 && IDLE_GRACE_MS <= 60_000, String(IDLE_GRACE_MS));
  });

  // A long burst would otherwise keep running the image the task started
  // with long after a deploy.
  test('stops taking fires once it has taken them for TAKE_FIRES_FOR_MS, leaving the rest on the lane', async () => {
    const script = Array.from({ length: 200 }, (_, i) => fireMessage(`m${i}`, { kind: 'schedule' }));
    const { deps, turns, logged, clock } = harness(script);
    const begun = clock.at;
    await work(deps as never);
    assert.ok(turns.length < 200);
    assert.ok(clock.at - begun >= TAKE_FIRES_FOR_MS);
    assert.ok(clock.at - begun < TAKE_FIRES_FOR_MS + 25_000, 'it takes no fire past the limit');
    assert.equal(logged.at(-1)?.event, 'lane-left');
    assert.ok(TAKE_FIRES_FOR_MS <= 60 * 60 * 1000, 'an hour is the most a deploy waits on a burst');
  });

  test('a fire the parser refuses goes to the dead-letter queue at once, as it came, and the task goes on', async () => {
    const bad = fireMessage('m1', { kind: 'stars' });
    const notJson = { messageId: 'm2', receiptHandle: 'rh-m2', body: 'not json' };
    const { deps, calls, dead, turns, logged } = harness([bad, notJson, fireMessage('m3', { kind: 'schedule' })]);
    await work(deps as never);
    assert.deepEqual(dead.map((d) => [d.messageId, d.body]), [['m1', bad.body], ['m2', 'not json']]);
    assert.match(dead[0]!.reason, /the task refuses it/);
    // Moved, then deleted: a delete first would lose the fire if the move failed.
    assert.ok(calls.indexOf('dead m1') < calls.indexOf('remove rh-m1'));
    assert.deepEqual(turns.map((t) => t.messageId), ['m3']);
    const refused = logged.filter((l) => l.event === 'fire-refused');
    assert.equal(refused.length, 2);
    assert.equal(refused[0]?.level, 'error');
    assert.equal(refused[0]?.messageId, 'm1');
  });

  test('a refused fire the dead-letter queue would not take stays on the lane, logged at error', async () => {
    const { deps, calls, logged } = harness([fireMessage('m1', { kind: 'stars' })], {
      deadLetter: async () => {
        throw new Error('AccessDenied');
      },
    });
    await work(deps as never);
    assert.ok(!calls.includes('remove rh-m1'), 'deleted with nowhere to go, the fire is lost');
    const line = logged.find((l) => l.event === 'fire-refused-unmoved');
    assert.equal(line?.level, 'error');
    assert.match(String(line?.moveError), /AccessDenied/);
  });

  test('a fire it could not delete is not run: the lane offers it again', async () => {
    const { deps, turns, logged } = harness([fireMessage('m1', { kind: 'schedule' })], {
      remove: async () => {
        throw new Error('ReceiptHandleIsInvalid');
      },
    });
    await work(deps as never);
    assert.deepEqual(turns, [], 'run and offered again, the fire would run twice');
    const line = logged.find((l) => l.event === 'fire-untaken');
    assert.equal(line?.level, 'error');
    assert.equal(line?.messageId, 'm1');
  });

  test('a lane it cannot read ends the task as a failure the metric filter counts', async () => {
    const { deps, logged } = harness([], {
      receive: async () => {
        throw new Error('AccessDenied: sqs:ReceiveMessage');
      },
    });
    const code = await work(deps as never);
    assert.equal(code, 1);
    assert.equal(logged.at(-1)?.event, 'dispatch-failed');
    assert.equal(logged.at(-1)?.reason, 'lane-unread');
  });
});

describe('clearTurnState', () => {
  // A long-lived task must not hand one turn's login, working directory or
  // origin remote to the next: the turn's directory keeps the first origin
  // it was given, so the next fire's message would run in another repo's.
  test('clears what a turn leaves behind, so each fire starts as a fresh task did', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { clearTurnState } = await import('../dispatch/turn.mjs');
    const root = mkdtempSync(join(tmpdir(), 'governor-lane-'));
    const home = join(root, 'home');
    const work = join(root, 'work', 'repo');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    writeFileSync(join(home, '.claude.json'), '{}');
    writeFileSync(join(home, '.profile'), 'kept');
    mkdirSync(join(work, '.git'), { recursive: true });
    mkdirSync(join(root, 'work', 'repos', 'acme', 'factory'), { recursive: true });
    clearTurnState({ HOME: home, DISPATCH_WORKDIR: work });
    assert.deepEqual(readdirSync(home), ['.profile'], 'only what the image put there stays');
    assert.equal(existsSync(work), false);
    assert.equal(existsSync(join(root, 'work', 'repos')), false);
    clearTurnState({ HOME: home, DISPATCH_WORKDIR: work });
  });
});
