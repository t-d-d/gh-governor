/**
 * What a dispatched session is told and called, and what the launcher's exit
 * means: the parts of an earlier dispatcher that ran on a Mac that the
 * Fargate dispatcher kept. The selection is `ready-work.mjs`, the
 * plan is `dispatch-router.mjs`, the turn is `dispatch/turn.mjs`.
 */

// An issue title goes through `oneLine`: GitHub titles are single-line by
// convention but not by rule, and a newline would land in sessionName's
// `--name` argv and push the prompt's issue number onto a line of its own.
import { oneLine } from '../../dispatch/webhook/mention.mjs';
import { instruction } from '../../dispatch/prompts.mjs';

/** The model the worker session runs on. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * The name the session shows in the sessions pane.
 *
 * Set outright through the CLI's `--name` rather than left to the namer.
 * Leading the prompt with the number was the first attempt and it does not
 * work: the namer summarises the whole prompt rather than copying its first
 * line, and an identifier reads as boilerplate to a summariser. `Pickup #381
 * 'A revocation parked after the purchase door's re-read is still never
 * routed'` came back as "Revocation routing after purchase door re-read",
 * a good summary, and useless to match against a backlog. Naming the session
 * beats moving the number around the prompt.
 *
 * @param {number} number
 * @param {string | undefined} title
 */
export const sessionName = (number, title) => {
  const flat = oneLine(title);
  return flat ? `#${number} ${flat}` : `#${number}`;
};

/**
 * The prompt each worker session opens with.
 *
 * Short on purpose: the session loads its repo's CLAUDE.md. The claim line
 * tells it the ticket is already claimed: the dispatcher claimed it before
 * the launch. Below the line naming the issue, the instruction is
 * the repo's `pickup` prompt, or the default (dispatch/prompts.mjs).
 *
 * The lead line is context, not naming: it puts the issue's title in front of
 * the session before it fetches anything. {@link sessionName} and the
 * launcher's `--name` do the naming.
 *
 * @param {number} number
 * @param {string | undefined} title
 * @param {string} repo
 * @param {string} claim The label the dispatcher claimed it with: the repo's own (dispatch/repo-config.mjs).
 * @param {Record<string, string | undefined>} [prompts] The repo's config file's prompts.
 */
export const promptFor = (number, title, repo, claim, prompts = {}) => {
  const lead = oneLine(title);
  return [
    lead ? `Pickup #${number} '${lead}'` : `Pickup #${number}`,
    '',
    instruction(prompts, 'pickup', { issue: number, repo, claim }),
  ].join('\n');
};

/**
 * What one exit status of `dispatch/launch-session.py` means.
 *
 * The launcher says three things. 0 is confirmed. 3 is unconfirmed,
 * meaning a clock ran out with `claude` still running, either the idle
 * window it may say nothing for or the deadline on the whole dispatch.
 * Anything else is a dispatch that never started. The middle one is
 * not a failure: the "Resume with:" marker is the only signal there is, so a
 * missing one leaves a session that may well be running.
 *
 * The status is `python3`'s as much as the launcher's, which is why
 * unconfirmed is 3. Python exits 2 by itself when it cannot open the script,
 * and 1 on an uncaught exception, both before any `claude` runs. Those belong
 * in the failure arm.
 *
 * @param {number | null} code Exit status; null when the launcher was signalled.
 * @returns {'dispatched' | 'unconfirmed' | null} null for a failure.
 */
export const launchOutcome = (code) => {
  if (code === 0) return 'dispatched';
  if (code === 3) return 'unconfirmed';
  return null;
};
