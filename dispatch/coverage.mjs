/**
 * What a shipping job, or a red run, on the repo's default branch covers,
 * the branch the fire names: the
 * one reading that both the label write (dispatch/turn.mjs `ticketsOf`) and
 * the messages (dispatch/workflow.mjs) consume. It reads, once each, the
 * run's workflow file, its jobs where they are needed, the runs before it,
 * the label's cursor, the baseline, the merges since and the PRs they
 * merged, and returns the facts it reached or the one reason it stopped. It
 * decides nothing about whom to tell or what to label.
 *
 * A shipping job that succeeded (a `job` fire; the job's name carries the
 * label it earns and the commit it built, `shippingJob` in webhook/fire.mjs):
 *
 * - The run is read by id for its workflow file, and the file at the run's
 *   head for `TICKET_LABEL_PATHS` (dispatch/labels.mjs).
 * - Its baseline is the label's cursor, the newest run a turn planned for
 *   that label (dispatch/runs.mjs), else the last green
 *   run on the branch with a successful job marked with the same label, searched
 *   for page by page up to RUNS_PAGES_MAX pages and BASELINE_READS_MAX job
 *   reads, its commit the one that job names, else its head. Per label: one
 *   run earns dev then prod, and a run that stopped after dev is no baseline
 *   for prod.
 * - A cursor at or past the run is a turn that planned it: a re-run attempt,
 *   or a second job marked with the same label in one run, covers nothing.
 * - It shipped no merge when it built its baseline's commit, or one its
 *   baseline covers (a release dispatched at an older commit).
 * - Its paths pick the PRs it merged with a changed file (or the path a
 *   rename left) they match; `all` picks every one.
 *
 * A red run of a workflow declaring a deploy target (a `workflow` fire): its
 * target is the final stage's, the last label the file's jobs earn
 * (`shippingLabelsOf` in dispatch/labels.mjs, a `uses:` job's read from the
 * called file). It covers when a merge starts the workflow (`on.push`,
 * `on.workflow_run`) or the target is one the repo's config triages
 * (`workflows.triage`), and a shipping job ran; a red release dispatched
 * by hand covers nothing, since whoever dispatched it is watching it. It built the commit a successful shipping job names, else
 * its head; its baseline is that label's, as above. A green run fire covers
 * nothing: its shipping jobs each fired.
 *
 * A red CI run (a run of the file the repo's config names `workflows.ci`;
 * with none, no run is CI) started by a push is the same shape with CI's
 * own baseline rule: the newest push run before it that finished green or red, passing over a red run
 * newer than the cursor (its turn never planned). A red baseline stops the
 * reading: its breaker was told. Every PR it merged is a suspect.
 *
 * The runs list can lag a run: one lacking it is read again after
 * each of STALE_RUNS_PAUSES_MS, and still lacking it, covers nothing, as
 * does a cursor that cannot be read. Both set `stale`, which the turn logs
 * as `dispatch-stale-runs` for an alarm to count.
 */

import { closedBy } from './pr-body.mjs';
import { pathsMatch, shippingLabelsOf, ticketLabelOf } from './labels.mjs';
import { FAILED, LABEL_PREFIX, WORKFLOW_PATH } from './webhook/fire.mjs';
import {
  BASELINE_READS_MAX, OUT_OF_READS, STALE_RUNS_PAUSES_MS, baselineIn, builtCommit, freshRuns, rangeSince, shippedNothing, shipsAs, short, stoppedAt,
} from './runs.mjs';
import { sameSession, sessionId, subscribersFor } from './webhook/subscribe.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { isCi } from './repo-config.mjs';

/**
 * @typedef {import('./webhook/fire.mjs').WorkflowFire} WorkflowFire
 * @typedef {import('./webhook/fire.mjs').JobFire} JobFire
 * @typedef {import('../scripts/lib/github-app.mjs').PullRow} PullRow
 * @typedef {import('../scripts/lib/github-app.mjs').JobRow} JobRow
 * @typedef {import('../scripts/lib/github-app.mjs').RunRow} RunRow
 * @typedef {import('./runs.mjs').Cursor} Cursor
 * @typedef {import('./workflow.mjs').WorkflowReader} WorkflowReader
 * @typedef {import('./labels.mjs').TicketLabel} TicketLabel
 * @typedef {import('./repo-config.mjs').Workflows} Workflows
 * @typedef {{ id: number, commit: string, created: string, conclusion: string, url: string }} Baseline
 *   The run a range starts after, and the commit it built (a deploy) or tested (CI).
 * @typedef {{ baseline: { id: number, commit: string, created: string }, end: string, merges: number }} Range
 *   What the turn logs before it labels or sends: the baseline, the
 *   commit the run built or tested, and the merge commits the compare returned.
 * @typedef {{ session: string, own: PullRow[], subscribed: PullRow[] }} Heard
 * @typedef {{
 *   reason: string | null,
 *   stale: { newest: { id: number, created: string } | null } | null,
 *   workflow: string | null,
 *   label: string | null,
 *   declared: TicketLabel | null,
 *   jobs: JobRow[],
 *   from: Cursor | null,
 *   at: Cursor | null,
 *   baseline: Baseline | null,
 *   range: Range | null,
 *   merges: string[],
 *   shipped: PullRow[],
 *   picked: PullRow[],
 *   closes: Map<number, number[]>,
 *   sessions: (prs: PullRow[], event: 'ci' | 'deploys') => Promise<{ sessions: Map<string, Heard>, owned: Set<number>, unnamed: Array<{ pr: number, reason: string }> }>,
 * }} Coverage
 *   `reason`: why the reading stopped short of the PRs, null when it reached
 *   them (or, for CI, a red baseline). `stale`: the stop is one the turn
 *   pages on. `workflow`: the workflow file's name, which keys the cursor,
 *   once known; `label`: the label the cursor is keyed by, null for CI.
 *   `declared`: a deploy target's paths. `jobs`: the run's jobs, read for a
 *   red run. `from`: the label's cursor below this run. `at`: this run as a
 *   cursor, once the fresh runs list holds it. `range`: set once the merges
 *   are read.
 *   `shipped`: the PRs the range merged, the one at its end always;
 *   `picked`: those the paths pick (CI: every one); `closes`: each shipped
 *   PR's closing tickets, as GitHub reads them. `sessions`: each PR's
 *   owner (by footer, else the live session on its head branch) and its
 *   subscribers to `event`, read on ask, so a triage reads no branch.
 */

/**
 * The PRs `merges` merged, the one `end` merged always: those whose merge
 * commit it is. A PR that merely contains the commit (an open branch that
 * merged main) is not one.
 *
 * @param {WorkflowReader} reader
 * @param {string[]} merges
 * @param {string} end
 * @returns {Promise<PullRow[]>}
 */
const mergedIn = async (reader, merges, end) => {
  const shas = [...new Set([...merges.filter((sha) => sha !== end), end])];
  return (await Promise.all(shas.map(async (sha) => (await reader.pullsForCommit(sha)).filter((p) => p.merged_at && p.merge_commit_sha === sha)))).flat();
};

/**
 * The PRs of `prs` a target's paths pick: every one for `all`, otherwise
 * each with a changed file (or the path a rename left) they match. Reads
 * only the files of `prs`.
 *
 * @param {WorkflowReader} reader
 * @param {'all' | string[]} paths
 * @param {PullRow[]} prs
 */
const pickedBy = async (reader, paths, prs) => {
  if (paths === 'all') return prs;
  const files = await Promise.all(prs.map(async (pr) => (await reader.pullFiles(pr.number)).flatMap((f) => (f.previous === undefined ? [f.filename] : [f.filename, f.previous]))));
  return prs.filter((_, i) => (files[i] ?? []).some((f) => pathsMatch(paths, f)));
};

/**
 * Oldest merge first.
 *
 * @param {PullRow} a
 * @param {PullRow} b
 */
export const byMerge = (a, b) => String(a.merged_at).localeCompare(String(b.merged_at)) || a.number - b.number;

/**
 * The sessions `prs` name for `event`, each with the PRs it wrote and those
 * it subscribes to, oldest merge first. A PR naming none has its owner
 * looked up by head branch; one still with nobody is `unnamed`. `owned`:
 * the PRs a session wrote.
 *
 * @param {PullRow[]} prs
 * @param {'ci' | 'deploys'} event
 * @param {((branch: string) => Promise<string | null>) | undefined} onBranch
 */
const sessionsOf = async (prs, event, onBranch) => {
  /** @type {Map<string, Heard>} */
  const sessions = new Map();
  /** @type {Set<number>} */
  const owned = new Set();
  /** @type {Array<{ pr: number, reason: string }>} */
  const unnamed = [];
  for (const pr of [...prs].sort(byMerge)) {
    let subscribers = subscribersFor(pr.body, event);
    /** Why the PR has no owner, where it has none. @type {string} */
    let ownerless = 'a person\'s, or its footer is gone';
    let lookupFailed = false;
    if (!subscribers.some((s) => s.owner) && onBranch !== undefined && pr.head !== '') {
      try {
        const found = await onBranch(pr.head);
        if (found !== null) subscribers = [{ session: found, owner: true }, ...subscribers.filter((s) => !sameSession(s.session, found))];
        else ownerless = `no live session holds its head branch ${pr.head}`;
      } catch (error) {
        ownerless = `its head branch ${pr.head} could not be looked up: ${messageOf(error)}`;
        lookupFailed = true;
        unnamed.push({ pr: pr.number, reason: `PR #${pr.number} names no session, and ${ownerless}` });
      }
    }
    if (subscribers.length === 0) {
      if (!lookupFailed) unnamed.push({ pr: pr.number, reason: `PR #${pr.number} names no session (${ownerless}), and nobody subscribes to its ${event}` });
      continue;
    }
    if (subscribers.some((s) => s.owner)) owned.add(pr.number);
    for (const { session, owner } of subscribers) {
      const heard = sessions.get(sessionId(session)) ?? { session, own: [], subscribed: [] };
      sessions.set(sessionId(session), heard);
      (owner ? heard.own : heard.subscribed).push(pr);
    }
  }
  return { sessions, owned, unnamed };
};

/**
 * The newest green run of `file` on `branch` before `runId` with a successful
 * job marked `label`, and the commit that job built. A dry run renames or
 * skips the job, and a run that stopped before the stage never ran it:
 * neither is a baseline, so the next real run ships its merges too. Reads
 * the jobs of at most BASELINE_READS_MAX runs across every page.
 *
 * @param {WorkflowReader} reader
 * @param {string} file
 * @param {string} branch
 * @param {RunRow[]} page The first page, every branch's runs.
 * @param {number} runId
 * @param {string} label
 */
const shippedBaseline = (reader, file, branch, page, runId, label) => {
  let reads = 0;
  return baselineIn(reader, file, branch, page, async (rows) => {
    for (const r of rows.filter((row) => row.id < runId && row.conclusion === 'success').sort((a, b) => b.id - a.id)) {
      if (reads >= BASELINE_READS_MAX) return OUT_OF_READS;
      reads += 1;
      const jobs = await reader.runJobs(r.id);
      if (shippedNothing(jobs, label) === null) return { ...r, built: builtCommit(jobs, r.head_sha, label) };
    }
    // Spent: no further page is read for a pick that can read no jobs.
    return reads >= BASELINE_READS_MAX ? OUT_OF_READS : null;
  });
};

/**
 * The newest push run before `runId` that finished green or red, a
 * timed-out one red. A cancelled or skipped run says nothing about main, and
 * neither does one dispatched by hand, which may have run one job. A red
 * run newer than the cursor was never planned (its turn refused), so it is
 * passed over; with no cursor, none is.
 *
 * @param {RunRow[]} runs
 * @param {number} runId
 * @param {Cursor | null} cursor
 * @returns {RunRow | null}
 */
const previousConclusive = (runs, runId, cursor) =>
  runs
    .filter((r) => r.id < runId && r.event === 'push' && r.status === 'completed' && (r.conclusion === 'success' || FAILED.has(String(r.conclusion))))
    .filter((r) => r.conclusion === 'success' || cursor === null || r.id <= cursor.runId)
    .sort((a, b) => b.id - a.id)[0] ?? null;

/**
 * Why a runs list that never held `runId` covers nothing, and the newest
 * run it did hold.
 *
 * @param {string} name
 * @param {number} runId
 * @param {RunRow[]} runs
 */
const staleList = (name, runId, runs) => {
  const top = [...runs].sort((a, b) => b.id - a.id)[0];
  const held = top === undefined ? 'no run' : `run ${top.id} (${top.created_at}) as its newest`;
  return {
    reason: `${name} run ${runId}: the runs list still lacked it after ${STALE_RUNS_PAUSES_MS.length} re-reads, holding ${held}; a baseline read from it could be days old, so its range is unknown`,
    stale: { newest: top === undefined ? null : { id: top.id, created: top.created_at } },
  };
};

/**
 * Why a run whose label's cursor could not be read covers nothing: a range
 * read without it could start after a run whose merges nobody was told. It
 * pages as a stale list does.
 *
 * @param {string} name
 * @param {number} runId
 * @param {unknown} error
 */
const unreadCursor = (name, runId, error) => ({
  reason: `${name} run ${runId}: its label's cursor could not be read (${messageOf(error)}); a range read without it could skip a run whose merges nobody was told, so its range is unknown`,
  stale: { newest: null },
});

/** A workflow file's name, which keys its cursor, off its path. @param {string} path */
export const fileOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Why a search that found no baseline covers nothing.
 *
 * @param {string} what The baseline it looked for.
 * @param {number} runId
 * @param {string} file
 * @param {string} branch
 * @param {{ read: number, capped: string | null }} got
 */
const noBaseline = (what, runId, file, branch, got) =>
  `no ${what} before run ${runId} in the ${got.read} runs of ${file} on ${branch}${stoppedAt(got)}, so its range is unknown`;

/**
 * What `invocation` covers: a shipping job that succeeded on the default
 * branch, or a red run there.
 *
 * @param {{
 *   invocation: WorkflowFire | JobFire,
 *   reader: WorkflowReader,
 *   repo: string,
 *   workflows: Workflows,
 *   sleep: (ms: number) => Promise<void>,
 *   cursor: (workflow: string, label: string | null) => Promise<Cursor | null>,
 *   onBranch?: (branch: string) => Promise<string | null>,
 * }} args `workflows`: the repo's config file's (dispatch/repo-config.mjs).
 *   `sleep`: the pause before a stale runs list is read again.
 *   `cursor`: the cursor of `label` under `workflow` (CI's is label-less),
 *   null when it has none; a read that fails throws. `onBranch`: the live
 *   session holding a branch, or null; a lookup that fails throws.
 * @returns {Promise<Coverage>}
 */
export const coverageOf = async ({ invocation, reader, repo, workflows, sleep, cursor, onBranch }) => {
  const { name, runId } = invocation.kind === 'job' ? { name: invocation.workflow, runId: invocation.runId } : invocation;
  const { branch } = invocation;
  /** @type {Coverage} */
  const facts = {
    reason: null, stale: null, workflow: null, label: null, declared: null, jobs: [], from: null, at: null, baseline: null, range: null,
    merges: [], shipped: [], picked: [], closes: new Map(),
    sessions: (prs, event) => sessionsOf(prs, event, onBranch),
  };
  /** @param {string} reason @param {Partial<Coverage>} [more] @returns {Coverage} */
  const stop = (reason, more = {}) => ({ ...facts, ...more, reason });
  /**
   * The fresh runs list of `file` and, into `facts.from`, the cursor of
   * `label` below this run; or the stop a stale list or an unread cursor
   * makes. `planned`: a cursor at or past the run, which a job fire reads
   * as a turn that planned it.
   *
   * @param {string} file
   * @param {string | null} label
   * @returns {Promise<{ stopped: Coverage } | { stopped: null, page: RunRow[], created: string, planned: Cursor | null }>}
   */
  const runsBelow = async (file, label) => {
    facts.workflow = file;
    facts.label = label;
    const { runs, fresh, page } = await freshRuns(reader, file, runId, sleep, branch);
    if (!fresh) return { stopped: { ...facts, ...staleList(name, runId, runs) } };
    /** @type {Cursor | null} */
    let c;
    try {
      c = await cursor(file, label);
    } catch (error) {
      return { stopped: { ...facts, ...unreadCursor(name, runId, error) } };
    }
    facts.from = c !== null && c.runId < runId ? c : null;
    return { stopped: null, page, created: runs.find((r) => r.id === runId)?.created_at ?? '', planned: c !== null && c.runId >= runId ? c : null };
  };
  /**
   * The range from `built`, the baseline's commit, to `end`, and the PRs
   * in it, into `facts`; or the stop a run that shipped no merge makes.
   *
   * @param {{ id: number, built: string, created_at: string, html_url: string }} baseline
   * @param {string} end
   * @param {string} createdAt When this run was created.
   * @param {boolean} rollback Red: a range of no commit is still news.
   * @param {'all' | string[]} paths
   */
  const rangeFrom = async ({ id, built, created_at: created, html_url }, end, createdAt, rollback, paths) => {
    facts.at = { runId, commit: end, created: createdAt };
    facts.baseline = { id, commit: built, created, conclusion: 'success', url: html_url };
    const { commits, merges } = await rangeSince(reader, built, end);
    facts.merges = merges;
    facts.range = { baseline: { id, commit: built, created }, end, merges: merges.length };
    // A run that shipped no merge (a re-deploy, or a green run behind its
    // baseline): its head's PR has been told. A red rollback is still news.
    if (built === end || (commits === 0 && !rollback)) {
      return stop(`${name} run ${runId} shipped no merge since run ${id}: it built ${short(end)}, and run ${id} built ${short(built)}`);
    }
    facts.shipped = await mergedIn(reader, merges, end);
    facts.picked = await pickedBy(reader, paths, facts.shipped);
    facts.closes = new Map(facts.shipped.map((pr) => [pr.number, closedBy(pr.body, repo)]));
    return facts;
  };
  /**
   * The range from `label`'s baseline, the cursor below this run or else
   * the last green run whose job marked `label` succeeded, to `end`; or the
   * stop a search that found none makes.
   *
   * @param {string} file
   * @param {{ page: RunRow[], created: string }} listed
   * @param {string} label
   * @param {string} end
   * @param {boolean} rollback
   * @param {'all' | string[]} paths
   */
  const rangeFromBaseline = async (file, { page, created }, label, end, rollback, paths) => {
    const search = facts.from === null
      ? await shippedBaseline(reader, file, branch, page, runId, label)
      : { baseline: { id: facts.from.runId, built: facts.from.commit, created_at: facts.from.created, conclusion: 'success', html_url: '' }, read: 0, capped: null };
    if (search.baseline === null) return stop(noBaseline(`successful ${name} run that shipped ${label}`, runId, file, branch, search));
    return rangeFrom(search.baseline, end, created, rollback, paths);
  };

  if (invocation.kind === 'job') {
    const { label, commit: end, headSha } = invocation;
    /** @type {string} */
    let path;
    try {
      path = (await reader.run(runId)).path;
    } catch (error) {
      return stop(`${name} run ${runId} could not be read for its workflow file: ${messageOf(error)}`);
    }
    if (typeof path !== 'string' || !WORKFLOW_PATH.test(path)) return stop(`${name} run ${runId} is of no workflow file under .github/workflows (${String(path)}), so ${label} goes nowhere`);
    try {
      facts.declared = ticketLabelOf(await reader.fileAt(path, headSha));
    } catch (error) {
      return stop(`${path} at ${short(headSha)} could not be read, so which tickets ${label} picks is unknown: ${messageOf(error)}`);
    }
    if (facts.declared === null) return stop(`${name} run ${runId}: ${path} at ${short(headSha)} declares no TICKET_LABEL_PATHS, so ${label} goes nowhere`);
    const file = fileOf(path);
    const listed = await runsBelow(file, label);
    if (listed.stopped !== null) return listed.stopped;
    if (listed.planned !== null) {
      return stop(`${name} run ${runId}: ${label}'s cursor stands at run ${listed.planned.runId}, so a turn planned this run's news already (a re-run attempt, or a second job marked ${label} in the run)`);
    }
    return rangeFromBaseline(file, listed, label, end, false, facts.declared.paths);
  }

  const { conclusion, headSha, path } = invocation;
  if (conclusion === 'success') return stop(`${name} run ${runId} ended success: each shipping job in it covers its own range`);
  if (conclusion !== 'failure') return stop(`${name} run ${runId} ended ${conclusion}: it shipped nothing`);
  // A red re-run covers what its first attempt did, and nothing reads it: a
  // red run labels nothing, and the first attempt's messages were sent.
  if ((invocation.runAttempt ?? 1) > 1) return stop(`${name} run ${runId} attempt ${invocation.runAttempt} failed: its first attempt covered it`);

  if (isCi(invocation, workflows)) {
    // A CI dispatched by hand (`only` one job, say) tested no merge.
    if (invocation.event !== 'push') return stop(`${name} run ${runId} on ${branch} was a ${invocation.event ?? 'run nothing named'}, not a push: it tested no merge`);
    const file = fileOf(String(path));
    const listed = await runsBelow(file, null);
    if (listed.stopped !== null) return listed.stopped;
    const got = await baselineIn(reader, file, branch, listed.page, (all) => previousConclusive(all, runId, facts.from));
    if (got.baseline === null) return stop(noBaseline(`finished ${name} run`, runId, file, branch, got));
    const before = got.baseline;
    facts.at = { runId, commit: headSha, created: listed.created };
    facts.baseline = { id: before.id, commit: before.head_sha, created: before.created_at, conclusion: String(before.conclusion), url: before.html_url };
    // Already red: its breaker was told, and nothing past it is read.
    if (before.conclusion !== 'success') return facts;
    facts.jobs = await reader.runJobs(runId);
    const { merges } = await rangeSince(reader, before.head_sha, headSha);
    facts.merges = merges;
    facts.range = { baseline: { id: before.id, commit: before.head_sha, created: before.created_at }, end: headSha, merges: merges.length };
    facts.shipped = await mergedIn(reader, merges, headSha);
    facts.picked = facts.shipped;
    facts.closes = new Map(facts.shipped.map((pr) => [pr.number, closedBy(pr.body, repo)]));
    return facts;
  }

  if (path === undefined) return stop(`${name} run ${runId} names no workflow file, so no deploy target`);
  /** @type {string[]} */
  let labels;
  try {
    const text = await reader.fileAt(path, headSha);
    facts.declared = ticketLabelOf(text);
    labels = await shippingLabelsOf(text, (file) => reader.fileAt(`.github/workflows/${file}`, headSha));
  } catch (error) {
    return stop(`${path} at ${short(headSha)} could not be read, so its deploy target is unknown: ${messageOf(error)}`);
  }
  const label = labels[labels.length - 1];
  if (facts.declared === null || label === undefined) return stop(`${name} run ${runId}: ${path} at ${short(headSha)} declares no deploy target: no TICKET_LABEL_PATHS, or no job named with the shipping marker`);
  facts.label = label;
  const { paths, merge } = facts.declared;
  if (!merge && !workflows.triage.includes(label.slice(LABEL_PREFIX.length))) return stop(`${name} run ${runId} failed, a release dispatched by hand: whoever dispatched it is watching it`);
  facts.jobs = await reader.runJobs(runId);
  const file = fileOf(path);
  const listed = await runsBelow(file, label);
  if (listed.stopped !== null) return listed.stopped;
  // A red run dispatched by hand whose shipping job never ran (a dry run, a
  // probe-only run, renames or skips it) deployed nothing, so no merge's
  // deploy failed. A run a merge started is news whichever job stopped it:
  // a train red before its dev stage still failed to release its merges,
  // and its skipped stages carry no marker for this to read.
  const byHand = listed.page.find((r) => r.id === runId)?.event === 'workflow_dispatch';
  if (byHand && !facts.jobs.some((j) => j.conclusion !== 'skipped' && shipsAs(j))) return stop(`${name} run ${runId} failed, but no job marked "\u00b7 deployed: \u2026" ran: it deployed nothing`);
  const end = builtCommit(facts.jobs, headSha);
  return rangeFromBaseline(file, listed, label, end, true, paths);
};
