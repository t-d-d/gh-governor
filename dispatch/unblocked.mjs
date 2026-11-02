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
 * | the same, and carries every ready label and no claim | also takes its ready labels off, and the comment says so | `pickup` |
 * | still blocked by another open issue | nothing: that blocker's close sends its own fire | |
 * | ready or not ready by its labels, and held by its own `Blocked until:` line | nothing, but one comment on a line governor cannot read, whatever the switches say | |
 * | carries an `exclude` label | nothing | |
 * | is claimed | messages the session its dispatch marker names | `unblocked` |
 * | is ready | picks it up as pickup does, the close's facts in the prompt | `pickup` |
 * | is not ready | starts a spec session with a marker and no claim, unless governor unreadied it on a not-planned close and nobody has answered since | `unblocked` |
 *
 * A not-planned close takes a ready, unclaimed ticket's ready labels off
 * ({@link readyToTakeOff}), whether or not another blocker is still open,
 * so pickup does not start it before a person decides it still stands. That
 * guard is `pickup`'s, since pickup is what could start the ticket; the
 * comment and the message stay `unblocked`'s. With both on, the ticket gets
 * one comment. A retry of the close, after the labels came off, reads the
 * App's label removals since the close ({@link unreadiedSince}), so its one
 * comment still says they came off and how to ready the ticket again.
 * That comment carries {@link UNREADIED_MARKER}, so a later close of another
 * blocker, finding the ticket not ready, starts no spec session until a
 * person has answered it (`heldUnreadied`, scripts/lib/ready-work.mjs).
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
import { UNREADIED_MARKER, ticketStatus, waitsOnClose } from '../scripts/lib/ready-work.mjs';

/**
 * @typedef {import('./webhook/fire.mjs').UnblockedFire} UnblockedFire
 * @typedef {import('./webhook/fire.mjs').Blocker} Blocker
 * @typedef {import('./webhook/fire.mjs').ClosingPull} ClosingPull
 * @typedef {{ repo: string, number: number, state: string, wait?: import('../scripts/lib/ready-work.mjs').Wait }} BlockedRow
 *   A ticket the closed issue blocked, in its repo, and what its `Blocked until:` line says.
 * @typedef {{ fire: UnblockedFire & { repo: string }, dedupId: string }} Queued
 * @typedef {{ repo: string, issue: number, reason: string }} Skipped
 * @typedef {import('../scripts/lib/ready-work.mjs').Labels} Labels
 * @typedef {'closed' | 'blocked' | 'not-planned' | import('../scripts/lib/ready-work.mjs').LabelState} Row
 */

/** The close reason GitHub gives an issue closed as not planned. */
export const NOT_PLANNED = 'not_planned';

/**
 * The switch each row that acts is governed by, in the ticket's repo:
 * `pickup` covers ready tickets wherever they come from, `unblocked` what
 * happens only when a blocker closes. The one overlap is a ready ticket's
 * not-planned close: its labels come off under `pickup` (turn.mjs reads
 * {@link readyToTakeOff} before this table), its comment under `unblocked`.
 *
 * @type {Readonly<Partial<Record<Row, 'pickup' | 'unblocked'>>>}
 */
export const ROW_SWITCH = Object.freeze({ 'not-planned': 'unblocked', claimed: 'unblocked', ready: 'pickup', 'not-ready': 'unblocked' });

/** Whether two repo names are the same repo: GitHub's compare in any case. @param {string} a @param {string} b */
export const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

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
 * is a ticket of the closing repo where its switches are off (`ownOff`),
 * unless its line waits a number of days after this close: governor
 * rewrites that line into its date whatever the switches say
 * (dispatch/waits.mjs). The closing turn cannot read another repo's
 * switches, so another repo's ticket is queued anyway, and its turn ends
 * there.
 *
 * @param {{ closed: Blocker, pr: ClosingPull | null, rows: readonly BlockedRow[], owners: readonly string[], ownOff?: boolean }} args
 * @returns {{ queue: Queued[], skipped: Skipped[] }}
 */
export const closingFires = ({ closed, pr, rows, owners, ownOff = false }) => {
  /** @type {Queued[]} */
  const queue = [];
  /** @type {Skipped[]} */
  const skipped = [];
  for (const { repo, number: issue, state, wait } of rows) {
    const owner = repo.split('/')[0] ?? '';
    const reason = state !== 'open' ? `#${issue} is ${state}`
      : !ownerListed(owners, owner) ? `${owner} is not on the owner list`
        : ownOff && sameRepo(repo, closed.repo) && !waitsOnClose(wait, repo, closed) ? `${repo}'s file turns neither pickup nor unblocked on`
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
 * `now` reads as still blocked, so the close starts nothing for it. The
 * line holds only where the labels read ready or not ready: a claimed
 * ticket's session still hears the close, and an excluded ticket still
 * reads excluded. Its status (`ticketStatus`) says all of this, and
 * {@link rowOf} reads the row from it.
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
export const ticketRow = ({ ticket, blockers, fire, labels, now = Date.now() }) => rowOf(ticketStatus(ticket, { labels, now, blockers }), fire);

/**
 * The row a ticket's status takes on its blocker's close: `closed`, then
 * `not-planned`, then `blocked` where anything holds it (an open blocker,
 * its line, or a line governor cannot read), else what its labels say.
 *
 * @param {import('../scripts/lib/ready-work.mjs').TicketStatus} status
 * @param {Pick<UnblockedFire, 'blocker'>} fire
 * @returns {Row}
 */
export const rowOf = (status, fire) => {
  if (!status.open) return 'closed';
  if (fire.blocker.reason === NOT_PLANNED) return 'not-planned';
  if (status.holds.length > 0) return 'blocked';
  return status.labels;
};

/**
 * What a set of label names says on its own (`ticketStatus`'s `labels`), for
 * a ticket's labels with some put back. A row with no line and no blocker is
 * open and held by nothing, so its status reads its labels alone.
 *
 * @param {readonly string[]} on
 * @param {Pick<Labels, 'ready' | 'claim' | 'exclude'>} labels
 * @returns {import('../scripts/lib/ready-work.mjs').LabelState}
 */
const labelsSay = (on, labels) => {
  const status = ticketStatus({ labels: on }, { labels, now: 0 });
  return status.open ? status.labels : 'not-ready';
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
export const specPrompt = ({ fire, title, labels, prompts }) => specSession({ issue: fire.issue, title, labels, prompts, kind: 'unblockedSpec', facts: unblockedFacts(fire) });

/**
 * A spec session's opening prompt, for a ticket not ready to pick up: the
 * line naming it, the facts of what freed it, the repo's instruction of
 * `kind`, and the unattended line. A blocker's close and an ended wait
 * (dispatch/waits.mjs) both start one.
 *
 * @param {{ issue: number, title: string, facts: string, kind: 'unblockedSpec' | 'waitEndedSpec', labels: { ready: readonly string[], claim: string }, prompts: Record<string, string | undefined> }} args
 */
export const specSession = ({ issue, title, facts, kind, labels, prompts }) => {
  const lead = oneLine(title);
  return [
    lead ? `Spec #${issue} '${lead}'` : `Spec #${issue}`,
    '',
    facts,
    instruction(prompts, kind, { issue, ready: labels.ready.map((l) => `\`${l}\``).join(' and '), claim: labels.claim }),
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
 * The ready labels a not-planned close takes off a ticket: every one of the
 * repo's, where pickup reads the ticket as ready by its labels, and
 * none otherwise. A claimed ticket's session is told instead, and keeps its
 * labels; an excluded one is never picked up, so it keeps them too.
 *
 * @param {readonly string[]} on The ticket's labels.
 * @param {Pick<Labels, 'ready' | 'claim' | 'exclude'>} labels The repo's.
 * @returns {string[]}
 */
export const readyToTakeOff = (on, labels) => (labelsSay(on, labels) === 'ready' ? [...labels.ready] : []);

/**
 * The ready labels an earlier run of this close took off a ticket, read back
 * on a retry: the retry reads the ticket without them, so
 * {@link readyToTakeOff} finds nothing and the comment would not say they
 * came off. A label counts when its latest removal is the App's, at or
 * after the close, and it is still off; the ticket, with those labels
 * back, must read as ready. Those still on are the ones that would not
 * come off.
 *
 * @param {readonly string[]} on The ticket's labels.
 * @param {ReadonlyArray<{ label: string, at: string, ours: boolean }>} removals The ticket's label removals, oldest first, each marked with whether the App made it.
 * @param {Pick<Labels, 'ready' | 'claim' | 'exclude'>} labels The repo's.
 * @param {string} since When the blocker closed.
 * @returns {{ removed: string[], failed: string[] } | undefined}
 */
export const unreadiedSince = (on, removals, labels, since) => {
  const from = Date.parse(since);
  // Each label's latest removal, so one the App made and a person undid and
  // made again is the person's.
  const latest = new Map(removals.map((r) => [r.label, r]));
  const ours = new Set([...latest.values()].filter((r) => r.ours && Date.parse(r.at) >= from).map((r) => r.label));
  const removed = labels.ready.filter((l) => ours.has(l) && !on.includes(l));
  if (removed.length === 0 || labelsSay([...on, ...removed], labels) !== 'ready') return undefined;
  return { removed, failed: labels.ready.filter((l) => on.includes(l)) };
};

/**
 * Whether a not-planned close could have taken a ticket's ready labels off
 * already: some are off, and with them all back it reads as ready.
 *
 * @param {readonly string[]} on
 * @param {Pick<Labels, 'ready' | 'claim' | 'exclude'>} labels
 */
export const mayBeUnreadied = (on, labels) => labels.ready.some((l) => !on.includes(l)) && labelsSay([...on, ...labels.ready], labels) === 'ready';

/** @param {readonly string[]} names */
const listed = (names) => {
  const quoted = names.map((n) => `\`${n}\``);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
};

/**
 * What became of a ticket's ready labels, for its comment. Fixed text, not
 * the repo's prompt, so a repo that replaces the ask still says it. Pickup
 * needs every ready label, so any one that came off holds the ticket.
 *
 * @param {number} issue
 * @param {{ removed: readonly string[], failed: readonly string[] }} unreadied
 */
const readySentence = (issue, { removed, failed }) => {
  if (removed.length === 0) {
    return `Governor could not take ${listed(failed)} off #${issue}, so it can still be picked up. Take ${failed.length === 1 ? 'it' : 'them'} off by hand until you decide #${issue} still stands.`;
  }
  if (failed.length === 0) {
    const its = removed.length === 1 ? `its ready label, ${listed(removed)},` : `its ready labels, ${listed(removed)},`;
    return `Governor took ${its} off #${issue}, so it is not picked up. Put ${removed.length === 1 ? 'it' : 'them'} back once you decide #${issue} still stands.`;
  }
  return `Governor took ${listed(removed)} off #${issue}, so it is not picked up, but could not take ${listed(failed)} off. Put ${listed(removed)} back once you decide #${issue} still stands.`;
};

/**
 * The comment a ticket gets when its blocker closed as not planned, and its
 * session's message if it is claimed. `blocked`: another open issue still
 * blocks the ticket, which the text says, so nobody reads it as free. That
 * sentence comes after the ask, since the default ask's "Its work" means the
 * blocker's and must follow the blocker's facts.
 *
 * `unreadied`: the ready labels this close took off, and those it could
 * not, which the comment ends on.
 *
 * @param {UnblockedFire & { repo?: string }} fire
 * @param {Record<string, string | undefined>} prompts
 * @param {{ blocked?: boolean, unreadied?: { removed: readonly string[], failed: readonly string[] } }} [options]
 */
export const notPlannedComment = (fire, prompts, { blocked = false, unreadied } = {}) => {
  const still = blocked ? `\n\n#${fire.issue} is still blocked by another open issue, so this close does not free it.` : '';
  const ready = unreadied === undefined ? '' : `\n\n${readySentence(fire.issue, unreadied)}`;
  const marker = unreadied !== undefined && unreadied.removed.length > 0 ? `\n\n${UNREADIED_MARKER}` : '';
  return `${unblockedFacts(fire, { quote: true })}\n\n${instruction(prompts, 'unblockedNotPlanned')}${still}${ready}${marker}`;
};

/** Why a ticket governor's not-planned close still holds (`specHold`, scripts/lib/ready-work.mjs) starts no spec session, as both a close and an ended wait log it. */
export const UNREADIED_HELD = 'its ready labels came off on a not-planned close, and nobody has answered governor\'s comment since';
