/**
 * The offer of an ownerless issue, under `sessionRules` (PRD #599).
 *
 * An issue's owner is the session whose link ends its body. Once that
 * session is archived, the issue has no owner, and a comment on it reaches
 * nobody. So does a comment on an issue a session filed without signing,
 * whose body ends in the Claude Code footer and names no session. Governor
 * offers such an issue to the session that signed the comment: nobody owns
 * it, no owner reads your comments, and if your comment changes what it
 * asks, take it by editing its body so your link ends it.
 *
 * - An owner that refuses as archived is learnt by sending it the comment:
 *   the spec owner's message on an unclaimed issue (dispatch/turn.mjs),
 *   whose fire names the commenter as `offer`, and the ticket fire on a
 *   claimed one (dispatch/ticket-fire.mjs), which names it as `poster`.
 *   Both run under `subscribeMessages`.
 * - An unsigned body queues an `offer` fire of its own, under
 *   `sessionRules` alone ({@link planOffer}).
 *
 * A person's issue, with no footer and no session, is the person's and gets
 * no offer, nor does a body `trust.relay` masks, nor a PR: governor takes a
 * PR over when its owner is archived. One of the ticket's builders, as
 * `rolesOf` finds them, is never offered it (#535). The offer is not a
 * correction, so it is not recorded and goes on every such comment; the cap
 * on messages to one session about one issue (#602) stops a loop. A send
 * the cap holds back counts as not sent, and logs nothing more here.
 */

import { GITHUB_SOURCE } from './deliveries.mjs';
import { relayOf, ticketAuthor } from './trust.mjs';
import { rolesOf } from './roles.mjs';
import { fireRepoOf } from './repos.mjs';
import { relayedBody, sameSession, sessionId, unsignedSessionBody } from './webhook/subscribe.mjs';

/**
 * Why an issue has no owner: its owner refused as archived, or a session
 * filed it unsigned.
 *
 * @typedef {'archived' | 'unsigned'} Ownerless
 */

/**
 * The offer, as the commenting session reads it.
 *
 * @param {number} issue
 * @param {Ownerless} why
 * @returns {string}
 */
export const offerText = (issue, why) => [
  why === 'archived'
    ? `Nobody owns #${issue}: the session its body names as owner is archived.`
    : `Nobody owns #${issue}: a session filed it without signing it, so its body names no session as owner.`,
  'No owner reads your comments on it.',
  `If your comment changes what #${issue} asks, take the issue: edit its body to say what it now asks, and end the body with this session's link, alone on the line just above the Claude Code footer. You then own it.`,
  'If your comment changes nothing it asks, there is nothing more to do.',
].join(' ');

/**
 * Offer `issue` to `session`, unless it is one of `builders`. Returns the
 * delivery, or null where nothing was sent.
 *
 * @param {{
 *   repo: string,
 *   issue: number,
 *   session: string,
 *   why: Ownerless,
 *   builders: readonly string[],
 *   deliveries: Pick<import('./deliveries.mjs').Deliveries, 'deliver'>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery | null>}
 */
export const offerIssue = async ({ repo, issue, session, why, builders, deliveries, log }) => {
  const about = { repo, issue, session: sessionId(session), why };
  if (builders.some((b) => sameSession(b, session))) {
    log('dispatch-offer', { ...about, outcome: 'not offered', reason: 'it builds the ticket, and a builder never takes the spec' });
    return null;
  }
  const sent = await deliveries.deliver({ session }, offerText(issue, why), { source: GITHUB_SOURCE, kind: 'offer', on: [issue] });
  // A send the cap held back logs itself.
  if (sent.capped !== true) log('dispatch-offer', { ...about, outcome: sent.ok ? 'offered' : sent.refused ? 'its session is archived' : 'not sent', ...(sent.ok || sent.refused ? {} : { level: 'error', error: sent.error }) });
  return sent;
};

/**
 * An `offer` fire: a session's signed comment on an issue whose body a
 * session filed unsigned. The issue is read again, since it may have been
 * taken since the comment: where its body, read through `relayedBody`,
 * still names no owner and still ends in the footer, and it is no PR, the
 * commenter is offered it, unless it builds the ticket. A read that fails
 * fails the turn.
 *
 * @param {import('./webhook/fire.mjs').OfferFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planOffer = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { issue, session } = invocation;
  const config = ctx.configOf(repo);
  const relay = relayOf(config);
  const reader = await ctx.readerFor(repo);
  const row = await reader.ticket(issue);
  const body = relayedBody({ ...ticketAuthor(row), body: String(row.body ?? '') }, relay);
  if (row.pull === true || !unsignedSessionBody(body)) {
    ctx.log('dispatch-offer', { repo, issue, session: sessionId(session), why: 'unsigned', outcome: 'not offered', reason: row.pull === true ? 'it is a PR' : 'its body names an owner now, is a person\'s, or trust.relay leaves its author out' });
    return { answer: { kind: invocation.kind, messaged: null, dispatched: [] } };
  }
  const { builders } = await rolesOf({ issue, relay, claim: config.labels.claim, ticket: row, owner: null, reader, ownerOf: (pr) => ctx.delivery().ownerOf(pr) });
  let loginStored = false;
  /** @type {import('./deliveries.mjs').Delivery | null} */
  let messaged = null;
  try {
    messaged = await offerIssue({ repo, issue, session, why: 'unsigned', builders, deliveries: ctx.delivery(), log: ctx.log });
  } finally {
    loginStored = await ctx.storeLogin();
  }
  return { answer: { kind: invocation.kind, messaged, dispatched: [], loginStored } };
};
