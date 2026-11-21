/**
 * A ready, unclaimed ticket whose dispatched session is still live. Pickup
 * claims a ticket with the repo's claim label, and the claim's second read
 * skips a ticket that carries it. Anyone who can write the ticket's labels
 * can take the label off, and the next ready label would then start a
 * second builder beside the first.
 *
 * So the claim's second read (dispatch/launch-plan.mjs) also reads the
 * ticket's newest dispatch comment of governor's (`lastDispatch`) and the
 * record of the session it names, as the release of a stopped session does
 * (dispatch/stopped.mjs). Where that session is not archived, governor
 * claims nothing and starts nothing, and says so once on the ticket under
 * `<!-- governor:held <session> -->`. A session the sessions API no longer
 * has counts as ended. A read that fails starts nothing, and never reads
 * as ended. A dispatch comment that names no session, which an unconfirmed
 * launch leaves, holds nothing: the labels decide.
 *
 * No timer decides it: a ticket whose session has ended is picked up by the
 * next fire.
 */

import { messageOf } from '../scripts/lib/error-message.mjs';
import { lastDispatch } from './webhook/fire.mjs';
import { sessionId } from './webhook/subscribe.mjs';
import { sessionLink } from './webhook/roles-text.mjs';

/** How governor's comment on a held ticket starts; the session id and ` -->` follow. */
export const HELD_MARKER = '<!-- governor:held ';

/** The log event for each ticket the claim holds, and its comment. */
export const HELD_EVENT = 'dispatch-held';

/**
 * @typedef {{ body: string, created_at: string, ours: boolean }} ThreadRow
 * @typedef {(session: string) => Promise<import('./stopped.mjs').Stopped>} ReadSession
 */

/**
 * The live session that holds a ticket: the one its newest dispatch comment
 * of governor's names, where its record says it is not archived. Null where
 * no such comment names a session, or the session has ended or is gone. A
 * read that fails throws.
 *
 * @param {readonly ThreadRow[]} comments The ticket's whole thread.
 * @param {ReadSession} stopped
 * @returns {Promise<{ session: string, url: string } | null>}
 */
export const liveBuilder = async (comments, stopped) => {
  const url = lastDispatch([...comments])?.sessionUrl ?? null;
  if (url === null) return null;
  const session = sessionId(url);
  const state = await stopped(session);
  return state !== null && !state.archived ? { session, url } : null;
};

/**
 * Governor's comment on a held ticket: which session holds it, and what
 * starts it again.
 *
 * @param {{ session: string, url: string }} holder
 * @returns {string}
 */
export const heldComment = ({ session, url }) => [
  `${HELD_MARKER}${session} -->`,
  `Pickup did not start this ticket. It reads as ready and unclaimed, but the ${sessionLink('session governor started for it', url)} has not ended, and a second session would build the same change beside it.`,
  '',
  'Pickup starts the ticket again once that session is archived or signs off. Nothing needs doing until then.',
].join('\n');

/**
 * Post the comment on a held ticket, once per holding session. Nothing here
 * throws: a comment that fails is logged at error, and the ticket stays
 * held, unclaimed.
 *
 * @param {{
 *   reader: { comment: (n: number, body: string) => Promise<unknown> },
 *   repo: string,
 *   issue: number,
 *   holder: { session: string, url: string },
 *   comments: readonly ThreadRow[],
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} args
 * @returns {Promise<string | null>} The comment posted, or null where none was.
 */
export const sayHeld = async ({ reader, repo, issue, holder, comments, log }) => {
  const marker = `${HELD_MARKER}${holder.session} -->`;
  const said = comments.some((c) => c.ours && c.body.includes(marker));
  log(HELD_EVENT, { level: 'info', repo, issue, session: holder.session, outcome: 'held', said: !said, reason: 'its newest dispatch comment names a session that is not archived, so it is not claimed and nothing starts' });
  if (said) return null;
  const text = heldComment(holder);
  try {
    await reader.comment(issue, text);
    return text;
  } catch (error) {
    log(HELD_EVENT, { level: 'error', repo, issue, session: holder.session, outcome: 'not said', error: messageOf(error), reason: 'the ticket stays held; the next fire that finds it held tries the comment again' });
    return null;
  }
};
