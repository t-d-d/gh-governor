/**
 * A ticket fire: a comment on an issue, or the issue closed or reopened,
 * which the receiver queued in place of the spec owner's message because
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
 * never edits the body.
 */

import { GITHUB_SOURCE } from './deliveries.mjs';
import { relayOf } from './trust.mjs';
import { buildersOf } from './builders.mjs';
import { fireRepoOf } from './repos.mjs';
import { sameSession, sessionId } from './webhook/subscribe.mjs';

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
  if (!claimed) {
    // The spec owner's message as the receiver queued it before, with no read.
    if (owner !== null && own(owner)) skipped.push(`${sessionId(owner)}'s own post`);
    else if (owner !== null) sends.push({ session: owner, text, role: null, owns: [] });
  } else {
    const relay = relayOf(config);
    const reader = await ctx.readerFor(repo);
    // A read that fails fails the turn: it never reads as no builder.
    const found = await buildersOf({ reader, ownerOf: (pr) => ctx.delivery().ownerOf(pr), issue, ticket: { state, labels }, claim: config.labels.claim, relay, owner });
    const builders = found.sessions;
    const both = owner !== null && builders.some((b) => sameSession(b, owner));
    // A builder whose PR's merge closed the ticket heard the merge through its PR.
    const throughPr = event === 'close' && state === 'closed' && found.by === 'merged PR';
    const say = (/** @type {TicketRole} */ role) => `${text}\n\n${rolesText({ issue, owner, builders, role })}`;
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
        closing: closing === true,
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
