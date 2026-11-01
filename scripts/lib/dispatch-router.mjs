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
import { byAge, isBlocked, selectReadyWork } from './ready-work.mjs';

/**
 * @typedef {{ issue?: number, repo: string, prompt: string, sessionName: string }} Dispatch
 *
 * @typedef {import('./github-app.mjs').IssueRow} IssueRow
 * @typedef {{
 *   readyIssues: (labels: readonly string[]) => Promise<IssueRow[]>,
 *   blockers: (number: number) => Promise<import('./github-app.mjs').BlockerRow[]>,
 *   comments: (number: number, options?: { since?: string }) => Promise<import('./github-app.mjs').CommentRow[]>,
 * }} Reader
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
 * With `unread`, a source whose read fails is recorded there and left out
 * of the rest of the plan, so one repo's refusal does not stop the others;
 * without it, the read's failure throws.
 *
 * With `cut`, the walk goes on past the cap to add each repo with a ticket
 * the selection would have started had the cap allowed it. It asks about a
 * repo's tickets only until it finds its first, so the reads past the cap
 * are at most a few per repo. The bare fire leaves such a repo's sweep
 * unrecorded: the cap limits load, and does not set how often a repo is
 * swept.
 *
 * @param {{ sources: readonly Source[], cap: number, now: number, windowMs?: number, only?: readonly number[], unread?: Array<{ repo: string, error: string }>, cut?: Set<string> }} args
 * @returns {Promise<Dispatch[]>}
 */
export const planSchedule = async ({ sources, cap, now, windowMs = DISPATCH_WINDOW_MS, only, unread, cut }) => {
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
  /** @type {Array<import('./ready-work.mjs').IssueRow & { source: Source }>} */
  const tagged = [];
  for (const source of sources) {
    const { labels } = source;
    const rows = await guarded(source.repo, () => source.reader.readyIssues(labels.ready));
    if (rows === null) continue;
    const ready = selectReadyWork(rows, { cap: Number.MAX_SAFE_INTEGER, labels });
    tagged.push(...ready.map((row) => ({ ...row, source })));
  }
  const ranked = tagged.sort(byAge);
  const named = only && new Set(only);
  const candidates = named ? ranked.filter((c) => named.has(c.number)) : ranked;
  // Only the window's comments: a marker older than the window would not
  // count, and the endpoint pages oldest first, so on a long thread the
  // newest marker would otherwise sit past the page.
  const since = new Date(now - windowMs).toISOString();
  /**
   * Whether the selection would have started a candidate past the cap; a
   * read that fails says yes.
   * @param {(typeof candidates)[number]} candidate
   */
  const cutAt = async (candidate) => {
    const { reader } = candidate.source;
    try {
      if (candidate.openBlockers === undefined && isBlocked(candidate, await reader.blockers(candidate.number))) return false;
      return !recentlyDispatched(await reader.comments(candidate.number, { since }), now, windowMs);
    } catch {
      return true;
    }
  };
  /** @type {Dispatch[]} */
  const plan = [];
  for (const candidate of candidates) {
    const full = plan.length >= cap;
    if (full && cut === undefined) break;
    const { reader, repo, labels, prompts } = candidate.source;
    if (failed.has(repo) || (full && cut?.has(repo))) continue;
    if (full) {
      // Past the cap a read that fails starts nothing, so it is no refusal:
      // the repo counts as cut, and the next fire sweeps it again.
      if (await cutAt(candidate)) cut?.add(repo);
      continue;
    }
    // A row carrying its dependency summary was judged by it in the first
    // pass, so only a row without one asks for its `blocked_by` rows.
    if (candidate.openBlockers === undefined) {
      const blocking = await guarded(repo, () => reader.blockers(candidate.number));
      if (blocking === null || isBlocked(candidate, blocking)) continue;
    }
    const comments = await guarded(repo, () => reader.comments(candidate.number, { since }));
    if (comments === null || recentlyDispatched(comments, now, windowMs)) continue;
    plan.push({
      issue: candidate.number,
      repo,
      prompt: promptFor(candidate.number, candidate.title, repo, labels.claim, prompts),
      sessionName: sessionName(candidate.number, candidate.title),
    });
  }
  return plan;
};
