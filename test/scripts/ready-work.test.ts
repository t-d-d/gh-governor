/**
 * Unit tests for the ready-work selector.
 *
 * The filter a scheduled run applies with no model in the loop. Its order is
 * load-bearing and each step is tested here:
 *
 *   1. open + `workflow: ready for development`
 *   2. `mode: afk` only; the repo's excluded labels (`type: prd` in the
 *      factory) and its claim label `workflow: under development` dropped
 *   3. anything with an OPEN native blocker dropped
 *   4. oldest first, then by number, whatever the type labels say
 *   5. the caller's cap, applied last
 *
 * The asymmetry that decides every ambiguous case: dispatching a ticket that
 * was not eligible spends a cloud session and, worse, puts an agent on work
 * someone else has claimed or that is blocked on unlanded work. Skipping an
 * eligible one costs nothing — the next fire picks it up, because the worker
 * claims its own ticket rather than the dispatcher claiming it. So every
 * fork here resolves toward dropping the ticket.
 *
 * Blocker state is the subtlety worth naming. `gh-deps list-blockers` returns
 * every linked blocker regardless of state, so a ticket whose blockers have
 * all since closed is eligible and must not be filtered out — treating "has
 * blockers" as "is blocked" would silently strand tickets forever. The
 * openness test therefore lives in the selector, under test, rather than in
 * the shell that fetches.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UNREADIED_MARKER, heldUnreadied, isWaiting, labelRow, mayPickUp, mayStartSpec, selectReadyWork, ticketStatus, waitOf } from '../../scripts/lib/ready-work.mjs';
import * as unblocked from '../../dispatch/unblocked.mjs';
import { dispatchMarker } from '../../dispatch/webhook/fire.mjs';

/** The factory's labels: two ready labels, the claim, and the default exclude. */
const FACTORY_LABELS = { ready: ['workflow: ready for development', 'mode: afk'], claim: 'workflow: under development', exclude: ['type: prd'] };

type Issue = {
  number: number;
  title: string;
  state: string;
  labels: string[];
  created_at: string;
  openBlockers?: number;
  wait?: { until: string } | { unreadable: string };
};

const READY = 'workflow: ready for development';

/** An eligible afk enhancement, unless a field is overridden. */
const issue = (n: number, over: Partial<Issue> = {}): Issue => ({
  number: n,
  title: `issue ${n}`,
  state: 'open',
  labels: [READY, 'mode: afk', 'type: enhancement'],
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const numbers = (rows: { number: number }[]) => rows.map((r) => r.number);

describe('selectReadyWork — eligibility', () => {
  test('keeps an open, ready, afk, unblocked issue', () => {
    assert.deepEqual(numbers(selectReadyWork([issue(1)], { labels: FACTORY_LABELS, cap: 5 })), [1]);
  });

  test('drops an issue without the ready-for-development label', () => {
    const notReady = issue(1, { labels: ['mode: afk', 'type: bug'] });
    assert.deepEqual(selectReadyWork([notReady], { labels: FACTORY_LABELS, cap: 5 }), []);
  });

  test('drops a closed issue even when every label qualifies', () => {
    assert.deepEqual(selectReadyWork([issue(1, { state: 'closed' })], { labels: FACTORY_LABELS, cap: 5 }), []);
  });

  test('keeps only mode: afk — hitl and human are not dispatchable', () => {
    const rows = [
      issue(1, { labels: [READY, 'mode: hitl', 'type: bug'] }),
      issue(2, { labels: [READY, 'mode: human', 'type: chore'] }),
      issue(3, { labels: [READY, 'mode: afk', 'type: bug'] }),
    ];
    assert.deepEqual(numbers(selectReadyWork(rows, { labels: FACTORY_LABELS, cap: 5 })), [3]);
  });

  test('drops an issue carrying no mode label at all', () => {
    assert.deepEqual(selectReadyWork([issue(1, { labels: [READY] })], { labels: FACTORY_LABELS, cap: 5 }), []);
  });

  test('drops a claimed issue that still carries the ready label', () => {
    // Its worker added `under development` without removing `ready`,
    // and the next fire dispatched a second session onto the claimed ticket.
    const claimed = issue(1, {
      labels: [READY, 'workflow: under development', 'mode: afk', 'type: nfr'],
    });
    assert.deepEqual(selectReadyWork([claimed], { labels: FACTORY_LABELS, cap: 5 }), []);
  });

  test('drops type: prd, the factory\'s excluded label, even when it is labelled afk', () => {
    const prd = issue(1, { labels: [READY, 'mode: afk', 'type: prd'] });
    assert.deepEqual(selectReadyWork([prd], { labels: FACTORY_LABELS, cap: 5 }), []);
  });

  test('tolerates a missing labels array rather than throwing', () => {
    const malformed = { number: 1, title: 'x', state: 'open', created_at: '2026-01-01T00:00:00Z' };
    assert.deepEqual(selectReadyWork([malformed as Issue], { labels: FACTORY_LABELS, cap: 5 }), []);
  });
});

describe('selectReadyWork — native blockers', () => {
  test('drops an issue with an open blocker', () => {
    const blockers = new Map([[1, [{ number: 99, state: 'open' }]]]);
    assert.deepEqual(selectReadyWork([issue(1)], { labels: FACTORY_LABELS, cap: 5, blockers }), []);
  });

  test('keeps an issue whose blockers have all closed', () => {
    const blockers = new Map([[1, [{ number: 99, state: 'closed' }]]]);
    assert.deepEqual(numbers(selectReadyWork([issue(1)], { labels: FACTORY_LABELS, cap: 5, blockers })), [1]);
  });

  test('drops when any one of several blockers is still open', () => {
    const blockers = new Map([
      [1, [
        { number: 98, state: 'closed' },
        { number: 99, state: 'open' },
      ]],
    ]);
    assert.deepEqual(selectReadyWork([issue(1)], { labels: FACTORY_LABELS, cap: 5, blockers }), []);
  });

  test('an empty blocker list is not blocked', () => {
    const blockers = new Map([[1, []]]);
    assert.deepEqual(numbers(selectReadyWork([issue(1)], { labels: FACTORY_LABELS, cap: 5, blockers })), [1]);
  });
});

/**
 * GitHub leaves a blocker the caller cannot see out of the `blocked_by`
 * rows and still answers 200, but the issue's dependency summary counts
 * it. The summary's open count, `openBlockers` on the row, decides where
 * the row carries one.
 */
describe('selectReadyWork: the dependency summary', () => {
  test('drops an issue whose summary counts an open blocker, with no rows', () => {
    assert.deepEqual(selectReadyWork([issue(1, { openBlockers: 1 })], { labels: FACTORY_LABELS, cap: 5 }), []);
  });

  test('drops an issue whose summary counts an open blocker its rows leave out', () => {
    const blockers = new Map([[1, [{ number: 99, state: 'closed' }]]]);
    assert.deepEqual(selectReadyWork([issue(1, { openBlockers: 1 })], { labels: FACTORY_LABELS, cap: 5, blockers }), []);
  });

  test('keeps an issue whose summary counts no open blocker, whatever its rows say', () => {
    const blockers = new Map([[1, [{ number: 99, state: 'open' }]]]);
    assert.deepEqual(numbers(selectReadyWork([issue(1, { openBlockers: 0 })], { labels: FACTORY_LABELS, cap: 5, blockers })), [1]);
  });
});

describe('selectReadyWork — ordering', () => {
  test('a bug and an enhancement dispatch oldest first', () => {
    const rows = [
      issue(1, { labels: [READY, 'mode: afk', 'type: bug'], created_at: '2026-02-01T00:00:00Z' }),
      issue(2, { labels: [READY, 'mode: afk', 'type: enhancement'], created_at: '2026-01-01T00:00:00Z' }),
    ];
    assert.deepEqual(numbers(selectReadyWork(rows, { labels: FACTORY_LABELS, cap: 5 })), [2, 1]);
  });

  test('oldest first', () => {
    const rows = [
      issue(1, { created_at: '2026-03-01T00:00:00Z' }),
      issue(2, { created_at: '2026-01-01T00:00:00Z' }),
      issue(3, { created_at: '2026-02-01T00:00:00Z' }),
    ];
    assert.deepEqual(numbers(selectReadyWork(rows, { labels: FACTORY_LABELS, cap: 5 })), [2, 3, 1]);
  });

  test('two issues filed in the same second go by number', () => {
    const rows = [issue(9), issue(4), issue(6)];
    assert.deepEqual(numbers(selectReadyWork(rows, { labels: FACTORY_LABELS, cap: 5 })), [4, 6, 9]);
  });

  test('ordering does not depend on input order', () => {
    const rows = [
      issue(1, { created_at: '2026-02-01T00:00:00Z' }),
      issue(2, { labels: [READY, 'mode: afk', 'type: bug'], created_at: '2026-05-01T00:00:00Z' }),
      issue(3, { created_at: '2026-01-01T00:00:00Z' }),
    ];
    const forward = numbers(selectReadyWork(rows, { labels: FACTORY_LABELS, cap: 5 }));
    const reversed = numbers(selectReadyWork([...rows].reverse(), { labels: FACTORY_LABELS, cap: 5 }));
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, [3, 1, 2]);
  });
});

describe('selectReadyWork — cap', () => {
  test('applies the cap after ordering, not before', () => {
    const rows = [
      issue(1, { created_at: '2026-09-01T00:00:00Z' }),
      issue(2, { created_at: '2026-01-01T00:00:00Z' }),
    ];
    // Capping before the sort would keep #1; the older ticket has to win.
    assert.deepEqual(numbers(selectReadyWork(rows, { labels: FACTORY_LABELS, cap: 1 })), [2]);
  });

  test('defaults to a cap of 1', () => {
    const rows = [issue(1), issue(2, { created_at: '2026-02-01T00:00:00Z' })];
    assert.deepEqual(numbers(selectReadyWork(rows, { labels: FACTORY_LABELS })), [1]);
  });

  test('a cap larger than the eligible set returns everything eligible', () => {
    assert.deepEqual(numbers(selectReadyWork([issue(1), issue(2)], { labels: FACTORY_LABELS, cap: 10 })), [1, 2]);
  });

  test('a cap of zero dispatches nothing', () => {
    assert.deepEqual(selectReadyWork([issue(1)], { labels: FACTORY_LABELS, cap: 0 }), []);
  });

  test('an empty input is not an error', () => {
    assert.deepEqual(selectReadyWork([], { labels: FACTORY_LABELS, cap: 5 }), []);
  });
});

describe('selectReadyWork — a repo\'s own labels', () => {
  const labels = { ready: ['mode: afk'], claim: 'claimed', exclude: ['epic', 'blocked'] };

  test('a ticket carrying every ready label the repo names is ready, and its claim label drops it', () => {
    assert.deepEqual(numbers(selectReadyWork([issue(1, { labels: ['mode: afk'] })], { cap: 5, labels })), [1]);
    assert.deepEqual(selectReadyWork([issue(1, { labels: ['mode: afk', 'claimed'] })], { cap: 5, labels }), []);
    assert.deepEqual(selectReadyWork([issue(1, { labels: ['bug'] })], { cap: 5, labels }), []);
  });

  test('a ticket carrying any label the repo excludes is dropped, and only those', () => {
    assert.deepEqual(selectReadyWork([issue(1, { labels: ['mode: afk', 'epic'] })], { cap: 5, labels }), []);
    assert.deepEqual(selectReadyWork([issue(1, { labels: ['mode: afk', 'blocked'] })], { cap: 5, labels }), []);
    assert.deepEqual(numbers(selectReadyWork([issue(1, { labels: ['mode: afk', 'type: prd'] })], { cap: 5, labels })), [1], 'type: prd is only the default');
  });
});

describe('labelRow, the ready-label rule the selection, the claim and the unblocked row share', () => {
  const ROWS: [string, string[] | undefined, string][] = [
    ['every ready label, no claim, no exclude', [READY, 'mode: afk'], 'ready'],
    ['a ready label missing', [READY], 'not-ready'],
    ['no labels at all', [], 'not-ready'],
    ['a missing labels array', undefined, 'not-ready'],
    ['claimed, ready labels still on', [READY, 'mode: afk', 'workflow: under development'], 'claimed'],
    ['claimed, ready labels off', ['workflow: under development'], 'claimed'],
    ['an excluded label on a ready ticket', [READY, 'mode: afk', 'type: prd'], 'excluded'],
    ['an excluded label on a claimed ticket', ['workflow: under development', 'type: prd'], 'excluded'],
  ];
  for (const [name, on, want] of ROWS) {
    test(`${name}: ${want}`, () => assert.equal(labelRow(on, FACTORY_LABELS), want));
  }

  test('a label the repo adds to its excludes keeps a ready ticket out', () => {
    const labels = { ...FACTORY_LABELS, exclude: ['type: prd', 'needs: design'] };
    assert.equal(labelRow([READY, 'mode: afk', 'needs: design'], labels), 'excluded');
  });
});

/**
 * A ticket's body may open with `Blocked until: <YYYY-MM-DD>`. Governor
 * holds the ticket until 00:00 UTC on that date, in every served repo,
 * whatever its config file says. A line it cannot read holds the ticket too.
 */
describe('waitOf: the `Blocked until:` line', () => {
  test('a body with no line carries no wait', () => {
    assert.deepEqual(waitOf(''), {});
    assert.deepEqual(waitOf(undefined), {});
    assert.deepEqual(waitOf('## Summary\n\nWork.'), {});
  });

  test('the first non-empty line, in any case, gives the date', () => {
    assert.deepEqual(waitOf('Blocked until: 2026-11-05\n\nParent PRD: #185'), { wait: { until: '2026-11-05' } });
    assert.deepEqual(waitOf('\n  \r\nblocked UNTIL: 2026-11-05\r\n'), { wait: { until: '2026-11-05' } });
    assert.deepEqual(waitOf('Blocked until:2026-11-05'), { wait: { until: '2026-11-05' } });
  });

  test('text after the date does not change the date read', () => {
    assert.deepEqual(waitOf('Blocked until: 2026-11-05 for a few days of stop-event lines'), { wait: { until: '2026-11-05' } });
  });

  test('a line that is not the first non-empty line is no wait', () => {
    assert.deepEqual(waitOf('Parent PRD: #185\nBlocked until: 2026-11-05'), {});
    assert.deepEqual(waitOf('Not Blocked until: 2026-11-05'), {});
  });

  test('a line holding no date governor can read is unreadable', () => {
    for (const value of ['2026-13-01', 'next week', '', '2026-02-30', '2026-11-5', '2026-11-05,', '05/11/2026']) {
      assert.deepEqual(waitOf(`Blocked until: ${value}`), { wait: { unreadable: value } }, value);
    }
  });
});

describe('isWaiting', () => {
  const at = (iso: string) => Date.parse(iso);

  test('a date still to come holds the ticket, until 00:00 UTC on that date', () => {
    const row = { wait: { until: '2026-11-05' } };
    assert.equal(isWaiting(row, at('2026-11-04T23:59:59.999Z')), true);
    assert.equal(isWaiting(row, at('2026-11-05T00:00:00Z')), false);
    assert.equal(isWaiting(row, at('2026-12-01T00:00:00Z')), false);
  });

  test('an unreadable line holds the ticket, and no line holds nothing', () => {
    assert.equal(isWaiting({ wait: { unreadable: 'next week' } }, at('2030-01-01T00:00:00Z')), true);
    assert.equal(isWaiting({}, 0), false);
  });
});

describe('selectReadyWork: a ticket\'s own wait', () => {
  const held = issue(1, { wait: { until: '2026-11-05' } });

  test('a ready ticket whose date is still to come is not selected, and is at the first sweep on or after it', () => {
    assert.deepEqual(numbers(selectReadyWork([held, issue(2)], { labels: FACTORY_LABELS, cap: 5, now: Date.parse('2026-11-04T23:00:00Z') })), [2]);
    assert.deepEqual(numbers(selectReadyWork([held, issue(2)], { labels: FACTORY_LABELS, cap: 5, now: Date.parse('2026-11-05T00:30:00Z') })), [1, 2]);
  });

  test('an unreadable line is not selected', () => {
    assert.deepEqual(selectReadyWork([issue(1, { wait: { unreadable: 'next week' } })], { labels: FACTORY_LABELS, cap: 5, now: 0 }), []);
  });
});

describe('ticketStatus: what keeps a ticket from starting', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const rules = { labels: FACTORY_LABELS, now };
  const READY_ON = [READY, 'mode: afk'];
  const NOT_READY_ON = ['mode: afk'];
  const CLAIMED_ON = [READY, 'mode: afk', 'workflow: under development'];
  const EXCLUDED_ON = [READY, 'mode: afk', 'type: prd'];

  test('a closed ticket reads closed, whatever else it carries', () => {
    assert.deepEqual(ticketStatus({ state: 'closed', labels: READY_ON }, rules), { open: false });
    assert.deepEqual(ticketStatus({ state: 'closed', labels: READY_ON, openBlockers: 1, wait: { unreadable: 'soon' } }, rules), { open: false });
  });

  test('a ticket with no state read is open, as the selection reads it', () => {
    assert.deepEqual(ticketStatus({ labels: READY_ON }, rules), { open: true, labels: 'ready', holds: [] });
  });

  test('the labels read as labelRow reads them', () => {
    for (const on of [READY_ON, NOT_READY_ON, CLAIMED_ON, EXCLUDED_ON, []]) {
      const status = ticketStatus({ state: 'open', labels: on }, rules);
      assert.deepEqual(status, { open: true, labels: labelRow(on, FACTORY_LABELS), holds: [] });
    }
  });

  test('an open blocker holds, by the dependency summary where the row has one, else by the blocker rows', () => {
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON, openBlockers: 1 }, rules), { open: true, labels: 'ready', holds: ['blocker'] });
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON, openBlockers: 0 }, { ...rules, blockers: [{ number: 9, state: 'open' }] }), { open: true, labels: 'ready', holds: [] });
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON }, { ...rules, blockers: [{ number: 9, state: 'open' }] }), { open: true, labels: 'ready', holds: ['blocker'] });
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON }, { ...rules, blockers: [{ number: 9, state: 'closed' }] }), { open: true, labels: 'ready', holds: [] });
  });

  test('a blocker holds whatever the labels read', () => {
    for (const on of [CLAIMED_ON, EXCLUDED_ON, NOT_READY_ON]) {
      assert.deepEqual(ticketStatus({ state: 'open', labels: on, openBlockers: 2 }, rules), { open: true, labels: labelRow(on, FACTORY_LABELS), holds: ['blocker'] });
    }
  });

  test('a date still to come and a relative line hold as a line; a date passed holds nothing', () => {
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON, wait: { until: '2026-11-05' } }, rules), { open: true, labels: 'ready', holds: ['line'] });
    assert.deepEqual(ticketStatus({ state: 'open', labels: NOT_READY_ON, wait: { after: { days: 3, issue: 7 } } }, rules), { open: true, labels: 'not-ready', holds: ['line'] });
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON, wait: { until: '2026-11-04' } }, rules), { open: true, labels: 'ready', holds: [] });
  });

  test('a line governor cannot read holds as unreadable, not as a line', () => {
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON, wait: { unreadable: 'next week' } }, rules), { open: true, labels: 'ready', holds: ['unreadable'] });
    assert.deepEqual(ticketStatus({ state: 'open', labels: NOT_READY_ON, wait: { unreadable: 'next week' } }, rules), { open: true, labels: 'not-ready', holds: ['unreadable'] });
  });

  test('a line or unreadable hold only where the labels read ready or not ready, as waitHolds says', () => {
    for (const on of [CLAIMED_ON, EXCLUDED_ON]) {
      for (const wait of [{ until: '2026-11-05' }, { after: { days: 3, issue: 7 } }, { unreadable: 'next week' }]) {
        assert.deepEqual(ticketStatus({ state: 'open', labels: on, wait }, rules), { open: true, labels: labelRow(on, FACTORY_LABELS), holds: [] });
      }
    }
  });

  test('a blocker and a line both hold, the blocker first', () => {
    assert.deepEqual(ticketStatus({ state: 'open', labels: READY_ON, openBlockers: 1, wait: { until: '2026-11-05' } }, rules), { open: true, labels: 'ready', holds: ['blocker', 'line'] });
    assert.deepEqual(ticketStatus({ state: 'open', labels: CLAIMED_ON, openBlockers: 1, wait: { unreadable: 'x' } }, rules), { open: true, labels: 'claimed', holds: ['blocker'] });
  });
});

describe('mayPickUp', () => {
  test('only an open, ready ticket nothing holds', () => {
    assert.equal(mayPickUp({ open: true, labels: 'ready', holds: [] }), true);
    assert.equal(mayPickUp({ open: false }), false);
    for (const labels of ['excluded', 'claimed', 'not-ready'] as const) assert.equal(mayPickUp({ open: true, labels, holds: [] }), false);
    for (const hold of ['blocker', 'line', 'unreadable'] as const) assert.equal(mayPickUp({ open: true, labels: 'ready', holds: [hold] }), false);
  });

  test('agrees with the selection on the same rows', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const rows = [
      issue(1),
      issue(2, { state: 'closed' }),
      issue(3, { labels: ['mode: afk'] }),
      issue(4, { labels: [READY, 'mode: afk', 'workflow: under development'] }),
      issue(5, { labels: [READY, 'mode: afk', 'type: prd'] }),
      issue(6, { openBlockers: 1 }),
      issue(7, { wait: { until: '2026-11-05' } }),
      issue(8, { wait: { until: '2026-11-04' } }),
      issue(9, { wait: { unreadable: 'soon' } }),
      issue(10),
    ];
    const blockers = new Map([[10, [{ number: 1, state: 'open' }]]]);
    const selected = numbers(selectReadyWork(rows, { labels: FACTORY_LABELS, cap: 99, now, blockers }));
    const picked = rows.filter((row) => mayPickUp(ticketStatus(row, { labels: FACTORY_LABELS, now, blockers: blockers.get(row.number) }))).map((row) => row.number);
    assert.deepEqual(picked, selected);
    assert.deepEqual(picked, [1, 8]);
  });
});

describe('mayStartSpec', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const held = { body: `Governor took its ready label off #7.\n\n${UNREADIED_MARKER}`, ours: true };
  const dispatched = (at: number) => ({ body: dispatchMarker({ at: new Date(at).toISOString(), sessionUrl: null }), ours: true });

  test('a thread with neither an unanswered unreadied comment nor a recent dispatch may start one', () => {
    assert.equal(mayStartSpec([], now), true);
    assert.equal(mayStartSpec([{ body: 'Filed.', ours: false }], now), true);
  });

  test('an unanswered unreadied comment stops it, and a person\'s answer frees it', () => {
    assert.equal(mayStartSpec([held], now), false);
    assert.equal(mayStartSpec([held, { body: 'Still stands.', ours: false }], now), true);
  });

  test('a dispatch inside the window stops it, and one past the window does not', () => {
    assert.equal(mayStartSpec([dispatched(now - 60 * 60 * 1000)], now), false);
    assert.equal(mayStartSpec([dispatched(now - 3 * 60 * 60 * 1000)], now), true);
  });
});

describe('heldUnreadied and UNREADIED_MARKER live here, and unblocked.mjs re-exports them', () => {
  test('the same values from both files', () => {
    assert.equal(unblocked.heldUnreadied, heldUnreadied);
    assert.equal(unblocked.UNREADIED_MARKER, UNREADIED_MARKER);
  });
});
