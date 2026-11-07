/**
 * What a `schedule` fire starts: the ready issues, up to the cap, or the
 * one issue (`issue`) the fire names (dispatch/webhook/fire.mjs reads the
 * fire; dispatch/turn.mjs runs it), and what an `unblocked` fire for a
 * ready ticket starts (dispatch/unblocked.mjs).
 *
 * The selection walks `scripts/lib/ready-work.mjs`'s ordered candidates,
 * asking about blockers and who added the ready labels only as far as the
 * cap needs. The turn claims each planned issue before its launch
 * (`workflow: under development`), which drops it from the selection, and
 * puts the ready label back on a launch that started nothing. The claim
 * label alone keeps a ticket out while it is built: a dispatch comment's
 * age holds nothing, and a ticket whose claim a person removed is selected
 * again. Fires run one at a time in the lane's one message group (`LANE`,
 * dispatch/webhook/fire.mjs), so a fire cannot race another's claim.
 */

import { promptFor, sessionName } from './dispatch-prompt.mjs';
import { authorPicked, byAge, mayPickUp, selectReadyWork, ticketStatus, unreadableOf } from './ready-work.mjs';
import { judgeReady } from '../../dispatch/start.mjs';
import { START } from '../../dispatch/trust.mjs';

/**
 * @typedef {{ issue?: number, repo: string, prompt: string, sessionName: string }} Dispatch
 *
 * @typedef {import('./github-app.mjs').IssueRow} IssueRow
 * @typedef {{
 *   readyIssues: (labels: readonly string[]) => Promise<IssueRow[]>,
 *   ticket: (number: number) => Promise<import('./github-app.mjs').TicketRow>,
 *   blockers: (number: number) => Promise<import('./github-app.mjs').BlockerRow[]>,
 *   comments: (number: number, options?: { since?: string }) => Promise<import('./github-app.mjs').CommentRow[]>,
 *   labelAdds: (number: number) => Promise<import('./ready-work.mjs').LabelAdd[]>,
 *   repoOwnerType?: () => Promise<string>,
 *   outsideCollaborators?: () => Promise<string[]>,
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
 * @typedef {{ repo: string, issue: number, after: import('./ready-work.mjs').After, openBlockers?: number }} Relative
 *   A ready ticket held by a relative `Blocked until:` line, with its open
 *   blockers by its dependency summary where its read carries one.
 *
 * @typedef {{ label: string, actor: string | null, bot: boolean }} AddedBy
 *   Who added a ready label last: the login, null where no event names it,
 *   and whether it was a bot.
 *
 * @typedef {{ repo: string, issue: number, labels: string[], author: string, association: string, addedBy: AddedBy[] }} Outsider
 *   A ready ticket whose ready labels `labels` no person but its outside
 *   author, or only a bot, added (`uncountedReady`), so the selection skips
 *   it, with who added each.
 *
 * @typedef {{ repo: string, issue: number, association: string, author?: string }} Stranger
 *   A ready ticket whose author's association the repo's `trust.task` does
 *   not list (`authorPicked`), so the selection skips it, with the author's
 *   login where it was read.
 *
 * @typedef {{ repo: string, issue: number, until: string }} HeldFailed
 *   A ready ticket the selection skipped because its last launch started
 *   nothing, held until `until`.
 */

/**
 * @typedef {{ repo: string, reader: Reader, labels: import('./ready-work.mjs').Labels, by?: readonly string[], start?: readonly string[], prompts?: Record<string, string | undefined>, signOff?: boolean, deployMessages?: boolean, failed?: ReadonlyMap<number, string> }} Source
 *   A served repo's tickets: its reader, its config file's ready, claim and
 *   excluded labels, whose tickets pickup starts (`byOf`,
 *   dispatch/pickup.mjs; `PICKUP_BY` where unset), who may ready one
 *   (`startOf`, dispatch/trust.mjs; `START` where unset), its prompts, whether
 *   its file turns `signOff` on, which the pickup prompt's ask reads, whether
 *   it turns `deployMessages` on, which says when that ask comes, and
 *   the tickets its failed-launch records hold (`failed`).
 */

/**
 * Why a ticket whose ready labels no person with a say added is skipped,
 * for its warn line: the selection's (dispatch/sweep.mjs,
 * dispatch/unblocked-fire.mjs) and the claim's (dispatch/launch-plan.mjs).
 *
 * @param {{ labels: readonly string[], author: string, association: string }} outsider
 */
export const outsiderReason = ({ labels, author, association }) =>
  `ready labels ${JSON.stringify(labels)} were added last by its ${association} author ${JSON.stringify(author)}, by a bot, or by no one the events name: someone with triage access takes them off and puts them back to pick it up, since adding a label the ticket already carries records no event`;

/**
 * Why work may not be about a ticket whose author `trust.task` does not
 * list, for its info line.
 *
 * @param {{ association: string }} stranger
 */
export const strangerReason = ({ association }) =>
  `opened by a ${association} author, and the repo's trust.task, or where it sets none the default narrowed to fit its trust.relay, does not list ${association}, so no work is started on it`;

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
 * still to come is held by the selection itself (`mayPickUp`).
 *
 * With `relative`, each open, ready-labelled ticket held by a relative
 * line (`3 days after #143 closes`) is recorded there, with its dependency
 * summary, so the turn can settle it (`repairRelative`, dispatch/waits.mjs).
 * Like `unreadable`, the report reads no blocker: the repair judges it, by
 * the summary and, where that counts none, by the `blocked_by` rows it
 * reads, so the plan does not read them too.
 *
 * With `strangers`, each ready ticket whose author's association the
 * source's `by` does not list is recorded there, so the turn can log it.
 * Such a ticket takes no place under the cap, and nothing more is read of it.
 *
 * With `outsiders`, each ticket the selection skips because its outside
 * author's issue template, a bot or no event added a ready label last is
 * recorded there with who added each, so the turn can log it and say so on
 * the ticket. Such a ticket takes no place under the cap.
 *
 * With `unstarted`, each ticket the selection skips because a person the
 * source's `start` leaves out added a ready label last is recorded there,
 * and with `unlooked`, each whose adder could not be looked up this turn.
 * Neither takes a place under the cap.
 *
 * A source's `failed` holds its tickets whose last launch started nothing
 * inside the hour, each with the time its record holds until
 * (`failedLaunchesOf`, dispatch/pickup.mjs). Such a ticket is skipped
 * however its ready labels came back, takes no place under the cap, and is
 * recorded in `heldFailed`, so the turn can log it.
 *
 * @param {{ sources: readonly Source[], cap: number, now: number, only?: readonly number[], seen?: Seen[], unread?: Array<{ repo: string, error: string }>, cut?: Set<string>, unreadable?: Unreadable[], relative?: Relative[], outsiders?: Outsider[], strangers?: Stranger[], unstarted?: import('../../dispatch/start.mjs').Unstarted[], unlooked?: import('../../dispatch/start.mjs').Unlooked[], heldFailed?: HeldFailed[] }} args
 * @returns {Promise<Dispatch[]>}
 */
export const planSchedule = async ({ sources, cap, now, only, seen = [], unread, cut, unreadable, relative, outsiders, strangers, unstarted, unlooked, heldFailed }) => {
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
    // selection would otherwise consider, is reported for its comment, and
    // one held by a relative line for its repair. Neither report asks
    // about blockers.
    for (const row of rows) {
      const status = ticketStatus(row, { labels, now });
      if (!status.open || status.labels !== 'ready') continue;
      const value = unreadableOf(row);
      if (value !== undefined && status.holds.includes('unreadable')) {
        unreadable?.push({ repo: source.repo, issue: row.number, value });
      }
      const { wait } = row;
      if (wait !== undefined && 'after' in wait) {
        relative?.push({ repo: source.repo, issue: row.number, after: wait.after, ...(row.openBlockers === undefined ? {} : { openBlockers: row.openBlockers }) });
      }
    }
    const ready = selectReadyWork(rows, { cap: Number.MAX_SAFE_INTEGER, labels, now });
    // Pickup starts only tickets whose author the repo's `by` lists. Such a
    // ticket is judged on its row alone, so it reads nothing more.
    for (const row of ready) {
      const until = source.failed?.get(row.number);
      if (until !== undefined) heldFailed?.push({ repo: source.repo, issue: row.number, until });
      else if (authorPicked(row, source.by)) tagged.push({ ...row, source });
      else strangers?.push({ repo: source.repo, issue: row.number, association: row.association ?? 'NONE', ...(row.author === undefined ? {} : { author: row.author }) });
    }
  }
  const candidates = tagged.sort(byAge);
  /**
   * Whether the selection starts a candidate: not blocked, and its ready
   * labels counted. A read `read` answers with null starts nothing.
   * @param {(typeof candidates)[number]} candidate
   * @param {typeof guarded} read
   */
  const starts = async (candidate, read) => {
    const { reader, repo, labels } = candidate.source;
    // A row carrying its dependency summary was judged by it in the first
    // pass, so only a row without one asks for its `blocked_by` rows.
    if (candidate.openBlockers === undefined) {
      const blocking = await read(repo, () => reader.blockers(candidate.number));
      const record = records.get(`${repo}#${candidate.number}`);
      if (record !== undefined && blocking !== null) record.openBlockers = blocking.filter((b) => b.state === 'open').length;
      if (blocking === null || !mayPickUp(ticketStatus(candidate, { labels, now, blockers: blocking }))) return false;
    }
    // A ready label counts only when someone in the repo's trust.start, or
    // governor's App, added it last, so a ticket readied by anyone else
    // takes no place under the cap (`judgeReady`). The claim's second read
    // asks again (dispatch/launch-plan.mjs).
    const judged = await read(repo, () => judgeReady({ reader, repo, ticket: candidate, ready: labels.ready, start: candidate.source.start ?? START }));
    if (judged === null) return false;
    if (judged.counts) return true;
    if ('outsider' in judged) outsiders?.push(judged.outsider);
    else if ('unstarted' in judged) unstarted?.push(judged.unstarted);
    else unlooked?.push(judged.unread);
    return false;
  };
  /** @type {Dispatch[]} */
  const plan = [];
  for (const candidate of candidates) {
    const full = plan.length >= cap;
    if (full && cut === undefined) break;
    const { repo, labels, prompts, signOff, deployMessages } = candidate.source;
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
      prompt: promptFor(candidate.number, candidate.title, repo, labels.claim, prompts, { signOff: signOff === true, deployMessages: deployMessages === true }),
      sessionName: sessionName(candidate.number, candidate.title),
    });
  }
  return plan;
};
