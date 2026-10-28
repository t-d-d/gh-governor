/**
 * The hand-off a merge into main owes: the open tickets each issue the PR closes blocked, split into
 * those waiting on the PR's session, carrying `Spec waits until #<closed>
 * lands`, and those started or ready, which the close freed.
 *
 * The receiver marks the owner's message of a merge into main (`merged` on
 * the message fire); the turn reads the PR's closing references, the
 * `blocking` relationships of each and each blocked ticket, and appends the
 * lists and the steps to the message. The steps are the repo's
 * `mergeHandoff` prompt, or the default (dispatch/prompts.mjs). With a ticket waiting, the message
 * carries a fallback: an owner that refuses (archived) is replaced by a
 * fresh session on the same message, which takes the merged PR over, so the
 * hand-off never goes unanswered. With none waiting, nothing new starts.
 */

import { UNATTENDED } from './webhook/fire.mjs';
import { HANDOFF, oneLine } from './webhook/mention.mjs';
import { closedBy } from './pr-body.mjs';
import { instruction } from './prompts.mjs';

/**
 * A repo's ready and claim labels (dispatch/repo-config.mjs).
 *
 * @typedef {{ ready: readonly string[], claim: string, claimRemoves: readonly string[] }} HandoffLabels
 */

/**
 * @typedef {import('../scripts/lib/github-app.mjs').TicketRow} TicketRow
 * @typedef {{ closed: number, waiting: TicketRow[], freed: TicketRow[] }} Blocked
 *   One issue the PR closes, and the open tickets it blocked.
 * @typedef {{
 *   pullRequest: (n: number) => Promise<{ title: string, body: string }>,
 *   blocking: (n: number) => Promise<Array<{ number: number, state: string }>>,
 *   ticket: (n: number) => Promise<TicketRow>,
 * }} HandoffReader
 */

/**
 * Whether `body` waits on `closed`: a `Spec waits until #<closed> lands`
 * line, this repository's issue by number, the line hard-wrapped or not.
 *
 * @param {string} body
 * @param {number} closed
 */
export const waitsOn = (body, closed) => new RegExp(`\\bSpec\\s+waits\\s+until\\s+#${closed}\\s+lands\\b`, 'i').test(body);

/**
 * What PR `pr` blocked through the issues it closes: its title, and each
 * closed issue's open blocked tickets, waiting or freed. A read that fails
 * throws.
 *
 * @param {{ pr: number, reader: HandoffReader, repo: string }} args
 * @returns {Promise<{ title: string, blocked: Blocked[] }>}
 */
export const blockedBy = async ({ pr, reader, repo }) => {
  const { title, body } = await reader.pullRequest(pr);
  const closes = closedBy(body, repo);
  // A ticket waits on this PR when its line names any issue the PR closes,
  // whichever of them it is natively blocked by.
  const waits = (/** @type {TicketRow} */ t) => closes.some((closed) => waitsOn(t.body, closed));
  /** @type {Blocked[]} */
  const blocked = await Promise.all(closes.map(async (closed) => {
    const rows = (await reader.blocking(closed)).filter((row) => row.state === 'open');
    const open = (await Promise.all(rows.map((row) => reader.ticket(row.number)))).filter((t) => t.state === 'open');
    return { closed, waiting: open.filter(waits), freed: open.filter((t) => !waits(t)) };
  }));
  return { title, blocked };
};

/** @param {TicketRow} t @param {string} repo */
const line = (t, repo) => `  - #${t.number}: ${oneLine(t.title)} (https://github.com/${repo}/issues/${t.number})`;

/**
 * A freed ticket's status, off its repo's labels: claimed, or carrying the
 * ready labels a claim takes off (every ready label where the claim takes
 * none off).
 *
 * @param {TicketRow} t
 * @param {HandoffLabels} labels
 */
const status = (t, { ready, claim, claimRemoves }) => {
  const readyMarks = claimRemoves.length > 0 ? claimRemoves : ready;
  return t.labels.includes(claim) ? ', under development' : readyMarks.every((l) => t.labels.includes(l)) ? ', ready' : ', not labelled ready';
};

/**
 * The lists and the steps, appended to the merge message, or null when no
 * closed issue blocked an open ticket: the message goes as it was.
 *
 * @param {Blocked[]} blocked
 * @param {string} repo
 * @param {Record<string, string | undefined>} prompts The repo's config file's prompts.
 * @param {HandoffLabels} labels The repo's config file's labels.
 * @returns {string | null}
 */
export const handoffText = (blocked, repo, prompts, labels) => {
  const listed = blocked.filter((b) => b.waiting.length + b.freed.length > 0);
  if (listed.length === 0) return null;
  const sections = listed.map(({ closed, waiting, freed }) => [
    `#${closed} blocked:`,
    ...(waiting.length === 0 ? [] : ['- Waiting on you (its `Spec waits until #N lands` names an issue this PR closes):', ...waiting.map((t) => line(t, repo))]),
    ...(freed.length === 0 ? [] : ['- Started or ready (freed by the close):', ...freed.map((t) => `${line(t, repo)}${status(t, labels)}`)]),
  ].join('\n'));
  return [
    'One step is left: the issues this PR closes blocked open tickets.',
    ...sections,
    instruction(prompts, 'mergeHandoff'),
  ].join('\n\n');
};

/**
 * What the message says when the lists could not be read: the step still
 * stands.
 *
 * @param {string} error
 * @param {Record<string, string | undefined>} [prompts] The repo's config file's prompts.
 */
export const unreadText = (error, prompts = {}) =>
  `Could not read which open tickets the issues this PR closes blocked (${error}). ${instruction(prompts, 'mergeHandoffUnread')}`;

/**
 * The fallback a waiting hand-off carries: a fresh session on the same
 * message, told the PR's session is gone and the hand-off is its own,
 * taking the merged PR over.
 *
 * @param {{ pr: number, title: string, text: string, deploys: boolean }} args
 *   `deploys`: whether the repo's file turns deploy messages on, so the
 *   session hears when the merge has shipped.
 * @returns {import('./webhook/fire.mjs').Fallback}
 */
export const handoffFallback = ({ pr, title, text, deploys }) => ({
  prompt: [
    text,
    '',
    HANDOFF,
    `The hand-off on PR #${pr} is yours too: do the steps above for each ticket waiting on it. ${deploys ? 'Sign off once its deploys have reached you.' : 'Sign off once the steps are done.'}`,
    UNATTENDED,
  ].join('\n'),
  sessionName: oneLine(`Hand-off #${pr} ${title}`).slice(0, 100),
  issue: pr,
});
