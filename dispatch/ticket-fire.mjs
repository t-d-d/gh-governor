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
 * not again from the ticket. Governor's deploy comment reaches both roles
 * like any comment, and the shipping turn sends no PR deploy message to a
 * session that holds a role on the ticket (dispatch/turn.mjs).
 *
 * Every message is a notice: it asks nothing beyond the recipient's own
 * part. The spec owner acts on a remark that changes what counts as done,
 * by editing the body. The builder acts on a remark about the build, and
 * never edits the body. A body edit tells the spec owner the edit may be
 * its own, and the builder that the spec changed.
 *
 * Governor's own dispatch comment, a change of builder, is a ticket fire
 * too (`dispatched`). It reaches the spec owner, and the builder it
 * displaced, which is asked to stop and sign off; never the builder it
 * names. Nothing is read to send it. A `closingPr` fire is a PR that may
 * have come to close a ticket: where a claimed ticket's builder is another
 * session, governor posts that dispatch comment ({@link planClosingPr}).
 */

import { GITHUB_SOURCE } from './deliveries.mjs';
import { relayOf } from './trust.mjs';
import { buildersOf } from './builders.mjs';
import { fireRepoOf } from './repos.mjs';
import { closedBy } from './pr-body.mjs';
import { dispatchMarker } from './webhook/fire.mjs';
import { relayedBody, sameSession, sessionId } from './webhook/subscribe.mjs';
import { EDIT_BUILDER, EDIT_SPEC_OWNER } from './webhook/mention.mjs';

/** @typedef {'spec owner' | 'builder' | 'spec owner and builder'} TicketRole */

/** @param {string[]} items */
const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * What a message about a ticket adds under what happened: who holds each
 * role, which one the recipient holds, and what that role does with it.
 *
 * @param {{ issue: number, owner: string | null, builders: readonly string[], role: TicketRole }} args
 * @returns {string}
 */
export const rolesText = ({ issue, owner, builders, role }) => {
  const spec = owner === null ? 'a person, as no session link ends its body' : owner;
  const built = builders.length === 0 ? 'none governor can find' : listed([...builders]);
  const lines = [
    `Roles on #${issue}: its spec owner is ${spec}; its builder is ${built}. You are its ${role === 'spec owner and builder' ? 'spec owner and its builder' : role}. This is a notice: it asks nothing of you beyond your own role's part.`,
  ];
  if (role !== 'builder') lines.push('As its spec owner you write its body: where a remark changes what counts as done, edit the body to say so.');
  if (role !== 'spec owner') lines.push('As its builder you build it, on its branch and PR, and do not edit its body: act on what bears on the build, and record where your work differs from the body in your PR description.');
  return lines.join('\n');
};

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
    // Governor's dispatch comment: the builder it names never hears it.
    const builder = invocation.builder ?? null;
    const displaced = invocation.displaced ?? null;
    const named = (/** @type {string | null} */ session) => session !== null && builder !== null && sameSession(session, builder);
    const gone = displaced !== null && !named(displaced) ? displaced : null;
    const instead = builder ?? 'another session';
    const stops = `You no longer build #${issue}: ${instead} does.`;
    if (owner !== null && named(owner)) {
      skipped.push(`${sessionId(owner)}, the builder it names`);
    } else if (owner !== null) {
      const ownerBuilt = gone !== null && sameSession(gone, owner);
      const lines = [text, '', rolesText({ issue, owner, builders: builder === null ? [] : [builder], role: 'spec owner' })];
      if (ownerBuilt) lines.push(`${stops} Stop building it, and leave its branch and PR to that session; you remain its spec owner.`);
      sends.push({ session: owner, text: lines.join('\n'), role: 'spec owner', owns: [] });
    }
    if (gone !== null && !(owner !== null && sameSession(gone, owner))) {
      sends.push({
        session: gone,
        text: `${text}\n\n${stops} Stop your work on it, and sign off unless you know a reason not to. You hear nothing more from the ticket.`,
        role: 'builder',
        owns: [],
      });
    }
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
 * that builder as displaced, and the relay asks it to stop. Where another
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
  }
  return answer();
};
