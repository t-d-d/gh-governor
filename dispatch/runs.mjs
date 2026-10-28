/**
 * Reading a workflow's runs on the repo's default branch, which the fire
 * names: the list, read again while it lags the
 * run being planned, paged back to a baseline, and what a run's jobs say it
 * shipped. dispatch/coverage.mjs reads a finished run's range through these;
 * the scheduled turn reads the run before a red one
 * (dispatch/turn.mjs), and a branch run its commits (dispatch/branch-run.mjs).
 *
 * Each workflow has a cursor in the dispatcher's state table:
 * the newest run whose news a turn planned. A turn that refused
 * leaves it, so the next run's range starts at the cursor and covers the
 * refused run's merges too. With no cursor, the baseline is searched for in
 * the runs list as before.
 */

import { RUNS_PER_PAGE } from '../scripts/lib/github-app.mjs';
import { shippingJob } from './webhook/fire.mjs';

/**
 * @typedef {import('../scripts/lib/github-app.mjs').JobRow} JobRow
 * @typedef {import('../scripts/lib/github-app.mjs').RunRow} RunRow
 * @typedef {import('./workflow.mjs').WorkflowReader} WorkflowReader
 * @typedef {{ runId: number, commit: string, created: string }} Cursor
 *   A workflow's newest run whose news a turn planned: its id, the commit it
 *   built (a deploy) or tested (CI), and when it was created.
 */

/**
 * The pauses before each re-read of a runs list that lacks the run being
 * planned. The list has lagged a run's end by three minutes (Deploy run
 * 36701093155), so the re-reads span more than that; a workflow turn waits
 * them out at most once (dispatch/coverage.mjs), and its send window (dispatch/turn.mjs
 * WORKFLOW_SEND_WINDOW_MS) leaves a minute after them to plan.
 */
export const STALE_RUNS_PAUSES_MS = [10_000, 30_000, 60_000, 90_000];

/**
 * The most pages of runs a turn reads looking for its baseline, each
 * RUNS_PER_PAGE runs of every branch.
 */
export const RUNS_PAGES_MAX = 20;

/** The most green runs whose jobs a turn reads looking for one that shipped. */
export const BASELINE_READS_MAX = 25;

/** A merge commit GitHub's merge button wrote. */
export const MERGE_OF_PR = /^Merge pull request #\d+ /;

/** @param {string} sha */
export const short = (sha) => sha.slice(0, 12);

/**
 * The commits after `base` up to `head`, and the merge commits among them:
 * what a run covers when CI cancelled the runs between (a push to main
 * cancels the one in progress) or a deploy ships every merge since the
 * last. No commit when `head` is `base` or behind it (a release of an
 * older commit than the last one built), or with no base.
 *
 * @param {WorkflowReader} reader
 * @param {string | undefined} base
 * @param {string} head
 * @returns {Promise<{ commits: number, merges: string[] }>}
 */
export const rangeSince = async (reader, base, head) => {
  const commits = base === undefined || base === head ? [] : await reader.compareCommits(base, head);
  return { commits: commits.length, merges: commits.filter((c) => MERGE_OF_PR.test(c.message)).map((c) => c.sha) };
};

/**
 * The runs on `branch`, of `filter`'s event and status, kept from one page of
 * the unfiltered list. GitHub's filtered list (`branch`,
 * `event`, `status`) has served an index months old while the unfiltered
 * one held the run (Deploy run 36879724895), so the filters are applied
 * here.
 *
 * @param {RunRow[]} rows
 * @param {string} branch
 * @param {{ event?: string, status?: string }} [filter]
 */
const onBranch = (rows, branch, { event, status } = {}) =>
  rows.filter((r) => r.head_branch === branch && (event === undefined || r.event === event) && (status === undefined || r.status === status));

/**
 * The runs of `file` on `branch` ({@link onBranch}), read again after each pause
 * while they lack `runId`. `fresh`: the last read holds it; `page`: the
 * last read's page, every branch's runs, for {@link baselineIn}.
 *
 * @param {Pick<WorkflowReader, 'workflowRuns'>} reader
 * @param {string} file
 * @param {number} runId
 * @param {(ms: number) => Promise<void>} sleep
 * @param {string} branch The repo's default branch.
 * @param {{ event?: string, status?: string }} [filter] Narrows the runs read.
 * @returns {Promise<{ runs: RunRow[], fresh: boolean, page: RunRow[] }>}
 */
export const freshRuns = async (reader, file, runId, sleep, branch, filter = {}) => {
  const read = async () => {
    const page = await reader.workflowRuns(file, {});
    const runs = onBranch(page, branch, filter);
    return { runs, fresh: runs.some((r) => r.id === runId), page };
  };
  let got = await read();
  for (const pause of STALE_RUNS_PAUSES_MS) {
    if (got.fresh) break;
    await sleep(pause);
    got = await read();
  }
  return got;
};

/**
 * Whether `job` is one that ships: its name carries the marker (`shippingJob`
 * in webhook/fire.mjs), for `label` where one is asked for.
 *
 * @param {Pick<JobRow, 'name'>} job
 * @param {string} [label]
 */
export const shipsAs = (job, label) => {
  const marked = shippingJob(job.name);
  return marked !== null && (label === undefined || marked.label === label);
};

/**
 * The jobs of a run that ship `label` (any label with none asked) and succeeded.
 *
 * @param {JobRow[]} jobs
 * @param {string} [label]
 */
const shipping = (jobs, label) => jobs.filter((j) => j.conclusion === 'success' && shipsAs(j, label));

/**
 * Why a run's jobs shipped nothing, or null when they shipped: a job marked
 * with `label` (any marker with none asked) must have succeeded. A dry run
 * renames or skips the marked job.
 *
 * @param {JobRow[]} jobs
 * @param {string} [label]
 * @returns {string | null}
 */
export const shippedNothing = (jobs, label) => {
  if (jobs.length === 0) return 'it ran no job';
  if (shipping(jobs, label).length > 0) return null;
  return label === undefined ? 'no job marked "\u00b7 deployed: \u2026" succeeded' : `no job marked "\u00b7 ${label}" succeeded`;
};

/**
 * The commit a run built: the one a marked job that succeeded (for `label`,
 * or any) names after ` at `, else its head.
 *
 * @param {JobRow[]} jobs
 * @param {string} head
 * @param {string} [label]
 */
export const builtCommit = (jobs, head, label) => {
  for (const { name } of shipping(jobs, label)) {
    const commit = shippingJob(name)?.commit;
    if (commit !== undefined) return commit;
  }
  return head;
};

/** What a pick returns when it has read the jobs of BASELINE_READS_MAX runs. */
export const OUT_OF_READS = Symbol('out of job reads');

/**
 * The baseline `pick` finds among `branch`'s runs in `runs`, the first page of
 * `file`'s runs of every branch, reading the pages after it until one
 * holds it, a short page ends the runs, RUNS_PAGES_MAX pages are read, or
 * the pick runs out of job reads. Runs created between reads push runs
 * already read onto the next page; those are skipped. `read` counts
 * `branch`'s runs only.
 *
 * @template {RunRow} T
 * @param {Pick<WorkflowReader, 'workflowRuns'>} reader
 * @param {string} file
 * @param {string} branch The repo's default branch.
 * @param {RunRow[]} runs
 * @param {(runs: RunRow[]) => T | null | typeof OUT_OF_READS | Promise<T | null | typeof OUT_OF_READS>} pick
 * @returns {Promise<{ baseline: T | null, read: number, capped: string | null }>}
 */
export const baselineIn = async (reader, file, branch, runs, pick) => {
  const first = onBranch(runs, branch);
  const seen = new Set(first.map((r) => r.id));
  let last = runs;
  let page = 1;
  let got = await pick(first);
  while (got === null && last.length >= RUNS_PER_PAGE && page < RUNS_PAGES_MAX) {
    page += 1;
    last = await reader.workflowRuns(file, { page });
    // The pages before held no baseline, so the newest in the unseen rows is the newest overall.
    const unseen = onBranch(last, branch).filter((r) => !seen.has(r.id));
    for (const r of unseen) seen.add(r.id);
    got = await pick(unseen);
  }
  if (got === OUT_OF_READS) return { baseline: null, read: seen.size, capped: `stopped at the jobs of ${BASELINE_READS_MAX} green runs` };
  return { baseline: got, read: seen.size, capped: got === null && last.length >= RUNS_PER_PAGE ? `stopped reading at ${RUNS_PAGES_MAX} pages` : null };
};

/**
 * What a reason adds for a search a cap stopped: which cap.
 *
 * @param {{ capped: string | null }} search
 */
export const stoppedAt = ({ capped }) => (capped === null ? '' : `; ${capped}`);
