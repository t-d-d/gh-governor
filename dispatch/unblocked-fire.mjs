/**
 * An unblocked fire: a ticket whose blocker closed, in the ticket's own repo,
 * under that repo's config. The turn takes the first row of the table that
 * fits (dispatch/unblocked.mjs), and the repo's switch for that row decides
 * whether it acts. The rows that comment or message start nothing and answer
 * the turn. The ready row picks the ticket up as pickup does, and the
 * not-ready row messages the owner its body names, with a spec session as
 * the fallback, or starts a spec session where it names none.
 *
 * It lives apart from unblocked.mjs because it settles a relative
 * `Blocked until:` line and reports an unreadable one (dispatch/waits.mjs),
 * and waits.mjs imports unblocked.mjs.
 */

import { DEFAULT_MODEL, sessionName } from '../scripts/lib/dispatch-prompt.mjs';
import { outsiderReason, planSchedule } from '../scripts/lib/dispatch-router.mjs';
import { mayStartSpec, specHold, ticketStatus, unreadableOf } from '../scripts/lib/ready-work.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { GITHUB_SOURCE } from './deliveries.mjs';
import { CONFIG_PATH, turnsOn } from './repo-config.mjs';
import { fireRepoOf } from './repos.mjs';
import { CAP_ZERO_REASON } from './launch-plan.mjs';
import { ROW_SWITCH, UNREADIED_HELD, mayBeUnreadied, notPlannedComment, ownerOutcome, ownerSpecMessage, readyPrompt, readyToTakeOff, rowOf, specPrompt, unblockedMessage, unreadiedSince } from './unblocked.mjs';
import { relativeAtClose, reportUnreadable } from './waits.mjs';
import { dispatchMarker, lastDispatch } from './webhook/fire.mjs';
import { sessionNamedIn } from './webhook/subscribe.mjs';

/** @typedef {import('./turn.mjs').Reader} Reader */

/** How often, and how far apart, an unblocked fire reads a ticket that still counts an open blocker. */
const UNBLOCKED_READS = 4;
const UNBLOCKED_WAIT_MS = 3000;

/**
 * An unblocked fire's ticket, and its `blocked_by` rows where it carries no
 * dependency summary (the summary counts a blocker the rows leave out). The
 * turn runs seconds after the blocker closed, and a read then may still
 * count it open, so an open ticket that reads blocked is read again, a few
 * times over about ten seconds, as the conflicts check re-reads a PR's
 * mergeable state. `reads`: each read's labels and open blocker count, for
 * the log.
 *
 * @param {Pick<Reader, 'ticket' | 'blockers'>} reader
 * @param {number} issue
 * @param {(ms: number) => Promise<void>} sleep
 * @param {(ticket: Awaited<ReturnType<Reader['ticket']>>, blockers: Awaited<ReturnType<Reader['blockers']>> | undefined) => import('../scripts/lib/ready-work.mjs').TicketStatus} statusOf
 *   The ticket's status under its repo's rules (`ticketStatus`).
 */
const readUnblocked = async (reader, issue, sleep, statusOf) => {
  /** @type {Array<{ labels: string[], openBlockers: number }>} */
  const reads = [];
  for (let read = 1; ; read += 1) {
    const ticket = await reader.ticket(issue);
    const blockers = ticket.openBlockers === undefined ? await reader.blockers(issue) : undefined;
    reads.push({ labels: ticket.labels, openBlockers: ticket.openBlockers ?? (blockers ?? []).filter((b) => b.state === 'open').length });
    const status = statusOf(ticket, blockers);
    if (!status.open || !status.holds.includes('blocker') || read >= UNBLOCKED_READS) return { ticket, blockers, reads };
    await sleep(UNBLOCKED_WAIT_MS);
  }
};

/**
 * An unblocked fire's plan. A row that ends the turn without a launch (a
 * refusal, nothing to do, a ticket its relative line holds, a comment, a
 * message to the claimed ticket's session) answers the turn as a whole. The
 * ready row plans one launch that claims the ticket, through the
 * selection's own checks, the window included; the not-ready row plans a
 * spec session that claims nothing. Either holds its repo on a failure, and
 * the plan's result carries the row.
 *
 * @param {import('./webhook/fire.mjs').UnblockedFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planUnblocked = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { issue, blocker } = invocation;
  const config = ctx.configOf(repo);
  const reader = await ctx.readerFor(repo);
  // The ticket's status under the repo's rules, read at the clock's time.
  /** @param {Parameters<typeof ticketStatus>[0]} read @param {Parameters<typeof ticketStatus>[1]['blockers']} [blockers] */
  const statusOf = (read, blockers) => ticketStatus(read, { labels: config.labels, now: ctx.now(), blockers });
  /** Whether the ticket's own line holds it, by its labels. @param {Parameters<typeof ticketStatus>[0]} read */
  const lineHolds = (read) => {
    const status = statusOf(read);
    return status.open && status.holds.includes('line');
  };
  // A relative `Blocked until:` line on this close is settled first,
  // whatever the switches say: rewritten into its date, or, on a close
  // that was not completed, left with one comment that replaces the
  // not-planned row's (dispatch/waits.mjs). Only a ticket ready or not
  // ready by its labels is then held; a claimed or excluded one takes its
  // own row, so a claimed ticket's session still hears the close.
  const settleRelative = (/** @type {{ state: string, labels: readonly string[], wait?: import('../scripts/lib/ready-work.mjs').Wait }} */ read) =>
    relativeAtClose({ reader, repo, ticket: read, fire: invocation, prompts: ctx.prompts, now: ctx.now(), log: ctx.log, holds: lineHolds(read) });
  if (!turnsOn(config, 'pickup') && !turnsOn(config, 'unblocked')) {
    const settled = await settleRelative(await reader.ticket(issue));
    const why = `${repo}'s ${CONFIG_PATH} turns neither pickup nor unblocked on`;
    ctx.log('dispatch-refused', { level: 'info', repo, kind: invocation.kind, issue, reason: why, ...(settled === null ? {} : { relative: settled.outcome }) });
    return { answer: { kind: invocation.kind, refusal: why, dispatched: [] } };
  }
  const read = await readUnblocked(reader, issue, ctx.sleep, statusOf);
  const { blockers, reads } = read;
  let { ticket } = read;
  const settled = await settleRelative(ticket);
  // A line changed since the ticket's read is no longer this close's: the
  // ticket is read again and takes its row as it now stands.
  const changed = settled?.outcome === 'line changed';
  if (changed) ticket = await reader.ticket(issue);
  else if (settled?.wait !== undefined) ticket = { ...ticket, wait: settled.wait };
  // The line's comment on a close that was not completed stands in for
  // the not-planned row's, which a claimed ticket's session still hears.
  const lineSaid = settled !== null && settled.wait === undefined && !changed;
  const status = statusOf(ticket, blockers);
  if (lineSaid && status.open && status.holds.includes('line')) {
    ctx.log('dispatch-unblocked', { repo, issue, blocker: `${blocker.repo}#${blocker.number}`, row: 'blocked', reads, outcome: `held by its relative line: ${settled.outcome}` });
    return { answer: { kind: invocation.kind, row: 'blocked', dispatched: [] } };
  }
  const row = rowOf(status, invocation);
  const about = { repo, issue, blocker: `${blocker.repo}#${blocker.number}`, row, reads, ...(ticket.wait === undefined ? {} : { wait: ticket.wait }), ...(lineSaid ? { relative: settled.outcome } : {}) };
  // An unreadable `Blocked until:` line holds a ticket ready or not ready
  // by its labels, which reads as blocked, and is said once on it whatever
  // the repo's switches say. A claimed or excluded ticket is not held.
  const unread = status.open && status.holds.includes('unreadable') ? unreadableOf(ticket) : undefined;
  if (unread !== undefined) await reportUnreadable({ reader, repo, issue, value: unread, log: ctx.log });
  // A not-planned close takes a ready, unclaimed ticket's ready labels off
  // under pickup, the switch that could start it before anyone decides.
  const takeOff = row === 'not-planned' && turnsOn(config, 'pickup') ? readyToTakeOff(ticket.labels, config.labels) : [];
  // A retry of this close reads the ticket after its labels came off: the
  // App's removals since the close say what the earlier run took off.
  const { closedAt } = blocker;
  const earlier = row === 'not-planned' && takeOff.length === 0 && turnsOn(config, 'pickup') && closedAt !== undefined && mayBeUnreadied(ticket.labels, config.labels)
    ? unreadiedSince(ticket.labels, await reader.labelRemovals(issue), config.labels, closedAt)
    : undefined;
  const governs = takeOff.length > 0 || earlier !== undefined ? 'pickup' : ROW_SWITCH[row];
  if (governs === undefined) {
    ctx.log('dispatch-unblocked', { ...about, outcome: 'nothing to do' });
    return { answer: { kind: invocation.kind, row, dispatched: [] } };
  }
  if (!turnsOn(config, governs)) {
    const why = `${repo}'s ${CONFIG_PATH} does not turn ${governs} on`;
    ctx.log('dispatch-refused', { level: 'info', ...about, kind: invocation.kind, reason: why });
    return { answer: { kind: invocation.kind, row, refusal: why, dispatched: [] } };
  }
  if (row === 'not-planned' || row === 'claimed') {
    // The line's comment, where this turn posted it, is the row's comment.
    /** @type {boolean} */
    let commented = lineSaid && settled.outcome === 'commented';
    /** @type {{ removed: string[], failed: string[] } | undefined} */
    let unreadied = earlier;
    if (takeOff.length > 0) {
      unreadied = { removed: [], failed: [] };
      /** @type {Array<{ label: string, error: string }>} */
      const stayed = [];
      for (const label of takeOff) {
        try {
          await reader.removeLabel(issue, label);
          unreadied.removed.push(label);
        } catch (error) {
          stayed.push({ label, error: messageOf(error) });
          unreadied.failed.push(label);
        }
      }
      // Pickup needs every ready label, so one that came off holds the ticket.
      const held = unreadied.removed.length > 0;
      for (const { label, error } of stayed) {
        ctx.log('dispatch-unblocked-unlabelled', { level: 'error', ...about, label, error, reason: held ? 'a ready label stayed on a ticket whose blocker closed as not planned; another came off, so pickup does not start it' : 'a ready label stayed on a ticket whose blocker closed as not planned, and none came off, so pickup can still start it' });
      }
    }
    const notPlanned = row === 'not-planned' ? notPlannedComment(invocation, ctx.prompts, { blocked: status.open && status.holds.includes('blocker'), ...(unreadied === undefined ? {} : { unreadied }) }) : null;
    if (notPlanned !== null && !lineSaid) {
      await reader.comment(issue, notPlanned);
      commented = true;
    }
    if (!ticket.labels.includes(config.labels.claim)) {
      ctx.log('dispatch-unblocked', { ...about, outcome: lineSaid ? `the line's comment stands for the row's: ${settled?.outcome}` : 'commented', ...(unreadied === undefined ? {} : { unreadied }) });
      return { answer: { kind: invocation.kind, row, commented, dispatched: [] } };
    }
    // The claimed ticket's session: the newest dispatch marker names it,
    // whatever its age, since the session builds for as long as it takes.
    const session = lastDispatch(await reader.comments(issue), ctx.now(), Infinity)?.sessionUrl ?? null;
    if (session === null) {
      ctx.log('dispatch-unblocked', { ...about, outcome: 'nobody told: no dispatch marker on the ticket names its session' });
      return { answer: { kind: invocation.kind, row, commented, messaged: null, dispatched: [] } };
    }
    const text = notPlanned ?? unblockedMessage(invocation, ctx.prompts);
    /** @type {import('./deliveries.mjs').Delivery} */
    let told;
    let loginStored = false;
    try {
      told = await ctx.delivery().deliver({ session }, text, { source: GITHUB_SOURCE, on: [issue] });
    } finally {
      loginStored = await ctx.storeLogin();
    }
    ctx.log('dispatch-unblocked', { ...about, session, outcome: told.ok ? 'messaged' : told.refused ? 'its session is archived' : 'not messaged' });
    return { answer: { kind: invocation.kind, row, commented, messaged: told, dispatched: [], loginStored } };
  }
  // The spec session's holds: a thread that cannot be read fails the
  // turn, never taken for no marker.
  /** Why no spec work starts on a not-ready ticket, or null. @returns {Promise<string | null>} */
  const specHeld = async () => {
    const thread = await reader.allComments(issue);
    const at = ctx.now();
    if (mayStartSpec(thread, at)) return null;
    return specHold(thread, at) === 'unreadied' ? UNREADIED_HELD : 'dispatched inside the window';
  };
  const spec = () => ({ prompt: specPrompt({ fire: invocation, title: ticket.title, labels: config.labels, prompts: ctx.prompts }), sessionName: sessionName(issue, ticket.title) });
  // A not-ready ticket whose body names its owner: the owner rewrites its
  // own spec and keeps the ticket. The spec session is the message's
  // fallback, for an owner archived, and counts against DispatchCap as the
  // launch it replaces does, so with a cap of 0 the owner is still asked
  // and nothing starts in its place.
  const owner = row === 'not-ready' ? sessionNamedIn(ticket.body) : null;
  if (owner !== null) {
    const held = await specHeld();
    if (held !== null) {
      ctx.log('dispatch-unblocked', { ...about, owner, outcome: `not started: ${held}` });
      return { answer: { kind: invocation.kind, row, messaged: null, dispatched: [] } };
    }
    const fallback = ctx.cap === 0 ? undefined : { ...spec(), issue };
    /** @type {import('./deliveries.mjs').Delivery} */
    let told;
    let loginStored = false;
    try {
      told = await ctx.delivery().deliver({ session: owner }, ownerSpecMessage(invocation, ctx.prompts, config.labels), { source: GITHUB_SOURCE, on: [issue], fallback });
      // An owner that took it is marked as a spec session's launch is, so
      // the claimed row finds the session that builds, and the sweep stays
      // off the ticket inside the window.
      if (told.ok) await reader.comment(issue, dispatchMarker({ at: new Date(ctx.now()).toISOString(), sessionUrl: owner }));
    } finally {
      loginStored = await ctx.storeLogin();
    }
    const outcome = ownerOutcome(told, `no spec session starts: ${CAP_ZERO_REASON}`);
    ctx.log('dispatch-unblocked', { ...about, owner, outcome });
    return { answer: { kind: invocation.kind, row, messaged: told, dispatched: [], loginStored } };
  }
  /** @type {import('./turn.mjs').PlannedLaunch[]} */
  const launches = [];
  if (ctx.cap === 0) {
    ctx.log('dispatch-unblocked', { ...about, outcome: 'not started', reason: CAP_ZERO_REASON });
  } else if (row === 'ready') {
    // As pickup does: the selection's own checks, the window included.
    /** @type {import('../scripts/lib/dispatch-router.mjs').Outsider[]} */
    const outsiders = [];
    const planned = await planSchedule({ sources: [{ repo, reader, labels: config.labels, prompts: ctx.prompts }], cap: 1, now: ctx.now(), only: [issue], outsiders });
    for (const d of planned) launches.push({ repo: d.repo, issue, claim: true, holdsRepo: true, asked: { prompt: readyPrompt(d.prompt, invocation, ctx.prompts), sessionName: d.sessionName, model: DEFAULT_MODEL } });
    const outsider = outsiders[0];
    ctx.log('dispatch-unblocked', { ...about, ...(outsider === undefined
      ? { outcome: planned.length === 0 ? 'not selectable: dispatched inside the window, blocked, or no longer ready' : 'picking up' }
      : { outcome: 'skipped', reason: outsiderReason(outsider) }) });
  } else {
    // The spec session is not claimed: its marker keeps the sweep off the
    // ticket inside the window, and the claim it adds before it builds
    // keeps it off after. A ticket governor unreadied on a not-planned
    // close waits for a person's answer first.
    const held = await specHeld();
    if (held !== null) {
      ctx.log('dispatch-unblocked', { ...about, outcome: `not started: ${held}` });
    } else {
      launches.push({ repo, issue, claim: false, holdsRepo: true, asked: { ...spec(), model: DEFAULT_MODEL } });
      ctx.log('dispatch-unblocked', { ...about, outcome: 'starting a spec session' });
    }
  }
  return { launches, unread: [], result: { row } };
};
