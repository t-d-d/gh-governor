/**
 * A relative wait: `Blocked until: 3 days after #143 closes`, on a ticket
 * that #143 blocks. While #143 is open the dependency hold keeps the ticket
 * out. When it closes as completed, governor rewrites the line once into
 * its date, and the date hold does the rest. A close of any other kind
 * leaves the line, and the ticket held, with one comment.
 *
 * What a turn does with it is test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { build, parseFire, waitLine } from '../dispatch/webhook/fire.mjs';
import { isWaiting, waitOf } from '../scripts/lib/ready-work.mjs';
import { closingFires } from '../dispatch/unblocked.mjs';
import { planSchedule } from '../scripts/lib/dispatch-router.mjs';
import {
  WAIT_UNREADABLE_MARKER, datedBody, endedWaits, holdWait, relativeAtClose, relativeUntil, repairRelative, waitNotPlannedMarker, waitRelativeMarker,
} from '../dispatch/waits.mjs';

const REPO = 'acme/factory';
const LABELS = { ready: ['workflow: ready for development', 'mode: afk'], claim: 'workflow: under development', exclude: ['type: prd'] };
const NOW = Date.parse('2026-11-02T10:00:00Z');
const CLOSED_AT = '2026-11-02T09:00:00Z';

describe('the line', () => {
  test('reads `<N> days after #<issue> closes` as a relative wait, in any case, with a reason after it', () => {
    assert.deepEqual(waitOf('Blocked until: 3 days after #143 closes'), { wait: { after: { days: 3, issue: 143 } } });
    assert.deepEqual(waitOf('blocked until: 1 day after #9 CLOSES for the logs'), { wait: { after: { days: 1, issue: 9 } } });
    assert.deepEqual(waitOf('Blocked until: 10 days after acme/tools#41 closes'), { wait: { after: { days: 10, issue: 41, repo: 'acme/tools' } } });
  });

  test('a count below one, or words it does not know, are unreadable', () => {
    for (const value of ['0 days after #143 closes', '3 days after #143', '3 days after #143 closed', 'three days after #143 closes', '3 days after #143 closesoon']) {
      assert.deepEqual(waitOf(`Blocked until: ${value}`), { wait: { unreadable: value } }, value);
    }
  });

  test('a count past a hundred years is unreadable, so a close always gives a four-digit year', () => {
    assert.deepEqual(waitOf('Blocked until: 36500 days after #143 closes'), { wait: { after: { days: 36500, issue: 143 } } });
    for (const value of ['36501 days after #143 closes', '999999999 days after #143 closes']) {
      assert.deepEqual(waitOf(`Blocked until: ${value}`), { wait: { unreadable: value } }, value);
    }
  });

  test('holds the ticket at any time, as the receiver still sees the line', () => {
    assert.equal(isWaiting(waitOf('Blocked until: 3 days after #143 closes'), Date.parse('2099-01-01T00:00:00Z')), true);
    assert.notEqual(waitLine('Blocked until: 3 days after #143 closes'), null);
  });
});

describe('the date', () => {
  test('is the first day whose 00:00 UTC is at least N days after the close', () => {
    assert.equal(relativeUntil('2026-11-02T09:00:00Z', 3), '2026-11-06');
    assert.equal(relativeUntil('2026-11-02T00:00:00Z', 3), '2026-11-05');
    assert.equal(relativeUntil('2026-11-30T23:59:59Z', 1), '2026-12-02');
  });

  test('the rewrite replaces only the line, keeping its reason and the rest of the body', () => {
    const body = 'Blocked until: 3 days after #143 closes for the stop-event lines\r\n\r\nThe rest, with Blocked until: 3 days after #143 closes quoted.';
    assert.equal(datedBody(body, '2026-11-06'), 'Blocked until: 2026-11-06 (3 days after #143 closed) for the stop-event lines\r\n\r\nThe rest, with Blocked until: 3 days after #143 closes quoted.');
    assert.equal(datedBody('\n  blocked until: 1 day after acme/tools#41 closes\nBody.', '2026-11-04'), '\n  Blocked until: 2026-11-04 (1 day after acme/tools#41 closed)\nBody.');
    assert.deepEqual(waitOf(datedBody('Blocked until: 3 days after #143 closes', '2026-11-06')), { wait: { until: '2026-11-06' } });
  });

  test('a body whose line is no longer relative is not rewritten', () => {
    assert.equal(datedBody('Blocked until: 2026-11-06', '2026-11-07'), null);
    assert.equal(datedBody('Body.', '2026-11-07'), null);
  });
});

describe('the fire', () => {
  test('an unblocked fire carries the blocker\'s close time, and parses back', () => {
    const fire = { ...build.unblocked({ issue: 7, blocker: { repo: REPO, number: 143, title: 'The change', reason: 'completed', closedAt: CLOSED_AT } }), repo: REPO };
    assert.deepEqual(fire.blocker, { repo: REPO, number: 143, title: 'The change', reason: 'completed', closedAt: CLOSED_AT });
    assert.deepEqual(parseFire(fire), fire);
    assert.throws(() => parseFire({ ...fire, blocker: { ...fire.blocker, closedAt: 'yesterday' } }), /closedAt/);
  });

  test('a close skips its own repo\'s ticket where both switches are off, but not one whose line waits on that close', () => {
    const closed = { repo: REPO, number: 143, title: 'The change', reason: 'completed', closedAt: CLOSED_AT };
    const rows = [
      { repo: REPO, number: 7, state: 'open', wait: { after: { days: 3, issue: 143 } } },
      { repo: REPO, number: 8, state: 'open', wait: { after: { days: 3, issue: 99 } } },
      { repo: REPO, number: 9, state: 'open' },
      { repo: REPO, number: 10, state: 'open', wait: { after: { days: 3, issue: 143, repo: 'Acme/Factory' } } },
    ];
    const { queue } = closingFires({ closed, pr: null, rows, owners: ['acme'], ownOff: true });
    assert.deepEqual(queue.map((q) => q.fire.issue), [7, 10]);
    assert.equal(queue[0]?.fire.blocker.closedAt, CLOSED_AT);
  });
});

type Comment = { issue: number; body: string };

/** A reader over one ticket's body and thread, and the issues it can read. */
const fakeReader = ({ body = 'Blocked until: 3 days after #143 closes\n\nThe rest.', thread = [] as Array<{ body: string }>, issues = {} as Record<number, Record<string, unknown> | 'gone'>, blockers = [] as Array<{ number: number; state: string; repo?: string }>, labels = [] as string[] } = {}) => {
  const comments: Comment[] = [];
  const edits: Array<{ issue: number; body: string }> = [];
  const links: Array<{ issue: number; id: number }> = [];
  const asked: string[] = [];
  const state = { body };
  const reader = {
    issue: async (n: number) => { asked.push(`issue ${n}`); return { number: n, body: state.body, pull: false }; },
    updateIssue: async (n: number, { body: next }: { body: string }) => { edits.push({ issue: n, body: next }); state.body = next; },
    allComments: async () => thread,
    comment: async (n: number, text: string) => { comments.push({ issue: n, body: text }); },
    issueClose: async (n: number) => {
      asked.push(`issueClose ${n}`);
      const read = issues[n];
      if (read === undefined || read === 'gone') throw Object.assign(new Error(`GET /issues/${n} failed: 404`), { status: 404 });
      return { id: 9000 + n, number: n, title: `Issue ${n}`, state: 'open', reason: null, closedAt: null, ...read };
    },
    blockers: async () => { asked.push('blockers'); return blockers; },
    addBlocker: async (n: number, id: number) => { links.push({ issue: n, id }); },
    ticket: async (n: number) => ({ number: n, title: `Issue ${n}`, body: state.body, state: 'open', labels, pull: false, openBlockers: 0, ...waitOf(state.body) }),
  };
  return { reader, comments, edits, links, asked, state };
};

const logs = () => {
  const logged: Array<Record<string, unknown>> = [];
  return { logged, log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); } };
};

describe('at the close', () => {
  const blocker = { repo: REPO, number: 143, title: 'The change', reason: 'completed', closedAt: CLOSED_AT };
  const fire = { kind: 'unblocked' as const, repo: REPO, issue: 7, blocker };
  const ticketOf = (body: string) => ({ number: 7, state: 'open', labels: [], ...waitOf(body) });

  test('a completed close rewrites the line into its date, reading the body just before it writes', async () => {
    const f = fakeReader();
    const { log } = logs();
    const done = await relativeAtClose({ reader: f.reader, repo: REPO, ticket: ticketOf(f.state.body), fire, prompts: {}, now: NOW, log });
    assert.deepEqual(done, { outcome: 'rewritten', wait: { until: '2026-11-06' } });
    assert.deepEqual(f.edits, [{ issue: 7, body: 'Blocked until: 2026-11-06 (3 days after #143 closed)\n\nThe rest.' }]);
    assert.deepEqual(f.comments, []);
  });

  test('a person\'s edit since the ticket was read stays: only the line is replaced', async () => {
    const f = fakeReader();
    const ticket = ticketOf(f.state.body);
    f.state.body = 'Blocked until: 3 days after #143 closes\n\nEdited since.';
    await relativeAtClose({ reader: f.reader, repo: REPO, ticket, fire, prompts: {}, now: NOW, log: logs().log });
    assert.deepEqual(f.edits.map((e) => e.body), ['Blocked until: 2026-11-06 (3 days after #143 closed)\n\nEdited since.']);
  });

  test('a fire without the close time counts from now, so the wait is never shorter', async () => {
    const f = fakeReader();
    const { closedAt: _closedAt, ...bare } = blocker;
    const done = await relativeAtClose({ reader: f.reader, repo: REPO, ticket: ticketOf(f.state.body), fire: { ...fire, blocker: bare }, prompts: {}, now: NOW, log: logs().log });
    assert.deepEqual(done?.wait, { until: '2026-11-06' });
  });

  test('a close that is not completed leaves the line and comments once, in the not-planned words, with its marker', async () => {
    for (const reason of ['not_planned', 'duplicate']) {
      const f = fakeReader();
      const done = await relativeAtClose({ reader: f.reader, repo: REPO, ticket: ticketOf(f.state.body), fire: { ...fire, blocker: { ...blocker, reason } }, prompts: {}, now: NOW, log: logs().log });
      assert.equal(done?.outcome, 'commented', reason);
      assert.deepEqual(f.edits, [], reason);
      assert.equal(f.comments.length, 1, reason);
      const said = f.comments[0]!.body;
      assert.ok(said.includes(waitNotPlannedMarker('#143')), said);
      assert.match(said, /Its work will not land as planned/);
      assert.match(said, /Blocked until:/);
      assert.match(said, /delete/);
    }
  });

  test('on a ticket the line does not hold, the comment does not say the line holds it', async () => {
    const f = fakeReader();
    await relativeAtClose({ reader: f.reader, repo: REPO, ticket: ticketOf(f.state.body), fire: { ...fire, blocker: { ...blocker, reason: 'not_planned' } }, prompts: {}, now: NOW, log: logs().log, holds: false });
    assert.equal(f.comments.length, 1);
    const said = f.comments[0]!.body;
    assert.ok(said.includes(waitNotPlannedMarker('#143')), said);
    assert.match(said, /Its work will not land as planned/);
    assert.doesNotMatch(said, /held|free/);
    assert.match(said, /Blocked until: YYYY-MM-DD[\s\S]*delete/);
  });

  test('a second not-completed close finds the marker and says nothing', async () => {
    const f = fakeReader({ thread: [{ body: `Earlier.\n${waitNotPlannedMarker('#143')}` }] });
    const done = await relativeAtClose({ reader: f.reader, repo: REPO, ticket: ticketOf(f.state.body), fire: { ...fire, blocker: { ...blocker, reason: 'not_planned' } }, prompts: {}, now: NOW, log: logs().log });
    assert.equal(done?.outcome, 'already told');
    assert.deepEqual(f.comments, []);
  });

  test('a line naming another issue, a dated line, or no line is not this close\'s', async () => {
    for (const body of ['Blocked until: 3 days after #99 closes', 'Blocked until: 2026-11-30', 'Body.', 'Blocked until: 3 days after acme/tools#143 closes']) {
      const f = fakeReader({ body });
      assert.equal(await relativeAtClose({ reader: f.reader, repo: REPO, ticket: ticketOf(body), fire, prompts: {}, now: NOW, log: logs().log }), null, body);
      assert.deepEqual([f.edits, f.comments], [[], []], body);
    }
  });

  test('a ticket moved to another repo is not this close\'s: its read names another number', async () => {
    const f = fakeReader();
    const moved = { ...ticketOf(f.state.body), number: 12 };
    assert.equal(await relativeAtClose({ reader: f.reader, repo: REPO, ticket: moved, fire, prompts: {}, now: NOW, log: logs().log }), null);
    assert.deepEqual([f.edits, f.comments], [[], []]);
  });

  test('a line naming another repo\'s issue is that close\'s', async () => {
    const f = fakeReader({ body: 'Blocked until: 2 days after acme/tools#41 closes' });
    const other = { ...fire, blocker: { ...blocker, repo: 'acme/tools', number: 41 } };
    const done = await relativeAtClose({ reader: f.reader, repo: REPO, ticket: ticketOf(f.state.body), fire: other, prompts: {}, now: NOW, log: logs().log });
    assert.equal(done?.outcome, 'rewritten');
    assert.deepEqual(f.edits.map((e) => e.body), ['Blocked until: 2026-11-05 (2 days after acme/tools#41 closed)']);
  });
});

describe('the wait turn, under `waits`', () => {
  const state = (items: Map<string, string>) => ({
    waits: async () => [...items].map(([k, until]) => ({ issue: Number(k.split('#')[1]), until })),
    wait: async (_r: string, n: number) => (items.has(`${REPO}#${n}`) ? { until: items.get(`${REPO}#${n}`)! } : null),
    recordWait: async (_r: string, n: number, _read: string | null, until: string) => { items.set(`${REPO}#${n}`, until); return true; },
    dropWait: async (_r: string, n: number) => items.delete(`${REPO}#${n}`),
  });

  test('a relative line is not reported unreadable, keeps no item, and links a same-repo issue that is not linked', async () => {
    const items = new Map([[`${REPO}#7`, '2026-11-30']]);
    const f = fakeReader({ issues: { 143: {} } });
    await holdWait({ reader: f.reader as never, state: state(items), repo: REPO, issue: 7, labels: LABELS, now: NOW, log: logs().log });
    assert.deepEqual([...items], []);
    assert.ok(!f.comments.some((c) => c.body.includes(WAIT_UNREADABLE_MARKER)), JSON.stringify(f.comments));
    assert.deepEqual(f.links, [{ issue: 7, id: 9143 }]);
  });

  test('an issue already linked is not linked again', async () => {
    const f = fakeReader({ issues: { 143: {} }, blockers: [{ number: 143, state: 'open' }] });
    await holdWait({ reader: f.reader as never, state: state(new Map()), repo: REPO, issue: 7, labels: LABELS, now: NOW, log: logs().log });
    assert.deepEqual([f.links, f.comments], [[], []]);
  });

  test('a pull request, or the ticket itself, is never linked: one comment saying to link an issue or write a date', async () => {
    for (const [body, issues, ref] of [
      ['Blocked until: 3 days after #143 closes', { 143: { pull: true } }, '#143'],
      ['Blocked until: 3 days after #143 closes', { 143: { pull: true, state: 'closed', closedAt: CLOSED_AT } }, '#143'],
      ['Blocked until: 3 days after #7 closes', { 7: {} }, '#7'],
    ] as const) {
      const f = fakeReader({ body, issues: issues as never });
      assert.equal(await holdWait({ reader: f.reader as never, state: state(new Map()), repo: REPO, issue: 7, labels: LABELS, now: NOW, log: logs().log }), 'relative: commented', JSON.stringify(issues));
      assert.deepEqual([f.links, f.edits], [[], []], JSON.stringify(issues));
      assert.ok(f.comments[0]?.body.includes(waitRelativeMarker(ref)), JSON.stringify(f.comments));
    }
  });

  test('another repo\'s issue is not read: a turn calls GitHub only for its fire\'s repo', async () => {
    const f = fakeReader({ body: 'Blocked until: 3 days after acme/tools#41 closes' });
    await holdWait({ reader: f.reader as never, state: state(new Map()), repo: REPO, issue: 7, labels: LABELS, now: NOW, log: logs().log });
    assert.deepEqual([f.links, f.comments, f.asked.filter((a) => a.startsWith('issueClose'))], [[], [], []]);
  });

  test('a same-repo issue that has already closed as completed rewrites the line', async () => {
    const f = fakeReader({ issues: { 143: { state: 'closed', reason: 'completed', closedAt: CLOSED_AT } } });
    await holdWait({ reader: f.reader as never, state: state(new Map()), repo: REPO, issue: 7, labels: LABELS, now: NOW, log: logs().log });
    assert.deepEqual(f.edits.map((e) => e.body), ['Blocked until: 2026-11-06 (3 days after #143 closed)\n\nThe rest.']);
    assert.deepEqual(f.links, []);
  });

  test('the bare fire drops an item whose ticket\'s line became relative', async () => {
    const items = new Map([[`${REPO}#7`, '2026-10-01']]);
    const f = fakeReader();
    const ended = await endedWaits({ reader: f.reader as never, state: state(items), repo: REPO, labels: LABELS, spec: true, now: NOW, log: logs().log });
    assert.deepEqual([...items], []);
    assert.deepEqual([ended.specs, ended.unread, f.comments], [[], [], []]);
  });
});

describe('the sweep\'s repair', () => {
  const after = { days: 3, issue: 143 };
  const repair = (f: ReturnType<typeof fakeReader>, wait: { days: number; issue: number; repo?: string } = after) =>
    repairRelative({ reader: f.reader as never, repo: REPO, issue: 7, after: wait, link: false, prompts: {}, log: logs().log });

  test('a same-repo issue that closed as completed: the line is rewritten', async () => {
    const f = fakeReader({ issues: { 143: { state: 'closed', reason: 'completed', closedAt: CLOSED_AT } } });
    assert.equal(await repair(f), 'rewritten');
    assert.deepEqual(f.edits.map((e) => e.body), ['Blocked until: 2026-11-06 (3 days after #143 closed)\n\nThe rest.']);
  });

  test('a same-repo issue that closed any other way: the not-planned comment, once', async () => {
    const f = fakeReader({ issues: { 143: { state: 'closed', reason: 'not_planned', closedAt: CLOSED_AT } } });
    assert.equal(await repair(f), 'commented');
    assert.ok(f.comments[0]!.body.includes(waitNotPlannedMarker('#143')));
    assert.deepEqual(f.edits, []);
  });

  test('an open issue not linked, a missing issue, or another repo\'s: one comment saying to link it or write a date', async () => {
    const cases: Array<[ReturnType<typeof fakeReader>, { days: number; issue: number; repo?: string }, string]> = [
      [fakeReader({ issues: { 143: {} } }), after, '#143'],
      [fakeReader({ issues: { 143: 'gone' } }), after, '#143'],
      [fakeReader(), { days: 3, issue: 41, repo: 'acme/tools' }, 'acme/tools#41'],
    ];
    for (const [f, wait, ref] of cases) {
      assert.equal(await repair(f, wait), 'commented', JSON.stringify(wait));
      assert.equal(f.comments.length, 1);
      const said = f.comments[0]!.body;
      assert.ok(said.includes(waitRelativeMarker(ref)), said);
      assert.match(said, /blocker/);
      assert.match(said, /YYYY-MM-DD/);
      assert.deepEqual([f.edits, f.links], [[], []]);
    }
    const told = fakeReader({ issues: { 143: {} }, thread: [{ body: waitRelativeMarker('#143') }] });
    assert.equal(await repair(told), 'already told');
    assert.deepEqual(told.comments, []);
  });

  test('the comment\'s marker names the issue, so a line moved to another issue that cannot be settled is told again', async () => {
    assert.equal(waitRelativeMarker('#143'), '<!-- governor:wait-relative #143 -->');
    assert.equal(waitRelativeMarker('acme/tools#41'), '<!-- governor:wait-relative acme/tools#41 -->');
    const f = fakeReader({ issues: { 143: {}, 150: {} } });
    assert.equal(await repair(f), 'commented');
    assert.ok(f.comments[0]!.body.includes(waitRelativeMarker('#143')), f.comments[0]!.body);
    const moved = fakeReader({ issues: { 150: {} }, thread: [{ body: f.comments[0]!.body }] });
    assert.equal(await repair(moved, { days: 3, issue: 150 }), 'commented');
    assert.equal(moved.comments.length, 1);
    assert.ok(moved.comments[0]!.body.includes(waitRelativeMarker('#150')), moved.comments[0]!.body);
    const again = fakeReader({ issues: { 150: {} }, thread: [{ body: f.comments[0]!.body }, { body: moved.comments[0]!.body }] });
    assert.equal(await repair(again, { days: 3, issue: 150 }), 'already told');
    assert.deepEqual(again.comments, []);
  });

  test('a ticket an open blocker still holds is left to that blocker\'s close', async () => {
    const f = fakeReader({ issues: { 143: {} }, blockers: [{ number: 143, state: 'open' }] });
    assert.equal(await repair(f), 'held by an open blocker');
    assert.deepEqual([f.edits, f.comments], [[], []]);
  });

  test('a dependency summary that counts an open blocker holds the ticket, and no blocker rows are read for it', async () => {
    // A blocker in a repo the App cannot see is left out of the rows, and
    // the summary still counts it.
    const f = fakeReader({ issues: { 143: {} } });
    assert.equal(await repairRelative({ reader: f.reader as never, repo: REPO, issue: 7, after, openBlockers: 1, link: false, prompts: {}, log: logs().log }), 'held by an open blocker');
    assert.deepEqual([f.edits, f.comments, f.asked], [[], [], []]);
  });

  test('a summary that counts none still has the rows read, so a link it has not counted yet holds the ticket', async () => {
    const f = fakeReader({ blockers: [{ number: 41, state: 'open', repo: 'acme/tools' }] });
    assert.equal(await repairRelative({ reader: f.reader as never, repo: REPO, issue: 7, after: { days: 3, issue: 41, repo: 'acme/tools' }, openBlockers: 0, link: false, prompts: {}, log: logs().log }), 'held by an open blocker');
    assert.deepEqual([f.edits, f.comments], [[], []]);
  });

  test('the selection reports every ready ticket held by a relative line, with its dependency summary, and starts none', async () => {
    const rows = [
      { number: 7, title: 'Issue 7', state: 'open', created_at: '2026-10-01T00:00:00Z', labels: LABELS.ready, openBlockers: 0, wait: { after } },
      { number: 8, title: 'Issue 8', state: 'open', created_at: '2026-10-01T00:00:00Z', labels: LABELS.ready, openBlockers: 1, wait: { after } },
    ];
    const reader = { readyIssues: async () => rows, ticket: async () => { throw new Error('unread'); }, blockers: async () => [], comments: async () => [] };
    const relative: Array<{ repo: string; issue: number; after: { days: number; issue: number; repo?: string }; openBlockers?: number }> = [];
    const planned = await planSchedule({ sources: [{ repo: REPO, reader: reader as never, labels: LABELS }], cap: 5, now: NOW, relative });
    assert.deepEqual(planned, []);
    assert.deepEqual(relative, [{ repo: REPO, issue: 7, after, openBlockers: 0 }, { repo: REPO, issue: 8, after, openBlockers: 1 }]);
  });
});
