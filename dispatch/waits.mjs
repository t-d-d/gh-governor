/**
 * A ticket's own wait: a body that opens with `Blocked until: <YYYY-MM-DD>`.
 *
 * The rule that holds the ticket is the shared readiness rule's
 * (`isWaiting`, scripts/lib/ready-work.mjs), and the reader carries what the
 * line says (`waitOf`). This file holds what governor says when it cannot
 * read the line: a warning in the log and one comment on the ticket, under
 * {@link WAIT_UNREADABLE_MARKER}, which a later turn finds before it writes
 * another. That comment is an error report, not a feature, so no switch
 * governs it.
 */

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
    'Write the date as `Blocked until: YYYY-MM-DD` on the body\'s first line, or delete the line to free the ticket.',
    '',
    WAIT_UNREADABLE_MARKER,
  ].join('\n');
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
 * }} args
 * @returns {Promise<'commented' | 'already told' | 'failed'>}
 */
export const reportUnreadable = async ({ reader, repo, issue, value, log }) => {
  log(WAIT_UNREADABLE, { level: 'warn', repo, issue, value, reason: 'its `Blocked until:` line holds no date governor can read, so the ticket is held' });
  try {
    const thread = await reader.allComments(issue);
    if (thread.some((c) => String(c.body ?? '').includes(WAIT_UNREADABLE_MARKER))) return 'already told';
    await reader.comment(issue, waitUnreadableComment(value));
    return 'commented';
  } catch (error) {
    log(WAIT_UNREADABLE, { level: 'error', repo, issue, value, error: error instanceof Error ? error.message : String(error), reason: 'the ticket is held, and governor could not say so on it this turn' });
    return 'failed';
  }
};
