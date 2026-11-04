/**
 * What pickup says about a ready ticket whose ready labels do not count
 * (`uncountedReady`, scripts/lib/ready-work.mjs): its author has no say in
 * the repo, the repo's `pickup.by` builds such tickets, and no person but
 * the author, or only a bot, added a ready label last. Most often an issue
 * template names the label, or a labelling workflow adds it.
 *
 * It is a warning in the log, never an error: anyone can open an issue, so
 * a stranger must not be able to page the operator. And it is one comment
 * on the ticket, under {@link UNCOUNTED_READY_MARKER}, which governor reads
 * the thread for first, so the maintainers who watch the repo's issues see
 * it on the ticket it concerns. The comment reports a fault, so it is posted
 * whatever the repo's switches say.
 */

import { outsiderReason } from '../scripts/lib/dispatch-router.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { sayOnce } from './waits.mjs';

/** The marker on governor's one comment about a ticket's uncounted ready labels. */
export const UNCOUNTED_READY_MARKER = '<!-- governor:uncounted-ready -->';

/** A label or login as inline code, so a backtick in it cannot end the span, and `@` or `#` neither notifies nor links. @param {string} text */
const code = (text) => `\`${text.replace(/`/g, "'")}\``;

/**
 * The comment: each uncounted label and who added it, and what starts the
 * ticket.
 *
 * @param {{ author: string, addedBy: ReadonlyArray<import('../scripts/lib/dispatch-router.mjs').AddedBy> }} args
 */
export const uncountedReadyComment = ({ author, addedBy }) => {
  const who = addedBy.map(({ label, actor, bot }) => {
    if (actor === null) return `- ${code(label)}, which no label event on the ticket names.`;
    if (bot) return `- ${code(label)}, added by ${code(actor)}, a bot. A labelling workflow or another App adds labels by rule, without anyone reading the ticket.`;
    if (actor.toLowerCase() === author.toLowerCase()) return `- ${code(label)}, added by ${code(actor)}, who opened the ticket. An issue template adds its labels this way.`;
    return `- ${code(label)}, added by ${code(actor)}.`;
  });
  return [
    'Governor has not started this ticket. On a ticket opened by someone outside the repo, a ready label counts only when a person other than its author, or governor itself, added it last. These ready labels do not count:',
    '',
    ...who,
    '',
    'Someone with triage access who takes these labels off and adds them again starts the ticket.',
    '',
    UNCOUNTED_READY_MARKER,
  ].join('\n');
};

/**
 * Say that a ticket's ready labels do not count: a warning on
 * `dispatch-pickup` every time, naming the labels and who added each, and
 * one comment on the ticket unless its thread already carries the marker. A
 * thread or a comment that fails is logged at error and skipped: the ticket
 * is not started either way, and the next sweep tries again, so a failed
 * read is never taken for a thread without the marker.
 *
 * @param {{
 *   reader: { allComments: (n: number) => Promise<Array<{ body: string }>>, comment: (n: number, body: string) => Promise<void> },
 *   outsider: import('../scripts/lib/dispatch-router.mjs').Outsider,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} args
 * @returns {Promise<'commented' | 'already told' | 'failed'>}
 */
export const reportUncounted = async ({ reader, outsider, log }) => {
  const { repo, issue, author, addedBy } = outsider;
  const labels = addedBy.map(({ label, actor }) => ({ label, addedBy: actor }));
  log('dispatch-pickup', { level: 'warn', repo, issue, outcome: 'skipped', labels, reason: outsiderReason(outsider) });
  try {
    return await sayOnce(reader, issue, UNCOUNTED_READY_MARKER, uncountedReadyComment({ author, addedBy }));
  } catch (error) {
    log('dispatch-pickup', { level: 'error', repo, issue, error: messageOf(error), reason: 'the ticket is not started, and governor could not say why on it this turn' });
    return 'failed';
  }
};
