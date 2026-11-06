/**
 * An unblocked fire: a ticket whose blocker closed, in the ticket's own repo,
 * under that repo's config. The turn takes the first row of the table that
 * fits (dispatch/unblocked.mjs), and the repo's switch for that row decides
 * whether it acts. The rows that comment or message start nothing and answer
 * the turn. The claimed row asks the ticket's builders, and sends its spec
 * owner a notice naming them. The ready row picks the ticket up as pickup
 * does, and sends its spec owner a notice naming the builder it started.
 * The not-ready row messages the owner its body names, with a spec session
 * as the fallback, or starts a spec session where it names none.
 *
 * It lives apart from unblocked.mjs because it settles a relative
 * `Blocked until:` line and reports an unreadable one (dispatch/waits.mjs),
 * and waits.mjs imports unblocked.mjs.
 */

import { DEFAULT_MODEL, sessionName } from '../scripts/lib/dispatch-prompt.mjs';
import { outsiderReason, planSchedule, strangerReason } from '../scripts/lib/dispatch-router.mjs';
import { mayStartSpec, ticketStatus, unreadableOf } from '../scripts/lib/ready-work.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { GITHUB_SOURCE } from './deliveries.mjs';
import { CONFIG_PATH, turnsOn } from './repo-config.mjs';
import { fireRepoOf } from './repos.mjs';
import { CAP_ZERO_REASON } from './launch-plan.mjs';
import { ROW_SWITCH, UNREADIED_HELD, mayBeUnreadied, notPlannedComment, ownerOutcome, ownerSpecMessage, readyPrompt, readyToTakeOff, rowOf, specPrompt, unblockedMessage, unblockedNotice, unreadiedSince } from './unblocked.mjs';
import { relativeAtClose, reportUnreadable } from './waits.mjs';
import { reportUncounted, reportUnlooked, reportUnstarted, reportUntasked } from './uncounted.mjs';
import { byOf, failedLaunchesOf, failedReason } from './pickup.mjs';
import { authorKind, autoOf, lets, relayOf, startOf } from './trust.mjs';
import { buildersOf } from './builders.mjs';
import { relayedBody, sameSession, sessionNamedIn } from './webhook/subscribe.mjs';

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
  // A relative `Blocked until:` line on this close is settled first,
  // whatever the switches say: rewritten into its date, or, on a close
  // that was not completed, left with one comment that replaces the
  // not-planned row's (dispatch/waits.mjs). Only a ticket ready or not
  // ready by its labels is then held; a claimed or excluded one takes its
  // own row, so a claimed ticket's session still hears the close. One
  // status read says both whether the line holds the ticket and whether
  // another open issue still blocks it. A read taken once, with no retry,
  // may still count the blocker that just closed (`readUnblocked`), so it
  // (`retried: false`) never says the ticket is still blocked.
  /** @param {{ state: string, labels: readonly string[], openBlockers?: number, wait?: import('../scripts/lib/ready-work.mjs').Wait }} read @param {Parameters<typeof ticketStatus>[1]['blockers']} [blockers] @param {boolean} [retried] */
  const settleRelative = (read, blockers, retried = true) => {
    const status = statusOf(read, blockers);
    const holds = status.open && status.holds.includes('line');
    const blocked = retried && status.open && status.holds.includes('blocker');
    return relativeAtClose({ reader, repo, ticket: read, fire: invocation, prompts: ctx.prompts, now: ctx.now(), log: ctx.log, holds, blocked });
  };
  if (!turnsOn(config, 'pickup') && !turnsOn(config, 'unblocked')) {
    const settled = await settleRelative(await reader.ticket(issue), undefined, false);
    const why = `${repo}'s ${CONFIG_PATH} turns neither pickup nor unblocked on`;
    ctx.log('dispatch-refused', { level: 'info', repo, kind: invocation.kind, issue, reason: why, ...(settled === null ? {} : { relative: settled.outcome }) });
    return { answer: { kind: invocation.kind, refusal: why, dispatched: [] } };
  }
  const read = await readUnblocked(reader, issue, ctx.sleep, statusOf);
  const { blockers, reads } = read;
  let { ticket } = read;
  const settled = await settleRelative(ticket, blockers);
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
    // Governor's comment on a claimed ticket reaches its builders as any
    // comment does (dispatch/ticket-fire.mjs), under subscribeMessages, so
    // a builder hears the close once, in the comment's words. That fire is
    // judged by the ticket's author under trust.relay, so where the relay
    // leaves the author out, the builders are messaged here instead.
    if (commented && turnsOn(config, 'subscribeMessages') && lets(relayOf(config), ticket)) {
      ctx.log('dispatch-unblocked', { ...about, outcome: "commented: the ticket's spec owner and builders hear governor's comment", ...(unreadied === undefined ? {} : { unreadied }) });
      return { answer: { kind: invocation.kind, row, commented, messaged: null, dispatched: [] } };
    }
    // The claimed ticket's builders, found one way (dispatch/builders.mjs):
    // the owner of each open PR that closes it, else the session the newest
    // dispatch comment names, else the body's owner link, which counts only
    // where the repo's trust.relay lets the body's author in. A read that
    // fails fails the turn.
    const relay = relayOf(config);
    const found = await buildersOf({ reader, ownerOf: (pr) => ctx.delivery().ownerOf(pr), issue, ticket, claim: config.labels.claim, relay });
    if (found.sessions.length === 0) {
      ctx.log('dispatch-unblocked', { ...about, outcome: 'nobody told: no open PR closing it, and no dispatch marker or owner link on the ticket names its session' });
      return { answer: { kind: invocation.kind, row, commented, messaged: null, dispatched: [] } };
    }
    // The spec owner, the session the body's owner link names. Where it is
    // also a builder it gets the ask alone; otherwise a notice.
    const owner = sessionNamedIn(relayedBody(ticket, relay));
    const noticed = owner !== null && !found.sessions.some((s) => sameSession(s, owner)) ? owner : null;
    const text = notPlanned ?? unblockedMessage(invocation, ctx.prompts);
    /** @type {import('./deliveries.mjs').Delivery[]} */
    const sent = [];
    /** @type {{ asked: string[], archived: string[], unreached: string[] }} */
    const asks = { asked: [], archived: [], unreached: [] };
    let loginStored = false;
    /** What came of a send, for the log. @param {import('./deliveries.mjs').Delivery} told */
    const outcomeOf = (told) => (told.ok ? 'messaged' : told.refused ? 'its session is archived' : 'not messaged');
    try {
      for (const session of found.sessions) {
        // A PR's builder that answers archived hands the message to the live
        // session on its PRs' head branches, as a PR's owner does.
        const owns = found.owns[session] ?? [];
        const told = await ctx.delivery().deliver({ session }, text, { source: GITHUB_SOURCE, on: [issue], owns });
        sent.push(told);
        const forwarded = told.fallback?.outcome === 'forwarded';
        if (told.ok || forwarded) asks.asked.push(forwarded ? told.fallback?.sessionUrl ?? session : session);
        else if (told.refused) asks.archived.push(session);
        else asks.unreached.push(session);
        ctx.log('dispatch-unblocked', { ...about, session, builder: found.by, ...(owns.length === 0 ? {} : { prs: owns }), outcome: outcomeOf(told) });
      }
      // A refused builder leaves the role vacant: its ask goes to nobody,
      // and the spec owner is not asked in its place.
      if (asks.asked.length === 0 && asks.archived.length > 0) {
        ctx.log('dispatch-unblocked', { ...about, builders: found.sessions, outcome: 'no builder took the ask, so it goes to nobody: the builder role is vacant' });
      }
      // The spec owner hears the close as a notice that asks nothing and
      // names the builders that were asked. A notice that fails is logged,
      // and does not fail the turn: the ask is what the turn owes.
      if (noticed !== null) {
        const told = await ctx.delivery().deliver({ session: noticed }, unblockedNotice(invocation, { ...asks, what: row === 'claimed' ? 'what merged' : 'this close' }), { source: GITHUB_SOURCE, on: [issue] });
        ctx.log('dispatch-unblocked', { ...about, session: noticed, role: 'spec owner', notice: true, ...(told.ok || told.refused ? {} : { level: 'error' }), outcome: outcomeOf(told), ...(told.error === null ? {} : { error: told.error }) });
      }
    } finally {
      loginStored = await ctx.storeLogin();
    }
    // The turn's answer: a send to a builder that failed, so the turn says
    // so, else one that took it, else the last refusal.
    const messaged = sent.find((t) => !t.ok && !t.refused) ?? sent.find((t) => t.ok) ?? /** @type {import('./deliveries.mjs').Delivery} */ (sent.at(-1));
    return { answer: { kind: invocation.kind, row, commented, messaged, dispatched: [], loginStored } };
  }
  // A not-ready ticket's spec work starts with no person choosing the
  // ticket, so only for an author the repo's trust.auto lets in. Anyone
  // may open an issue and link it as blocked by a real ticket.
  const auto = autoOf(config);
  if (row === 'not-ready' && !lets(auto, ticket)) {
    ctx.log('dispatch-unblocked', { ...about, level: 'info', outcome: `nothing starts and nothing is sent: opened by a ${authorKind(ticket)} author, whom trust.auto (${auto.join(', ') || 'empty'}) does not let in` });
    return { answer: { kind: invocation.kind, row, dispatched: [] } };
  }
  // The spec session's hold: governor's not-planned close, unanswered. A
  // thread that cannot be read fails the turn, never taken for no hold.
  /** Why no spec work starts on a not-ready ticket, or null. @returns {Promise<string | null>} */
  const specHeld = async () => (mayStartSpec(await reader.allComments(issue)) ? null : UNREADIED_HELD);
  const spec = () => ({ prompt: specPrompt({ fire: invocation, title: ticket.title, labels: config.labels, prompts: ctx.prompts }), sessionName: sessionName(issue, ticket.title) });
  // A not-ready ticket whose body names its owner: the owner rewrites its
  // own spec and keeps the ticket, and nothing is posted on it. The spec
  // session is the message's fallback, for an owner archived, written into
  // the body in the owner's place, and counts against DispatchCap as the
  // launch it replaces does, so with a cap of 0 the owner is still asked
  // and nothing starts in its place.
  // The owner counts only where the repo's trust.relay lets the body's
  // author in: a session link in a stranger's body routes nothing.
  const owner = row === 'not-ready' ? sessionNamedIn(relayedBody(ticket, relayOf(config))) : null;
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
      told = await ctx.delivery().deliver({ session: owner }, ownerSpecMessage(invocation, ctx.prompts, config.labels), { source: GITHUB_SOURCE, on: [issue], fallback, spec: true });
    } finally {
      loginStored = await ctx.storeLogin();
    }
    const outcome = ownerOutcome(told, `no spec session starts: ${CAP_ZERO_REASON}`);
    ctx.log('dispatch-unblocked', { ...about, owner, outcome });
    return { answer: { kind: invocation.kind, row, messaged: told, dispatched: [], loginStored } };
  }
  /** @type {import('./turn.mjs').PlannedLaunch[]} */
  const launches = [];
  // A ready ticket's spec owner hears, under unblocked, that a builder was
  // started, as a notice that asks nothing. Nothing is sent where the
  // launch started nothing.
  const specOwner = row === 'ready' && turnsOn(config, 'unblocked') ? sessionNamedIn(relayedBody(ticket, relayOf(config))) : null;
  /** @type {import('./launch-plan.mjs').LaunchablePlan['done']} */
  const done = specOwner === null ? undefined : async ({ dispatched }) => {
    const builder = dispatched.find((d) => d.issue === issue && d.repo === repo && d.outcome !== 'failed');
    if (builder === undefined) {
      ctx.log('dispatch-unblocked', { ...about, session: specOwner, role: 'spec owner', notice: true, outcome: 'no notice: no builder started' });
      return;
    }
    if (builder.sessionUrl !== null && sameSession(builder.sessionUrl, specOwner)) return;
    const told = await ctx.delivery().deliver({ session: specOwner }, unblockedNotice(invocation, { started: builder.sessionUrl }), { source: GITHUB_SOURCE, on: [issue] });
    ctx.log('dispatch-unblocked', { ...about, session: specOwner, role: 'spec owner', notice: true, ...(told.ok || told.refused ? {} : { level: 'error' }), outcome: told.ok ? 'messaged' : told.refused ? 'its session is archived' : 'not messaged', ...(told.error === null ? {} : { error: told.error }) });
  };
  if (ctx.cap === 0) {
    ctx.log('dispatch-unblocked', { ...about, outcome: 'not started', reason: CAP_ZERO_REASON });
  } else if (row === 'ready') {
    // As pickup does: the selection's own checks.
    /** @type {import('../scripts/lib/dispatch-router.mjs').Outsider[]} */
    const outsiders = [];
    /** @type {import('../scripts/lib/dispatch-router.mjs').Stranger[]} */
    const strangers = [];
    /** @type {import('./start.mjs').Unstarted[]} */
    const unstarted = [];
    /** @type {import('./start.mjs').Unlooked[]} */
    const unlooked = [];
    /** @type {import('../scripts/lib/dispatch-router.mjs').HeldFailed[]} */
    const heldFailed = [];
    // A ticket whose last launch started nothing is held for the hour; a
    // read that fails refuses the fire, never reads as no record.
    const now = ctx.now();
    const failed = await failedLaunchesOf(ctx.state, repo, now);
    const planned = await planSchedule({ sources: [{ repo, reader, labels: config.labels, by: byOf(config), start: startOf(config), prompts: ctx.prompts, signOff: turnsOn(config, 'signOff'), failed }], cap: 1, now, only: [issue], outsiders, strangers, unstarted, unlooked, heldFailed });
    for (const held of heldFailed) ctx.log('dispatch-pickup', { level: 'info', repo: held.repo, issue: held.issue, outcome: 'skipped', reason: failedReason(held.until) });
    for (const d of planned) launches.push({ repo: d.repo, issue, claim: true, holdsRepo: true, asked: { prompt: readyPrompt(d.prompt, invocation, ctx.prompts), sessionName: d.sessionName, model: DEFAULT_MODEL } });
    const [outsider] = outsiders;
    const [stranger] = strangers;
    const [refused] = unstarted;
    const [unknown] = unlooked;
    const [failedHold] = heldFailed;
    if (refused !== undefined) await reportUnstarted({ reader, unstarted: refused, what: 'readied', event: 'dispatch-unblocked', log: (event, context) => ctx.log(event, { ...about, ...context }) });
    else if (unknown !== undefined) reportUnlooked({ unlooked: unknown, event: 'dispatch-unblocked', log: (event, context) => ctx.log(event, { ...about, ...context }) });
    else ctx.log('dispatch-unblocked', { ...about, ...(failedHold !== undefined
      ? { outcome: 'skipped', reason: failedReason(failedHold.until) }
      : outsider !== undefined
        ? { outcome: 'skipped', reason: outsiderReason(outsider) }
        : stranger !== undefined
          ? { outcome: 'skipped', reason: strangerReason(stranger) }
          : { outcome: planned.length === 0 ? 'not selectable: blocked, or no longer ready' : 'picking up' }) });
    if (outsider !== undefined) await reportUncounted({ reader, outsider, log: ctx.log });
    if (stranger !== undefined) await reportUntasked({ reader, stranger, what: 'readied', ready: config.labels.ready, start: startOf(config), event: 'dispatch-unblocked', log: (event, context) => ctx.log(event, { ...about, ...context }) });
  } else {
    // The spec session is not claimed: the ticket is not ready, so the
    // sweep leaves it, and the claim it adds before it builds keeps it off
    // after. Its launch writes it into the body as the ticket's owner
    // (dispatch/launch-plan.mjs), where a later close finds it. A ticket
    // governor unreadied on a not-planned close waits for a person's
    // answer first.
    const held = await specHeld();
    if (held !== null) {
      ctx.log('dispatch-unblocked', { ...about, outcome: `not started: ${held}` });
    } else {
      launches.push({ repo, issue, claim: false, holdsRepo: true, asked: { ...spec(), model: DEFAULT_MODEL } });
      ctx.log('dispatch-unblocked', { ...about, outcome: 'starting a spec session' });
    }
  }
  return { launches, unread: [], result: { row }, ...(done === undefined ? {} : { done }) };
};
