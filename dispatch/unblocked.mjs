/**
 * A blocker's close, handled in each blocked ticket's own repo.
 *
 * An issue closing queues a `schedule` fire naming it as `freed`
 * (dispatch/webhook/route.mjs). That closing turn reads the issue's
 * `blocking` list, which can name tickets in other repos, and the PR whose
 * merge closed it, and queues one `unblocked` fire per open ticket in a
 * repo whose owner is on the owner list ({@link closingFires}). It starts
 * nothing and calls GitHub only under the closed issue's repo.
 *
 * Each `unblocked` fire runs in the ticket's repo's own turn, under that
 * repo's config. The turn reads the ticket and its `blocked_by` list there,
 * and acts on the first row of the table that fits ({@link ticketRow}):
 *
 * | The ticket | The turn | Switch |
 * |---|---|---|
 * | closed, or still blocked by another open issue | nothing: that blocker's close sends its own fire | |
 * | lost its blocker to a "not planned" close | comments, and messages its session if claimed | `unblocked` |
 * | carries an `exclude` label | nothing | |
 * | is claimed | messages the session its dispatch marker names | `unblocked` |
 * | is ready | picks it up as pickup does, the close's facts in the prompt | `pickup` |
 * | is not ready | starts a spec session with a marker and no claim | `unblocked` |
 *
 * The last row is pickup's reverse: the prompt tells the session to add the
 * claim label itself before it builds. The marker keeps the sweep off the
 * ticket inside the dispatch window, and the claim keeps it off after.
 *
 * Pure: dispatch/turn.mjs reads and writes.
 */

import { createHash } from 'node:crypto';
import { UNATTENDED, build, ownerListed } from './webhook/fire.mjs';
import { oneLine } from './webhook/mention.mjs';
import { instruction } from './prompts.mjs';

/**
 * @typedef {import('./webhook/fire.mjs').UnblockedFire} UnblockedFire
 * @typedef {import('./webhook/fire.mjs').Blocker} Blocker
 * @typedef {import('./webhook/fire.mjs').ClosingPull} ClosingPull
 * @typedef {{ repo: string, number: number, state: string }} BlockedRow A ticket the closed issue blocked, in its repo.
 * @typedef {{ fire: UnblockedFire & { repo: string }, dedupId: string }} Queued
 * @typedef {{ repo: string, issue: number, reason: string }} Skipped
 * @typedef {'closed' | 'blocked' | 'not-planned' | 'excluded' | 'claimed' | 'ready' | 'not-ready'} Row
 */

/** The close reason GitHub gives an issue closed as not planned. */
export const NOT_PLANNED = 'not_planned';

/**
 * The switch each row that acts is governed by, in the ticket's repo:
 * `pickup` covers ready tickets wherever they come from, `unblocked` what
 * happens only when a blocker closes. No ticket falls under both.
 *
 * @type {Readonly<Partial<Record<Row, 'pickup' | 'unblocked'>>>}
 */
export const ROW_SWITCH = Object.freeze({ 'not-planned': 'unblocked', claimed: 'unblocked', ready: 'pickup', 'not-ready': 'unblocked' });

/** @param {string} a @param {string} b */
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * A fire's deduplication id: the closed issue and the ticket, so a retried
 * close queues nothing twice. Hashed: two repo names can pass SQS's 128.
 *
 * @param {{ repo: string, number: number }} closed
 * @param {{ repo: string, issue: number }} ticket
 */
const dedupIdOf = (closed, ticket) =>
  createHash('sha256').update(`unblocked:${closed.repo.toLowerCase()}#${closed.number}:${ticket.repo.toLowerCase()}#${ticket.issue}`).digest('hex');

/**
 * The fires a close queues: one per open blocked ticket in a repo whose
 * owner is on the list, with no cap, since each starts at most one
 * session and queues nothing. Any repo can link its issue as blocked by one
 * of ours, so the list can hold strangers' tickets: those are skipped, as
 * is a ticket of the closing repo where its switches are off (`ownOff`).
 * The closing turn cannot read another repo's switches, so another repo's
 * ticket is queued anyway, and its turn ends there.
 *
 * @param {{ closed: Blocker, pr: ClosingPull | null, rows: readonly BlockedRow[], owners: readonly string[], ownOff?: boolean }} args
 * @returns {{ queue: Queued[], skipped: Skipped[] }}
 */
export const closingFires = ({ closed, pr, rows, owners, ownOff = false }) => {
  /** @type {Queued[]} */
  const queue = [];
  /** @type {Skipped[]} */
  const skipped = [];
  for (const { repo, number: issue, state } of rows) {
    const owner = repo.split('/')[0] ?? '';
    const reason = state !== 'open' ? `#${issue} is ${state}`
      : !ownerListed(owners, owner) ? `${owner} is not on the owner list`
        : ownOff && sameRepo(repo, closed.repo) ? `${repo}'s file turns neither pickup nor unblocked on`
          : null;
    if (reason !== null) {
      skipped.push({ repo, issue, reason });
      continue;
    }
    queue.push({ fire: { ...build.unblocked({ issue, blocker: closed, pr }), repo }, dedupId: dedupIdOf(closed, { repo, issue }) });
  }
  return { queue, skipped };
};

/**
 * The first row of the table that fits the ticket, read in its own repo.
 * The closed blocker reads closed in `blockers`, so any open one is
 * another.
 *
 * @param {{
 *   ticket: { state: string, labels: readonly string[] },
 *   blockers: ReadonlyArray<{ state: string }>,
 *   fire: Pick<UnblockedFire, 'blocker'>,
 *   labels: { ready: readonly string[], claim: string, exclude: readonly string[] },
 * }} args
 * @returns {Row}
 */
export const ticketRow = ({ ticket, blockers, fire, labels }) => {
  if (ticket.state !== 'open') return 'closed';
  if (blockers.some((b) => b.state === 'open')) return 'blocked';
  if (fire.blocker.reason === NOT_PLANNED) return 'not-planned';
  if (labels.exclude.some((l) => ticket.labels.includes(l))) return 'excluded';
  if (ticket.labels.includes(labels.claim)) return 'claimed';
  if (labels.ready.every((l) => ticket.labels.includes(l))) return 'ready';
  return 'not-ready';
};

/**
 * What closed and how: the blocker, by its repo where that is not the
 * ticket's, its close reason, and the PR that closed it.
 *
 * @param {UnblockedFire & { repo?: string }} fire
 */
export const unblockedFacts = ({ repo, issue, blocker, pr }) => {
  const name = repo !== undefined && sameRepo(repo, blocker.repo) ? `#${blocker.number}` : `${blocker.repo}#${blocker.number}`;
  const how = blocker.reason === undefined ? 'closed' : `closed as ${blocker.reason.replace(/_/g, ' ')}`;
  const by = pr === undefined ? 'with no PR' : `by PR #${pr.number} (${pr.title}, ${pr.url})`;
  return `${name} (${blocker.title}) ${how}, ${by}. It blocked #${issue}.`;
};

/**
 * A ready ticket's opening prompt: pickup's, then the close's facts and the
 * ask to check the spec against what merged first.
 *
 * @param {string} pickup The pickup prompt (scripts/lib/dispatch-prompt.mjs).
 * @param {UnblockedFire & { repo?: string }} fire
 * @param {Record<string, string | undefined>} prompts The repo's.
 */
export const readyPrompt = (pickup, fire, prompts) => `${pickup}\n\n${unblockedFacts(fire)}\n${instruction(prompts, 'unblockedReady')}`;

/**
 * A ticket not ready to pick up: a session to rewrite its spec from what
 * merged. Governor does not claim it; the prompt tells the session to add
 * the claim label itself before it builds.
 *
 * @param {{ fire: UnblockedFire & { repo?: string }, title: string, labels: { ready: readonly string[], claim: string }, prompts: Record<string, string | undefined> }} args
 */
export const specPrompt = ({ fire, title, labels, prompts }) => {
  const lead = oneLine(title);
  return [
    lead ? `Spec #${fire.issue} '${lead}'` : `Spec #${fire.issue}`,
    '',
    unblockedFacts(fire),
    instruction(prompts, 'unblockedSpec', { issue: fire.issue, ready: labels.ready.map((l) => `\`${l}\``).join(' and '), claim: labels.claim }),
    UNATTENDED,
  ].join('\n');
};

/**
 * A claimed ticket's session's message: its blocker closed, by which PR.
 *
 * @param {UnblockedFire & { repo?: string }} fire
 * @param {Record<string, string | undefined>} prompts
 */
export const unblockedMessage = (fire, prompts) => `${unblockedFacts(fire)}\n\n${instruction(prompts, 'unblockedClaimed', { issue: fire.issue })}`;

/**
 * The comment a ticket gets when its blocker closed as not planned.
 *
 * @param {UnblockedFire & { repo?: string }} fire
 * @param {Record<string, string | undefined>} prompts
 */
export const notPlannedComment = (fire, prompts) => `${unblockedFacts(fire)}\n\n${instruction(prompts, 'unblockedNotPlanned')}`;
