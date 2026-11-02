/**
 * A ticket's own wait: a body that opens with `Blocked until: <YYYY-MM-DD>`.
 *
 * The rule that holds the ticket is the shared readiness rule's
 * (`isWaiting`, scripts/lib/ready-work.mjs), and the reader carries what the
 * line says (`waitOf`). The hold needs no switch, and nor does what governor
 * says when it cannot read the line: a warning in the log and one comment on
 * the ticket, under {@link WAIT_UNREADABLE_MARKER}, which a later turn finds
 * before it writes another. That comment is an error report, not a feature.
 *
 * With a repo's `waits` switch on, governor also acts when a wait ends. The
 * receiver queues a `wait` fire for an issue opened, reopened or edited with
 * the line,
 * and its turn keeps one item per waiting ticket in the state table,
 * `wait#<repo>` / `<issue>`, holding the date ({@link holdWait}). The item
 * only tells governor when to look: the ticket's line stays the record
 * people read and edit. The bare schedule fire reads each such repo's items
 * ({@link endedWaits}). A ticket whose date has passed and that is not
 * ready gets one comment, under a marker naming the date
 * ({@link waitEndedMarker}), and, with `unblocked` on, a spec session on the
 * repo's `waitEndedSpec` prompt. Every session governor starts in such a
 * repo is told how to make a ticket wait ({@link WAIT_PROMPT}).
 *
 * A lost `opened`, `reopened` or `edited` delivery leaves its ticket out of the items,
 * so it gets no comment or spec session when its wait ends. A ready ticket
 * loses nothing: pickup's sweep reads its line itself.
 *
 * A line may wait a number of days after an issue closes instead:
 * `Blocked until: 3 days after #143 closes`. The issue must be a declared
 * blocker of the ticket, so the dependency hold keeps the ticket out while
 * it is open, and its close reaches the ticket's own turn, from another repo
 * too. The line holds the ticket until governor rewrites it, once, into its
 * date ({@link relativeAtClose}), whatever the repo's switches say. A close
 * that is not completed leaves the line, and the ticket held, with one
 * comment under {@link waitNotPlannedMarker}. With `waits` on, the `wait`
 * turn links a same-repo issue the line names where it is not linked, and
 * the bare schedule fire's sweep repairs a ready ticket whose line no open
 * blocker holds ({@link repairRelative}), or says once, under
 * {@link WAIT_RELATIVE_MARKER}, that it cannot.
 */

import { recentlyDispatched, waitLine } from './webhook/fire.mjs';
import { specSession, unblockedFacts } from './unblocked.mjs';
import { instruction } from './prompts.mjs';
import { RELATIVE_WAIT, isBlocked, isWaiting, labelRow, waitOf, waitsOnClose } from '../scripts/lib/ready-work.mjs';

/** The log event for a `Blocked until:` line governor cannot read. */
export const WAIT_UNREADABLE = 'dispatch-wait-unreadable';

/** The marker on governor's one comment about an unreadable line. */
export const WAIT_UNREADABLE_MARKER = '<!-- governor:wait-unreadable -->';

/**
 * The comment a ticket gets when governor cannot read its line. The value is
 * quoted as code, so an `@handle` or `#N` in it neither notifies nor links.
 *
 * @param {string} value What followed `Blocked until:`.
 */
export const waitUnreadableComment = (value) => {
  const said = value === '' ? 'holds no date' : `says \`${value.replace(/`/g, "'")}\``;
  return [
    `Governor cannot read the date on this ticket's \`Blocked until:\` line, which ${said}, so it is holding the ticket.`,
    'Write the date as `Blocked until: YYYY-MM-DD` on the body\'s first line, or delete the line to free the ticket.',
    '',
    WAIT_UNREADABLE_MARKER,
  ].join('\n');
};

/**
 * Say that a ticket's line cannot be read: a warning in the log every time,
 * and one comment on the ticket, unless its thread already carries the
 * marker. A thread or a comment that fails is logged at error and skipped:
 * the ticket is held either way, and the next turn tries again, so a failed
 * read is never taken for a thread without the marker.
 *
 * @param {{
 *   reader: { allComments: (n: number) => Promise<Array<{ body: string }>>, comment: (n: number, body: string) => Promise<void> },
 *   repo: string,
 *   issue: number,
 *   value: string,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} args
 * @returns {Promise<'commented' | 'already told' | 'failed'>}
 */
export const reportUnreadable = async ({ reader, repo, issue, value, log }) => {
  log(WAIT_UNREADABLE, { level: 'warn', repo, issue, value, reason: 'its `Blocked until:` line holds no date governor can read, so the ticket is held' });
  try {
    const thread = await reader.allComments(issue);
    if (thread.some((c) => String(c.body ?? '').includes(WAIT_UNREADABLE_MARKER))) return 'already told';
    await reader.comment(issue, waitUnreadableComment(value));
    return 'commented';
  } catch (error) {
    log(WAIT_UNREADABLE, { level: 'error', repo, issue, value, error: error instanceof Error ? error.message : String(error), reason: 'the ticket is held, and governor could not say so on it this turn' });
    return 'failed';
  }
};

// ── When a wait ends, under the `waits` switch ───────────────────────────

/** The log event for what a turn did with a ticket's wait item. */
export const WAIT = 'dispatch-wait';

/** The log event for an ended wait governor could not act on this turn. */
export const WAIT_UNHANDLED = 'dispatch-wait-unhandled';

/** How governor's comment on a wait that ended starts: the marker, then the date. */
export const WAIT_ENDED_MARKER = '<!-- governor:wait-ended ';

/**
 * The marker on governor's one comment about a wait that ended on `until`.
 * It names the date, so a ticket that waits again on a later date is told
 * again.
 *
 * @param {string} until `YYYY-MM-DD`.
 */
export const waitEndedMarker = (until) => `${WAIT_ENDED_MARKER}${until} -->`;

/**
 * The comment a ticket that is not ready gets when its wait ends.
 *
 * @param {string} until
 */
export const waitEndedComment = (until) => [
  `The wait on this ticket has ended: its \`Blocked until:\` line names ${until}, which has passed. It is not ready to pick up.`,
  'Ready it, or write the question it still waits on into its body.',
  '',
  waitEndedMarker(until),
].join('\n');

/**
 * The line that ends every launch's prompt in a repo with `waits` on, after
 * the line on signing posts (dispatch/turn.mjs).
 */
export const WAIT_PROMPT = 'To make a ticket wait until a date, start its body with the line `Blocked until: YYYY-MM-DD`. Governor does not start it before 00:00 UTC on that date.';

/**
 * A spec session's opening prompt for a ticket whose wait ended: the
 * unblocked spec session's shape, the wait's facts in place of a close's,
 * and the repo's `waitEndedSpec` instruction. Governor does not claim the
 * ticket; the prompt tells the session to add the claim itself before it
 * builds.
 *
 * @param {{ issue: number, title: string, until: string, labels: { ready: readonly string[], claim: string }, prompts: Record<string, string | undefined> }} args
 */
export const waitSpecPrompt = ({ issue, title, until, labels, prompts }) => specSession({
  issue, title, labels, prompts, kind: 'waitEndedSpec',
  facts: `#${issue}'s wait has ended: its \`Blocked until:\` line named ${until}, which has passed.`,
});

/**
 * @typedef {{
 *   waits: (repo: string) => Promise<Array<{ issue: number, until: string }>>,
 *   wait: (repo: string, issue: number) => Promise<{ until: string } | null>,
 *   recordWait: (repo: string, issue: number, read: string | null, until: string) => Promise<boolean>,
 *   dropWait: (repo: string, issue: number, read: string) => Promise<boolean>,
 * }} WaitState
 *   A repo's wait items, each its ticket and date; one ticket's (null for
 *   none). A put goes only where none stands (`read` null) or over the date
 *   the turn read, and a delete only over that date: false where another
 *   turn changed it since. A read that fails throws, and is never taken
 *   for no item.
 *
 * @typedef {{
 *   ticket: (n: number) => Promise<{ number: number, title: string, state: string, labels: string[], openBlockers?: number, wait?: import('../scripts/lib/ready-work.mjs').Wait }>,
 *   blockers: (n: number) => Promise<Array<{ state: string }>>,
 *   allComments: (n: number) => Promise<Array<{ body: string }>>,
 *   comment: (n: number, body: string) => Promise<void>,
 * }} WaitReader
 *
 * @typedef {(event: string, context?: Record<string, unknown>) => void} Log
 */

/**
 * Whether an unreadable line holds a ticket from anyone, so its comment is
 * true: a ticket ready or not ready by its labels. A claimed ticket is
 * someone's work, and an excluded one is never picked up, so neither is
 * told it is held, as the claim's second read tells only a ready one.
 *
 * @param {readonly string[]} on
 * @param {import('../scripts/lib/ready-work.mjs').Labels} labels
 */
const holds = (on, labels) => ['ready', 'not-ready'].includes(labelRow(on, labels));

/** When a wait on `until` ends: 00:00 UTC on that date. @param {string} until */
const endOf = (until) => Date.parse(`${until}T00:00:00Z`);

/**
 * A ticket's read, or null where it is no ticket here any more: gone (404,
 * or 410 for a deleted one), or moved, whose read follows GitHub's redirect
 * to another repository's issue under another number. Its item then goes,
 * as the selection's read of one issue starts nothing for it
 * (scripts/lib/dispatch-router.mjs). Any other failure throws.
 *
 * @param {WaitReader} reader
 * @param {number} issue
 */
const ticketOf = (reader, issue) => reader.ticket(issue).then((t) => (t.number === issue ? t : null), (error) => {
  const status = /** @type {{ status?: number }} */ (error)?.status;
  if (status === 404 || status === 410) return null;
  throw error;
});

/**
 * A `wait` fire's turn: read the ticket and its line, and put, rewrite or
 * delete its item to match. A date still to come is held in the item, and
 * so is a date that has passed where an item stands, which the schedule
 * fire then acts on. No line, a date that has passed with no item, or a
 * closed ticket deletes it, or puts none. An unreadable line deletes it,
 * and is reported as the hold reports it on a ticket ready or not ready by
 * its labels. A ticket gone or
 * moved to another repo deletes it too. Each write goes only over the item
 * the turn read.
 *
 * A relative line keeps no item, and drops one that stands: it has no date
 * yet. On a ticket ready or not ready by its labels, the turn then settles
 * it ({@link repairRelative}): it links a same-repo issue the line names
 * where it is not linked, and rewrites or comments where that issue has
 * already closed. Another repo's issue is not read.
 *
 * @param {{ reader: WaitReader & RelativeReader, state: WaitState, repo: string, issue: number, labels: import('../scripts/lib/ready-work.mjs').Labels, now: number, log: Log, prompts?: Record<string, string | undefined> }} args
 * @returns {Promise<string>} What came of it, as logged.
 */
export const holdWait = async ({ reader, state, repo, issue, labels, now, log, prompts = {} }) => {
  const found = await ticketOf(reader, issue);
  const ticket = found ?? { state: 'gone or moved', labels: [], wait: undefined };
  const wait = ticket.state === 'open' ? ticket.wait : undefined;
  const read = await state.wait(repo, issue);
  const about = { repo, issue, ...(read === null ? {} : { read: read.until }) };
  if (wait !== undefined && 'after' in wait) {
    const dropped = read === null ? null : await state.dropWait(repo, issue, read.until);
    const settled = holds(ticket.labels, labels) ? await repairRelative({ reader, repo, issue, after: wait.after, link: true, prompts, now, log }) : 'not settled: the ticket is not held from anyone';
    const outcome = `relative: ${settled}`;
    log(WAIT, { ...about, after: wait.after, outcome, ...(dropped === null ? {} : { item: dropped ? 'dropped' : 'not dropped: it changed since it was read' }) });
    return outcome;
  }
  // A date that has passed, over an item: the item is kept at that date, so
  // the schedule fire still says the wait ended. An edit just after
  // midnight, or a wait moved earlier into the past, loses nothing.
  const passedOverItem = wait !== undefined && 'until' in wait && read !== null;
  if (wait !== undefined && 'until' in wait && (isWaiting({ wait }, now) || passedOverItem)) {
    if (read?.until === wait.until) {
      log(WAIT, { ...about, until: wait.until, outcome: 'held: the item already holds this date' });
      return 'held';
    }
    const written = await state.recordWait(repo, issue, read?.until ?? null, wait.until);
    const outcome = written ? 'held' : 'not held: the item changed since it was read';
    log(WAIT, { ...about, until: wait.until, outcome });
    return outcome;
  }
  if (wait !== undefined && 'unreadable' in wait && holds(ticket.labels, labels)) await reportUnreadable({ reader, repo, issue, value: wait.unreadable, log });
  if (read === null) {
    log(WAIT, { ...about, outcome: 'nothing to hold', state: ticket.state });
    return 'nothing to hold';
  }
  const dropped = await state.dropWait(repo, issue, read.until);
  const outcome = dropped ? 'dropped' : 'not dropped: the item changed since it was read';
  log(WAIT, { ...about, outcome, state: ticket.state, ...(wait === undefined ? {} : { wait }) });
  return outcome;
};

/**
 * @typedef {{ issue: number, title: string, until: string, read: string }} WaitSpec
 *   A ticket whose wait ended that gets a spec session: its title, the date
 *   its line names, and the date its item holds, which the turn deletes the
 *   item over once the session started.
 */

/**
 * The bare schedule fire's look at one repo's wait items. For each whose
 * date has passed, it reads the ticket again:
 *
 * - closed, gone, moved to another repo, or its line gone: the item goes;
 * - an unreadable line: the item goes, and the line is reported as the hold
 *   reports it on a ticket ready or not ready by its labels;
 * - a date still to come: the item is rewritten to it, and nothing is released;
 * - a date that has passed, on a ticket ready, claimed, excluded or still
 *   blocked: the item goes, since pickup or the blocker's close takes the
 *   ticket on;
 * - a date that has passed, on a ticket not ready: one comment, unless its
 *   thread carries the marker for that date, and, with `spec`, the ticket
 *   back as a {@link WaitSpec} unless a dispatch inside the window is on its
 *   thread. Its item stays until the turn has started the session, so a
 *   launch that fails, or one the turn has no room for, is tried at the next
 *   fire, and the marker keeps it to one comment. Otherwise the item goes.
 *
 * A ticket that cannot be read, or whose comment fails, keeps its item for
 * the next fire, and is logged and returned in `unread`. An items read that
 * fails leaves the whole repo for the next fire the same way.
 *
 * @param {{ reader: WaitReader, state: WaitState, repo: string, labels: import('../scripts/lib/ready-work.mjs').Labels, spec: boolean, now: number, log: Log }} args
 * @returns {Promise<{ specs: WaitSpec[], unread: Array<{ repo: string, error: string }> }>}
 */
export const endedWaits = async ({ reader, state, repo, labels, spec, now, log }) => {
  /** @type {WaitSpec[]} */
  const specs = [];
  /** @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  /** @type {Array<{ issue: number, until: string }>} */
  let items;
  try {
    items = await state.waits(repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(WAIT_UNHANDLED, { level: 'error', repo, error: message, reason: 'its wait items could not be read, so no ended wait is acted on this turn' });
    return { specs, unread: [{ repo, error: `wait items: ${message}` }] };
  }
  /** @param {{ issue: number, until: string }} item @param {Record<string, unknown>} context */
  const drop = async ({ issue, until }, context) => {
    const dropped = await state.dropWait(repo, issue, until);
    log(WAIT, { repo, issue, read: until, ...context, item: dropped ? 'dropped' : 'not dropped: it changed since it was read' });
  };
  for (const item of items) {
    if (now < endOf(item.until)) continue;
    const { issue } = item;
    try {
      const ticket = await ticketOf(reader, issue);
      if (ticket === null) {
        await drop(item, { outcome: 'its ticket is gone or moved' });
        continue;
      }
      const wait = ticket.state === 'open' ? ticket.wait : undefined;
      if (wait === undefined) {
        await drop(item, { outcome: ticket.state === 'open' ? 'its line is gone' : `its ticket is ${ticket.state}` });
        continue;
      }
      if ('unreadable' in wait) {
        if (holds(ticket.labels, labels)) await reportUnreadable({ reader, repo, issue, value: wait.unreadable, log });
        await drop(item, { outcome: 'its line cannot be read' });
        continue;
      }
      if ('after' in wait) {
        await drop(item, { outcome: 'its line now waits on an issue\'s close' });
        continue;
      }
      if (isWaiting({ wait }, now)) {
        const written = await state.recordWait(repo, issue, item.until, wait.until);
        log(WAIT, { repo, issue, read: item.until, until: wait.until, outcome: written ? 'moved later: not released' : 'moved later, and the item changed since it was read' });
        continue;
      }
      const blockers = ticket.openBlockers === undefined ? await reader.blockers(issue) : undefined;
      const row = isBlocked(ticket, blockers) ? 'blocked' : labelRow(ticket.labels, labels);
      if (row !== 'not-ready') {
        await drop(item, { until: wait.until, outcome: `ended on a ticket ${row}: nothing to say` });
        continue;
      }
      const thread = await reader.allComments(issue);
      const marker = waitEndedMarker(wait.until);
      const told = thread.some((c) => String(c.body ?? '').includes(marker));
      if (!told) await reader.comment(issue, waitEndedComment(wait.until));
      if (spec && !recentlyDispatched(thread, now)) {
        specs.push({ issue, title: ticket.title, until: wait.until, read: item.until });
        log(WAIT, { repo, issue, read: item.until, until: wait.until, outcome: told ? 'ended: already told, starting a spec session' : 'ended: commented, starting a spec session' });
        continue;
      }
      await drop(item, { until: wait.until, outcome: told ? 'ended: already told' : 'ended: commented', ...(spec ? { spec: 'dispatched inside the window' } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(WAIT_UNHANDLED, { level: 'error', repo, issue, read: item.until, error: message, reason: 'its item stays, so the next fire tries again' });
      unread.push({ repo, error: `wait #${issue}: ${message}` });
    }
  }
  return { specs, unread };
};


// ── A relative wait: `Blocked until: <N> days after #<issue> closes` ─────

/** The log event for what governor did with a relative line. */
export const WAIT_RELATIVE = 'dispatch-wait-relative';

/** How governor's comment on a relative wait's close that was not completed starts. */
export const WAIT_NOT_PLANNED_MARKER = '<!-- governor:wait-not-planned ';

/**
 * The marker on governor's one comment about `ref`'s close that was not
 * completed. It names the issue, so a line moved to wait on another issue
 * is told again.
 *
 * @param {string} ref `#<issue>`, or `<owner>/<repo>#<issue>` for another repo's.
 */
export const waitNotPlannedMarker = (ref) => `${WAIT_NOT_PLANNED_MARKER}${ref} -->`;

/** The marker on governor's one comment about a relative line it cannot settle. */
export const WAIT_RELATIVE_MARKER = '<!-- governor:wait-relative -->';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A relative wait's date: the first day whose 00:00 UTC is at least `days`
 * days after `closedAt`, so the wait is never shorter than it says.
 *
 * @param {string} closedAt ISO time.
 * @param {number} days
 * @returns {string} `YYYY-MM-DD`.
 */
export const relativeUntil = (closedAt, days) => {
  const at = Date.parse(closedAt) + days * DAY_MS;
  return new Date(Math.ceil(at / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
};

/**
 * `body` with its relative line rewritten into `until`: `Blocked until:
 * <date> (<N> days after #143 closed)`, then any reason the line gave. The
 * rest of the body, and the line's indent and line ending, are left as they
 * were. Null where the body's first non-empty line is not a relative line.
 *
 * @param {string} body
 * @param {string} until `YYYY-MM-DD`.
 * @returns {string | null}
 */
export const datedBody = (body, until) => {
  const lines = body.split('\n');
  const at = lines.findIndex((line) => line.trim() !== '');
  if (at < 0) return null;
  const line = /** @type {string} */ (lines[at]);
  const end = line.endsWith('\r') ? '\r' : '';
  const core = line.slice(0, line.length - end.length);
  const value = waitLine(core);
  const match = value === null ? null : RELATIVE_WAIT.exec(value);
  if (value === null || match === null) return null;
  const days = Number(match[1]);
  const ref = `${match[2] ?? ''}#${match[3]}`;
  const indent = /^\s*/.exec(core)?.[0] ?? '';
  lines[at] = `${indent}Blocked until: ${until} (${days} ${days === 1 ? 'day' : 'days'} after ${ref} closed)${value.slice(match[0].length)}${end}`;
  return lines.join('\n');
};

/**
 * @typedef {{
 *   issue: (n: number) => Promise<{ body: string }>,
 *   updateIssue: (n: number, change: { body: string }) => Promise<void>,
 *   allComments: (n: number) => Promise<Array<{ body: string }>>,
 *   comment: (n: number, body: string) => Promise<void>,
 *   blockers: (n: number) => Promise<Array<{ number: number, state: string, repo?: string }>>,
 *   issueClose: (n: number) => Promise<{ id: number, number: number, title: string, state: string, reason: string | null, closedAt: string | null }>,
 *   addBlocker: (n: number, id: number) => Promise<void>,
 * }} RelativeReader
 *   What a relative wait reads and writes, all in the ticket's own repo.
 */

/** @param {string} a @param {string} b */
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * How a ticket of `repo` names `closed`: `#<issue>` in its own repo, or
 * `<owner>/<repo>#<issue>`.
 *
 * @param {string} repo
 * @param {{ repo: string, number: number }} closed
 */
const refOf = (repo, closed) => (sameRepo(repo, closed.repo) ? `#${closed.number}` : `${closed.repo}#${closed.number}`);

/**
 * The comment a ticket gets when the issue its line waits on closed other
 * than as completed: the close's facts, the not-planned ask, and how to free
 * the ticket, which the line still holds.
 *
 * @param {{ facts: string, issue: number, ref: string, prompts: Record<string, string | undefined> }} args
 */
export const waitNotPlannedComment = ({ facts, issue, ref, prompts }) => [
  facts,
  '',
  instruction(prompts, 'unblockedNotPlanned'),
  '',
  `#${issue} stays held by its \`Blocked until:\` line, which waits on ${ref} closing. Write a date into the line, as \`Blocked until: YYYY-MM-DD\`, or delete the line, to free it.`,
  '',
  waitNotPlannedMarker(ref),
].join('\n');

/**
 * The comment a ticket gets when governor cannot settle its relative line.
 *
 * @param {string} ref
 */
export const waitRelativeComment = (ref) => [
  `Governor cannot work out the date on this ticket's \`Blocked until:\` line, which waits on ${ref} closing, so it is holding the ticket. Governor only sees a close of an issue linked as a blocker of this ticket, and ${ref} is not one it can read as closed.`,
  `Link ${ref} as a blocker of this ticket, or write the date as \`Blocked until: YYYY-MM-DD\`.`,
  '',
  WAIT_RELATIVE_MARKER,
].join('\n');

/**
 * Say something once on a ticket: nothing where its thread carries `marker`.
 *
 * @param {Pick<RelativeReader, 'allComments' | 'comment'>} reader
 * @param {number} issue
 * @param {string} marker
 * @param {string} text
 * @returns {Promise<'commented' | 'already told'>}
 */
const sayOnce = async (reader, issue, marker, text) => {
  const thread = await reader.allComments(issue);
  if (thread.some((c) => String(c.body ?? '').includes(marker))) return 'already told';
  await reader.comment(issue, text);
  return 'commented';
};

/**
 * Settle a relative line on `closed`'s close. A completed close, or one
 * GitHub gave no reason for, rewrites the line into its date, from the body
 * read just before the write, so a person's edit elsewhere stays. A body
 * whose line no longer waits on `closed` is left alone. Any other close
 * leaves the line and comments once.
 *
 * @param {{ reader: Pick<RelativeReader, 'issue' | 'updateIssue' | 'allComments' | 'comment'>, repo: string, issue: number, closed: { repo: string, number: number, reason?: string | null, closedAt: string }, facts: string, prompts: Record<string, string | undefined>, log: Log }} args
 * @returns {Promise<{ outcome: string, wait?: { until: string } }>}
 */
const settle = async ({ reader, repo, issue, closed, facts, prompts, log }) => {
  const ref = refOf(repo, closed);
  const about = { repo, issue, closed: ref, reason: closed.reason ?? null };
  if (closed.reason !== undefined && closed.reason !== null && closed.reason !== 'completed') {
    const outcome = await sayOnce(reader, issue, waitNotPlannedMarker(ref), waitNotPlannedComment({ facts, issue, ref, prompts }));
    log(WAIT_RELATIVE, { ...about, outcome: outcome === 'commented' ? 'held: commented on a close that was not completed' : 'held: already told of a close that was not completed' });
    return { outcome };
  }
  const { body } = await reader.issue(issue);
  const { wait } = waitOf(body);
  if (wait === undefined || !('after' in wait) || !waitsOnClose(wait, repo, closed)) {
    log(WAIT_RELATIVE, { ...about, outcome: 'not rewritten: the line changed since it was read' });
    return { outcome: 'line changed' };
  }
  const until = relativeUntil(closed.closedAt, wait.after.days);
  const next = datedBody(body, until);
  if (next === null) return { outcome: 'line changed' };
  await reader.updateIssue(issue, { body: next });
  log(WAIT_RELATIVE, { ...about, closedAt: closed.closedAt, until, outcome: 'rewritten' });
  return { outcome: 'rewritten', wait: { until } };
};

/**
 * An `unblocked` turn's first step: where the ticket is open and its line
 * waits on the fire's blocker, settle it ({@link settle}), counting from
 * the close time the fire carries, or from `now` for a fire without one, so
 * the wait is never shorter. Null where the line is not this close's.
 *
 * @param {{
 *   reader: Pick<RelativeReader, 'issue' | 'updateIssue' | 'allComments' | 'comment'>,
 *   repo: string,
 *   ticket: { state: string, wait?: import('../scripts/lib/ready-work.mjs').Wait },
 *   fire: import('./webhook/fire.mjs').UnblockedFire & { repo?: string },
 *   prompts: Record<string, string | undefined>,
 *   now: number,
 *   log: Log,
 * }} args
 * @returns {Promise<{ outcome: string, wait?: { until: string } } | null>}
 */
export const relativeAtClose = async ({ reader, repo, ticket, fire, prompts, now, log }) => {
  if (ticket.state !== 'open' || !waitsOnClose(ticket.wait, repo, fire.blocker)) return null;
  const { blocker } = fire;
  const closed = { repo: blocker.repo, number: blocker.number, reason: blocker.reason ?? null, closedAt: blocker.closedAt ?? new Date(now).toISOString() };
  return settle({ reader, repo, issue: fire.issue, closed, facts: unblockedFacts({ ...fire, repo }, { quote: true }), prompts, log });
};

/**
 * Settle a relative line no close has: one the `wait` turn reads (`link`),
 * or one the bare schedule fire's sweep finds on a ready ticket. Only an
 * issue in the ticket's repo is read.
 *
 * - The sweep leaves a ticket an open blocker holds to that blocker's close.
 * - A same-repo issue that has closed: settled as at its close
 *   ({@link settle}).
 * - A same-repo issue still open: the `wait` turn links it where it is not
 *   linked. The sweep, which finds no open blocker, comments once.
 * - Another repo's issue: the `wait` turn leaves it, since a person must
 *   declare it. The sweep comments once.
 * - An issue that is gone or moved: one comment.
 *
 * @param {{ reader: RelativeReader, repo: string, issue: number, after: import('../scripts/lib/ready-work.mjs').After, link: boolean, prompts: Record<string, string | undefined>, now?: number, log: Log }} args
 * @returns {Promise<string>} What came of it.
 */
export const repairRelative = async ({ reader, repo, issue, after, link, prompts, now = Date.now(), log }) => {
  const named = { repo: after.repo ?? repo, number: after.issue };
  const ref = refOf(repo, named);
  /** @type {Array<{ number: number, state: string, repo?: string }> | null} */
  let rows = null;
  if (!link) {
    rows = await reader.blockers(issue);
    if (rows.some((r) => r.state === 'open')) return 'held by an open blocker';
  }
  const cannot = async (/** @type {string} */ why) => {
    const outcome = await sayOnce(reader, issue, WAIT_RELATIVE_MARKER, waitRelativeComment(ref));
    log(WAIT_RELATIVE, { level: 'warn', repo, issue, after, reason: why, outcome: outcome === 'commented' ? 'held: commented that it cannot be settled' : 'held: already told it cannot be settled' });
    return outcome;
  };
  if (!sameRepo(named.repo, repo)) {
    if (link) return 'another repo\'s issue: a person declares it';
    return cannot(`${ref} is in another repo, and no open blocker holds the ticket`);
  }
  const read = await reader.issueClose(after.issue).then((r) => (r.number === after.issue ? r : null), (error) => {
    const status = /** @type {{ status?: number }} */ (error)?.status;
    if (status === 404 || status === 410) return null;
    throw error;
  });
  if (read === null) return cannot(`${ref} is gone or moved`);
  if (read.state !== 'open') {
    const reason = read.reason ?? 'completed';
    const facts = `${ref} (\`${read.title.replace(/`/g, "'")}\`) closed as ${reason.replace(/_/g, ' ')}. It blocked #${issue}.`;
    const closed = { ...named, reason: read.reason, closedAt: read.closedAt ?? new Date(now).toISOString() };
    return (await settle({ reader, repo, issue, closed, facts, prompts, log })).outcome;
  }
  rows ??= await reader.blockers(issue);
  const linked = rows.some((r) => r.number === after.issue && sameRepo(r.repo ?? repo, repo));
  if (!link) return linked ? 'held by its blocker' : cannot(`${ref} is open and not linked as a blocker`);
  if (linked) return 'linked already';
  await reader.addBlocker(issue, read.id);
  log(WAIT_RELATIVE, { repo, issue, after, outcome: `linked ${ref} as a blocker` });
  return 'linked';
};
