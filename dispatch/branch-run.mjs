/**
 * Who hears of a run dispatched on a branch, and what: the branch-run
 * turn's plan.
 *
 * A session dispatches a run on its branch (an emulator, device or Apple
 * run, CI's one-client leg) and waits on it before it raises or readies its
 * PR. The receiver queues a `branch-run` fire when
 * one finishes, whatever it concluded (dispatch/webhook/route.mjs); it holds
 * no GitHub token, so the reads are here.
 *
 * The session told is the one that wrote the commit the run tested, read
 * off its `Claude-Session` trailer ({@link commitSession}): the session that
 * pushed a branch's head is the one that dispatches on it. A local session
 * writes no trailer, so with none the live local session holding the
 * branch is asked for, as a PR's owner is. With neither, nobody is told.
 * Nothing starts in a gone session's place: a run nobody waits on owes
 * nothing.
 *
 * `planBranchRun` reads through the injected reader and writes nothing;
 * dispatch/turn.mjs sends what it plans.
 */

import { FAILED, RED } from './webhook/fire.mjs';
import { jobList } from './workflow.mjs';
import { MERGE_OF_PR, short } from './runs.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/** Names no repo's skill: a session finds its own through its CLAUDE.md. */
const LOGS = "Read the failed jobs' logs and find the cause.";

/**
 * @typedef {import('./webhook/fire.mjs').BranchRunFire} BranchRunFire
 * @typedef {import('../scripts/lib/github-app.mjs').JobRow} JobRow
 * @typedef {(sha: string) => Promise<{ message: string, parents?: string[] }>} ReadCommit
 * @typedef {{ commit: ReadCommit, runJobs: (runId: number) => Promise<JobRow[]> }} BranchRunReader
 * @typedef {{ session: string | null, text: string | null, reason: string }} BranchRunPlan
 *   `session`: whom to tell, or null for nobody; `text`: what, where there is someone.
 */

/** A commit's `Claude-Session` trailer, the session that wrote it. */
const COMMIT_SESSION = /^Claude-Session:[ \t]*(\S+)[ \t]*$/m;

/** How many trailerless merges a commit is followed through to one that names its session. */
export const MERGE_DEPTH = 5;

/**
 * The session that wrote `sha`: its `Claude-Session` trailer's, or null. A
 * merge with no trailer (a catch-up `git merge origin/main`) is its first
 * parent's, the branch it was made on, up to MERGE_DEPTH merges. A merge
 * GitHub's button wrote is main's, and names nobody: a branch cut from main
 * with no commit of its own has one at its head, and main's history is
 * other sessions'. A read that fails throws.
 *
 * @param {ReadCommit} read
 * @param {string} sha
 * @returns {Promise<string | null>}
 */
export const commitSession = async (read, sha) => {
  let at = sha;
  for (let depth = 0; depth < MERGE_DEPTH; depth += 1) {
    const { message, parents = [] } = await read(at);
    const named = COMMIT_SESSION.exec(message)?.[1];
    if (named !== undefined) return named;
    if (parents.length < 2 || MERGE_OF_PR.test(message)) return null;
    at = /** @type {string} */ (parents[0]);
  }
  return null;
};

/**
 * What the run's conclusion asks of the session waiting on it.
 *
 * A cancelled run is not re-run on cue: a workflow whose runs share one
 * concurrency queue (emulator, device, e2e) cancels a waiting run when a
 * newer one is dispatched, and re-running it would cancel that one in turn,
 * whose session is then told the same.
 *
 * @param {BranchRunFire} run
 * @param {JobRow[] | null} failed Null when the jobs could not be read.
 * @returns {string[]}
 */
const verdict = (run, failed) => {
  if (run.conclusion === 'success') {
    return ["If you dispatched it to wait on before raising or readying your PR, that wait is over for this commit: carry on if it is still your branch's head."];
  }
  if (RED.has(run.conclusion)) {
    const jobs = failed === null ? ['- the failed jobs could not be read; the run page names them'] : jobList(failed);
    return ['Failed jobs:', ...jobs, '', `${LOGS} If ${short(run.headSha)} is still your branch's head, fix it, push, and re-run it: a red run is a fix and a re-run, not a Verification row.`];
  }
  if (run.conclusion === 'cancelled') {
    return [`It gave no verdict: a newer dispatch of ${run.name} replaced it in its concurrency queue, or someone stopped it. If you are waiting on it, check \`actions_list\` first: re-running while a run of it is queued or in progress cancels that one, so re-run once none is.`];
  }
  return ['It gave no verdict: if you are waiting on it, re-run it.'];
};

/**
 * Who hears of `invocation`, and what.
 *
 * @param {{ invocation: BranchRunFire, reader: BranchRunReader, onBranch?: (branch: string) => Promise<string | null> }} args
 *   `onBranch`: the live local session holding a branch, or null; a lookup
 *   that fails throws.
 * @returns {Promise<BranchRunPlan>}
 */
export const planBranchRun = async ({ invocation: run, reader, onBranch }) => {
  const { name, runId, branch, headSha } = run;
  const commit = short(headSha);
  const signed = await commitSession(reader.commit, headSha);
  const session = signed ?? (onBranch === undefined ? null : await onBranch(branch));
  if (session === null) {
    return { session: null, text: null, reason: `${name} run ${runId} on ${branch}: no session signed its commit ${commit}, and no live local session holds the branch` };
  }
  // The jobs only name what failed; a read of them that fails still tells
  // the waiting session the verdict, and the reason says why they are missing.
  /** @type {JobRow[] | null} */
  let failed = [];
  /** @type {string | null} */
  let jobsError = null;
  if (RED.has(run.conclusion)) {
    try {
      failed = (await reader.runJobs(runId)).filter((j) => FAILED.has(String(j.conclusion)));
    } catch (error) {
      failed = null;
      jobsError = messageOf(error);
    }
  }
  const attempt = (run.runAttempt ?? 1) > 1 ? ` (attempt ${run.runAttempt})` : '';
  const whose = signed === null ? `It ran on ${commit}, and you hold the branch.` : `You wrote the commit it ran on, ${commit}.`;
  const text = [
    `${name} run ${runId}${attempt}, dispatched on ${branch}, concluded ${run.conclusion}. ${whose}`,
    '',
    `Run: ${run.url}`,
    ...verdict(run, failed),
    '',
    'If you did not dispatch it, nothing is owed.',
  ].join('\n');
  const reason = signed === null
    ? `${name} run ${runId} on ${branch}: no session signed its commit ${commit}; the local session ${session} holds the branch`
    : `${name} run ${runId} on ${branch}: its commit ${commit}'s Claude-Session trailer names ${session}`;
  return { session, text, reason: jobsError === null ? reason : `${reason}; its jobs could not be read: ${jobsError}` };
};
