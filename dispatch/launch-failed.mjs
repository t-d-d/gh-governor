/**
 * Governor's comment on a ticket whose launch or claim failed. Pickup
 * claims a ticket, and where its session does not start, puts the ticket's
 * failed-launch record and puts its ready labels back (dispatch/launch-plan.mjs).
 * The ticket then reads ready, and the record holds it from pickup for the
 * hour (dispatch/pickup.mjs), so without a word on the thread its owner sees
 * a ready ticket pickup ignores.
 *
 * The comment says no session is working on the ticket, when the hold ends,
 * and which log line holds the reason. It quotes none of the launcher's
 * output: a served repo can be public, and the output can name the account
 * or its environment.
 *
 * A run of failures gets one comment. Where the newest dispatch or
 * failed-launch marker in a comment governor's App posted is a failed-launch
 * one, nothing new is posted. A launch that starts a session posts its
 * dispatch marker, which ends the run. Governor's other comments on the
 * thread end nothing.
 */

import { messageOf } from '../scripts/lib/error-message.mjs';
import { DISPATCH_MARKER } from './webhook/fire.mjs';

/** How the comment starts; the hold's end time and ` -->` follow. */
export const LAUNCH_FAILED_MARKER = '<!-- governor:launch-failed ';

/** The log event for each comment this file posts, or does not. */
export const LAUNCH_FAILED_EVENT = 'dispatch-launch-failed-comment';

/**
 * @typedef {'launch' | 'claim'} Failed
 *   What failed: the launch, whose reason is the `dispatch-launcher-output`
 *   line, or the claim, whose reason is the `dispatch-claim` line.
 * @typedef {{ body: string, created_at: string, ours: boolean }} ThreadRow
 */

/**
 * The comment, for a hold that ends at `until`.
 *
 * @param {{ until: string, failed: Failed }} args
 * @returns {string}
 */
export const launchFailedComment = ({ until, failed }) => [
  `${LAUNCH_FAILED_MARKER}${until} -->`,
  failed === 'launch'
    ? 'Governor could not start a session for this ticket, so no session is working on it.'
    : 'Governor could not claim this ticket, so it could not start a session for it and no session is working on it.',
  '',
  `Pickup holds the ticket until ${until}. Putting its ready labels back before then starts nothing. The first sweep or ready-label fire after that time tries again.`,
  '',
  `The reason is in governor's logs at this comment's time, in the \`${failed === 'launch' ? 'dispatch-launcher-output' : 'dispatch-claim'}\` line.`,
].join('\n');

/**
 * Whether the newest dispatch or failed-launch marker on the thread, in a
 * comment governor's App posted, is a failed-launch one: the run of
 * failures it starts has already been said. A marker in anyone else's
 * comment is text.
 *
 * @param {readonly ThreadRow[]} comments The ticket's whole thread, oldest first.
 * @returns {boolean}
 */
export const alreadySaid = (comments) =>
  comments.filter((c) => c.ours && (c.body.includes(DISPATCH_MARKER) || c.body.includes(LAUNCH_FAILED_MARKER))).at(-1)?.body.includes(LAUNCH_FAILED_MARKER) === true;

/**
 * Post the comment on a ticket whose failed-launch record was put, unless
 * its run of failures was already said. Nothing here throws: a read or a
 * comment that fails is logged at error, and the release goes on.
 *
 * @param {{
 *   reader: { allComments: (n: number) => Promise<readonly ThreadRow[]>, comment: (n: number, body: string) => Promise<unknown> },
 *   repo: string,
 *   issue: number,
 *   until: string,
 *   failed: Failed,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} args
 * @returns {Promise<string | null>} The comment posted, or null where none was.
 */
export const sayLaunchFailed = async ({ reader, repo, issue, until, failed, log }) => {
  let comments;
  try {
    comments = await reader.allComments(issue);
  } catch (error) {
    log(LAUNCH_FAILED_EVENT, { level: 'error', repo, issue, failed, until, outcome: 'not said', error: messageOf(error), reason: 'the thread could not be read, so the ticket is not told its launch failed' });
    return null;
  }
  if (alreadySaid(comments)) {
    log(LAUNCH_FAILED_EVENT, { repo, issue, failed, until, outcome: 'already said' });
    return null;
  }
  const text = launchFailedComment({ until, failed });
  try {
    await reader.comment(issue, text);
  } catch (error) {
    log(LAUNCH_FAILED_EVENT, { level: 'error', repo, issue, failed, until, outcome: 'not said', error: messageOf(error), reason: 'the comment was refused, so the ticket is not told its launch failed' });
    return null;
  }
  log(LAUNCH_FAILED_EVENT, { repo, issue, failed, until, outcome: 'said' });
  return text;
};
