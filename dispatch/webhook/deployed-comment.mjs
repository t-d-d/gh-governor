/**
 * The comment governor posts on a ticket when a shipping job first labels
 * it `deployed: <target>` (dispatch/turn.mjs), and what the receiver reads
 * from it. It lives beside the receiver because the receiver's Lambda ships
 * this directory alone, and it must tell governor's deploy comment from a
 * person's.
 *
 * Pure: no I/O.
 */

import { LABEL_PREFIX } from './fire.mjs';

/** The start of the marker every deploy comment ends with. */
export const DEPLOYED_MARKER = '<!-- governor:deployed ';

/**
 * The deploy comment: one line naming the label, the workflow as a link to
 * the job, and the commit it built, then the marker naming the target. Only
 * the marker is read back. A bracket or a backslash in the workflow's name
 * is escaped, so it cannot end the link's words early.
 *
 * @param {{ target: string, workflow: string, url: string, commit: string }} deploy
 *   `workflow`: the shipping job's workflow's name; `url`: the job's page.
 */
export const deployedComment = ({ target, workflow, url, commit }) =>
  `Labelled \`${LABEL_PREFIX}${target}\` by the [${workflow.replace(/[[\]\\]/g, '\\$&')}](${url}) workflow at ${commit.slice(0, 7)}.\n\n${DEPLOYED_MARKER}${target} -->`;
