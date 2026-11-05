/**
 * The comment governor posts on a ticket when a shipping job first labels
 * it `deployed: <target>` (dispatch/turn.mjs), and what the receiver reads
 * from it. It lives beside the receiver because the receiver's Lambda ships
 * this directory alone, and it must tell governor's deploy comment from a
 * person's.
 *
 * Pure: no I/O.
 */

/** The start of the marker every deploy comment ends with. */
export const DEPLOYED_MARKER = '<!-- governor:deployed ';

/**
 * The deploy comment: one line naming the target, the job and the commit
 * it built, then the marker naming the target.
 *
 * @param {{ target: string, workflow: string, url: string, commit: string }} deploy
 *   `workflow`: the shipping job's workflow's name; `url`: the job's page.
 */
export const deployedComment = ({ target, workflow, url, commit }) =>
  `Deployed to ${target} by ${workflow} ([job](${url})), built from ${commit.slice(0, 7)}.\n\n${DEPLOYED_MARKER}${target} -->`;
