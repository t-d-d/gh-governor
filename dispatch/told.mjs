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

import { relayedBody, sameSession, sessionId, sessionNamedIn } from './webhook/subscribe.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { relayOf } from './trust.mjs';

/** The log event for a message a turn sends about its own comment on an issue. */
export const TOLD = 'dispatch-told';

/** @typedef {'spec owner' | 'builder' | 'spec owner and builder'} TicketRole */

/** Items joined as a sentence lists them: `a, b and c`. @param {string[]} items */
export const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

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
 * The spec owner a ticket's row names: the session link that ends its body,
 * read only where `relay` lets the body's author in. A row governor's App
 * opened is judged as the App.
 *
 * @param {{ body?: unknown, author?: string, association?: string, app?: boolean }} row
 * @param {readonly string[]} relay
 * @returns {string | null}
 */
export const specOwnerOf = (row, relay) => sessionNamedIn(relayedBody({ ...row, body: String(row.body ?? ''), own: row.app === true }, relay));

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
 * and that the change it asks for, where it asks one, is the spec owner's
 * to make in the body.
 *
 * @param {number} issue
 * @param {string} comment
 */
export const specOwnerNote = (issue, comment) => [
  `Governor commented on #${issue}:`,
  '',
  unmarked(comment),
  '',
  `You are #${issue}'s spec owner, the session its body's link names. Where the comment asks for a change to the ticket, that change is yours to make in its body.`,
].join('\n');

/**
 * @typedef {(session: string, text: string, options: { closing: boolean }) => Promise<import('./deliveries.mjs').Delivery>} Deliver
 *   A send to one session about the ticket, with its standing line asking it
 *   to sign off where `closing` and nothing else of its is open.
 * @typedef {(event: string, context?: Record<string, unknown>) => void} Log
 */

/** What came of a send, for the log. @param {import('./deliveries.mjs').Delivery} told */
const outcomeOf = (told) => (told.ok ? 'messaged' : told.refused ? 'its session is archived' : 'not messaged');

/**
 * Send each of `sends`, in turn, logging each under {@link TOLD}. A send
 * that throws, or fails, is logged at error, and the rest still go.
 *
 * @param {{ deliver: Deliver, log: Log, about: Record<string, unknown>, sends: ReadonlyArray<{ session: string, text: string, role: TicketRole, closing?: boolean }> }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery[]>}
 */
export const sendAll = async ({ deliver, log, about, sends }) => {
  /** @type {import('./deliveries.mjs').Delivery[]} */
  const sent = [];
  for (const { session, text, role, closing = false } of sends) {
    try {
      const told = await deliver(session, text, { closing });
      sent.push(told);
      log(TOLD, { ...about, session, role, ...(told.ok || told.refused ? {} : { level: 'error' }), outcome: outcomeOf(told), ...(told.error === null || told.error === undefined ? {} : { error: told.error }) });
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
  const stops = `You no longer build #${issue}: ${builder ?? 'another session'} does.`;
  if (owner !== null && named(owner)) {
    skipped.push(`${sessionId(owner)}, the builder it names`);
  } else if (owner !== null) {
    const ownerBuilt = gone !== null && sameSession(gone, owner);
    const lines = [text, '', rolesText({ issue, owner, builders: builder === null ? [] : [builder], role: 'spec owner' })];
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
  `Issue #${issue}: ${title.replace(/\s+/g, ' ').trim()} (${url}) has a new builder: ${builder ?? 'a cloud session the launcher printed no link for'}. Governor's dispatch comment on it records the change for people.`;

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
  return sendAll({ deliver, log, about, sends });
};

/**
 * A wait warning's message to the ticket's spec owner, for the turn that
 * posted it: the ticket read for its body, the spec owner named in it under
 * `relay`, and {@link specOwnerNote} sent. A read or a send that fails is
 * logged at error, and the comment stands.
 *
 * @param {{ read: (issue: number) => Promise<{ body?: unknown, author?: string, association?: string, app?: boolean }>, relay: readonly string[], deliver: (issue: number) => Deliver, log: Log, repo: string }} args
 * @returns {(issue: number, comment: string) => Promise<void>}
 */
export const specOwnerTeller = ({ read, relay, deliver, log, repo }) => async (issue, comment) => {
  const about = { repo, issue, change: 'comment' };
  /** @type {string | null} */
  let owner;
  try {
    owner = specOwnerOf(await read(issue), relay);
  } catch (error) {
    log(TOLD, { ...about, level: 'error', outcome: 'nobody told', error: messageOf(error), reason: 'the ticket could not be read for its spec owner; the comment stands' });
    return;
  }
  if (owner === null) {
    log(TOLD, { ...about, outcome: 'nobody told', reason: 'its body names no spec owner' });
    return;
  }
  await sendAll({ deliver: deliver(issue), log, about, sends: [{ session: owner, text: specOwnerNote(issue, comment), role: 'spec owner' }] });
};

/**
 * A turn's {@link specOwnerTeller} for one repo: the ticket read with the
 * repo's reader, its spec owner judged by the repo's `trust.relay`, and the
 * message sent through the repo's deliveries from `source`.
 *
 * @param {Pick<import('./turn.mjs').TurnContext, 'readerFor' | 'configOf' | 'delivery' | 'log'>} ctx
 * @param {string} repo
 * @param {import('./deliveries.mjs').MessageSource} source
 * @param {{ body?: unknown, author?: string, association?: string, app?: boolean }} [row]
 *   The ticket as the turn already read it, so it is not read again.
 * @returns {(issue: number, comment: string) => Promise<void>}
 */
export const tellerFor = (ctx, repo, source, row) => specOwnerTeller({
  read: async (issue) => row ?? (await ctx.readerFor(repo)).ticket(issue),
  relay: relayOf(ctx.configOf(repo)),
  deliver: (issue) => (session, text, { closing }) => ctx.delivery(repo).deliver({ session }, text, { source, on: [issue], closing }),
  log: ctx.log,
  repo,
});
