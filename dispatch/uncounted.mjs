/**
 * Governor's one refusal comment, under {@link UNCOUNTED_READY_MARKER}: a
 * ticket gets it once, whichever reason it gives, and a later refusal finds
 * the marker on the thread and says no more. Two reasons give it.
 *
 * One: the ticket's author is not in the repo's `trust.task`, though a
 * person readied it under the rule pickup applies to ready labels, or
 * someone with a say summoned a session on it ({@link reportUntasked}).
 * Work is never about such an issue or PR: its body may hide instructions
 * in HTML comments GitHub does not render, so readying it vouches for text
 * nobody has seen. This is the repo's own choice, so it logs at info.
 *
 * Two, what pickup says about a ready ticket whose ready labels do not count
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

import { outsiderReason, strangerReason } from '../scripts/lib/dispatch-router.mjs';
import { authorHasSay, uncountedReady } from '../scripts/lib/ready-work.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { CONFIG_PATH } from './repo-config.mjs';
import { sayOnce } from './waits.mjs';

/** The marker on governor's one refusal comment on a ticket: its uncounted ready labels, or an author `trust.task` leaves out. */
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

/**
 * The refusal comment for an author the repo's `trust.task` leaves out:
 * which list refused it, and the two ways on.
 *
 * @param {{ author: string, association: string, what: 'readied' | 'summoned' }} args
 */
export const untaskedComment = ({ author, association, what }) => [
  `Governor has not ${what === 'readied' ? 'started this ticket' : 'started a session on this'}. Work is about an issue or pull request only when the repo's ${code('trust.task')} lets its author in, and its author, ${author === '' ? 'whose login was not read' : code(author)}, is ${code(association)}, which ${code('trust.task')} leaves out.`,
  '',
  'To have this built, either:',
  '',
  `- restate the work in a ticket of your own, in your own words, linking this one, and ${what === 'readied' ? 'ready' : 'summon a session on'} that; or`,
  `- widen ${code('trust.task')} in ${code(CONFIG_PATH)}, if the repo means to build such authors' issues and pull requests as they stand.`,
  '',
  UNCOUNTED_READY_MARKER,
].join('\n');

/**
 * Say that work may not be about a ticket whose author the repo's
 * `trust.task` leaves out: one line on `event` at info, and the refusal
 * comment once ({@link untaskedComment}), whatever the repo's switches say,
 * since someone with a say set it going and should hear why. A ready ticket
 * gets the comment only where a person readied it under the rule pickup
 * applies to ready labels: where its author has no say, its label events
 * are read, and a label the author, a bot or no event added
 * (`uncountedReady`) leaves it silent, as a stranger's own template must not
 * make governor write. A read or a comment that fails is logged at error
 * and skipped: nothing starts either way, and the next sweep tries again.
 *
 * @param {{
 *   reader: { allComments: (n: number) => Promise<Array<{ body: string }>>, comment: (n: number, body: string) => Promise<void>, labelAdds?: (n: number) => Promise<import('../scripts/lib/ready-work.mjs').LabelAdd[]> },
 *   stranger: import('../scripts/lib/dispatch-router.mjs').Stranger,
 *   what: 'readied' | 'summoned',
 *   ready?: readonly string[],
 *   event: string,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} args `ready`: the repo's ready labels, for a ticket `what` readied.
 * @returns {Promise<'commented' | 'already told' | 'silent' | 'failed'>}
 */
export const reportUntasked = async ({ reader, stranger, what, ready = [], event, log }) => {
  const { repo, issue, association, author = '' } = stranger;
  try {
    if (what === 'readied' && !authorHasSay(stranger)) {
      if (reader.labelAdds === undefined) return 'silent';
      const adds = await reader.labelAdds(issue);
      if (uncountedReady(stranger, adds, ready).length > 0) return 'silent';
    }
    return await sayOnce(reader, issue, UNCOUNTED_READY_MARKER, untaskedComment({ author, association, what }));
  } catch (error) {
    log(event, { level: 'error', repo, issue, error: messageOf(error), reason: `nothing is started, and governor could not say why on it this turn: ${strangerReason(stranger)}` });
    return 'failed';
  }
};
