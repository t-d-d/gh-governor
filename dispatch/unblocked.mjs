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
 * repo's config. The turn reads the ticket there, and its `blocked_by` list
 * only where the ticket carries no dependency summary, and acts on the
 * first row of the table that fits ({@link ticketRow}):
 *
 * | The ticket | The turn | Switch |
 * |---|---|---|
 * | closed | nothing | |
 * | lost its blocker to a "not planned" close | comments, and messages its session if claimed, saying so if another open issue still blocks it | `unblocked` |
 * | still blocked by another open issue | nothing: that blocker's close sends its own fire | |
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
import { isBlocked, isWaiting, labelRow } from '../scripts/lib/ready-work.mjs';

/**
 * @typedef {import('./webhook/fire.mjs').UnblockedFire} UnblockedFire
 * @typedef {import('./webhook/fire.mjs').Blocker} Blocker
 * @typedef {import('./webhook/fire.mjs').ClosingPull} ClosingPull
 * @typedef {{ repo: string, number: number, state: string }} BlockedRow A ticket the closed issue blocked, in its repo.
 * @typedef {{ fire: UnblockedFire & { repo: string }, dedupId: string }} Queued
 * @typedef {{ repo: string, issue: number, reason: string }} Skipped
 * @typedef {import('../scripts/lib/ready-work.mjs').Labels} Labels
 * @typedef {'closed' | 'blocked' | 'not-planned' | ReturnType<typeof labelRow>} Row
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
 * The closed blocker reads closed, so any open one is another. A
 * not-planned close is told even while another blocker is open, so nobody
 * starts on a spec that assumed the dropped work. A ticket
 * carrying its dependency summary is judged by it (`isBlocked`), since the
 * rows leave out a blocker the App cannot see; `blockers` is read only for
 * a ticket without one. A ticket its own `Blocked until:` line holds at
 * `now` (`isWaiting`) reads as still blocked, so the close starts nothing
 * for it.
 *
 * @param {{
 *   ticket: { state: string, labels: readonly string[], openBlockers?: number, wait?: import('../scripts/lib/ready-work.mjs').Wait },
 *   blockers: ReadonlyArray<{ state: string }> | undefined,
 *   fire: Pick<UnblockedFire, 'blocker'>,
 *   labels: Labels,
 *   now?: number,
 * }} args `now`: epoch ms, the clock where unset.
 * @returns {Row}
 */
export const ticketRow = ({ ticket, blockers, fire, labels, now = Date.now() }) => {
  if (ticket.state !== 'open') return 'closed';
  if (fire.blocker.reason === NOT_PLANNED) return 'not-planned';
  if (isBlocked(ticket, blockers) || isWaiting(ticket, now)) return 'blocked';
  return labelRow(ticket.labels, labels);
};

/**
 * What closed and how: the blocker and the PR that closed it, each by the
 * blocker's repo where that is not the ticket's, and its close reason.
 * `quote`: each title as code, for a comment GitHub renders, so an
 * `@handle` or `#N` in a title neither notifies nor links.
 *
 * @param {UnblockedFire & { repo?: string }} fire
 * @param {{ quote?: boolean }} [options]
 */
export const unblockedFacts = ({ repo, issue, blocker, pr }, { quote = false } = {}) => {
  const ref = repo !== undefined && sameRepo(repo, blocker.repo) ? '#' : `${blocker.repo}#`;
  const title = (/** @type {string} */ t) => (quote ? `\`${t.replace(/`/g, "'")}\`` : t);
  const how = blocker.reason === undefined ? 'closed' : `closed as ${blocker.reason.replace(/_/g, ' ')}`;
  const by = pr === undefined ? 'with no PR' : `by PR ${ref}${pr.number} (${title(pr.title)}, ${pr.url})`;
  return `${ref}${blocker.number} (${title(blocker.title)}) ${how}, ${by}. It blocked #${issue}.`;
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
 * The comment a ticket gets when its blocker closed as not planned, and its
 * session's message if it is claimed. `blocked`: another open issue still
 * blocks the ticket, which the text says, so nobody reads it as free. That
 * sentence comes after the ask, since the default ask's "Its work" means the
 * blocker's and must follow the blocker's facts.
 *
 * @param {UnblockedFire & { repo?: string }} fire
 * @param {Record<string, string | undefined>} prompts
 * @param {{ blocked?: boolean }} [options]
 */
export const notPlannedComment = (fire, prompts, { blocked = false } = {}) => {
  const still = blocked ? `\n\n#${fire.issue} is still blocked by another open issue, so this close does not free it.` : '';
  return `${unblockedFacts(fire, { quote: true })}\n\n${instruction(prompts, 'unblockedNotPlanned')}${still}`;
};
