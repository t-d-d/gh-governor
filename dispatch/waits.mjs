/**
 * A ticket's own wait: a body that opens with `Blocked until: <YYYY-MM-DD>`,
 * or with a time of day after the date, in UTC: `Blocked until: <YYYY-MM-DD>
 * <HH:MM>`. The wait ends at 00:00 UTC on a date, or at the time.
 *
 * The rule that holds the ticket is the shared readiness rule's
 * (`isWaiting`, scripts/lib/ready-work.mjs), and the reader carries what the
 * line says (`waitOf`). Every pickup path applies it: the sweep, a ready
 * label's fire and a blocker's close. The hold needs no switch, and nor does
 * what governor says when it cannot read the line: a warning in the log and
 * one comment on the ticket, under {@link WAIT_UNREADABLE_MARKER}, which a
 * later turn finds before it writes another. That comment is an error
 * report, not a feature.
 *
 * With a repo's `waits` switch on, every session governor starts there is
 * told how to make a ticket wait ({@link waitPrompt}). Where the file also
 * sets `waits.label`, the filer adds that label with the line, so GitHub
 * lists every waiting ticket by it, and the hourly fire takes it off each
 * open ticket whose date has passed ({@link clearWaitLabels}), before that
 * fire's sweep. Governor never adds the label, and keeps no state of its own
 * for a wait: the line and the label are the record.
 */

import { isWaiting } from '../scripts/lib/ready-work.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/** The log event for a `Blocked until:` line governor cannot read. */
export const WAIT_UNREADABLE = 'dispatch-wait-unreadable';

/** The marker on governor's one comment about an unreadable line. */
export const WAIT_UNREADABLE_MARKER = '<!-- governor:wait-unreadable -->';

/**
 * The comment a ticket gets when governor cannot read its line. The value is
 * quoted as code, so an `@handle` or `#N` in it neither notifies nor links.
 *
 * @param {string} value What followed `Blocked until:`.
 */
export const waitUnreadableComment = (value) => {
  const said = value === '' ? 'holds no date' : `says \`${value.replace(/`/g, "'")}\``;
  return [
    `Governor cannot read the date on this ticket's \`Blocked until:\` line, which ${said}, so it is holding the ticket.`,
    'Write the date as `Blocked until: YYYY-MM-DD` on the body\'s first line, or as `Blocked until: YYYY-MM-DD HH:MM` for a time of day in UTC, or delete the line to free the ticket.',
    '',
    WAIT_UNREADABLE_MARKER,
  ].join('\n');
};

/**
 * @typedef {import('./told.mjs').Tell} Tell
 *   The message to the ticket's spec owner of a comment governor just
 *   posted on it (`specOwnerTeller`, dispatch/told.mjs). The comment is a
 *   record for people, which the relay sends to nobody, so the turn that
 *   posts a warning only the spec owner can act on tells it. It never
 *   throws: a send that fails is logged, and the comment stands.
 */

/**
 * Say something once on a ticket: nothing where its thread carries `marker`.
 * With `tell`, the spec owner hears the comment once, when it is posted.
 *
 * @param {{ allComments: (n: number) => Promise<Array<{ body: string }>>, comment: (n: number, body: string) => Promise<void> }} reader
 * @param {number} issue
 * @param {string} marker
 * @param {string} text
 * @param {Tell | undefined} [tell]
 * @returns {Promise<'commented' | 'already told'>}
 */
export const sayOnce = async (reader, issue, marker, text, tell) => {
  const thread = await reader.allComments(issue);
  if (thread.some((c) => String(c.body ?? '').includes(marker))) return 'already told';
  await reader.comment(issue, text);
  if (tell !== undefined) await tell(issue, text);
  return 'commented';
};

/**
 * Say that a ticket's line cannot be read: a warning in the log every time,
 * and one comment on the ticket, unless its thread already carries the
 * marker. A thread or a comment that fails is logged at error and skipped:
 * the ticket is held either way, and the next turn tries again, so a failed
 * read is never taken for a thread without the marker.
 *
 * @param {{
 *   reader: { allComments: (n: number) => Promise<Array<{ body: string }>>, comment: (n: number, body: string) => Promise<void> },
 *   repo: string,
 *   issue: number,
 *   value: string,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   tell?: Tell | undefined,
 * }} args `tell`: the spec owner's message of the comment, under the
 *   switch of the feature whose turn posts it.
 * @returns {Promise<'commented' | 'already told' | 'failed'>}
 */
export const reportUnreadable = async ({ reader, repo, issue, value, log, tell }) => {
  log(WAIT_UNREADABLE, { level: 'warn', repo, issue, value, reason: 'its `Blocked until:` line holds no date governor can read, so the ticket is held' });
  try {
    return await sayOnce(reader, issue, WAIT_UNREADABLE_MARKER, waitUnreadableComment(value), tell);
  } catch (error) {
    log(WAIT_UNREADABLE, { level: 'error', repo, issue, value, error: messageOf(error), reason: 'the ticket is held, and governor could not say so on it this turn' });
    return 'failed';
  }
};

// ── The wait label and the line sessions are told, under the `waits` switch ──

/**
 * The line that ends every launch's prompt in a repo with `waits` on, after
 * the line on signing posts (dispatch/turn.mjs).
 */
export const WAIT_PROMPT = 'To make a ticket wait until a date, start its body with the line `Blocked until: YYYY-MM-DD`. Governor does not start it before 00:00 UTC on that date. To make it wait until a time of day, write `Blocked until: YYYY-MM-DD HH:MM`, in UTC.';

/**
 * The line on making a ticket wait, naming the repo's wait label where its
 * file sets one.
 *
 * @param {string | undefined} label The file's `waits.label`.
 */
export const waitPrompt = (label) => (label === undefined
  ? WAIT_PROMPT
  : `${WAIT_PROMPT} Add the label \`${label}\` with the line. Governor takes the label off once the date has passed.`);

/** The log event for what the hourly fire did with a ticket's wait label. */
export const WAIT_LABEL = 'dispatch-wait-label';

/**
 * @typedef {{
 *   readyIssues: (labels: readonly string[]) => Promise<Array<{ number: number, wait?: import('../scripts/lib/ready-work.mjs').Wait | undefined }>>,
 *   removeLabel: (n: number, label: string) => Promise<void>,
 * }} LabelReader
 *   The open issues carrying every label named, each with what its
 *   `Blocked until:` line says, and a label's removal.
 */

/**
 * The hourly fire's pass over one repo's wait label: list the open issues
 * carrying it, and take it off each whose line is readable and whose date
 * has passed. A ticket whose date is still to come, whose line cannot be
 * read, or that has no line keeps the label, since a repo may use the same
 * label for waits a routine clears. A label GitHub says is already gone
 * counts as cleared.
 *
 * A list that cannot be read, or a removal that fails, is logged at error
 * and returned in `unread`, and the next fire tries again. The other
 * removals still go.
 *
 * @param {{ reader: LabelReader, repo: string, label: string, now: number, log: (event: string, context?: Record<string, unknown>) => void }} args
 * @returns {Promise<{ cleared: number[], unread: Array<{ repo: string, error: string }> }>}
 */
export const clearWaitLabels = async ({ reader, repo, label, now, log }) => {
  /** @type {number[]} */
  const cleared = [];
  /** @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  /** @type {Awaited<ReturnType<LabelReader['readyIssues']>>} */
  let rows;
  try {
    rows = await reader.readyIssues([label]);
  } catch (error) {
    const message = messageOf(error);
    log(WAIT_LABEL, { level: 'error', repo, label, error: message, reason: 'the tickets carrying the wait label could not be listed, so the next fire tries again' });
    return { cleared, unread: [{ repo, error: `wait label: ${message}` }] };
  }
  const ended = rows.filter(({ wait }) => wait !== undefined && 'until' in wait && !isWaiting({ wait }, now));
  for (const { number, wait } of ended) {
    const until = wait !== undefined && 'until' in wait ? wait.until : undefined;
    try {
      await reader.removeLabel(number, label).catch((error) => {
        if (/** @type {{ status?: number }} */ (error)?.status !== 404) throw error;
      });
      cleared.push(number);
      log(WAIT_LABEL, { repo, issue: number, label, until, outcome: 'removed: its date has passed' });
    } catch (error) {
      const message = messageOf(error);
      log(WAIT_LABEL, { level: 'error', repo, issue: number, label, until, error: message, reason: 'its date has passed and the label stays, so the next fire tries again' });
      unread.push({ repo, error: `wait label #${number}: ${message}` });
    }
  }
  return { cleared, unread };
};
