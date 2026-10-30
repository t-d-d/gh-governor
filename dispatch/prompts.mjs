/**
 * The instruction in each message the dispatcher sends, and in the opening
 * prompt of each session it starts. A message is facts the
 * dispatcher writes (what happened, the PR or issue, the run and commit, the
 * session's standing line) and an instruction about what to do with them.
 * A served repo's config file may replace the instruction through its
 * `prompts` map, keyed by message kind ({@link PROMPTS}); the facts stay the
 * dispatcher's.
 *
 * Every kind has a default, and the defaults are generic: they name no
 * repo's skill, file or section. A prompt may name a fact the kind has,
 * `{pr}` say, and the dispatcher writes it in ({@link instruction}); a
 * placeholder the kind lacks makes the file invalid (dispatch/repo-config.mjs).
 *
 * The task reads the prompts, from the config file it already reads each
 * turn; the receiver holds no token and reads none.
 */

import { SIGN_OFF } from '../scripts/lib/session-signoff.mjs';

const LOGS = "Read the failed jobs' logs and find the cause.";

/**
 * @typedef {{ text: string, fills: readonly string[] }} Kind
 *   `text`: the default. `fills`: the facts a prompt may name, as `{name}`.
 */

/** Every message kind, its default and the facts it may name. @type {Readonly<Record<string, Kind>>} */
export const PROMPTS = Object.freeze({
  // A pickup session's opening prompt, after the line naming its issue (scripts/lib/dispatch-prompt.mjs).
  pickup: {
    text: [
      'Implement GitHub issue #{issue} in {repo} through to a reviewable PR.',
      'The dispatcher claimed #{issue} for this session: it is `{claim}` for you, so proceed on it.',
      'Unattended session: push and raise the PR without asking, `Closes #{issue}`.',
    ].join('\n'),
    fills: ['issue', 'repo', 'claim'],
  },
  // The standing line's ask, when nothing else names the session (dispatch/deliveries.mjs).
  signOff: {
    text: `Sign this session off unless you know otherwise (work not on GitHub or in another repo, a check you still owe, or the operator is working with you in this session, which is theirs to end): make \`${SIGN_OFF}\` the last line of your reply, and the dispatcher archives the session.`,
    fills: [],
  },
  // A blocker's close, in the blocked ticket's own repo (dispatch/unblocked.mjs).
  // A ready ticket's pickup prompt, after the facts of the close.
  unblockedReady: {
    text: "Before you build, check the spec against what merged, and fix the ticket's body where the merge changed what it builds on.",
    fills: [],
  },
  // A ticket not ready to pick up: a fresh session with no claim.
  unblockedSpec: {
    text: [
      "Rewrite #{issue}'s spec from what merged. If it needs a decision only a person can make, write that into its body as a question and stop.",
      'Otherwise label it {ready} and stop, or build it: add `{claim}` to it first, then take it through to a reviewable PR, `Closes #{issue}`.',
    ].join('\n'),
    fills: ['issue', 'ready', 'claim'],
  },
  // A claimed ticket's session, told its blocker closed.
  unblockedClaimed: {
    text: 'Check your work on #{issue} against what merged, and change it where the merge calls for that.',
    fills: ['issue'],
  },
  // A blocker closed as not planned: a comment on the ticket, and its session's message if it is claimed.
  unblockedNotPlanned: {
    text: 'Its work will not land as planned. Decide whether this ticket still stands, and what it needs instead.',
    fills: [],
  },
  // The red scheduled run's fresh session (dispatch/webhook/route.mjs gives the facts).
  redScheduledRun: {
    text: `${LOGS} First search the open issues and PRs for it: if one already covers this failure, comment this run on it and stop. If the fix is in the repo, push it on a new branch from the default branch with a new PR. If it is not (a lapsed credential, a third-party outage), raise an issue saying what failed and what it needs.`,
    fills: [],
  },
  // The CI and deploy notices and triage prompts (dispatch/workflow.mjs).
  ciBreaker: {
    text: `${LOGS} If the cause is in your change, push the fix on a new branch from the default branch with a new PR: PR #{pr} is merged and its branch is done. If it is not, comment on PR #{pr} with what you found instead.`,
    fills: ['pr'],
  },
  ciTriage: {
    text: `${LOGS} Work out which merge caused it, and push the fix on a new branch from the default branch with a new PR naming that PR. Then comment on the culprit PR with what broke and a link to your fix.`,
    fills: [],
  },
  ciBumpTriage: {
    text: `${LOGS} If the bump caused it, push the fix on a new branch from the default branch with a new PR naming PR #{pr}: the change the new version needs. Where none is in reach, revert the bump in that PR instead and raise an issue naming the bump and what broke, since Dependabot raises it again. Then comment on PR #{pr} with what broke and a link to your fix. If the bump did not cause it, comment on PR #{pr} with what you found instead.`,
    fills: ['pr'],
  },
  prodTriage: {
    text: `${LOGS} If a merge caused it, push the fix on a new branch from the default branch with a new PR naming that PR, and comment on it with what broke and a link to your fix. If none did (a prod-only secret, store or quota), raise an issue saying what broke and what the operator must do.`,
    fills: [],
  },
  deployGreen: {
    text: 'Run any check your PR promised for the {target} deploy, and report the result on PR #{pr}. If it promised none, nothing is owed.',
    fills: ['pr', 'target'],
  },
  deployGreenMany: {
    text: 'Run any check their PRs promised for the {target} deploy, and report the results in one comment on PR #{pr}, the newest. If none promised any, nothing is owed.',
    fills: ['pr', 'target'],
  },
  deployRed: {
    text: `${LOGS} If your change caused it, push the fix on a new branch from the default branch with a new PR. If it did not, nothing is owed; say what you found on PR #{pr}.`,
    fills: ['pr'],
  },
  deployRedMany: {
    text: `${LOGS} If one of your changes caused it, push the fix on a new branch from the default branch with a new PR. If none did, nothing is owed; say what you found in one comment on PR #{pr}, the newest.`,
    fills: ['pr'],
  },
  // What a subscriber to a PR it did not write is asked to do with a CI or deploy notice.
  subscribed: {
    text: 'Act only on what is yours: a check you promised, a change of yours this bears on.',
    fills: [],
  },
  // A PR a merge left conflicted, to its session or the fallback's (dispatch/conflicts.mjs).
  conflicts: {
    text: 'Merge {base} into your branch, resolve the conflicts, run the checks and push.',
    fills: ['base'],
  },
});

/**
 * Prompt keys a served file may still set, though governor sends no
 * message of their kind: the schema is strict, and a file the change made
 * invalid would stop its repo being served (dispatch/repo-config.mjs).
 * The merge hand-off's two went when a blocker's close came to be handled
 * in each blocked ticket's own repo (dispatch/unblocked.mjs).
 */
export const RETIRED_PROMPTS = Object.freeze(['mergeHandoff', 'mergeHandoffUnread']);

/** A fact a prompt names. */
const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/**
 * The placeholders in `text` that `kind` has no fact for.
 *
 * @param {string} kind
 * @param {string} text
 * @returns {string[]}
 */
export const unknownFills = (kind, text) => {
  const fills = PROMPTS[kind]?.fills ?? [];
  return [...text.matchAll(PLACEHOLDER)].map((m) => /** @type {string} */ (m[1])).filter((name) => !fills.includes(name));
};

/**
 * The instruction for `kind`: the repo's prompt, or the default, with the
 * facts it names written in.
 *
 * @param {Readonly<Record<string, string | undefined>> | undefined} prompts A config file's `prompts`.
 * @param {keyof typeof PROMPTS} kind
 * @param {Readonly<Record<string, string | number>>} [fills]
 * @returns {string}
 */
export const instruction = (prompts, kind, fills = {}) => {
  const known = PROMPTS[kind];
  if (known === undefined) throw new Error(`no message kind ${kind}`);
  const text = prompts?.[kind] ?? known.text;
  return text.replace(PLACEHOLDER, (whole, name) => (known.fills.includes(name) && fills[name] !== undefined ? String(fills[name]) : whole));
};
