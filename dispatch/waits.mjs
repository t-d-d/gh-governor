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
 * ({@link waitEndedMarker}), and, with `unblocked` on, its spec work,
 * unless governor's not-planned close still holds the ticket (`mayStartSpec`,
 * scripts/lib/ready-work.mjs). Where its body names a session, its owner,
 * that session is asked to rewrite its own spec on the repo's
 * `waitEndedOwnerSpec` prompt, so it keeps the ticket, with a spec session
 * as the fallback should it refuse as archived. Where it names none, a spec
 * session starts on the repo's `waitEndedSpec` prompt. Every session
 * governor starts in such a repo is told how to make a ticket wait
 * ({@link WAIT_PROMPT}).
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
 * {@link waitRelativeMarker}, that it cannot.
 */

import { waitLine } from './webhook/fire.mjs';
import { UNREADIED_HELD, ownerMessage, sameRepo, specSession, stillBlockedSentence, unblockedFacts } from './unblocked.mjs';
import { relayedBody, sessionNamedIn } from './webhook/subscribe.mjs';
import { AUTO, RELAY, authorKind, lets } from './trust.mjs';
import { DAY_MS } from './periodics.mjs';
import { instruction } from './prompts.mjs';
import { RELATIVE_WAIT, isWaiting, mayStartSpec, ticketStatus, waitOf, waitsOnClose } from '../scripts/lib/ready-work.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

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
 * Say something once on a ticket: nothing where its thread carries `marker`.
 *
 * @param {Pick<RelativeReader, 'allComments' | 'comment'>} reader
 * @param {number} issue
 * @param {string} marker
 * @param {string} text
 * @returns {Promise<'commented' | 'already told'>}
 */
export const sayOnce = async (reader, issue, marker, text) => {
  const thread = await reader.allComments(issue);
  if (thread.some((c) => String(c.body ?? '').includes(marker))) return 'already told';
  await reader.comment(issue, text);
  return 'commented';
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
    return await sayOnce(reader, issue, WAIT_UNREADABLE_MARKER, waitUnreadableComment(value));
  } catch (error) {
    log(WAIT_UNREADABLE, { level: 'error', repo, issue, value, error: messageOf(error), reason: 'the ticket is held, and governor could not say so on it this turn' });
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
  issue, title, labels, prompts, kind: 'waitEndedSpec', facts: waitFacts(issue, until),
});

/** What ended: the ticket's wait, on its date. @param {number} issue @param {string} until */
const waitFacts = (issue, until) => `#${issue}'s wait has ended: its \`Blocked until:\` line named ${until}, which has passed.`;

/**
 * The message a not-ready ticket's owner, the session its body names, gets
 * when the ticket's wait ends, in place of a spec session: the wait's facts
 * and the repo's `waitEndedOwnerSpec` instruction, asking it to rewrite the
 * spec in its own body, so it keeps the ticket.
 *
 * @param {{ issue: number, until: string, labels: { ready: readonly string[], claim: string }, prompts: Record<string, string | undefined> }} args
 */
export const waitOwnerMessage = ({ issue, until, labels, prompts }) => ownerMessage({ issue, facts: waitFacts(issue, until), kind: 'waitEndedOwnerSpec', labels, prompts });

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
 *   ticket: (n: number) => Promise<{ number: number, id?: number, title: string, body?: string, state: string, labels: string[], pull?: boolean, openBlockers?: number, author?: string, association?: string, wait?: import('../scripts/lib/ready-work.mjs').Wait }>,
 *   blockers: (n: number) => Promise<Array<{ state: string, id?: number }>>,
 *   allComments: (n: number) => Promise<Array<{ body: string, created_at?: string, ours: boolean }>>,
 *   comment: (n: number, body: string) => Promise<void>,
 * }} WaitReader
 *
 * @typedef {WaitReader & {
 *   addBlocker: (n: number, blockerId: number) => Promise<void>,
 *   removeBlocker: (n: number, blockerId: number) => Promise<void>,
 *   blocking: (n: number) => Promise<Array<{ number: number, state: string, repo?: string }>>,
 * }} LinkReader
 *
 * @typedef {(event: string, context?: Record<string, unknown>) => void} Log
 */

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

// ── The wait ticket, under the `waits` switch and the file's `waits.issue` ──

/** The log event for what a turn did with a ticket's link to the wait ticket. */
export const WAIT_LINK = 'dispatch-wait-link';

/** How many issues GitHub lets one issue block. */
export const BLOCKING_CAP = 50;

/** The marker on governor's one comment on a ticket linked to the wait ticket with no line. */
export const WAIT_UNLINED_MARKER = '<!-- governor:wait-unlined -->';

/** The marker on governor's one comment on a ticket the wait ticket had no room for. */
export const WAIT_FULL_MARKER = '<!-- governor:wait-full -->';

/**
 * The comment a ticket linked to the wait ticket with no line gets.
 *
 * @param {number} board The wait ticket.
 */
export const waitUnlinedComment = (board) => [
  `This ticket is linked as blocked by #${board}, the wait ticket, but its body has no \`Blocked until:\` line. Governor holds a ticket by its line, not by that link, and leaves the link alone.`,
  'While the link stands, pickup holds the ticket as blocked by an open issue. To make it wait, start its body with `Blocked until: YYYY-MM-DD`. To free it, remove the link.',
  '',
  WAIT_UNLINED_MARKER,
].join('\n');

/**
 * The comment a waiting ticket gets when the wait ticket can block no more.
 *
 * @param {number} board The wait ticket.
 */
export const waitFullComment = (board) => [
  `Governor could not link this ticket as blocked by #${board}, the wait ticket: GitHub lets one issue block at most 50, and it is full. The sidebar does not show this wait.`,
  'The ticket\'s `Blocked until:` line still holds it.',
  '',
  WAIT_FULL_MARKER,
].join('\n');

/**
 * Whether a refused link is GitHub's cap on how many issues one issue may
 * block: a 422 whose text from GitHub speaks of that limit. The request
 * line before the status is left out, since its path carries an issue
 * number, and issue #50's other refusals are not the cap.
 *
 * @param {unknown} error
 */
const atCap = (error) => /** @type {{ status?: number }} */ (error)?.status === 422
  && /\b50\b|\blimit\b|\bmaximum\b|\bat most\b/i.test(messageOf(error).replace(/^\S+ \S+ failed: \d{3}\b/, ''));

/**
 * @typedef {{
 *   board: number,
 *   show: (issue: number) => Promise<string>,
 *   hide: (issue: number) => Promise<'removed' | 'not linked'>,
 *   linked: (issue: number) => Promise<boolean>,
 *   open: () => Promise<boolean>,
 *   unlined: (issue: number) => Promise<string>,
 * }} WaitLinks
 *   One turn's handle on a repo's wait ticket, read once, the first time a
 *   call needs it. `show` links a ticket as blocked by it, unless it is
 *   linked already, the wait ticket is closed, or GitHub's cap refuses the
 *   link, which is said once on the ticket. `hide` removes the link where
 *   it stands. `open` is whether the wait ticket is open, so a link to it
 *   counts as an open blocker. `unlined` says once on a ticket that it is
 *   linked with no line. Any other failure throws.
 */

/**
 * The wait ticket's links for one repo's turn, or undefined where its file
 * names no wait ticket: then governor links nothing.
 *
 * @param {{ reader: LinkReader, repo: string, board: number | undefined, log: Log }} args
 * @returns {WaitLinks | undefined}
 */
export const waitLinks = ({ reader, repo, board, log }) => {
  if (board === undefined) return undefined;
  /** @type {Promise<{ id: number, state: string }> | undefined} */
  let read;
  const boardOf = () => (read ??= reader.ticket(board).then((t) => {
    if (t.number !== board || t.pull === true || !Number.isInteger(t.id)) throw new Error(`the wait ticket #${board} is not an issue in ${repo}`);
    return { id: /** @type {number} */ (t.id), state: t.state };
  }));
  /** @param {number} issue */
  const linked = async (issue) => {
    const rows = await reader.blockers(issue);
    if (rows.length === 0) return false;
    const { id } = await boardOf();
    return rows.some((r) => r.id === id);
  };
  return {
    board,
    linked,
    open: async () => (await boardOf()).state === 'open',
    show: async (issue) => {
      if (issue === board) return 'the wait ticket itself';
      const { id, state } = await boardOf();
      if (state !== 'open') {
        log(WAIT_LINK, { level: 'warn', repo, issue, board, outcome: 'not linked', reason: `the wait ticket #${board} is ${state}, so governor links no ticket to it` });
        return 'wait ticket closed';
      }
      if (await linked(issue)) return 'already linked';
      try {
        await reader.addBlocker(issue, id);
      } catch (error) {
        // GitHub's text for its cap may sit outside the `message` the error
        // carries, so a 422 is the cap too where the wait ticket already
        // blocks as many as GitHub allows.
        const full = /** @type {{ status?: number }} */ (error)?.status === 422 && (atCap(error) || (await reader.blocking(board)).length >= BLOCKING_CAP);
        if (!full) throw error;
        const told = await sayOnce(reader, issue, WAIT_FULL_MARKER, waitFullComment(board));
        log(WAIT_LINK, { level: 'warn', repo, issue, board, outcome: `not linked: the wait ticket is full, ${told}`, error: messageOf(error) });
        return 'wait ticket full';
      }
      log(WAIT_LINK, { repo, issue, board, outcome: 'linked' });
      return 'linked';
    },
    hide: async (issue) => {
      if (issue === board || !(await linked(issue))) return 'not linked';
      await reader.removeBlocker(issue, (await boardOf()).id);
      log(WAIT_LINK, { repo, issue, board, outcome: 'removed' });
      return 'removed';
    },
    unlined: async (issue) => {
      const told = await sayOnce(reader, issue, WAIT_UNLINED_MARKER, waitUnlinedComment(board));
      log(WAIT_LINK, { repo, issue, board, outcome: `linked with no line: ${told}` });
      return told;
    },
  };
};

/**
 * Show or hide a wait in the sidebar, where `links` is set. A failure is
 * logged at error, with `reason`, and taken for nothing: the link is only
 * for display, and the line holds the ticket either way.
 *
 * @param {WaitLinks | undefined} links @param {'show' | 'hide'} act @param {string} repo @param {number} issue @param {Log} log @param {string} reason
 */
const softly = async (links, act, repo, issue, log, reason) => {
  if (links === undefined) return;
  await links[act](issue).catch((error) => {
    log(WAIT_LINK, { level: 'error', repo, issue, board: links.board, error: messageOf(error), reason });
  });
};

/**
 * Whether a ticket's status holds it by `hold` (`ticketStatus`): its line, or
 * a line governor cannot read, holds only a ticket ready or not ready by its
 * labels.
 *
 * @param {import('../scripts/lib/ready-work.mjs').StatusRow} ticket
 * @param {import('../scripts/lib/ready-work.mjs').Labels} labels
 * @param {number} now
 * @param {import('../scripts/lib/ready-work.mjs').Hold} hold
 */
const holdsBy = (ticket, labels, now, hold) => {
  const status = ticketStatus(ticket, { labels, now });
  return status.open && status.holds.includes(hold);
};

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
 * With `links`, the repo's wait ticket: a date still to come links the
 * ticket as blocked by it, after the item is written. Any other line, or a
 * closed ticket, takes the link off; where the line was deleted, before the
 * item goes, so a removal that fails fails the turn and leaves the item for
 * the schedule fire. A ticket linked with no line where no item stood was
 * linked by hand: it is told once, and its link stays.
 *
 * @param {{ reader: WaitReader & RelativeReader, state: WaitState, repo: string, issue: number, labels: import('../scripts/lib/ready-work.mjs').Labels, now: number, log: Log, prompts?: Record<string, string | undefined>, links?: WaitLinks }} args
 * @returns {Promise<string>} What came of it, as logged.
 */
export const holdWait = async ({ reader, state, repo, issue, labels, now, log, prompts = {}, links }) => {
  const found = await ticketOf(reader, issue);
  const ticket = found ?? { state: 'gone or moved', labels: [], wait: undefined };
  const wait = ticket.state === 'open' ? ticket.wait : undefined;
  const read = await state.wait(repo, issue);
  const about = { repo, issue, ...(read === null ? {} : { read: read.until }) };
  if (wait !== undefined && 'after' in wait) {
    // A relative line names its own blocker, which the sidebar shows: the
    // wait ticket's link comes off, before any item goes.
    if (links !== undefined && found !== null) await links.hide(issue);
    const dropped = read === null ? null : await state.dropWait(repo, issue, read.until);
    const settled = holdsBy({ state: ticket.state, labels: ticket.labels, wait }, labels, now, 'line') ? await repairRelative({ reader, repo, issue, after: wait.after, link: true, prompts, now, log }) : 'not settled: the ticket is not held from anyone';
    const outcome = `relative: ${settled}`;
    log(WAIT, { ...about, after: wait.after, outcome, ...(dropped === null ? {} : { item: dropped ? 'dropped' : 'not dropped: it changed since it was read' }) });
    return outcome;
  }
  // A date that has passed, over an item: the item is kept at that date, so
  // the schedule fire still says the wait ended. An edit just after
  // midnight, or a wait moved earlier into the past, loses nothing.
  const passedOverItem = wait !== undefined && 'until' in wait && read !== null;
  if (wait !== undefined && 'until' in wait && (isWaiting({ wait }, now) || passedOverItem)) {
    /** @type {string} */
    let outcome;
    if (read?.until === wait.until) {
      outcome = 'held';
      log(WAIT, { ...about, until: wait.until, outcome: 'held: the item already holds this date' });
    } else {
      const written = await state.recordWait(repo, issue, read?.until ?? null, wait.until);
      outcome = written ? 'held' : 'not held: the item changed since it was read';
      log(WAIT, { ...about, until: wait.until, outcome });
    }
    // The item stands at a passed date, so a removal that fails here is
    // tried again by the schedule fire.
    if (isWaiting({ wait }, now)) await softly(links, 'show', repo, issue, log, 'the ticket is held by its line all the same; its sidebar does not show the wait');
    else await softly(links, 'hide', repo, issue, log, 'its item stands, so the schedule fire takes the link off once the wait has ended');
    return outcome;
  }
  if (wait !== undefined && 'unreadable' in wait && holdsBy({ state: ticket.state, labels: ticket.labels, wait }, labels, now, 'unreadable')) await reportUnreadable({ reader, repo, issue, value: wait.unreadable, log });
  if (links !== undefined && found !== null) {
    if (wait === undefined && read === null) {
      // No line and no item: governor never linked it, so a link is a
      // person's. It is told once, and left alone.
      if (ticket.state === 'open' && await links.linked(issue)) await links.unlined(issue);
    } else {
      await links.hide(issue);
    }
  }
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
 * @typedef {{ issue: number, title: string, until: string, read: string, owner: string | null }} WaitSpec
 *   A ticket whose wait ended that gets its spec work: its title, the date
 *   its line names, the date its item holds, which the turn deletes the
 *   item over once the work went, and the session its body names, its
 *   owner, or null. An owner is asked to rewrite its own spec, with the
 *   spec session as the fallback; a ticket with none gets the spec session.
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
 *   back as a {@link WaitSpec} unless governor's not-planned close still
 *   holds it (`mayStartSpec`, scripts/lib/ready-work.mjs). Its item stays until the turn has started the
 *   session, so a launch that fails, or one the turn has no room for, is
 *   tried at the next fire, and the marker keeps it to one comment. A spec
 *   session the turn started is written into the ticket's body as its
 *   owner, so an item a failed delete left is its owner's at the next fire:
 *   a second message, never a second session.
 *   Otherwise the item goes.
 *
 * A ticket that cannot be read, or whose comment fails, keeps its item for
 * the next fire, and is logged and returned in `unread`. An items read that
 * fails leaves the whole repo for the next fire the same way.
 *
 * With `links`, the repo's wait ticket: every ended item's ticket that is
 * still there loses its link first, so the turn runs this before its sweep
 * reads the backlog, and a removal that fails keeps the item for the next
 * fire. A link just removed is not counted as an open blocker, though the
 * ticket's dependency summary may still count it. Then each open ticket in
 * this repo the wait ticket blocks with no item: with no line, it was linked
 * by hand, and is told once and keeps its link; with a line that has passed
 * or cannot be read, its link comes off, as a turn that failed to take it
 * off left it.
 *
 * With `auto`, the repo's `trust.auto` (dispatch/trust.mjs): a ticket whose
 * author it does not let in gets its comment, but no spec work, and its
 * item goes, logged at info. With `relay`, its `trust.relay`: a session
 * link that ends a ticket's body names its owner only where the body's
 * author is let in (`relayedBody`, dispatch/webhook/subscribe.mjs).
 *
 * @param {{ reader: WaitReader, state: WaitState, repo: string, labels: import('../scripts/lib/ready-work.mjs').Labels, spec: boolean, now: number, log: Log, links?: WaitLinks, blocking?: LinkReader['blocking'], auto?: readonly string[], relay?: readonly string[] }} args
 * @returns {Promise<{ specs: WaitSpec[], unread: Array<{ repo: string, error: string }> }>}
 */
export const endedWaits = async ({ reader, state, repo, labels, spec, now, log, links, blocking, auto = AUTO, relay = RELAY }) => {
  /** @type {WaitSpec[]} */
  const specs = [];
  /** @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  /** @type {Array<{ issue: number, until: string }>} */
  let items;
  try {
    items = await state.waits(repo);
  } catch (error) {
    const message = messageOf(error);
    log(WAIT_UNHANDLED, { level: 'error', repo, error: message, reason: 'its wait items could not be read, so no ended wait is acted on this turn' });
    return { specs, unread: [{ repo, error: `wait items: ${message}` }] };
  }
  /** @param {{ issue: number, until: string }} item @param {Record<string, unknown>} context */
  const drop = async ({ issue, until }, context) => {
    const dropped = await state.dropWait(repo, issue, until);
    log(WAIT, { repo, issue, read: until, ...context, item: dropped ? 'dropped' : 'not dropped: it changed since it was read' });
  };
  // Each ended item is read and acted on side by side, as the turn's other
  // reports are, so a day when many waits end does not use up the launch
  // window. Each item catches its own failure.
  /** @type {Array<{ issue: number, error: string }>} */
  const failed = [];
  /** @param {{ issue: number, until: string }} item */
  const one = async (item) => {
    const { issue } = item;
    try {
      const ticket = await ticketOf(reader, issue);
      if (ticket === null) {
        await drop(item, { outcome: 'its ticket is gone or moved' });
        return;
      }
      const wait = ticket.state === 'open' ? ticket.wait : undefined;
      const moved = wait !== undefined && 'until' in wait && isWaiting({ wait }, now);
      const removed = links !== undefined && !moved ? await links.hide(issue) === 'removed' : false;
      if (wait === undefined) {
        await drop(item, { outcome: ticket.state === 'open' ? 'its line is gone' : `its ticket is ${ticket.state}` });
        return;
      }
      if ('unreadable' in wait) {
        if (holdsBy(ticket, labels, now, 'unreadable')) await reportUnreadable({ reader, repo, issue, value: wait.unreadable, log });
        await drop(item, { outcome: 'its line cannot be read' });
        return;
      }
      if ('after' in wait) {
        await drop(item, { outcome: 'its line now waits on an issue\'s close' });
        return;
      }
      if (isWaiting({ wait }, now)) {
        const written = await state.recordWait(repo, issue, item.until, wait.until);
        log(WAIT, { repo, issue, read: item.until, until: wait.until, outcome: written ? 'moved later: not released' : 'moved later, and the item changed since it was read' });
        return;
      }
      // A link just removed may still be in the dependency summary, which
      // counts it only while the wait ticket is open.
      const counted = removed && ticket.openBlockers !== undefined && await links?.open() ? { ...ticket, openBlockers: Math.max(0, ticket.openBlockers - 1) } : ticket;
      const blockers = counted.openBlockers === undefined ? await reader.blockers(issue) : undefined;
      const status = ticketStatus(counted, { labels, now, blockers });
      const row = !status.open || status.holds.length > 0 ? 'blocked' : status.labels;
      if (row !== 'not-ready') {
        await drop(item, { until: wait.until, outcome: `ended on a ticket ${row}: nothing to say` });
        return;
      }
      const thread = await reader.allComments(issue);
      const marker = waitEndedMarker(wait.until);
      const told = thread.some((c) => String(c.body ?? '').includes(marker));
      if (!told) await reader.comment(issue, waitEndedComment(wait.until));
      // The spec work starts with no person choosing the ticket, so only
      // for an author the repo's trust.auto lets in.
      if (spec && !lets(auto, ticket)) {
        await drop(item, { until: wait.until, level: 'info', outcome: `${told ? 'ended: already told' : 'ended: commented'}; nothing starts and nothing is sent: opened by a ${authorKind(ticket)} author, whom trust.auto (${auto.join(', ') || 'empty'}) does not let in` });
        return;
      }
      // A ticket governor unreadied on a not-planned close waits for a
      // person's answer first, as a later blocker's close does.
      if (spec && mayStartSpec(thread)) {
        // A session link counts only where trust.relay lets the body's author in.
        const owner = sessionNamedIn(relayedBody(ticket, relay));
        specs.push({ issue, title: ticket.title, until: wait.until, read: item.until, owner });
        const work = owner === null ? 'starting a spec session' : `asking its owner, ${owner}, to rewrite its spec`;
        log(WAIT, { repo, issue, read: item.until, until: wait.until, outcome: told ? `ended: already told, ${work}` : `ended: commented, ${work}` });
        return;
      }
      await drop(item, { until: wait.until, outcome: told ? 'ended: already told' : 'ended: commented', ...(spec ? { spec: `held: ${UNREADIED_HELD}` } : {}) });
    } catch (error) {
      const message = messageOf(error);
      log(WAIT_UNHANDLED, { level: 'error', repo, issue, read: item.until, error: message, reason: 'its item stays, so the next fire tries again' });
      failed.push({ issue, error: `wait #${issue}: ${message}` });
    }
  };
  await Promise.all(items.filter((item) => now >= endOf(item.until)).map(one));
  // DispatchCap takes the first spec sessions, so they go in issue order,
  // whichever read answered first.
  specs.sort((a, b) => a.issue - b.issue);
  unread.push(...failed.sort((a, b) => a.issue - b.issue).map(({ error }) => ({ repo, error })));
  if (links !== undefined && blocking !== undefined) {
    const waiting = new Set(items.map((i) => i.issue));
    try {
      const rows = (await blocking(links.board)).filter((r) => r.state === 'open' && (r.repo ?? repo).toLowerCase() === repo.toLowerCase() && !waiting.has(r.number));
      for (const { number } of rows) {
        const ticket = await ticketOf(reader, number);
        if (ticket === null || ticket.state !== 'open') continue;
        // No line: a person's link, told once and left alone. A date that
        // has passed, a line that cannot be read, or a relative line:
        // governor's link, which a turn could not take off, so it comes off
        // now, before the sweep.
        if (ticket.wait === undefined) await links.unlined(number);
        else if (!('until' in ticket.wait) || !isWaiting({ wait: ticket.wait }, now)) await links.hide(number);
      }
    } catch (error) {
      const message = messageOf(error);
      log(WAIT_UNHANDLED, { level: 'error', repo, board: links.board, error: message, reason: 'the tickets the wait ticket blocks could not be read or told, so the next fire tries again' });
      unread.push({ repo, error: `wait ticket #${links.board}: ${message}` });
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

/** How governor's comment on a relative line it cannot settle starts. */
export const WAIT_RELATIVE_MARKER = '<!-- governor:wait-relative ';

/**
 * The marker on governor's one comment about a relative line on `ref` it
 * cannot settle. It names the issue, so a line moved to wait on another
 * issue that cannot be settled either is told again.
 *
 * @param {string} ref `#<issue>`, or `<owner>/<repo>#<issue>` for another repo's.
 */
export const waitRelativeMarker = (ref) => `${WAIT_RELATIVE_MARKER}${ref} -->`;

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
 *   issueClose: (n: number) => Promise<{ id: number, number: number, title: string, state: string, reason: string | null, closedAt: string | null, pull?: boolean }>,
 *   addBlocker: (n: number, id: number) => Promise<void>,
 * }} RelativeReader
 *   What a relative wait reads and writes, all in the ticket's own repo.
 */

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
 * than as completed: the close's facts, the not-planned ask, and what to do
 * with the line. Where the line holds the ticket (`holds`), how to free it;
 * a claimed or excluded ticket is not held, so it is told only that the
 * line waits on a close that will not settle it. Where another open issue
 * still blocks the ticket (`blocked`), the comment says so after the ask,
 * as the not-planned row's does (`notPlannedComment`, dispatch/unblocked.mjs),
 * and does not say the line alone frees it.
 *
 * @param {{ facts: string, issue: number, ref: string, prompts: Record<string, string | undefined>, holds?: boolean, blocked?: boolean }} args
 */
export const waitNotPlannedComment = ({ facts, issue, ref, prompts, holds = true, blocked = false }) => [
  facts,
  '',
  instruction(prompts, 'unblockedNotPlanned'),
  '',
  ...(blocked ? [stillBlockedSentence(issue), ''] : []),
  holds
    ? `#${issue} stays held by its \`Blocked until:\` line, which waits on ${ref} closing. Write a date into the line, as \`Blocked until: YYYY-MM-DD\`, or delete the line${blocked ? '' : ', to free it'}.`
    : `#${issue}'s \`Blocked until:\` line waits on ${ref} closing, and this close does not give it a date. Write a date into the line, as \`Blocked until: YYYY-MM-DD\`, or delete the line.`,
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
  waitRelativeMarker(ref),
].join('\n');

/**
 * Settle a relative line on `closed`'s close. A completed close, or one
 * GitHub gave no reason for, rewrites the line into its date, from the body
 * read just before the write, so a person's edit elsewhere stays. A body
 * whose line no longer waits on `closed` is left alone. Any other close
 * leaves the line and comments once, saying it holds the ticket where it
 * does (`holds`, true where unset), and that another open issue still
 * blocks it where one does (`blocked`).
 *
 * @param {{ reader: Pick<RelativeReader, 'issue' | 'updateIssue' | 'allComments' | 'comment'>, repo: string, issue: number, closed: { repo: string, number: number, reason?: string | null, closedAt: string }, facts: string, prompts: Record<string, string | undefined>, log: Log, holds?: boolean, blocked?: boolean }} args
 * @returns {Promise<{ outcome: string, wait?: { until: string } }>}
 */
const settle = async ({ reader, repo, issue, closed, facts, prompts, log, holds = true, blocked = false }) => {
  const ref = refOf(repo, closed);
  const about = { repo, issue, closed: ref, reason: closed.reason ?? null };
  if (closed.reason !== undefined && closed.reason !== null && closed.reason !== 'completed') {
    const outcome = await sayOnce(reader, issue, waitNotPlannedMarker(ref), waitNotPlannedComment({ facts, issue, ref, prompts, holds, blocked }));
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
 * the wait is never shorter. Null where the line is not this close's, or
 * the ticket's read names another number: it moved to another repo.
 * `holds`: whether the line holds the ticket by its status (`ticketStatus`),
 * true where unset. `blocked`: whether another open issue still blocks the
 * ticket, false where unset.
 *
 * @param {{
 *   reader: Pick<RelativeReader, 'issue' | 'updateIssue' | 'allComments' | 'comment'>,
 *   repo: string,
 *   ticket: { number?: number, state: string, wait?: import('../scripts/lib/ready-work.mjs').Wait },
 *   fire: import('./webhook/fire.mjs').UnblockedFire & { repo?: string },
 *   prompts: Record<string, string | undefined>,
 *   now: number,
 *   log: Log,
 *   holds?: boolean,
 *   blocked?: boolean,
 * }} args
 * @returns {Promise<{ outcome: string, wait?: { until: string } } | null>}
 */
export const relativeAtClose = async ({ reader, repo, ticket, fire, prompts, now, log, holds = true, blocked = false }) => {
  if (ticket.state !== 'open' || (ticket.number !== undefined && ticket.number !== fire.issue) || !waitsOnClose(ticket.wait, repo, fire.blocker)) return null;
  const { blocker } = fire;
  const closed = { repo: blocker.repo, number: blocker.number, reason: blocker.reason ?? null, closedAt: blocker.closedAt ?? new Date(now).toISOString() };
  return settle({ reader, repo, issue: fire.issue, closed, facts: unblockedFacts({ ...fire, repo }, { quote: true }), prompts, log, holds, blocked });
};

/**
 * Settle a relative line no close has: one the `wait` turn reads (`link`),
 * or one the bare schedule fire's sweep finds on a ready ticket. Only an
 * issue in the ticket's repo is read.
 *
 * - The sweep leaves a ticket an open blocker holds to that blocker's close:
 *   one its dependency summary (`openBlockers`) counts, which needs no read,
 *   or one in its `blocked_by` rows, read where the summary counts none.
 *   The rows are read even then because a summary can be a moment slow to
 *   count a link just made, and the comments below are said only once.
 * - A same-repo issue that has closed: settled as at its close
 *   ({@link settle}).
 * - A same-repo issue still open: the `wait` turn links it where it is not
 *   linked. The sweep, which finds no open blocker, comments once.
 * - Another repo's issue: the `wait` turn leaves it, since a person must
 *   declare it. The sweep comments once.
 * - An issue that is gone or moved, a pull request, or the ticket itself,
 *   none of which can be its blocker: one comment.
 *
 * @param {{ reader: RelativeReader, repo: string, issue: number, after: import('../scripts/lib/ready-work.mjs').After, openBlockers?: number, link: boolean, prompts: Record<string, string | undefined>, now?: number, log: Log }} args
 * @returns {Promise<string>} What came of it.
 */
export const repairRelative = async ({ reader, repo, issue, after, openBlockers, link, prompts, now = Date.now(), log }) => {
  const named = { repo: after.repo ?? repo, number: after.issue };
  const ref = refOf(repo, named);
  /** @type {Array<{ number: number, state: string, repo?: string }> | null} */
  let rows = null;
  if (!link) {
    if (openBlockers !== undefined && openBlockers > 0) return 'held by an open blocker';
    rows = await reader.blockers(issue);
    if (rows.some((r) => r.state === 'open')) return 'held by an open blocker';
  }
  const cannot = async (/** @type {string} */ why) => {
    const outcome = await sayOnce(reader, issue, waitRelativeMarker(ref), waitRelativeComment(ref));
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
  if (read.pull === true) return cannot(`${ref} is a pull request, which cannot be a blocker`);
  if (after.issue === issue) return cannot(`${ref} is the ticket itself`);
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
