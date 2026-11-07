/**
 * What a turn that posts a comment on an issue tells the issue's roles.
 *
 * A comment governor's App posts on an issue is a record for people, and the
 * relay sends it to nobody (dispatch/webhook/mention.mjs). The turn that
 * posts it decides, once, which roles should hear it, and messages them
 * itself (docs/constraints/dispatcher-repos.md):
 *
 * - a change of builder, the dispatch comment, tells the spec owner, and the
 *   builder it displaced, which is asked to stop and sign off
 *   ({@link builderChangeSends});
 * - a wait warning, a fix only the spec owner can make, tells the spec owner
 *   ({@link specOwnerTeller});
 * - a blocker's close tells the builders and the spec owner
 *   (dispatch/unblocked-fire.mjs).
 *
 * A send that fails is logged at error and never fails the turn: the
 * comment, the record people read, is posted already.
 *
 * Pure but for the `deliver`, `read` and `log` its callers hand it.
 */

import { sameSession, sessionId } from './webhook/subscribe.mjs';
import { rolesFrom, rolesOf, rolesText, sessionLink } from './roles.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { relayOf } from './trust.mjs';

/** The log event for a message a turn sends about its own comment on an issue. */
export const TOLD = 'dispatch-told';

/** @typedef {import('./roles.mjs').TicketRole} TicketRole */

/**
 * Governor's comment as a session reads it: its markers taken out, since
 * they are governor's to read, and a session quoting one would be read as
 * governor.
 *
 * @param {string} text
 */
export const unmarked = (text) => text.replace(/\n*<!-- governor:[^>]*-->/g, '').trim();

/**
 * A spec owner's message of governor's comment on its ticket: the comment,
 * and that the spec owner weighs it as it weighs any comment: it edits the
 * body where it agrees a change is needed, and replies where it does not.
 *
 * @param {number} issue
 * @param {string} comment
 */
export const specOwnerNote = (issue, comment) => [
  `Governor commented on #${issue}:`,
  '',
  unmarked(comment),
  '',
  rolesText({ issue, owner: null, builders: [] }, { role: 'spec owner', merged: false }, { duty: true }),
].join('\n');

/**
 * @typedef {{ on: number[], closing: boolean, dropFrom: number[] }} SendOptions
 * @typedef {(session: string, text: string, options: SendOptions) => Promise<import('./deliveries.mjs').Delivery>} Deliver
 *   A send to one session about the ticket (`on`), with its standing line
 *   asking it to sign off where `closing` and nothing else of its is open.
 *   A spec owner hears the ticket as its filer does, so one archived with
 *   no fallback is dropped from the ticket's subscribe line (`dropFrom`),
 *   as a relayed message dropped it.
 * @typedef {(event: string, context?: Record<string, unknown>) => void} Log
 */

/** What came of a send, for the log. @param {import('./deliveries.mjs').Delivery} told */
export const outcomeOf = (told) => (told.ok ? 'messaged' : told.refused ? 'its session is archived' : told.capped ? 'held at the message ceiling' : 'not messaged');

/**
 * Send each of `sends`, in turn, logging each under {@link TOLD}. A send
 * that throws, or fails, is logged at error, and the rest still go.
 *
 * @param {{ deliver: Deliver, log: Log, issue: number, about: Record<string, unknown>, sends: ReadonlyArray<{ session: string, text: string, role: TicketRole, closing?: boolean }> }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery[]>}
 */
export const sendAll = async ({ deliver, log, issue, about, sends }) => {
  /** @type {import('./deliveries.mjs').Delivery[]} */
  const sent = [];
  for (const { session, text, role, closing = false } of sends) {
    try {
      const told = await deliver(session, text, { on: [issue], closing, dropFrom: role === 'builder' ? [] : [issue] });
      sent.push(told);
      log(TOLD, { ...about, session, role, ...(told.ok || told.refused ? {} : { level: told.capped ? 'info' : 'error' }), outcome: outcomeOf(told), ...(told.error === null || told.error === undefined ? {} : { error: told.error }) });
    } catch (error) {
      log(TOLD, { ...about, session, role, level: 'error', outcome: 'not messaged', error: messageOf(error) });
    }
  }
  return sent;
};

/**
 * Who hears a change of builder, and what: the spec owner a notice naming
 * the new builder, and the builder it displaced, where that is live and is
 * not the new one, that it no longer builds the ticket, asked to stop and
 * sign off unless it knows a reason not to. A spec owner that was the
 * displaced builder hears both in one message, and stays the spec owner.
 * The builder named never hears of its own start. `text`: what happened,
 * the first line of each message.
 *
 * @param {{ issue: number, text: string, owner: string | null, builder: string | null, displaced: string | null }} args
 * @returns {{ sends: Array<{ session: string, text: string, role: TicketRole, closing: boolean }>, skipped: string[] }}
 */
export const builderChangeSends = ({ issue, text, owner, builder, displaced }) => {
  /** @type {Array<{ session: string, text: string, role: TicketRole, closing: boolean }>} */
  const sends = [];
  /** @type {string[]} */
  const skipped = [];
  const named = (/** @type {string | null} */ session) => session !== null && builder !== null && sameSession(session, builder);
  const gone = displaced !== null && !named(displaced) ? displaced : null;
  const stops = `You no longer build #${issue}: ${builder === null ? 'another session' : sessionLink('another session', builder)} does.`;
  if (owner !== null && named(owner)) {
    skipped.push(`${sessionId(owner)}, the builder it names`);
  } else if (owner !== null) {
    const ownerBuilt = gone !== null && sameSession(gone, owner);
    const lines = [text, '', rolesText(rolesFrom({ issue, owner, builders: builder === null ? [] : [builder] }), { role: 'spec owner', merged: false }, { notice: !ownerBuilt })];
    if (ownerBuilt) lines.push(`${stops} Stop building it, and leave its branch and PR to that session; you remain its spec owner.`);
    sends.push({ session: owner, text: lines.join('\n'), role: 'spec owner', closing: false });
  }
  if (gone !== null && !(owner !== null && sameSession(gone, owner))) {
    // A displaced builder has nothing left on the ticket: its standing
    // line asks it to sign off where nothing else of its is open.
    sends.push({
      session: gone,
      text: `${text}\n\n${stops} Stop your work on it, and sign off unless you know a reason not to. You hear nothing more from the ticket.`,
      role: 'builder',
      closing: true,
    });
  }
  return { sends, skipped };
};

/**
 * The first line of a change of builder's messages.
 *
 * @param {{ issue: number, title: string, url: string, builder: string | null }} args
 */
export const builderChangeText = ({ issue, title, url, builder }) =>
  `[#${issue}](${url}) ${title.replace(/\s+/g, ' ').trim()} has ${builder === null ? 'a new builder, a cloud session the launcher printed no link for' : sessionLink('a new builder', builder)}.`;

/**
 * Tell a change of builder from the turn that posted its dispatch comment
 * ({@link builderChangeSends}), each send logged.
 *
 * @param {{ deliver: Deliver, log: Log, repo: string, issue: number, title: string, url: string, owner: string | null, builder: string | null, displaced: string | null }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery[]>}
 */
export const tellBuilderChange = async ({ deliver, log, repo, issue, title, url, owner, builder, displaced }) => {
  const about = { repo, issue, change: 'dispatched', builder, displaced };
  const { sends, skipped } = builderChangeSends({ issue, text: builderChangeText({ issue, title, url, builder }), owner, builder, displaced });
  if (sends.length === 0) {
    log(TOLD, { ...about, outcome: 'nobody told', ...(skipped.length === 0 ? { reason: 'no session holds the spec owner role, and nobody was displaced' } : { skipped }) });
    return [];
  }
  return sendAll({ deliver, log, issue, about, sends });
};

/**
 * A message of governor's comment to the ticket's spec owner, for the turn
 * that posted it: the spec owner found as every path finds a ticket's roles
 * (`rolesOf`, dispatch/roles.mjs), from the row the turn read where it
 * hands one in, else from the ticket read now, and {@link specOwnerNote}
 * sent. A read or a send that fails is logged at error, and the comment
 * stands.
 *
 * @typedef {import('./roles.mjs').TicketRow} Row
 * @typedef {(issue: number, comment: string, row?: Row) => Promise<void>} Tell
 *   `row`: the ticket as the turn already read it, so it is not read again.
 *
 * @param {{ read: (issue: number) => Promise<Row>, relay: readonly string[], deliver: Deliver, log: Log, repo: string }} args
 * @returns {Tell}
 */
export const specOwnerTeller = ({ read, relay, deliver, log, repo }) => async (issue, comment, row) => {
  const about = { repo, issue, change: 'comment' };
  /** @type {string | null} */
  let owner;
  try {
    ({ owner } = await rolesOf({ issue, relay, ticket: row ?? await read(issue) }));
  } catch (error) {
    log(TOLD, { ...about, level: 'error', outcome: 'nobody told', error: messageOf(error), reason: 'the ticket could not be read for its spec owner; the comment stands' });
    return;
  }
  if (owner === null) {
    log(TOLD, { ...about, outcome: 'nobody told', reason: 'its body names no spec owner' });
    return;
  }
  await sendAll({ deliver, log, issue, about, sends: [{ session: owner, text: specOwnerNote(issue, comment), role: 'spec owner' }] });
};

/** Each turn's last queued tell, so its tellers send one at a time. @type {WeakMap<object, Promise<void>>} */
const queues = new WeakMap();

/**
 * A turn's {@link specOwnerTeller} for one repo: the ticket read with the
 * repo's reader, its spec owner judged by the repo's `trust.relay`, and the
 * message sent through the repo's deliveries from `source`. Every teller
 * made from one `ctx` sends one at a time, in the order asked, however many
 * comments its callers post side by side: each send is a CLI call on the
 * one login, which may refresh it, and two at once could each spend a
 * refresh token the other had already rotated. A teller never throws, so
 * one send that fails holds up none after it.
 *
 * @param {Pick<import('./turn.mjs').TurnContext, 'readerFor' | 'configOf' | 'delivery' | 'log'>} ctx
 * @param {string} repo
 * @param {import('./deliveries.mjs').MessageSource} source
 * @param {Row} [row]
 *   The ticket as the turn already read it, so it is not read again; a
 *   caller may hand in the row with each comment instead.
 * @returns {Tell}
 */
export const tellerFor = (ctx, repo, source, row) => {
  const tell = specOwnerTeller({
    read: async (issue) => row ?? (await ctx.readerFor(repo)).ticket(issue),
    relay: relayOf(ctx.configOf(repo)),
    deliver: (session, text, options) => ctx.delivery(repo).deliver({ session }, text, { source, kind: 'told', ...options }),
    log: ctx.log,
    repo,
  });
  return (issue, comment, read) => {
    const run = () => tell(issue, comment, read);
    const next = (queues.get(ctx) ?? Promise.resolve()).then(run, run);
    queues.set(ctx, next);
    return next;
  };
};
