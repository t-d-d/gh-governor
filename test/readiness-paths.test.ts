/**
 * What the four paths that decide whether a ticket may start answer for the
 * same ticket states, as main has them.
 *
 * - The selection: `selectReadyWork` (scripts/lib/ready-work.mjs) through
 *   `planSchedule` (scripts/lib/dispatch-router.mjs), with its unreadable
 *   and relative reports.
 * - The claim's second read: `claim` in dispatch/turn.mjs, through `run`.
 * - The unblocked row: `ticketRow` (dispatch/unblocked.mjs), and what an
 *   `unblocked` fire does with it, through `run`.
 * - Wait end: `endedWaits` (dispatch/waits.mjs), on an item whose date has
 *   passed.
 *
 * Each path's answer is written out below as a rule over the state. Where
 * two paths answer differently, a comment names the difference. This test
 * records them and fixes none: the readiness rule is moving into one
 * function, and this table must read the same after every step of the move.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';
import { run } from '../dispatch/turn.mjs';
import { planSchedule } from '../scripts/lib/dispatch-router.mjs';
import { waitOf } from '../scripts/lib/ready-work.mjs';
import { ticketRow, UNREADIED_MARKER } from '../dispatch/unblocked.mjs';
import { endedWaits, WAIT_UNREADABLE_MARKER } from '../dispatch/waits.mjs';
import { dispatchMarker } from '../dispatch/webhook/fire.mjs';
import { storedLogin } from '../scripts/lib/claude-login.mjs';
import { factoryFile } from './helpers/factory.ts';

const REPO = 'acme/factory';
const FILE = factoryFile(CONFIG_PATH);
const READ = readConfig(FILE);
if (!READ.ok) throw new Error(`the factory's ${CONFIG_PATH} does not read: ${READ.fault}`);
/** The factory's labels, as governor reads its file, defaults filled. */
const LABELS = READ.config.labels;
const READY: string[] = LABELS.ready;
const NOW = Date.parse('2026-09-25T12:00:00Z');
const ISSUE = 7;
/** The blocker whose close sends the `unblocked` fire, closed as completed. */
const BLOCKER = { repo: REPO, number: 41, title: 'The parser', reason: 'completed' };
/** Wait end's item: a date that has passed. */
const ITEM = '2026-09-20';
/** The App that posts governor's comments. */
const APP_ID = 5;
/** A session an earlier pickup started, named by its dispatch marker, older than the dispatch window. */
const SESSION = 'https://claude.ai/code/session_01OWNER';
const MARKED = { body: dispatchMarker({ at: '2026-09-01T00:00:00.000Z', sessionUrl: SESSION }), created_at: '2026-09-01T00:00:00Z', ours: true };
const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'sk-ant-ort01-r', expiresAt: NOW + 3_600_000, refreshTokenExpiresAt: NOW + 30 * 86_400_000, scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'] } });
const CONFIRMED = 'Created cloud session: https://claude.ai/code/session_01ABC\nResume with: claude --teleport session_01ABC\n';

// ── The states ───────────────────────────────────────────────────────────

type LabelState = 'excluded' | 'claimed' | 'ready' | 'not-ready';
type Line = 'none' | 'ahead' | 'past' | 'relative' | 'unreadable';
/** `summary`: whether the read carries its dependency summary, or leaves the blocker to its `blocked_by` rows. */
type State = { open: boolean; labels: LabelState; blocker: boolean; summary: boolean; line: Line; unreadied: boolean };

const LABEL_STATES: LabelState[] = ['excluded', 'claimed', 'ready', 'not-ready'];
const LINES: Line[] = ['none', 'ahead', 'past', 'relative', 'unreadable'];

const labelsOf: Record<LabelState, string[]> = {
  excluded: [...READY, LABELS.exclude[0]!],
  claimed: [LABELS.claim, 'mode: afk'],
  ready: [...READY],
  'not-ready': ['mode: afk'],
};
/** Each line, as the body's first line. A relative line waits on #43, not the closing blocker. */
const bodyOf: Record<Line, string> = {
  none: 'The work.',
  ahead: 'Blocked until: 2026-10-01\n\nThe work.',
  past: `Blocked until: ${ITEM}\n\nThe work.`,
  relative: 'Blocked until: 3 days after #43 closes\n\nThe work.',
  unreadable: 'Blocked until: soon\n\nThe work.',
};

const STATES: State[] = [true, false].flatMap((open) =>
  LABEL_STATES.flatMap((labels) => [false, true].flatMap((blocker) => [true, false].flatMap((summary) =>
    LINES.flatMap((line) => [false, true].map((unreadied) => ({ open, labels, blocker, summary, line, unreadied })))))));

const nameOf = (s: State) => `${s.open ? 'open' : 'closed'}, ${s.labels}, ${s.blocker ? 'an open blocker' : 'no blocker'}${s.summary ? '' : ' by its rows alone'}, line ${s.line}${s.unreadied ? ', unanswered unreadied comment' : ''}`;

/** The ticket as the reader returns it, its blocker in its dependency summary or, without one, only in its `blocked_by` rows. */
const ticketOf = (s: State) => {
  const body = bodyOf[s.line];
  return { number: ISSUE, id: 9007, title: 'The ticket', body, state: s.open ? 'open' : 'closed', labels: labelsOf[s.labels], pull: false, ...(s.summary ? { openBlockers: s.blocker ? 1 : 0 } : {}), created_at: '2026-09-01T00:00:00Z', ...waitOf(body) };
};
/** Its `blocked_by` rows. */
const rowsOf = (s: State) => (s.blocker ? [{ number: 42, state: 'open', title: 'Another' }] : []);
/** A ticket ready and free, as an earlier read saw it. */
const cleanTicket = () => ticketOf({ open: true, labels: 'ready', blocker: false, summary: true, line: 'none', unreadied: false });

/** The thread: the dispatch marker of an earlier session, and governor's unreadied comment with no answer. */
const threadOf = (s: State) => [
  MARKED,
  ...(s.unreadied ? [{ body: `Its work will not land as planned.\n\n${UNREADIED_MARKER}`, created_at: '2026-09-10T00:00:00Z', ours: true }] : []),
].map((c, i) => ({ id: i + 1, ...c }));

/** A reader over one ticket; `ticketAt(n)` is the ticket on the n-th read, from 1, and `reads()` counts them. */
const readerOf = (s: State, ticketAt: (n: number) => ReturnType<typeof ticketOf>, sink: { comments: string[] }) => {
  let reads = 0;
  return {
    reads: () => reads,
    readyIssues: async () => [],
    ticket: async (n: number) => {
      if (n !== ISSUE) throw Object.assign(new Error('no such issue'), { status: 404 });
      reads += 1;
      return ticketAt(reads);
    },
    blockers: async () => rowsOf(s),
    blocking: async () => [],
    comments: async () => threadOf(s),
    allComments: async () => threadOf(s),
    comment: async (_n: number, body: string) => { sink.comments.push(body); },
    addLabels: async () => {},
    removeLabel: async () => {},
    ensureLabel: async () => {},
    labelRemovals: async () => [],
    addBlocker: async () => {},
    removeBlocker: async () => {},
    issue: async (n: number) => ({ number: n, body: '', pull: false }),
    updateIssue: async () => {},
    defaultBranch: async () => 'main',
    mergedSince: async () => [],
    issuesOpenedSince: async () => [],
    issuesClosedSince: async () => [],
  };
};

/**
 * The turn's dependencies, with every store empty and no cloud session but
 * the ones it launches. Each error the turn logs lands in `errors`: a stub
 * that throws would otherwise read as a path that does nothing.
 */
const depsOf = (reader: unknown, launches: string[], messages: string[], errors: string[]) => ({
  owners: ['acme'],
  installations: async () => [{ account: 'acme', repos: [REPO] }],
  configFile: async (repo: string) => (repo === REPO ? FILE : null),
  cap: 2,
  now: () => NOW,
  sleep: async () => {},
  log: errorsTo(errors),
  secret: { get: async () => storedLogin(LOGIN, { accountUuid: 'acc-1', organizationUuid: 'org-1' }), put: async () => {} },
  githubToken: async () => 'ghs_t',
  appId: async () => APP_ID,
  reader: () => reader,
  workspace: { prepare: () => ({ home: '/tmp/home', cwd: '/tmp/repo' }), writeLogin: () => {}, readLogin: () => null, useAccount: () => {} },
  launch: async ({ prompt }: { prompt: string }) => { launches.push(prompt); return { status: 0, output: CONFIRMED }; },
  probe: async () => ({ ok: true }),
  message: async ({ session }: { session: string }) => { messages.push(session); return { status: 0, output: JSON.stringify({ ok: true, session_id: 'session_01OWNER', url: SESSION }) }; },
  archive: async () => ({ status: 200, body: '{}' }),
  sessions: { list: async () => ({ data: [] }), get: async (id: string) => ({ id, session_status: 'SESSION_STATUS_IDLE' }), events: async () => ({ data: [] }) },
  fires: { waiting: async () => 1 },
  enqueue: async () => { throw new Error('this test queues no fire'); },
  routines: () => ({}),
  uuid: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  hookTable: { publish: async () => true },
  state: {
    cursor: async () => null, advance: async () => true, delivered: async () => ({ told: [], failed: [] }), record: async () => {},
    recordConflict: async () => true, periodic: async () => null, recordPeriodic: async () => true,
    sweep: async () => null, recordSweep: async () => true, hookSession: async () => null, recordHookSession: async () => true,
    recordSession: async () => {}, startedSession: async () => false,
    waits: async () => [], wait: async () => null, recordWait: async () => true, dropWait: async () => true,
  },
});

/** A log that keeps each error-level line, as JSON. */
function errorsTo(errors: string[]) {
  return (event: string, fields: Record<string, unknown> = {}) => {
    if (fields.level === 'error') errors.push(JSON.stringify({ event, ...fields }));
  };
}

const unreadableSaid = (comments: string[]) => comments.some((c) => c.includes(WAIT_UNREADABLE_MARKER));

// ── Each path's answer ──────────────────────────────────────────────────

/** The selection: whether it picks the ticket, and which reports it makes. */
const selection = async (s: State) => {
  const sink = { comments: [] as string[] };
  const reader = readerOf(s, () => ticketOf(s), sink);
  const unreadable: unknown[] = [];
  const relative: unknown[] = [];
  const plan = await planSchedule({ sources: [{ repo: REPO, reader: reader as never, labels: LABELS }], cap: 1, now: NOW, only: [ISSUE], unreadable: unreadable as never, relative: relative as never });
  return { picks: plan.length === 1, unreadable: unreadable.length > 0, relative: relative.length > 0 };
};

/** The claim's second read: a schedule fire naming the ticket, whose plan read it ready and free, and whose claim reads it as `s`. */
const claim = async (s: State) => {
  const sink = { comments: [] as string[] };
  const reader = readerOf(s, (n) => (n === 1 ? cleanTicket() : ticketOf(s)), sink);
  const launches: string[] = [];
  const errors: string[] = [];
  await run({ kind: 'schedule', repo: REPO, issue: ISSUE }, depsOf(reader, launches, [], errors) as never);
  assert.deepEqual(errors, [], nameOf(s));
  // The plan's read, then the claim's: with any other count, what follows
  // would not be the claim's answer.
  assert.equal(reader.reads(), 2, `the plan reads the ticket once and the claim once more: ${nameOf(s)}`);
  return { claims: launches.length === 1, unreadable: unreadableSaid(sink.comments) };
};

type Does = 'pickup' | 'spec' | 'message' | 'nothing';

/** The unblocked row, and what the `unblocked` fire of a completed close does. */
const unblocked = async (s: State) => {
  const row = ticketRow({ ticket: ticketOf(s), blockers: s.summary ? undefined : rowsOf(s), fire: { blocker: BLOCKER }, labels: LABELS, now: NOW });
  const sink = { comments: [] as string[] };
  const reader = readerOf(s, () => ticketOf(s), sink);
  const launches: string[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  const result = await run({ kind: 'unblocked', repo: REPO, issue: ISSUE, blocker: BLOCKER }, depsOf(reader, launches, messages, errors) as never) as { row?: string };
  assert.deepEqual(errors, [], nameOf(s));
  assert.equal(result.row, row, `the fire takes ticketRow's row: ${nameOf(s)}`);
  const does: Does = messages.length > 0 ? 'message'
    : launches.length === 0 ? 'nothing'
      : launches[0]!.startsWith(`Spec #${ISSUE}`) ? 'spec' : 'pickup';
  return { row, does, unreadable: unreadableSaid(sink.comments) };
};

type WaitEnd = 'spec' | 'commented' | 'moved later' | 'dropped';

/** Wait end: what the bare fire does with an item whose date has passed, under `waits` and `unblocked`. */
const waitEnd = async (s: State) => {
  const sink = { comments: [] as string[] };
  const reader = readerOf(s, () => ticketOf(s), sink);
  const writes: string[] = [];
  const state = {
    waits: async () => [{ issue: ISSUE, until: ITEM }],
    wait: async () => ({ until: ITEM }),
    recordWait: async (_r: string, _i: number, _read: string, until: string) => { writes.push(`moved ${until}`); return true; },
    dropWait: async () => { writes.push('dropped'); return true; },
  };
  const errors: string[] = [];
  const ended = await endedWaits({ reader: reader as never, state: state as never, repo: REPO, labels: LABELS, spec: true, now: NOW, log: errorsTo(errors) });
  assert.deepEqual(ended.unread, [], nameOf(s));
  assert.deepEqual(errors, [], nameOf(s));
  const commented = sink.comments.some((c) => !c.includes(WAIT_UNREADABLE_MARKER));
  const does: WaitEnd = ended.specs.length > 0 ? 'spec'
    : writes.some((w) => w.startsWith('moved')) ? 'moved later'
      : commented ? 'commented' : 'dropped';
  return { does, unreadable: unreadableSaid(sink.comments) };
};

// ── What main answers ───────────────────────────────────────────────────

/** A line that holds a ticket at NOW, as `isWaiting` reads it. A date that has passed holds nothing. */
const lineHolds = (s: State) => s.line === 'ahead' || s.line === 'relative' || s.line === 'unreadable';

/**
 * Pickup's selection and the claim's second read answer the same for every
 * state: open, ready by its labels, no open blocker, and no line that
 * holds. They have agreed on an open blocker since the claim's second read
 * learned to skip a ticket with one.
 */
const mayPickUp = (s: State) => s.open && s.labels === 'ready' && !s.blocker && !lineHolds(s);

/**
 * The selection and the claim say an unreadable line only on a ticket ready
 * by its labels, open blocker or not.
 *
 * Difference: the unblocked row and wait end say it on a ticket ready or not
 * ready (`waitHolds`). A not-ready ticket's unreadable line is told only
 * when a blocker closes or its wait ends.
 */
const pickupSaysUnreadable = (s: State) => s.open && s.labels === 'ready' && s.line === 'unreadable';
const specSaysUnreadable = (s: State) => s.open && (s.labels === 'ready' || s.labels === 'not-ready') && s.line === 'unreadable';

/**
 * The selection reports every ready ticket held by a relative line, blocked
 * or not, as its unreadable report does. The sweep's repair
 * (`repairRelative`) judges the blocker: by the dependency summary the
 * report passes it, or, with none, by the `blocked_by` rows it reads.
 *
 * Difference: only the selection reports a relative line it may need to
 * settle. The unblocked fire settles one only when the line waits on the
 * issue that closed, which these states' line does not, and wait end drops
 * the item of a ticket whose line became relative.
 */
const selectionSaysRelative = (s: State) => s.open && s.labels === 'ready' && s.line === 'relative';

/**
 * `ticketRow`: closed, then an open blocker, then a line that holds where
 * the labels read ready or not ready, then the labels.
 *
 * Difference: an open blocker reads `blocked` whatever the labels say, while
 * a line holds only a ticket ready or not ready. So a claimed ticket with
 * another open blocker reads `blocked`, and its session is not told this
 * close, though a claimed ticket with a line ahead reads `claimed` and is.
 * An excluded ticket with an open blocker reads `blocked`, not `excluded`.
 */
const rowOf = (s: State) => {
  if (!s.open) return 'closed';
  if (s.blocker) return 'blocked';
  if ((s.labels === 'ready' || s.labels === 'not-ready') && lineHolds(s)) return 'blocked';
  return s.labels;
};

/**
 * What the `unblocked` fire does with its row, with the factory's pickup
 * and unblocked on. A ready row starts as pickup does. A not-ready row
 * starts a spec session unless governor's unreadied comment has no answer
 * (`heldUnreadied`). A claimed row messages the session its dispatch marker
 * names.
 */
const unblockedDoes = (s: State): Does => {
  const row = rowOf(s);
  if (row === 'ready') return 'pickup';
  if (row === 'claimed') return 'message';
  if (row === 'not-ready') return s.unreadied ? 'nothing' : 'spec';
  return 'nothing';
};

/**
 * Wait end, on an item whose date has passed. A closed ticket's item, or
 * one whose line is gone, unreadable or now relative, goes. A date a person
 * moved later rewrites the item, whatever the labels or blockers say: it
 * asks only whether the date is still to come. A date that has passed on a
 * ticket not ready and with no open blocker gets the wait-ended comment and
 * a spec session; any other ticket's item goes.
 *
 * Difference: with an unanswered unreadied comment, the unblocked fire says
 * nothing on a not-ready ticket, while wait end still posts its wait-ended
 * comment. Neither starts a spec session.
 */
const waitEndDoes = (s: State): WaitEnd => {
  if (!s.open) return 'dropped';
  if (s.line === 'ahead') return 'moved later';
  if (s.line !== 'past') return 'dropped';
  if (s.blocker || s.labels !== 'not-ready') return 'dropped';
  return s.unreadied ? 'commented' : 'spec';
};

describe('the four readiness paths, as main has them', () => {
  test('the states cover open and closed, every label state, a blocker or none, by summary or by rows, every line, and an unreadied comment or none', () => {
    assert.equal(STATES.length, 2 * 4 * 2 * 2 * 5 * 2);
    // Wait end's moved date on a claimed ticket is among them.
    assert.ok(STATES.some((s) => s.open && s.labels === 'claimed' && s.line === 'ahead'));
  });

  test('pickup\'s selection, with its unreadable and relative reports', async () => {
    for (const s of STATES) {
      assert.deepEqual(await selection(s), { picks: mayPickUp(s), unreadable: pickupSaysUnreadable(s), relative: selectionSaysRelative(s) }, nameOf(s));
    }
  });

  test('the claim\'s second read, through run', async () => {
    for (const s of STATES) {
      assert.deepEqual(await claim(s), { claims: mayPickUp(s), unreadable: pickupSaysUnreadable(s) }, nameOf(s));
    }
  });

  test('the unblocked row, and the unblocked fire through run', async () => {
    for (const s of STATES) {
      assert.deepEqual(await unblocked(s), { row: rowOf(s), does: unblockedDoes(s), unreadable: specSaysUnreadable(s) }, nameOf(s));
    }
  });

  test('wait end', async () => {
    for (const s of STATES) {
      assert.deepEqual(await waitEnd(s), { does: waitEndDoes(s), unreadable: specSaysUnreadable(s) }, nameOf(s));
    }
  });

  // Where a ready ticket's start is decided, the paths that can start it agree.
  test('a ticket the selection and the claim would start is the one the unblocked row reads ready', () => {
    for (const s of STATES) assert.equal(mayPickUp(s), rowOf(s) === 'ready', nameOf(s));
  });
});
