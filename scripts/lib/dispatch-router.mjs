/**
 * What a `schedule` fire starts: the ready issues, up to the cap, or the
 * one issue (`issue`) or the issues a close freed (`freed`) the fire names
 * (dispatch/webhook/fire.mjs reads the fire; dispatch/turn.mjs runs it).
 *
 * The selection walks `scripts/lib/ready-work.mjs`'s ordered candidates,
 * asking about blockers, parent and recent dispatches only as far as the cap
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
import { byPriority, selectReadyWork } from './ready-work.mjs';

/**
 * @typedef {{ issue?: number, repo: string, prompt: string, sessionName: string }} Dispatch
 *
 * @typedef {import('./github-app.mjs').IssueRow} IssueRow
 * @typedef {{
 *   readyIssues: (labels: readonly string[]) => Promise<IssueRow[]>,
 *   blockers: (number: number) => Promise<import('./github-app.mjs').BlockerRow[]>,
 *   blocking: (number: number) => Promise<import('./github-app.mjs').BlockerRow[]>,
 *   parent: (number: number) => Promise<import('./github-app.mjs').ParentRow | null>,
 *   comments: (number: number, options?: { since?: string }) => Promise<import('./github-app.mjs').CommentRow[]>,
 * }} Reader
 *
 * @typedef {{ repo: string, reader: Reader, labels: import('./ready-work.mjs').Labels, prompts?: Record<string, string | undefined> }} Source
 *   A served repo's tickets: its reader, its config file's ready and claim
 *   labels, and its prompts.
 */

/**
 * The schedule's plan: eligible issues in priority order, up to the cap,
 * asking about blockers, parent and recent dispatches only as far as the cap
 * needs. The order runs over every source's tickets together:
 * type, then oldest, whichever repo each is in. With `only`, those issues
 * and no other, still in the selector's
 * order and under the cap: the fire for an issue just labelled ready
 * dispatches it if the selection would, and the fire for an issue just
 * closed dispatches what it blocked, leaving the rest of the backlog to the
 * sweep, so a batch of labels is a session each and not the cap's worth per
 * label, and a close cannot cascade past what it blocked. A fire naming
 * issues names one repo, so `only` is for one source.
 *
 * With `unread`, a source whose read fails is recorded there and left out
 * of the rest of the plan, so one repo's refusal does not stop the others;
 * without it, the read's failure throws.
 *
 * @param {{ sources: readonly Source[], cap: number, now: number, windowMs?: number, only?: readonly number[], unread?: Array<{ repo: string, error: string }> }} args
 * @returns {Promise<Dispatch[]>}
 */
export const planSchedule = async ({ sources, cap, now, windowMs = DISPATCH_WINDOW_MS, only, unread }) => {
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
  const ranked = tagged.sort(byPriority);
  const named = only && new Set(only);
  const candidates = named ? ranked.filter((c) => named.has(c.number)) : ranked;
  // Only the window's comments: a marker older than the window would not
  // count, and the endpoint pages oldest first, so on a long thread the
  // newest marker would otherwise sit past the page.
  const since = new Date(now - windowMs).toISOString();
  /** @type {Dispatch[]} */
  const plan = [];
  for (const candidate of candidates) {
    if (plan.length >= cap) break;
    const { reader, repo, labels, prompts } = candidate.source;
    if (failed.has(repo)) continue;
    const blocking = await guarded(repo, () => reader.blockers(candidate.number));
    if (blocking === null || selectReadyWork([candidate], { cap: 1, blockers: new Map([[candidate.number, blocking]]), labels }).length === 0) continue;
    const parent = await guarded(repo, () => reader.parent(candidate.number));
    if (failed.has(repo) || selectReadyWork([candidate], { cap: 1, parents: new Map([[candidate.number, parent]]), labels }).length === 0) continue;
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
