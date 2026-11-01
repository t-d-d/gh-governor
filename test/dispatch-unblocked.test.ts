/**
 * A blocker's close, handled in each blocked ticket's own repo
 * (dispatch/unblocked.mjs): the closing turn's fires, and the row of the
 * ticket's turn's table a ticket falls under.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ROW_SWITCH, closingFires, readyPrompt, specPrompt, ticketRow, unblockedFacts, unblockedMessage, notPlannedComment } from '../dispatch/unblocked.mjs';
import { parseFire, overrideWeight, OVERRIDE_BUDGET } from '../dispatch/webhook/fire.mjs';

const FACTORY = 'acme/factory';
const closed = { repo: FACTORY, number: 41, title: 'The parser', reason: 'completed' };
const pr = { number: 52, title: 'Parse it', url: 'https://github.com/acme/factory/pull/52' };
const row = (repo: string, number: number, state = 'open') => ({ repo, number, state, title: `Ticket ${number}` });

describe('closingFires', () => {
  test('one fire per open blocked ticket in a listed owner\'s repo, its own repo\'s included', () => {
    const { queue, skipped } = closingFires({ closed, pr, rows: [row(FACTORY, 7), row('acme/tools', 7), row('t-d-d/askme', 9), row(FACTORY, 8, 'closed'), row('stranger/repo', 3)], owners: ['acme', 'T-D-D'] });
    assert.deepEqual(queue.map((q) => q.fire), [
      { kind: 'unblocked', repo: FACTORY, issue: 7, blocker: closed, pr },
      { kind: 'unblocked', repo: 'acme/tools', issue: 7, blocker: closed, pr },
      { kind: 'unblocked', repo: 't-d-d/askme', issue: 9, blocker: closed, pr },
    ]);
    assert.deepEqual(skipped.map((s) => [s.repo, s.issue]), [[FACTORY, 8], ['stranger/repo', 3]]);
    for (const { fire } of queue) {
      assert.deepEqual(parseFire(fire), fire);
      assert.ok(overrideWeight(fire) <= OVERRIDE_BUDGET);
    }
  });

  // A retried close queues the same ids, which the lane drops.
  test('each fire\'s deduplication id is the closed issue\'s and the ticket\'s, the same on a retry', () => {
    const once = closingFires({ closed, pr, rows: [row(FACTORY, 7), row('acme/tools', 7)], owners: ['acme'] });
    const again = closingFires({ closed: { ...closed, title: 'Renamed' }, pr: null, rows: [row('Acme/Tools', 7), row(FACTORY, 7)], owners: ['acme'] });
    const ids = once.queue.map((q) => q.dedupId);
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(again.queue.map((q) => q.dedupId).sort(), [...ids].sort());
    for (const id of ids) assert.match(id, /^[0-9a-f]{64}$/);
    const other = closingFires({ closed: { ...closed, number: 42 }, pr, rows: [row(FACTORY, 7)], owners: ['acme'] });
    assert.ok(!ids.includes(other.queue[0]!.dedupId));
  });

  // Each fire starts at most one session and queues nothing: the
  // dependency graph bounds a close, not DispatchCap.
  test('no cap: a close that blocked many tickets queues one fire each', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(FACTORY, i + 1));
    assert.equal(closingFires({ closed, pr, rows, owners: ['acme'] }).queue.length, 30);
  });

  test('a fire for its own repo is skipped where the closing turn knows its switches are off', () => {
    const { queue, skipped } = closingFires({ closed, pr: null, rows: [row(FACTORY, 7), row('acme/tools', 8)], owners: ['acme'], ownOff: true });
    assert.deepEqual(queue.map((q) => q.fire.repo), ['acme/tools']);
    assert.deepEqual(skipped.map((s) => [s.repo, s.issue]), [[FACTORY, 7]]);
    assert.match(skipped[0]!.reason, /pickup|unblocked/);
  });
});

describe('ticketRow', () => {
  const labels = { ready: ['mode: afk'], claim: 'claimed', exclude: ['type: prd', 'mode: human'] };
  const ticket = (on: string[], state = 'open') => ({ number: 7, title: 'T', body: '', state, labels: on, pull: false });
  const done = { kind: 'unblocked' as const, repo: FACTORY, issue: 7, blocker: { repo: 'acme/tools', number: 41, title: 'The parser', reason: 'completed' } };
  const dropped = { ...done, blocker: { ...done.blocker, reason: 'not_planned' } };
  const unsaid = { kind: 'unblocked' as const, repo: FACTORY, issue: 7, blocker: { repo: 'acme/tools', number: 41, title: 'The parser' } };
  const closedBlocker = [{ number: 41, state: 'closed', title: 'The parser' }];
  const stillBlocked = [...closedBlocker, { number: 43, state: 'open', title: 'Another' }];

  // The table in dispatch/unblocked.mjs, one row each, in its order: the first row that fits.
  const cases: Array<[string, ReturnType<typeof ticket>, typeof closedBlocker, typeof unsaid, string]> = [
    ['closed', ticket(['mode: afk'], 'closed'), closedBlocker, done, 'closed'],
    ['still blocked by another open issue', ticket(['mode: afk']), stillBlocked, done, 'blocked'],
    ['lost its blocker to a not-planned close, still blocked by another', ticket(['mode: afk']), stillBlocked, dropped, 'not-planned'],
    ['claimed, its blocker dropped, still blocked by another', ticket(['claimed']), stillBlocked, dropped, 'not-planned'],
    ['closed, its blocker dropped, still blocked by another', ticket(['mode: afk'], 'closed'), stillBlocked, dropped, 'closed'],
    ['lost its blocker to a not-planned close', ticket(['mode: afk']), closedBlocker, dropped, 'not-planned'],
    ['not planned, excluded too', ticket(['mode: human']), closedBlocker, dropped, 'not-planned'],
    ['carries an exclude label', ticket(['mode: human']), closedBlocker, done, 'excluded'],
    ['excluded and ready', ticket(['mode: afk', 'type: prd']), closedBlocker, done, 'excluded'],
    ['claimed', ticket(['claimed']), closedBlocker, done, 'claimed'],
    ['claimed, the ready label left on', ticket(['mode: afk', 'claimed']), closedBlocker, done, 'claimed'],
    ['ready', ticket(['mode: afk']), closedBlocker, done, 'ready'],
    ['not ready', ticket(['enhancement']), closedBlocker, done, 'not-ready'],
    ['not ready, closed by hand with no reason', ticket([]), closedBlocker, unsaid, 'not-ready'],
  ];
  for (const [name, t, blockers, fire, want] of cases) {
    test(`${name}: ${want}`, () => assert.equal(ticketRow({ ticket: t, blockers, fire, labels }), want));
  }

  // The summary counts a blocker the rows leave out, one in a repo the App
  // cannot see; where the ticket carries it, it decides.
  test('a summary counting an open blocker the rows leave out: blocked', () => {
    assert.equal(ticketRow({ ticket: { ...ticket(['mode: afk']), openBlockers: 1 }, blockers: closedBlocker, fire: done, labels }), 'blocked');
  });

  test('a summary counting an open blocker, its blocker dropped: not-planned', () => {
    assert.equal(ticketRow({ ticket: { ...ticket(['mode: afk']), openBlockers: 1 }, blockers: undefined, fire: dropped, labels }), 'not-planned');
  });

  test('a summary counting no open blocker: not blocked, whatever the rows say', () => {
    assert.equal(ticketRow({ ticket: { ...ticket(['mode: afk']), openBlockers: 0 }, blockers: stillBlocked, fire: done, labels }), 'ready');
  });

  test('pickup governs the ready row, unblocked the not-planned, claimed and not-ready rows', () => {
    assert.deepEqual(ROW_SWITCH, { 'not-planned': 'unblocked', claimed: 'unblocked', ready: 'pickup', 'not-ready': 'unblocked' });
  });
});

describe('the texts', () => {
  const fire = { kind: 'unblocked' as const, repo: FACTORY, issue: 7, blocker: closed, pr };
  const across = { kind: 'unblocked' as const, repo: 't-d-d/askme', issue: 7, blocker: { repo: FACTORY, number: 41, title: 'The parser' } };

  test('the facts name the blocker, how it closed and the PR, by its repo where that is not the ticket\'s', () => {
    assert.equal(unblockedFacts(fire), '#41 (The parser) closed as completed, by PR #52 (Parse it, https://github.com/acme/factory/pull/52). It blocked #7.');
    assert.equal(unblockedFacts(across), 'acme/factory#41 (The parser) closed, with no PR. It blocked #7.');
    assert.equal(unblockedFacts({ ...across, pr }), 'acme/factory#41 (The parser) closed, by PR acme/factory#52 (Parse it, https://github.com/acme/factory/pull/52). It blocked #7.');
  });

  test('a ready ticket\'s prompt is pickup\'s, then the facts and the ask to check the spec first', () => {
    const text = readyPrompt('Pickup #7\n\nImplement it.', fire, {});
    assert.ok(text.startsWith('Pickup #7\n\nImplement it.\n\n#41 (The parser) closed'), text);
    assert.match(text, /before you build/i);
  });

  test('a spec session is told to add the claim label itself before it builds', () => {
    const text = specPrompt({ fire, title: 'The step', labels: { ready: ['mode: afk'], claim: 'claimed' }, prompts: {} });
    assert.match(text, /^Spec #7 'The step'/);
    assert.match(text, /add `claimed`/);
    assert.match(text, /`mode: afk`/);
    assert.match(text, /question/);
    assert.match(text, /Unattended session/);
  });

  test('a claimed session hears the blocker closed and by which PR', () => {
    assert.match(unblockedMessage(fire, {}), /#41.*PR #52[\s\S]*against what merged/);
  });

  test('a not-planned close leaves a comment naming the blocker', () => {
    const text = notPlannedComment({ kind: 'unblocked', repo: FACTORY, issue: 7, blocker: { ...closed, reason: 'not_planned' } }, {});
    assert.match(text, /#41 \(`The parser`\) closed as not planned/);
    assert.doesNotMatch(text, /still blocked/);
  });

  test('a not-planned close on a ticket still blocked says so, so nobody reads it as free', () => {
    const text = notPlannedComment({ kind: 'unblocked', repo: FACTORY, issue: 7, blocker: { ...closed, reason: 'not_planned' } }, {}, { blocked: true });
    assert.match(text, /#41 \(`The parser`\) closed as not planned/);
    assert.match(text, /#7 is still blocked by another open issue/);
  });

  // A comment GitHub renders: a title's @handle or #N must not notify or link.
  test('the comment quotes each title as code, so a mention in it notifies nobody', () => {
    const text = notPlannedComment({ kind: 'unblocked', repo: FACTORY, issue: 7, blocker: { ...closed, title: 'Ask @alice about `#9`', reason: 'not_planned' }, pr: { ...pr, title: 'Ping @team' } }, {});
    assert.match(text, /\(`Ask @alice about '#9'`\)/);
    assert.match(text, /\(`Ping @team`, https/);
    assert.doesNotMatch(text.replace(/`[^`]*`/g, ''), /@/);
  });
});
