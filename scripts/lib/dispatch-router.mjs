/**
 * What a `schedule` fire starts: the ready issues, up to the cap, or the
 * one issue (`issue`) the fire names (dispatch/webhook/fire.mjs reads the
 * fire; dispatch/turn.mjs runs it), and what an `unblocked` fire for a
 * ready ticket starts (dispatch/unblocked.mjs).
 *
 * The selection walks `scripts/lib/ready-work.mjs`'s ordered candidates,
 * asking about blockers and recent dispatches only as far as the cap
 * needs. A fire can follow another within minutes (a run by hand beside the
 * schedule, and webhook bursts later), reading the backlog before the first
 * has claimed its tickets, so an issue dispatched inside
 * {@link DISPATCH_WINDOW_MS} is skipped. The record of a dispatch is a marker
 * comment on the issue (`dispatchMarker`), carrying the session URL where the
 * launcher printed one: the in-flight list lives on the ticket, not in a UI.
 * The turn claims each planned issue before its launch (`workflow: under
 * development`), which drops it from the selection, and puts the ready
 * label back on a launch that started nothing. The window still covers a
 * claim a person undid, or a fire racing the claim.
 */

import { DISPATCH_WINDOW_MS, recentlyDispatched } from '../../dispatch/webhook/fire.mjs';
import { promptFor, sessionName } from './dispatch-prompt.mjs';
import { byAge, isBlocked, labelRow, selectReadyWork, unreadableOf } from './ready-work.mjs';

/**
 * @typedef {{ issue?: number, repo: string, prompt: string, sessionName: string }} Dispatch
 *
 * @typedef {import('./github-app.mjs').IssueRow} IssueRow
 * @typedef {{
 *   readyIssues: (labels: readonly string[]) => Promise<IssueRow[]>,
 *   ticket: (number: number) => Promise<import('./github-app.mjs').TicketRow>,
 *   blockers: (number: number) => Promise<import('./github-app.mjs').BlockerRow[]>,
 *   comments: (number: number, options?: { since?: string }) => Promise<import('./github-app.mjs').CommentRow[]>,
 * }} Reader
 *
 * @typedef {{ repo: string, issue: number, labels: string[], openBlockers?: number, wait?: import('./ready-work.mjs').Wait }} Seen
 *   What a named issue's read saw: its labels, its open blockers by its
 *   dependency summary or, where it has none and was read, its `blocked_by`
 *   rows, and its `Blocked until:` line, where it has one.
 *
 * @typedef {{ repo: string, issue: number, value: string }} Unreadable
 *   A ticket held by a `Blocked until:` line whose value is no date.
 *
 * @typedef {{ repo: string, reader: Reader, labels: import('./ready-work.mjs').Labels, prompts?: Record<string, string | undefined> }} Source
 *   A served repo's tickets: its reader, its config file's ready, claim and
 *   excluded labels, and its prompts.
 */

/**
 * The schedule's plan: eligible issues oldest first, up to the cap,
 * asking about blockers and recent dispatches only as far as the cap
 * needs. The order runs over every source's tickets together:
 * oldest, then number, whichever repo each is in. With `only`, those issues
 * and no other, still in the selector's
 * order and under the cap: the fire for an issue just labelled ready, or
 * a ready ticket whose blocker just closed, dispatches it if the selection
 * would, leaving the rest of the backlog to the sweep, so a batch of labels
 * is a session each and not the cap's worth per label. A fire naming
 * issues names one repo, so `only` is for one source.
 *
 * A named issue is read on its own (`reader.ticket`), never found in the
 * ready list: GitHub's filtered list shows a label change about four seconds
 * after it, and a label fire's turn runs inside that, while the single
 * issue shows it on its first read. `seen` gets what each named issue's read
 * saw, so a fire that starts nothing can log why.
 *
 * With `unread`, a source whose read fails is recorded there and left out
 * of the rest of the plan, so one repo's refusal does not stop the others;
 * without it, the read's failure throws.
 *
 * With `cut`, the walk goes on past the cap to add each repo with a ticket
 * the selection would have started had the cap allowed it. It stops asking
 * about a repo's tickets once it finds the first: a recent-dispatch read for
 * each ticket up to it, and a blockers read for each one whose row carries no
 * dependency summary. The bare fire leaves such a repo's sweep
 * unrecorded: the cap limits load, and does not set how often a repo is
 * swept.
 *
 * With `unreadable`, each open, ready-labelled ticket that a `Blocked
 * until:` line governor cannot read holds is recorded there, with the
 * line's value, so the turn can say so on the ticket. A ticket whose date is
 * still to come is held by the selection itself (`isWaiting`).
 *
 * @param {{ sources: readonly Source[], cap: number, now: number, windowMs?: number, only?: readonly number[], seen?: Seen[], unread?: Array<{ repo: string, error: string }>, cut?: Set<string>, unreadable?: Unreadable[] }} args
 * @returns {Promise<Dispatch[]>}
 */
export const planSchedule = async ({ sources, cap, now, windowMs = DISPATCH_WINDOW_MS, only, seen = [], unread, cut, unreadable }) => {
  /** @type {Set<string>} */
  const failed = new Set();
  /**
   * @template T
   * @param {string} repo
   * @param {() => Promise<T>} read
   * @returns {Promise<T | null>}
   */
  const guarded = async (repo, read) => {
    if (unread === undefined) return read();
    try {
      return await read();
    } catch (error) {
      failed.add(repo);
      unread.push({ repo, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  /** Each named issue's record in `seen`, by repo and number. @type {Map<string, Seen>} */
  const records = new Map();
  /**
   * The source's rows: the named issues, each read on its own, or else its ready list.
   * @param {Source} source
   * @returns {Promise<import('./ready-work.mjs').IssueRow[]>}
   */
  const rowsOf = async ({ repo, reader, labels }) => {
    if (only === undefined) return reader.readyIssues(labels.ready);
    // A moved issue's read follows GitHub's redirect to another repository's
    // issue, under another number; that one, and an issue that is gone (404,
    // or 410 for a deleted one), is no ticket here and starts nothing.
    /** @param {number} n */
    const readOne = (n) => reader.ticket(n).then((t) => (t.number === n ? t : null), (error) => {
      const status = /** @type {{ status?: number }} */ (error)?.status;
      if (status === 404 || status === 410) return null;
      throw error;
    });
    const read = (await Promise.all([...new Set(only)].map(readOne))).filter((t) => t !== null);
    for (const { number, labels: on, openBlockers, wait } of read) {
      const record = { repo, issue: number, labels: on, ...(openBlockers === undefined ? {} : { openBlockers }), ...(wait === undefined ? {} : { wait }) };
      records.set(`${repo}#${number}`, record);
      seen.push(record);
    }
    return read.filter((t) => !t.pull);
  };
  /** @type {Array<import('./ready-work.mjs').IssueRow & { source: Source }>} */
  const tagged = [];
  for (const source of sources) {
    const { labels } = source;
    const rows = await guarded(source.repo, () => rowsOf(source));
    if (rows === null) continue;
    // A ticket held by an unreadable `Blocked until:` line, one the
    // selection would otherwise consider, is reported for its comment.
    for (const row of rows) {
      const value = unreadableOf(row);
      if (value !== undefined && (row.state ?? 'open') === 'open' && labelRow(row.labels, labels) === 'ready') {
        unreadable?.push({ repo: source.repo, issue: row.number, value });
      }
    }
    const ready = selectReadyWork(rows, { cap: Number.MAX_SAFE_INTEGER, labels, now });
    tagged.push(...ready.map((row) => ({ ...row, source })));
  }
  const candidates = tagged.sort(byAge);
  // Only the window's comments: a marker older than the window would not
  // count, and the endpoint pages oldest first, so on a long thread the
  // newest marker would otherwise sit past the page.
  const since = new Date(now - windowMs).toISOString();
  /**
   * Whether the selection starts a candidate: not blocked, and not
   * dispatched inside the window. A read `read` answers with null starts
   * nothing.
   * @param {(typeof candidates)[number]} candidate
   * @param {typeof guarded} read
   */
  const starts = async (candidate, read) => {
    const { reader, repo } = candidate.source;
    // A row carrying its dependency summary was judged by it in the first
    // pass, so only a row without one asks for its `blocked_by` rows.
    if (candidate.openBlockers === undefined) {
      const blocking = await read(repo, () => reader.blockers(candidate.number));
      const record = records.get(`${repo}#${candidate.number}`);
      if (record !== undefined && blocking !== null) record.openBlockers = blocking.filter((b) => b.state === 'open').length;
      if (blocking === null || isBlocked(candidate, blocking)) return false;
    }
    const comments = await read(repo, () => reader.comments(candidate.number, { since }));
    return comments !== null && !recentlyDispatched(comments, now, windowMs);
  };
  /** @type {Dispatch[]} */
  const plan = [];
  for (const candidate of candidates) {
    const full = plan.length >= cap;
    if (full && cut === undefined) break;
    const { repo, labels, prompts } = candidate.source;
    if (failed.has(repo) || (full && cut?.has(repo))) continue;
    if (full) {
      // Past the cap a read that fails starts nothing, so it is no refusal:
      // the repo counts as cut, and the next fire sweeps it again.
      const cutHere = await starts(candidate, (_, read) => read()).catch(() => true);
      if (cutHere) cut?.add(repo);
      continue;
    }
    if (!(await starts(candidate, guarded))) continue;
    plan.push({
      issue: candidate.number,
      repo,
      prompt: promptFor(candidate.number, candidate.title, repo, labels.claim, prompts),
      sessionName: sessionName(candidate.number, candidate.title),
    });
  }
  return plan;
};
