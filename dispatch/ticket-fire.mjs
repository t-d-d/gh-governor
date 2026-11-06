/**
 * A ticket fire: a comment on an issue, the issue closed or reopened, or
 * its body edited, which the receiver queued in place of the spec owner's message because
 * the issue carries the repo's claim label, or the hook table could not
 * say which label that is (dispatch/webhook/route.mjs). The receiver holds
 * no token, so the builders are found here.
 *
 * On an unclaimed ticket the spec owner is sent the fire's text as its
 * message was before, and nothing is read from GitHub. On a claimed ticket
 * the spec owner and each builder the one lookup finds
 * (dispatch/builders.mjs) are sent it, each told who holds both roles and
 * which it holds. A session never hears its own signed post. A builder
 * whose PR's merge closed the ticket hears the close through its PR, and
 * not again from the ticket. A comment governor's App posted is no ticket
 * fire: the turn that posted it tells the roles itself (dispatch/told.mjs).
 *
 * Every message is a notice: it asks nothing beyond the recipient's own
 * part. The spec owner acts on a remark that changes what counts as done,
 * by editing the body. The builder acts on a remark about the build, and
 * never edits the body. A body edit tells the spec owner the edit may be
 * its own, and the builder that the spec changed.
 *
 * A `dispatched` ticket fire, governor's dispatch comment queued before
 * the relay dropped governor's comments, still reaches the spec owner and
 * the builder it displaced, as the posting turn now tells them
 * (`builderChangeSends`, dispatch/told.mjs). A `closingPr` fire is a PR
 * that may have come to close a ticket: where a claimed ticket's builder is
 * another session, governor posts that dispatch comment and tells both
 * itself ({@link planClosingPr}).
 */

import { GITHUB_SOURCE } from './deliveries.mjs';
import { relayOf } from './trust.mjs';
import { buildersOf } from './builders.mjs';
import { fireRepoOf } from './repos.mjs';
import { closedBy } from './pr-body.mjs';
import { dispatchMarker } from './webhook/fire.mjs';
import { relayedBody, sameSession, sessionId } from './webhook/subscribe.mjs';
import { EDIT_BUILDER, EDIT_SPEC_OWNER } from './webhook/mention.mjs';
import { builderChangeSends, rolesText, specOwnerOf, tellBuilderChange } from './told.mjs';

/** @typedef {import('./told.mjs').TicketRole} TicketRole */



/**
 * A ticket fire's answer: the turn starts nothing.
 *
 * @param {import('./webhook/fire.mjs').TicketFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planTicket = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { issue, text, event, state, labels, poster, closing } = invocation;
  const config = ctx.configOf(repo);
  const owner = invocation.owner ?? null;
  const claimed = labels.includes(config.labels.claim) && config.labels.claim !== '';
  const about = { repo, issue, change: event, state, claimed };
  /** @type {Array<{ session: string, text: string, role: TicketRole | null, owns: number[] }>} */
  const sends = [];
  /** The sessions left out, and why, for the log. @type {string[]} */
  const skipped = [];
  const own = (/** @type {string} */ session) => poster !== undefined && sameSession(session, poster);
  // What a body edit tells each role, under what happened.
  const edit = (/** @type {TicketRole} */ role) => (event !== 'edit' ? '' : `\n\n${[
    ...(role === 'builder' ? [] : [EDIT_SPEC_OWNER]),
    ...(role === 'spec owner' ? [] : [EDIT_BUILDER]),
  ].join('\n')}`);
  if (event === 'dispatched') {
    // A dispatch comment's fire queued before the relay dropped governor's
    // comments: the builder it names never hears it.
    const builder = invocation.builder ?? null;
    const displaced = invocation.displaced ?? null;
    const change = builderChangeSends({ issue, text, owner, builder, displaced });
    skipped.push(...change.skipped);
    for (const send of change.sends) sends.push({ session: send.session, text: send.text, role: send.role, owns: [] });
    Object.assign(about, { builder, displaced });
  } else if (!claimed) {
    // The spec owner's message as the receiver queued it before, with no read.
    if (owner !== null && own(owner)) skipped.push(`${sessionId(owner)}'s own post`);
    else if (owner !== null) sends.push({ session: owner, text: `${text}${edit('spec owner')}`, role: null, owns: [] });
  } else {
    const relay = relayOf(config);
    const reader = await ctx.readerFor(repo);
    // A read that fails fails the turn: it never reads as no builder.
    const found = await buildersOf({ reader, ownerOf: (pr) => ctx.delivery().ownerOf(pr), issue, ticket: { state, labels }, claim: config.labels.claim, relay, owner });
    const builders = found.sessions;
    const both = owner !== null && builders.some((b) => sameSession(b, owner));
    // A builder whose PR's merge closed the ticket heard the merge through its PR.
    const throughPr = event === 'close' && state === 'closed' && found.by === 'merged PR';
    const say = (/** @type {TicketRole} */ role) => `${text}${edit(role)}\n\n${rolesText({ issue, owner, builders, role })}`;
    if (owner !== null) {
      if (own(owner)) skipped.push(`${sessionId(owner)}'s own post`);
      else sends.push({ session: owner, text: say(both ? 'spec owner and builder' : 'spec owner'), role: both ? 'spec owner and builder' : 'spec owner', owns: [] });
    }
    for (const builder of builders) {
      if (owner !== null && sameSession(builder, owner)) continue;
      if (throughPr) skipped.push(`${sessionId(builder)}, which heard the merge that closed it through its PR`);
      else if (own(builder)) skipped.push(`${sessionId(builder)}'s own post`);
      else sends.push({ session: builder, text: say('builder'), role: 'builder', owns: found.owns[builder] ?? [] });
    }
    Object.assign(about, { builders, builder: found.by });
  }
  if (sends.length === 0) {
    ctx.log('dispatch-ticket', { ...about, outcome: 'nobody told', ...(skipped.length === 0 ? { reason: 'no role on the ticket is held by a session' } : { skipped }) });
    return { answer: { kind: invocation.kind, messaged: null, dispatched: [] } };
  }
  /** @type {import('./deliveries.mjs').Delivery[]} */
  const sent = [];
  let loginStored = false;
  try {
    for (const { session, text: told, role, owns } of sends) {
      const delivered = await ctx.delivery().deliver({ session }, told, {
        source: GITHUB_SOURCE,
        on: [issue],
        // A displaced builder has nothing left on the ticket: its standing
        // line asks it to sign off where nothing else of its is open.
        closing: closing === true || (event === 'dispatched' && role === 'builder'),
        // The spec owner hears the ticket as its filer does, so an
        // archived one with no fallback is dropped from its subscribe line.
        dropFrom: role === 'builder' ? [] : [issue],
        owns,
      });
      sent.push(delivered);
      ctx.log('dispatch-ticket', { ...about, session, role: role ?? 'spec owner', ...(owns.length === 0 ? {} : { prs: owns }), outcome: delivered.ok ? 'messaged' : delivered.refused ? 'its session is archived' : 'not messaged', ...(skipped.length === 0 ? {} : { skipped }) });
    }
  } finally {
    loginStored = await ctx.storeLogin();
  }
  // The turn's answer: a send that failed, so the turn says so, else one
  // that took it, else the last refusal.
  const messaged = sent.find((t) => !t.ok && !t.refused) ?? sent.find((t) => t.ok) ?? /** @type {import('./deliveries.mjs').Delivery} */ (sent.at(-1));
  return { answer: { kind: invocation.kind, messaged, dispatched: [], loginStored } };
};

/**
 * A PR that may have come to close a ticket (`closingPr`): for each claimed
 * open ticket its body closes, where the PR's owner, as `ownerOf` finds it,
 * is not among the ticket's builders without this PR, governor posts its
 * dispatch comment naming the owner. Where the builder it replaces was
 * found by the newest dispatch comment or the owner link, the comment names
 * that builder as displaced. The turn then tells the spec owner, and the
 * displaced builder, which is asked to stop ({@link tellBuilderChange}),
 * since the relay sends governor's comment to nobody. Where another
 * open PR closes the ticket, both owners build it, and nobody is displaced.
 * Only a dispatch comment governor's App posted names a builder, as the
 * lookup reads it. A read or a comment that fails fails the turn.
 *
 * @param {import('./webhook/fire.mjs').ClosingPrFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planClosingPr = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { pr } = invocation;
  const config = ctx.configOf(repo);
  const claim = config.labels.claim;
  /** @type {number[]} */
  const announced = [];
  const answer = () => ({ answer: { kind: invocation.kind, dispatched: [], announced } });
  const relay = relayOf(config);
  const reader = await ctx.readerFor(repo);
  const pull = await reader.pull(pr);
  // The receiver judged the author by the hook-table item, which may lag
  // the file: a body trust.relay leaves out closes nothing here.
  const tickets = closedBy(relayedBody(pull, relay), repo);
  if (!pull.open || tickets.length === 0) {
    ctx.log('dispatch-builder', { repo, pr, outcome: 'nothing announced', reason: pull.open ? 'its body closes no ticket, or trust.relay leaves its author out' : 'it is closed' });
    return answer();
  }
  const owners = ctx.delivery();
  const { session } = await owners.ownerOf(pr);
  if (session === null) {
    ctx.log('dispatch-builder', { repo, pr, outcome: 'nothing announced', reason: 'no session holds it' });
    return answer();
  }
  // The ticket's builders as they were without this PR.
  const without = {
    openClosing: async (/** @type {number} */ n) => (await reader.openClosing(n)).filter((p) => p.number !== pr),
    closure: (/** @type {number} */ n) => reader.closure(n),
    allComments: (/** @type {number} */ n) => reader.allComments(n),
  };
  // A send may refresh the login, which is stored once, whatever the loop
  // threw.
  let loginStored = false;
  try {
    for (const issue of tickets) {
      const ticket = await reader.ticket(issue);
      const at = { repo, pr, issue, session };
      if (ticket.pull || ticket.state !== 'open' || claim === '' || !ticket.labels.includes(claim)) {
        ctx.log('dispatch-builder', { ...at, outcome: 'nothing announced', reason: 'the ticket is not an open claimed issue' });
        continue;
      }
      const found = await buildersOf({ reader: without, ownerOf: (n) => owners.ownerOf(n), issue, ticket: { ...ticket, association: ticket.association ?? 'NONE' }, claim, relay });
      if (found.sessions.some((s) => sameSession(s, session))) {
        ctx.log('dispatch-builder', { ...at, outcome: 'nothing announced', reason: `it builds the ticket already, by its ${found.by}` });
        continue;
      }
      const displaced = found.by === 'dispatch comment' || found.by === 'owner link' ? found.sessions[0] ?? null : null;
      await reader.comment(issue, dispatchMarker({ at: new Date(ctx.now()).toISOString(), sessionUrl: session, displaced }));
      announced.push(issue);
      ctx.log('dispatch-builder', { ...at, displaced, outcome: 'announced the new builder on the ticket' });
      // The comment is a record for people: this turn tells the spec owner,
      // and the builder it displaced, itself.
      await tellBuilderChange({
        deliver: (target, text, options) => owners.deliver({ session: target }, text, { source: GITHUB_SOURCE, ...options }),
        log: ctx.log,
        repo,
        issue,
        title: ticket.title,
        url: `https://github.com/${repo}/issues/${issue}`,
        owner: specOwnerOf(ticket, relay),
        builder: session,
        displaced,
      });
    }
  } finally {
    if (announced.length > 0) loginStored = await ctx.storeLogin();
  }
  return { answer: { kind: invocation.kind, dispatched: [], announced, loginStored } };
};
