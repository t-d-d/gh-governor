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
 */

import { recentlyDispatched } from './webhook/fire.mjs';
import { specSession } from './unblocked.mjs';
import { isBlocked, isWaiting, labelRow } from '../scripts/lib/ready-work.mjs';

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
 * @param {{ reader: WaitReader, state: WaitState, repo: string, issue: number, labels: import('../scripts/lib/ready-work.mjs').Labels, now: number, log: Log }} args
 * @returns {Promise<string>} What came of it, as logged.
 */
export const holdWait = async ({ reader, state, repo, issue, labels, now, log }) => {
  const found = await ticketOf(reader, issue);
  const ticket = found ?? { state: 'gone or moved', labels: [], wait: undefined };
  const wait = ticket.state === 'open' ? ticket.wait : undefined;
  const read = await state.wait(repo, issue);
  const about = { repo, issue, ...(read === null ? {} : { read: read.until }) };
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
