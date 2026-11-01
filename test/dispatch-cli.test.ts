/**
 * The task's entrypoint: one turn from the event in DISPATCH_EVENT, the
 * result on the log, and an exit code the probe and the metric filter can
 * read. A Fargate task has no timeout of its own, so the entrypoint carries
 * the deadline that the Lambda's configuration used to.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEADLINE_MS, exitCodeFor, main } from '../dispatch/cli.mjs';

type Logged = { event: string; [key: string]: unknown };

const harness = (over: Record<string, unknown> = {}) => {
  const logged: Logged[] = [];
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cancelled: unknown[] = [];
  const args = {
    env: { DISPATCH_EVENT: '{"kind":"probe"}' },
    run: async (_event: unknown, _deps: unknown) => ({ kind: 'probe', ok: true, detail: 'pty-ok' }),
    deps: () => ({ real: true }),
    log: (event: string, context: Record<string, unknown> = {}) => {
      logged.push({ event, ...context });
    },
    exit: (code: number) => {
      exits.push(code);
    },
    schedule: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    cancel: (handle: unknown) => {
      cancelled.push(handle);
    },
    lane: () => {
      throw new Error('a task with an event on its override reads no lane');
    },
    ...over,
  };
  return { args, logged, exits, timers, cancelled };
};

const dispatched = (...outcomes: string[]) => ({
  kind: 'schedule' as const,
  dispatched: outcomes.map((outcome, i) => ({ issue: i + 1, outcome, sessionUrl: null })),
  heartbeat: outcomes.some((o) => o !== 'failed'),
  loginStored: false,
});

describe('exitCodeFor', () => {
  // An unblocked fire for a claimed ticket: the message to its session is the turn.
  test('an unblocked message that failed is a fault; one a gone session refused, or a close that queued its fires, is not', () => {
    assert.equal(exitCodeFor({ kind: 'unblocked', messaged: { ok: true, refused: false }, dispatched: [] }), 0);
    assert.equal(exitCodeFor({ kind: 'unblocked', messaged: { ok: false, refused: true }, dispatched: [] }), 0);
    assert.equal(exitCodeFor({ kind: 'unblocked', messaged: { ok: false, refused: false }, dispatched: [] }), 1);
    assert.equal(exitCodeFor({ kind: 'schedule', queued: ['acme/factory#7'], passedOver: [] } as never), 0);
  });

  test('a message is the CLI\'s answer: 0 delivered, 1 refused', () => {
    assert.equal(exitCodeFor({ kind: 'message', ok: true, sessionUrl: 'https://claude.ai/code/session_01ABC', error: null, loginStored: false }), 0);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, sessionUrl: null, error: 'archived', loginStored: false }), 1);
  });
  test('a refused message whose fallback session started is a success; one whose fallback failed too is not', () => {
    assert.equal(exitCodeFor({ kind: 'message', ok: false, sessionUrl: null, error: 'archived', loginStored: false, fallback: { outcome: 'dispatched', sessionUrl: 'https://claude.ai/code/session_01NEW' } }), 0);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, sessionUrl: null, error: 'archived', loginStored: false, fallback: { outcome: 'unconfirmed', sessionUrl: null } }), 0);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, sessionUrl: null, error: 'archived', loginStored: false, fallback: { outcome: 'failed', sessionUrl: null } }), 1);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, sessionUrl: null, error: 'archived', loginStored: false, fallback: { outcome: 'forwarded', sessionUrl: 'https://claude.ai/code/session_01NEW' } }), 0);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, sessionUrl: null, error: 'archived', loginStored: false, fallback: { outcome: 'skipped', sessionUrl: null } }), 0);
  });
  /**
   * A subscriber's message: a refusal is a gone subscriber, dropped
   * from the body, and no failure; a session's own push, not sent, is none
   * either. A send the CLI never answered still fails.
   */
  test('a refused subscriber, dropped or not, and a skipped own push exit 0; an unanswered send exits 1', () => {
    assert.equal(exitCodeFor({ kind: 'message', ok: false, answered: true, sessionUrl: null, error: 'archived', loginStored: false, fallback: null, dropped: true }), 0);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, answered: true, sessionUrl: null, error: 'archived', loginStored: false, fallback: null, dropped: false }), 0);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, answered: null, sessionUrl: null, error: null, loginStored: false, fallback: null, dropped: null, skipped: 'its own push, bbbbbbbbbbbb' }), 0);
    assert.equal(exitCodeFor({ kind: 'message', ok: false, answered: false, sessionUrl: null, error: 'network', loginStored: false, fallback: null, dropped: null }), 1);
  });
  /**
   * A workflow turn fails only on a fault: a send the CLI never
   * answered or answered with anything but the session gone, or a
   * breaker's fallback that started nothing. A refusal with no fallback is
   * a gone session, which owes nothing.
   */
  test('a workflow turn fails on a send nobody answered, a send failing on a live session, or a fallback that started nothing, not on a gone session', () => {
    const delivery = (over: Record<string, unknown>) => ({ prs: [1], session: 's', ok: true, answered: true, refused: false, error: null, fallback: null, ...over });
    const wf = (...deliveries: Array<Record<string, unknown>>) => ({ kind: 'workflow', reason: null, deliveries: deliveries.map(delivery), loginStored: false });
    assert.equal(exitCodeFor(wf()), 0, 'nobody to tell');
    assert.equal(exitCodeFor(wf({})), 0);
    assert.equal(exitCodeFor(wf({ ok: false, refused: true, error: 'archived' })), 0, 'a deploy note to a gone session');
    assert.equal(exitCodeFor(wf({ ok: false, refused: true, error: 'archived', fallback: { outcome: 'dispatched', sessionUrl: 'u' } })), 0);
    assert.equal(exitCodeFor(wf({ ok: false, refused: true, error: 'archived', fallback: { outcome: 'failed', sessionUrl: null } })), 1);
    assert.equal(exitCodeFor(wf({}, { ok: false, answered: false, error: 'ECONNRESET' })), 1);
    assert.equal(exitCodeFor(wf({ ok: false, error: 'Unable to get organization UUID' })), 1, 'the session may be live: the dispatcher failed');
  });

  test('a branch-run turn fails on a send nobody answered or one failing on a live session, not on a gone session or nobody to tell', () => {
    const delivery = (over: Record<string, unknown>) => ({ prs: [], session: 's', ok: true, answered: true, refused: false, error: null, fallback: null, ...over });
    const br = (...deliveries: Array<Record<string, unknown>>) => ({ kind: 'branch-run', reason: 'r', deliveries: deliveries.map(delivery), loginStored: false });
    assert.equal(exitCodeFor(br()), 0, 'nobody signed the commit or holds the branch');
    assert.equal(exitCodeFor(br({})), 0);
    assert.equal(exitCodeFor(br({ ok: false, refused: true, error: 'archived' })), 0, 'a gone session waits on nothing');
    assert.equal(exitCodeFor(br({ ok: false, answered: false, error: 'ECONNRESET' })), 1);
    assert.equal(exitCodeFor(br({ ok: false, error: 'Unable to get organization UUID' })), 1, 'the session may be live and waiting');
  });

  // A repo whose part of the turn failed fails the turn, whatever its kind.
  test('a non-empty unread exits 1 on every kind, refusal or not', () => {
    const unread = [{ repo: 'acme/factory', error: 'hook table: AccessDeniedException' }];
    assert.equal(exitCodeFor({ kind: 'workflow', reason: null, deliveries: [], loginStored: false, unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'job', deliveries: [], loginStored: false, unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'branch-run', deliveries: [], loginStored: false, unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'review', reviews: [], unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'conflicts', checks: [], unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'message', ok: true, sessionUrl: 'https://claude.ai/code/session_01ABC', error: null, loginStored: false, unread }), 1);
    assert.equal(exitCodeFor({ kind: 'hook', messaged: { ok: true }, unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'unblocked', messaged: { ok: true, refused: false }, dispatched: [], unread }), 1);
    assert.equal(exitCodeFor({ kind: 'schedule', refusal: 'type: bug is not one of acme/factory\'s ready labels', unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'message', refusal: 'acme/factory does not turn prMessages on', unread } as never), 1);
    assert.equal(exitCodeFor({ kind: 'message', refusal: 'acme/factory does not turn prMessages on', unread: [] } as never), 0);
  });

  test('a probe exits with what it proved', () => {
    assert.equal(exitCodeFor({ kind: 'probe', ok: true, detail: '' }), 0);
    assert.equal(exitCodeFor({ kind: 'probe', ok: false, detail: 'out of pty devices' }), 1);
  });

  test('a fire that started something, or had nothing to start, is a success', () => {
    assert.equal(exitCodeFor(dispatched('dispatched', 'failed')), 0);
    assert.equal(exitCodeFor(dispatched('unconfirmed')), 0);
    assert.equal(exitCodeFor(dispatched()), 0);
  });

  test('a fire whose every launch failed is a dispatcher that cannot dispatch', () => {
    assert.equal(exitCodeFor(dispatched('failed', 'failed')), 1);
  });
});

describe('main', () => {
  test('runs the event from DISPATCH_EVENT with the real dependencies, logs the result and exits 0', async () => {
    const seen: unknown[] = [];
    const { args, logged, exits } = harness({
      run: async (event: unknown, deps: unknown) => {
        seen.push(event, deps);
        return { kind: 'probe', ok: true, detail: 'pty-ok' };
      },
    });
    await main(args as never);
    assert.deepEqual(seen, [{ kind: 'probe' }, { real: true, claims: new Set(), unrecorded: new Set() }], 'the real dependencies, with the claims and pending records the deadline reads');
    assert.deepEqual(logged, [{ event: 'dispatch-result', kind: 'probe', ok: true, detail: 'pty-ok' }]);
    assert.deepEqual(exits, [0]);
  });

  test('a probe that proved nothing logs the failure the metric filter counts, and exits 1', async () => {
    const { args, logged, exits } = harness({
      run: async () => ({ kind: 'probe', ok: false, detail: 'out of pty devices' }),
    });
    await main(args as never);
    assert.equal(logged[0]?.event, 'dispatch-failed');
    assert.match(String(logged[0]?.detail), /pty/);
    assert.deepEqual(exits, [1]);
  });

  test('a message into an archived session is the caller\'s answer: exits 1, but is no dispatcher failure', async () => {
    const { args, logged, exits } = harness({
      env: { DISPATCH_EVENT: '{"kind":"message","session":"session_01OLD","text":"hi"}' },
      run: async () => ({ kind: 'message', ok: false, archived: true, sessionUrl: null, error: 'cloud session session_01OLD is archived and cannot accept new messages', loginStored: false }),
    });
    await main(args as never);
    assert.equal(logged[0]?.event, 'dispatch-result');
    assert.deepEqual(exits, [1]);
  });

  test('a message into an archived session in a turn with an unread repo is a dispatcher failure', async () => {
    const { args, logged, exits } = harness({
      env: { DISPATCH_EVENT: '{"kind":"message","session":"session_01OLD","text":"hi"}' },
      run: async () => ({ kind: 'message', ok: false, archived: true, sessionUrl: null, error: 'archived', loginStored: false, unread: [{ repo: 'acme/factory', error: 'hook table: AccessDeniedException' }] }),
    });
    await main(args as never);
    assert.equal(logged[0]?.event, 'dispatch-failed');
    assert.deepEqual(exits, [1]);
  });

  test('a message into an archived session in a turn whose heartbeat went unwritten is a dispatcher failure', async () => {
    const { args, logged, exits } = harness({
      env: { DISPATCH_EVENT: '{"kind":"message","session":"session_01OLD","text":"hi"}' },
      run: async () => ({ kind: 'message', ok: false, archived: true, sessionUrl: null, error: 'archived', loginStored: false, heartbeatUnwritten: [{ repo: 'acme/factory', error: 'Bad credentials' }] }),
    });
    await main(args as never);
    assert.equal(logged[0]?.event, 'dispatch-failed');
    assert.deepEqual(exits, [1]);
  });

  test('any other failed message is a dispatcher failure', async () => {
    const { args, logged, exits } = harness({
      env: { DISPATCH_EVENT: '{"kind":"message","session":"session_01ABC","text":"hi"}' },
      run: async () => ({ kind: 'message', ok: false, archived: false, sessionUrl: null, error: 'Error: --cloud requires a claude.ai login', loginStored: false }),
    });
    await main(args as never);
    assert.equal(logged[0]?.event, 'dispatch-failed');
    assert.deepEqual(exits, [1]);
  });

  test('a fire whose every launch failed is logged as a failure', async () => {
    const { args, logged, exits } = harness({
      env: { DISPATCH_EVENT: '{"kind":"schedule"}' },
      run: async () => dispatched('failed'),
    });
    await main(args as never);
    assert.equal(logged[0]?.event, 'dispatch-failed');
    assert.deepEqual(exits, [1]);
  });

  test('a turn that threw is logged with its error, and exits 1', async () => {
    const { args, logged, exits } = harness({
      run: async () => {
        throw new Error('the stored login is not a login: no refresh token');
      },
    });
    await main(args as never);
    assert.equal(logged[0]?.event, 'dispatch-failed');
    assert.match(String(logged[0]?.error), /not a login/);
    assert.deepEqual(exits, [1]);
  });

  // A turn that throws while a record is still pending ends the task, which
  // cuts the record off, so the entrypoint's catch logs it as the deadline does.
  test('a turn that threw logs each session record still pending, naming the session', async () => {
    const { args, logged, exits } = harness({
      run: async (_event: unknown, deps: { unrecorded: Set<{ repo: string; sessionName: string; sessionUrl: string }> }) => {
        deps.unrecorded.add({ repo: 'acme/factory', sessionName: 'Issue 7', sessionUrl: 'https://claude.ai/code/session_01ABC' });
        throw new Error('the heartbeat write threw');
      },
    });
    await main(args as never);
    assert.deepEqual(logged.map((l) => [l.event, l.repo, l.sessionUrl]), [['dispatch-session-unrecorded', 'acme/factory', 'https://claude.ai/code/session_01ABC'], ['dispatch-failed', undefined, undefined]]);
    assert.equal(logged[0]?.level, 'error');
    assert.equal(logged[0]?.sessionName, 'Issue 7');
    assert.match(String(logged[0]?.error), /threw/);
    assert.match(String(logged[0]?.reason), /human-only path/);
    assert.deepEqual(exits, [1]);
  });

  test('an event that is not JSON runs nothing', async () => {
    for (const env of [{ DISPATCH_EVENT: 'schedule' }, { DISPATCH_EVENT: '{' }]) {
      let ran = false;
      const { args, logged, exits } = harness({
        env,
        run: async () => {
          ran = true;
          return dispatched();
        },
      });
      await main(args as never);
      assert.equal(ran, false, JSON.stringify(env));
      assert.equal(logged[0]?.event, 'dispatch-failed');
      assert.deepEqual(exits, [1]);
    }
  });

  test('arms a deadline before the turn, past which the task dies as a failure', async () => {
    let armedAtTurn = -1;
    const { args, logged, exits, timers } = harness({
      run: async () => {
        armedAtTurn = timers.length;
        return { kind: 'probe', ok: true, detail: 'pty-ok' };
      },
    });
    await main(args as never);
    assert.equal(armedAtTurn, 1, 'a deadline armed after the turn cannot bound a turn that hangs');
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.ms, DEADLINE_MS);
    assert.ok(DEADLINE_MS >= 10 * 60 * 1000, 'two sessions at four minutes each, and the reads around them');
    timers[0]!.fn();
    assert.deepEqual(logged.at(-1), { event: 'dispatch-failed', reason: 'deadline', deadlineMs: DEADLINE_MS });
    assert.deepEqual(exits.at(-1), 1);
  });

  // The deadline unwinds nothing, so the turn's open claims, each a
  // ticket under development with no marker naming its session, are logged here.
  test('the deadline logs each claim the turn still held open, naming the ticket', async () => {
    const { args, logged, exits, timers } = harness({
      run: async (_event: unknown, deps: { claims: Set<string> }) => {
        deps.claims.add('t-d-d/askme-mcp#717');
        return new Promise(() => {});
      },
    });
    void main(args as never);
    await new Promise((settle) => setImmediate(settle));
    timers[0]!.fn();
    assert.deepEqual(logged.map((l) => [l.event, l.repo, l.issue]), [['dispatch-claim-stranded', 't-d-d/askme-mcp', 717], ['dispatch-failed', undefined, undefined]]);
    assert.match(String(logged[0]?.reason), /deadline/);
    assert.deepEqual(exits, [1]);
  });

  // A session's record is written in the background. One still pending when
  // the deadline ends the turn never lands, so the deadline logs it.
  test('the deadline logs each session record still pending, naming the session', async () => {
    const { args, logged, exits, timers } = harness({
      run: async (_event: unknown, deps: { unrecorded: Set<{ repo: string; sessionName: string; sessionUrl: string }> }) => {
        deps.unrecorded.add({ repo: 'acme/factory', sessionName: 'Issue 7', sessionUrl: 'https://claude.ai/code/session_01ABC' });
        return new Promise(() => {});
      },
    });
    void main(args as never);
    await new Promise((settle) => setImmediate(settle));
    timers[0]!.fn();
    assert.deepEqual(logged.map((l) => [l.event, l.repo, l.sessionUrl]), [['dispatch-session-unrecorded', 'acme/factory', 'https://claude.ai/code/session_01ABC'], ['dispatch-failed', undefined, undefined]]);
    assert.equal(logged[0]?.level, 'error');
    assert.equal(logged[0]?.sessionName, 'Issue 7');
    assert.match(String(logged[0]?.error), /deadline/);
    assert.match(String(logged[0]?.reason), /human-only path/);
    assert.deepEqual(exits, [1]);
  });
});

/**
 * With no event on its override, the task is the lane's reader
 * (dispatch/lane.mjs): each fire it takes is its own turn, under its own
 * deadline, and its result line names the fire's message.
 */
describe('main: the lane', () => {
  const laneOf = (bodies: unknown[]) => {
    const script = bodies.map((fire, i) => ({ messageId: `m${i + 1}`, receiptHandle: `rh${i + 1}`, body: JSON.stringify({ fire, reason: 'queued' }) }));
    const clock = { at: 0 };
    return {
      clock,
      lane: () => ({
        receive: async (wait: number) => {
          const next = script.shift();
          if (next === undefined) clock.at += wait * 1000;
          return next ?? null;
        },
        remove: async () => {},
        deadLetter: async () => {},
        reset: () => {},
        now: () => clock.at,
      }),
    };
  };

  test('runs each fire it takes as its own turn, with its own claims, and names the message on its result line', async () => {
    const seen: Array<{ event: unknown; deps: { claims: Set<string> } }> = [];
    const { lane } = laneOf([{ kind: 'schedule' }, { kind: 'review', repo: 'acme/factory', pr: 12 }]);
    const { args, logged, exits, timers, cancelled } = harness({
      env: {},
      lane,
      run: async (event: unknown, deps: { claims: Set<string> }) => {
        deps.claims.add(`acme/factory#${seen.length + 1}`);
        seen.push({ event, deps });
        return dispatched();
      },
    });
    await main(args as never);
    assert.deepEqual(seen.map((s) => s.event), [{ kind: 'schedule' }, { kind: 'review', repo: 'acme/factory', pr: 12 }]);
    assert.notEqual(seen[0]!.deps.claims, seen[1]!.deps.claims, 'a claim one turn held is not the next turn\'s');
    const results = logged.filter((l) => l.event === 'dispatch-result');
    assert.deepEqual(results.map((r) => [r.messageId, r.exitCode]), [['m1', 0], ['m2', 0]]);
    assert.deepEqual(timers.map((t) => t.ms), [DEADLINE_MS, DEADLINE_MS], 'the deadline bounds each turn, not the task');
    assert.deepEqual(cancelled, [1, 2], 'each turn\'s deadline is cleared when it ends');
    assert.equal(logged.at(-1)?.event, 'lane-idle');
    assert.deepEqual(exits, [0]);
  });

  test('a turn that failed is logged with its message and its exit code, and the task takes the next fire', async () => {
    const { lane } = laneOf([{ kind: 'schedule' }, { kind: 'schedule' }]);
    let calls = 0;
    const { args, logged, exits } = harness({
      env: {},
      lane,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('the stored login is not a login');
        return dispatched('failed');
      },
    });
    await main(args as never);
    const failed = logged.filter((l) => l.event === 'dispatch-failed');
    assert.deepEqual(failed.map((f) => [f.messageId, f.reason ?? null, f.exitCode]), [['m1', 'threw', 1], ['m2', null, 1]]);
    assert.deepEqual(exits, [0], 'a failed turn fails its fire, not the task');
  });

  test('a turn that runs past its deadline logs dispatch-failed with the reason deadline, naming its message, and ends the task', async () => {
    const { lane } = laneOf([{ kind: 'schedule' }, { kind: 'schedule' }]);
    const { args, logged, exits, timers } = harness({ env: {}, lane, run: async () => new Promise(() => {}) });
    void main(args as never);
    await new Promise((settle) => setImmediate(settle));
    assert.equal(timers.length, 1);
    timers[0]!.fn();
    assert.deepEqual(logged.at(-1), { event: 'dispatch-failed', reason: 'deadline', deadlineMs: DEADLINE_MS, messageId: 'm1', exitCode: 1 });
    // The fire behind it was never received, so it waits on the lane for the
    // task the stop event starts.
    assert.deepEqual(exits, [1]);
  });

  test('a lane it cannot read exits 1', async () => {
    const { args, exits, logged } = harness({
      env: {},
      lane: () => ({
        receive: async () => {
          throw new Error('AccessDenied');
        },
        remove: async () => {},
        deadLetter: async () => {},
        reset: () => {},
        now: () => 0,
      }),
    });
    await main(args as never);
    assert.equal(logged.at(-1)?.reason, 'lane-unread');
    assert.deepEqual(exits, [1]);
  });
});
