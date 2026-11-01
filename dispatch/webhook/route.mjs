/**
 * The webhook receiver's decisions: a GitHub delivery in, the fires it means
 * queued.
 *
 * GitHub posts every event the App's webhook subscribes to ({@link
 * HOOK_EVENTS}), from every repo the App is installed on. The
 * receiver verifies the delivery is GitHub's (the HMAC over the raw body,
 * keyed by the secret both sides hold), decides what it means for the
 * dispatcher, and queues its fires on the lane the dispatcher task reads
 * (dispatch/lane.mjs). Three kinds of fire for issues and remarks: a `schedule`
 * fire naming the issue and a label a person just added to it, queued only
 * where the repo's hook-table item lists the label as ready or cannot say
 * ({@link handle}), which the task dispatches if the label is one of the
 * repo's ready labels and the selection would, and no other; a `dispatch` fire with a prompt of its
 * own, for a mention of @claude (mention.mjs); and a `message` fire per
 * session subscribed to what happened (subscribe.mjs): a comment or review
 * on a PR whose body names the session that wrote it, carrying the prompt
 * into that session and the dispatch as its fallback, and any other
 * comment, review, push, close or label on a PR or issue that its footer
 * or a `governor:subscribe` line in its body subscribes a session to, with
 * none. The task decides, so the receiver never reads the backlog. A
 * fourth, `workflow`, names a run on the default branch that went red, of
 * any workflow, and its file: a PR's sessions hear of a red CI (the file
 * the repo's config names) and of a red run of any workflow
 * declaring a deploy target (dispatch/workflow.mjs). A green run
 * queues nothing: each shipping job in it queues a `job` fire of its own
 * when it succeeds on the default branch, read off the `workflow_job`
 * payload's name, which carries the label it earns and the commit it built
 * (`shippingJob` in fire.mjs); the task labels the tickets the job shipped
 * and tells their sessions (dispatch/coverage.mjs and `ticketsOf` in
 * dispatch/turn.mjs).
 * The receiver holds no GitHub token and reads no file, so the task reads
 * the run, the jobs, the PRs, the run before and the workflow file.
 * A scheduled run on the default branch that went red, of any workflow, queues a
 * `dispatch` fire instead: nobody dispatched it, so nobody is watching it,
 * and one fresh session looks into it. A run dispatched on a branch queues a
 * `branch-run` fire, whatever it concluded: the session that wrote the
 * commit it tested is waiting on it (dispatch/branch-run.mjs).
 * A fifth, `review`, runs the PR review (the repo's `review.checklist`) over
 * a PR opened, readied, pushed to or its body edited, naming the PR and its
 * head. No run's end queues one: a merge is never held.
 * A sixth, `conflicts`, is queued by a PR merged into the default branch: GitHub sends no
 * event when that merge leaves another PR conflicted, so the task reads every
 * open PR's mergeable state and tells the conflicted ones' sessions
 * (dispatch/conflicts.mjs).
 * A merge into the default branch, an issue opened and an issue closed are
 * also counted for the repo's periodics: the fire the event queues carries
 * it as `counted`, and an issue opened that queues none queues a
 * `periodics` fire of its own ({@link counting}).
 * An issue closed queues a `schedule` fire naming it as `freed`. Its turn
 * starts nothing: it queues one `unblocked` fire for each open ticket the
 * issue directly blocked, in whichever listed owner's repo the ticket is,
 * and each runs in that repo's own turn under its own config
 * (dispatch/unblocked.mjs). A close once ran the whole selection, cap
 * included, and every session that finished started two more; bounded to
 * what the close blocked, a chain advances one link per merge and cannot
 * fan out past the dependency graph.
 * A PR merged into the default branch tells its owner session, as any close
 * does, and lists no blocked ticket: the merging session has no step left
 * after the merge, and can sign off.
 *
 * Routing reads the payload alone. Once a delivery would queue fires, the
 * receiver reads the repo's switches from the hook table, as the task last
 * read the repo's file (hook-table.mjs), and drops each fire whose switch
 * they say is off before it reaches the lane ({@link handle}, switches.mjs):
 * a fire the task would refuse still costs a whole task. Anything the table
 * cannot say, the fire is queued and the task decides.
 *
 * One task at a time is the starter's to keep (starter.mjs), and one turn at
 * a time the task's: a dispatcher turn refreshes
 * the stored login, and two turns refreshing one login leave one of them
 * dead. The receiver only queues, so a burst of deliveries costs nothing
 * more than a queue of fires, each started in turn: a delivery with three
 * subscribers is three fires, one after another. The schedule fire itself
 * comes through here too ({@link handleSchedule}) and joins the same lane.
 *
 * A hook is the one request not GitHub's: an outside system posts signed
 * text to `/hooks/<owner>/<repo>/<hook>` (hook.mjs), and the receiver queues
 * a `hook` fire naming the hook, the key version and the text
 * ({@link handleHook}), unless the hook table says the repo's file lists no
 * such hook or has moved past that key version, or the hook has had its
 * hourly cap of fires (hook-table.mjs). Every other path is a GitHub
 * delivery.
 *
 * Pure: `handle` takes its I/O as `deps`. handler.mjs binds the real ones.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HOOK_KEY_STALE, HOOK_PER_HOUR, HOOK_PER_HOUR_MAX, FIRE_BUDGET, REPO_NAME, RED, ownerListed, WORKFLOW_PATH, build, isCommit, fireWeight, shippingJob } from './fire.mjs';
import { HOOK_CLOCK_AHEAD_MS, HOOK_CLOCK_BEHIND_MS, HOOK_HEADER, HOOK_TEXT_LIMIT, hookPath, readSignature, verifyHook } from './hook.mjs';
import { MENTION, MENTION_EVENTS, defaultBranch, issueEventFires, mentionFires, oneLine, pullRequestFires } from './mention.mjs';
import { droppedBy } from './switches.mjs';

/**
 * The events the receiver acts on, which the App's webhook subscribes to:
 * issues for the selection, the three a mention of @claude can arrive in
 * (mention.mjs), pull requests, for a push or a close a subscriber hears
 * of, workflow jobs, for a shipping job that succeeded on main,
 * and workflow runs, for a red main and a red deploy. Alphabetical, as
 * GitHub lists them. The nightly `dispatch-app-events` check holds the
 * App's subscription to cover them (scripts/lib/conformance-app-events.mjs).
 */
export const HOOK_EVENTS = Object.freeze(['issue_comment', 'issues', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'workflow_job', 'workflow_run']);

/**
 * The key, read once per warm environment. A read that failed (a throttle,
 * a permission the role lost) is not kept: keeping it would hand every later
 * delivery the same rejection for the environment's life.
 *
 * @param {() => Promise<string>} read
 * @returns {() => Promise<string>}
 */
export const cachedSecret = (read) => {
  /** @type {Promise<string> | null} */
  let once = null;
  return () => (once ??= read().catch((error) => {
    once = null;
    throw error;
  }));
};

/**
 * The dispatcher's App ID from the receiver's configuration (`APP_ID`), or
 * undefined when it is not one: a receiver that knows no App takes no
 * comment for the PR review's.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
export const appIdOf = (value) => {
  const text = String(value ?? '').trim();
  const id = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(id) ? id : undefined;
};

/**
 * Whether `signature` is GitHub's `sha256=<hex>` HMAC of `body` under
 * `secret`. A constant-time compare, so a wrong signature costs the same as
 * a right one.
 *
 * @param {string} secret
 * @param {string | Buffer} body The raw bytes GitHub signed.
 * @param {string | undefined} signature The X-Hub-Signature-256 header.
 * @returns {boolean}
 */
export const verifySignature = (secret, body, signature) => {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const given = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/**
 * @typedef {import('./fire.mjs').Fire} Fire
 * @typedef {import('./fire.mjs').FireMessage} FireMessage
 * @typedef {{ fire: Fire, reason: string, key?: string }} Queued One fire, and the key that tells it from the delivery's others.
 * @typedef {{ fires: Queued[], reason: string }} Decision
 */

/** @param {string} reason @returns {Decision} */
const nothing = (reason) => ({ fires: [], reason });

/** @param {Queued} queued @returns {Decision} */
const one = (queued) => ({ fires: [queued], reason: queued.reason });

/** @param {Decision} first @param {Decision} then @returns {Decision} */
const both = (first, then) => ({
  fires: [...first.fires, ...then.fires],
  reason: [first.reason, then.reason].filter(Boolean).join('; '),
});

/**
 * The conclusions of a run on the default branch a fire is queued for, whatever its
 * workflow: the task decides what each means. A green run's
 * shipping jobs fired on their own ({@link jobFire}), so the run says
 * nothing they did not. A skipped or cancelled run shipped nothing and
 * broke nothing; a Deliver skipped because CI failed is covered by CI's. A
 * timed-out run is queued as a failure: it broke the deploy as surely, and
 * the task reads only `failure` as red.
 */
const CONCLUSIVE = new Set(['failure', 'timed_out']);

/**
 * A scheduled run on main that went red: a `dispatch` fire starting one
 * fresh session on it, or why not. Nobody dispatched the run, so no session
 * is watching it; a run a session dispatched is that session's to watch.
 * A re-run is someone already looking, the first attempt's session or a
 * person. A workflow that stays red goes red on every scheduled run, and
 * the payload does not say how the run before ended: the fire names the
 * workflow and the run, and the task, which holds a token, starts nothing
 * when the run before was red too.
 *
 * @param {any} run The payload's `workflow_run`, completed and scheduled.
 * @param {string} main The repo's default branch.
 * @returns {Decision}
 */
const scheduledRedFire = (run, main) => {
  const name = oneLine(run?.name);
  if (run?.head_branch !== main) return nothing(`scheduled ${name} run ${run?.id} on ${run?.head_branch}, not ${main}`);
  if (!RED.has(String(run?.conclusion))) return nothing(`scheduled ${name} run ${run?.id} ended ${run?.conclusion}: nothing to look into`);
  if ((run?.run_attempt ?? 1) > 1) return nothing(`scheduled ${name} run ${run?.id} attempt ${run?.run_attempt}: its first attempt started a session`);
  if (!(Number.isSafeInteger(run?.workflow_id) && run.workflow_id > 0 && Number.isSafeInteger(run?.id) && run.id > 0)) {
    return nothing(`scheduled ${name} run ${run?.id} names no workflow and run the task can read`);
  }
  const commit = String(run?.head_sha ?? '').slice(0, 12);
  // The facts alone: the task adds the repo's instruction (dispatch/workflow.mjs
  // `redRunPrompt`), since the receiver reads no config file.
  const prompt = [
    `A scheduled run of ${name} on ${main} ended ${run.conclusion}. Nobody dispatched it, so no session is watching it: it is yours.`,
    '',
    `Run: ${run.html_url}, commit ${commit}`,
    ...(typeof run.path === 'string' ? [`Workflow: ${run.path}`] : []),
  ].join('\n');
  return one({
    fire: build.dispatch({
      prompt,
      sessionName: `Scheduled ${name} red ${commit}`.slice(0, 100),
      scheduled: { workflowId: run.workflow_id, runId: run.id, branch: main },
    }),
    reason: `scheduled ${name} run ${run.id} on ${main} ended ${run.conclusion}: start a session on it`,
  });
};

/**
 * A run dispatched on a branch, finished: a `branch-run` fire naming it and
 * the branch, whatever it concluded, or why not. A session dispatches one
 * (an emulator, device or Apple run, CI's one-client leg) and waits on it
 * before it raises or readies its PR; the task tells
 * the session that wrote the commit it tested (dispatch/branch-run.mjs). A
 * re-run is told too: someone re-ran it to wait on it. One on the default
 * branch is not: its head commit is the last merge's, not the dispatcher's.
 *
 * @param {any} run The payload's `workflow_run`, completed, dispatched, and not on the default branch.
 * @returns {Decision}
 */
const branchRunFire = (run) => {
  const name = oneLine(run?.name);
  const branch = run?.head_branch;
  if (typeof branch !== 'string' || branch === '') return nothing(`dispatched ${name} run ${run?.id} names no branch`);
  if (name === '' || !Number.isSafeInteger(run?.id) || run.id <= 0 || !isCommit(run?.head_sha)
    || typeof run?.html_url !== 'string' || !run.html_url.startsWith('https://') || typeof run?.conclusion !== 'string' || run.conclusion === '') {
    return nothing(`dispatched ${name} run ${run?.id} on ${branch} names no workflow, run, link, conclusion or commit the task can read`);
  }
  return one({
    fire: build.branchRun({
      name,
      runId: run.id,
      url: run.html_url,
      conclusion: run.conclusion,
      headSha: run.head_sha,
      branch,
      runAttempt: Number.isInteger(run.run_attempt) ? run.run_attempt : undefined,
    }),
    reason: `dispatched ${name} run ${run.id} on ${branch} ended ${run.conclusion}: tell the session waiting on it`,
  });
};

/**
 * A finished run: on the default branch `main`, a `workflow` fire naming
 * it, or why not. A scheduled run is {@link scheduledRedFire}'s, routed
 * before this, and one dispatched on another branch {@link branchRunFire}'s.
 * Whether the run is CI is the task's to read from the repo's config: the fire names what started it, and the task refuses a CI run
 * that tested no merge.
 *
 * @param {any} payload
 * @param {string} main The repo's default branch.
 * @returns {Decision}
 */
const workflowRunFire = (payload, main) => {
  const run = payload?.workflow_run;
  const name = String(run?.name);
  if (payload?.action !== 'completed') return nothing(`workflow_run ${payload?.action}: only a completed run is told`);
  if (run?.event === 'workflow_dispatch' && run?.head_branch !== main) return branchRunFire(run);
  if (run?.head_branch !== main) return nothing(`${name} run ${run?.id} on ${run?.head_branch}, not ${main}`);
  if (run?.conclusion === 'success') return nothing(`${name} run ${run?.id} on ${main} ended success: each shipping job in it fired on its own`);
  if (!CONCLUSIVE.has(String(run?.conclusion))) return nothing(`${name} run ${run?.id} ended ${run?.conclusion}: nothing to tell`);
  const reason = `${name} run ${run.id} on ${main} ended ${run.conclusion}`;
  return one({
    fire: build.workflow({
      name,
      path: typeof run.path === 'string' && WORKFLOW_PATH.test(run.path) ? run.path : undefined,
      branch: main,
      event: typeof run.event === 'string' && run.event !== '' ? run.event : undefined,
      runId: run.id,
      url: run.html_url,
      conclusion: run.conclusion === 'timed_out' ? 'failure' : run.conclusion,
      headSha: run.head_sha,
      runAttempt: Number.isInteger(run.run_attempt) ? run.run_attempt : undefined,
    }),
    reason,
  });
};

/**
 * A shipping job that succeeded on the default branch `main`: a `job` fire naming
 * it, the label its name carries and the commit it built, or why not. Read
 * from the payload alone: the name carries the marker, the run id, head and
 * page are the job's own. A job that failed, was skipped or cancelled
 * shipped nothing; its run's end, red, is {@link workflowRunFire}'s. A
 * re-run attempt fires too: its first attempt's job did not succeed, or the
 * cursor (dispatch/runs.mjs) stops the task telling twice.
 *
 * @param {any} payload
 * @param {string} main The repo's default branch.
 * @returns {Decision}
 */
const jobFire = (payload, main) => {
  const job = payload?.workflow_job;
  const name = oneLine(job?.name);
  const run = Number.isSafeInteger(job?.run_id) ? job.run_id : null;
  if (payload?.action !== 'completed') return nothing(`workflow_job ${payload?.action}: only a completed job is read`);
  if (job?.conclusion !== 'success') return nothing(`job ${job?.id} "${name}" of run ${run} ended ${job?.conclusion}: only a success shipped`);
  if (job?.head_branch !== main) return nothing(`job ${job?.id} "${name}" of run ${run} on ${job?.head_branch}, not ${main}`);
  const marked = shippingJob(name);
  if (marked === null) return nothing(`job ${job?.id} "${name}" of run ${run} on ${main} carries no shipping marker: it earns no label`);
  if (run === null || run <= 0 || !Number.isSafeInteger(job?.id) || job.id <= 0 || !isCommit(job?.head_sha)
    || typeof job?.html_url !== 'string' || !job.html_url.startsWith('https://') || typeof job?.workflow_name !== 'string' || job.workflow_name.trim() === '') {
    return nothing(`job ${job?.id} "${name}" of run ${run} names no run, job id, workflow, commit or link the task can read`);
  }
  // The task takes a whole commit id only (parseFire): a short one queued
  // here would fail there, and the label with it.
  if (marked.commit !== undefined && !isCommit(marked.commit)) {
    return nothing(`job ${job.id} "${name}" of run ${run} names commit ${marked.commit}, not a whole commit id the task can read`);
  }
  return one({
    fire: build.job({
      name,
      workflow: oneLine(job.workflow_name),
      branch: main,
      runId: run,
      jobId: job.id,
      url: job.html_url,
      headSha: job.head_sha,
      label: marked.label,
      commit: marked.commit ?? job.head_sha,
      runAttempt: Number.isInteger(job.run_attempt) ? job.run_attempt : undefined,
    }),
    reason: `job "${name}" of ${job.workflow_name} run ${run} succeeded on ${main}: label ${marked.label} and tell what it shipped`,
  });
};

/** The `pull_request` actions the PR review runs on; `edited` only when the body or the base changed. */
const REVIEWED = new Set(['opened', 'ready_for_review', 'synchronize', 'edited']);

/**
 * A PR the review should read again: a `review` fire naming it and the head
 * it was queued for, keyed apart from the subscribers' fires on the same
 * delivery. A draft is the task's to skip: it reads the PR anyway.
 *
 * @param {any} payload
 * @returns {Decision}
 */
const reviewFire = (payload) => {
  const action = payload?.action;
  const pr = payload?.pull_request;
  if (!REVIEWED.has(String(action))) return nothing(`pull_request ${action}: not one the PR review reads`);
  if (action === 'edited' && payload?.changes?.body === undefined && payload?.changes?.base === undefined) return nothing(`#${pr?.number} edited, its body and base unchanged: nothing for the PR review`);
  if (!Number.isInteger(pr?.number) || pr.number <= 0) return nothing(`pull_request ${action} names no PR number: nothing to review`);
  const head = pr?.head?.sha;
  return one({
    fire: build.review({ pr: pr.number, headSha: isCommit(head) ? head : undefined }),
    reason: `#${pr.number} ${action}: review it`,
    key: 'review',
  });
};

/**
 * A run that finished on a PR's head, off the default branch: a `review`
 * fire for each PR the payload lists, at the head the run ran on. The review skips a PR whose required checks have not finished,
 * so a run's end is when it is read again; a re-run that turns a red check
 * green is read the same way. A fork's PRs the payload does not list.
 *
 * @param {any} payload
 * @param {string} main The repo's default branch.
 * @returns {Decision}
 */
const finishedRunReviews = (payload, main) => {
  const run = payload?.workflow_run;
  if (payload?.action !== 'completed' || run?.head_branch === main || !isCommit(run?.head_sha)) return nothing('');
  /** @type {any[]} */
  const prs = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  return prs.filter((p) => Number.isInteger(p?.number) && p.number > 0).map((p) => one({
    fire: build.review({ pr: p.number, headSha: run.head_sha }),
    reason: `${String(run?.name)} run ${run?.id} finished on #${p.number}'s head: review it`,
    key: `review-${p.number}`,
  })).reduce(both, nothing(''));
};

/**
 * An event a periodic counts (dispatch/periodics.mjs): `counted` marked on
 * the delivery's fire of the `carrier` kind, so the check rides the turn
 * the event already queues, or a `periodics` fire of its own where it
 * queues none. The receiver reads no config file, so it marks the event in
 * every listed repo; the turn checks the repo's periodics under their own
 * switch, whatever switch the carrying turn needs.
 *
 * @param {Decision} decision
 * @param {import('./fire.mjs').Count} counted
 * @param {Fire['kind']} carrier
 * @returns {Decision}
 */
const counting = (decision, counted, carrier) => {
  const at = decision.fires.findIndex((queued) => queued.fire.kind === carrier);
  if (at === -1) return both(decision, one({ fire: build.periodics({ counted }), reason: `count it for the repo's periodics (${counted})`, key: 'periodics' }));
  return { ...decision, fires: decision.fires.map((queued, i) => (i === at ? { ...queued, fire: { ...queued.fire, counted } } : queued)) };
};

/**
 * A PR merged into the default branch `main`: a `conflicts` fire naming
 * it, its merge commit and the branch, so every open PR the merge left
 * conflicted is told, carrying the merge for the periodics' count. Keyed
 * apart from the subscribers' fires on the same delivery.
 *
 * @param {any} payload
 * @param {string} main The repo's default branch.
 * @returns {Decision}
 */
const mergedFire = (payload, main) => {
  const pr = payload?.pull_request;
  if (payload?.action !== 'closed' || pr?.merged !== true) return nothing('');
  if (pr?.base?.ref !== main) return nothing(`#${pr?.number} merged into ${pr?.base?.ref}, not ${main}: ${main} did not move`);
  const sha = pr?.merge_commit_sha;
  if (!Number.isInteger(pr?.number) || pr.number <= 0 || !isCommit(sha)) {
    return counting(nothing(`#${pr?.number} merged with no merge commit named: no conflict check`), 'merges', 'conflicts');
  }
  return counting(one({ fire: build.conflicts({ pr: pr.number, sha, base: main }), reason: `#${pr.number} merged into ${main}: check the open PRs for conflicts`, key: 'conflicts' }), 'merges', 'conflicts');
};

/**
 * What a delivery means for the dispatcher. Anything not listed queues
 * nothing: a session costs money and attention, and the schedule fire
 * covers whatever this misses.
 *
 * The App's one webhook carries every installation's deliveries
 * (docs/constraints/dispatcher-repos.md). A repository whose owner is off the list queues nothing; any
 * other's fires each name it. The receiver holds no token, so it reads no
 * config file: the turn applies the repo's (dispatch/repo-config.mjs). It
 * filters a workflow or merge event on facts in the payload alone, the
 * default branch among them, never by repo. Every listed
 * repo's PR routes to the PR review; {@link handle} drops it where the hook
 * table says the repo's file leaves `prReview` off, and the task refuses it
 * where the file does.
 *
 * @param {{ event: string | undefined, payload: any, owners: readonly string[], appId?: number | undefined }} args
 * `owners`: the stack's owner list. `appId`: the dispatcher's own App,
 * whose comment alone is the PR review's; without it, no comment is.
 * @returns {Decision}
 */
export const routeEvent = ({ event, payload, owners, appId }) => {
  const repo = payload?.repository?.full_name;
  if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return nothing(`${event ?? 'unnamed'} delivery names no repository`);
  const owner = repo.slice(0, repo.indexOf('/'));
  if (!ownerListed(owners, owner)) return nothing(`delivery is for ${repo}, whose owner ${owner} is not on the owner list`);
  const decision = routeFor({ event, payload, appId });
  return { ...decision, fires: decision.fires.map((queued) => ({ ...queued, fire: { ...queued.fire, repo } })) };
};

/**
 * A listed repo's delivery, routed.
 *
 * @param {{ event: string | undefined, payload: any, appId?: number | undefined }} args
 * @returns {Decision}
 */
const routeFor = ({ event, payload, appId }) => {
  const main = defaultBranch(payload);
  const unbranched = nothing(`${event} delivery names no default branch: no run or merge on it to read`);
  if (event === 'issues') {
    const number = payload?.issue?.number;
    const action = payload?.action;
    const label = payload?.label?.name;
    /** @type {Decision | null} */
    let selection = null;
    // A label a bot added is the dispatcher's own: a ready label put back on
    // a launch that failed, or a claim. A fire for it would launch
    // the ticket again, and the payload names no App behind a bot sender,
    // so no label a bot adds selects. Subscribers still hear it below.
    if (action === 'labeled' && payload?.sender?.type === 'Bot') {
      selection = nothing(`issue #${number} labelled ${label} by ${payload.sender.login ?? 'a bot'}: the dispatcher's own, no selection`);
    } else if (action === 'labeled' && typeof label === 'string' && label !== '' && typeof number === 'number') {
      // Routing reads only the payload: {@link handle} drops this fire where
      // the repo's hook-table item says the label is not one of its ready
      // labels, and the task ends the turn before the login where the file
      // says so.
      selection = one({ fire: build.schedule({ issue: number, label }), reason: `issue #${number} labelled ${label}: select it if it is one of the repo's ready labels` });
    } else if (action === 'closed') {
      // The close is counted on the fire that queues what it blocked.
      selection = typeof number === 'number'
        ? counting(one({ fire: build.schedule({ freed: number }), reason: `issue #${number} closed: queue what it blocked` }), 'issuesClosed', 'schedule')
        : nothing('issue closed with no number: nothing to free');
    }
    // The selection's fire, where there is one, beside each subscriber's.
    if (selection !== null) return both(selection, issueEventFires(payload));
    if (action === 'labeled' || action === 'unlabeled' || action === 'reopened') return issueEventFires(payload);
    const mentioned = mentionFires({ event, payload, appId }) ?? nothing(`issues ${action}: nothing to select from`);
    // An issue opened is counted on its summons, or on a fire of its own.
    return action === 'opened' && typeof number === 'number' ? counting(mentioned, 'issuesOpened', 'dispatch') : mentioned;
  }
  if (event === 'pull_request') {
    const reviewed = both(pullRequestFires(payload), reviewFire(payload));
    return main === null ? reviewed : both(reviewed, mergedFire(payload, main));
  }
  if (event === 'workflow_run' || event === 'workflow_job') {
    if (main === null) return unbranched;
    if (event === 'workflow_job') return jobFire(payload, main);
    if (payload?.action === 'completed' && payload?.workflow_run?.event === 'schedule') return scheduledRedFire(payload.workflow_run, main);
    return both(workflowRunFire(payload, main), finishedRunReviews(payload, main));
  }
  if (MENTION_EVENTS.has(String(event))) {
    return mentionFires({ event, payload, appId }) ?? nothing(`${event} ${payload?.action}: no ${MENTION} mention and no subscriber`);
  }
  return nothing(`${event ?? 'unnamed'} event: not one the dispatcher acts on`);
};

/**
 * @typedef {{
 *   secret: () => Promise<string>,
 *   hookSecret: () => Promise<string>,
 *   listedHooks: import('./hook-table.mjs').HookTable['listed'],
 *   countFire: import('./hook-table.mjs').HookTable['count'],
 *   repoItem: import('./hook-table.mjs').HookTable['item'],
 *   now?: () => number,
 *   owners: readonly string[],
 *   appId: number | undefined,
 *   enqueue: (message: FireMessage, dedupId?: string) => Promise<string>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} Deps
 *   `secret`: GitHub's webhook key. `hookSecret`: the stack's hook secret,
 *   every hook key's root (hook.mjs). `listedHooks`: the repo's item in the
 *   hook table (hook-table.mjs), the hooks its file listed when the task last
 *   read it. `countFire`: one more fire of a hook in the clock hour, taken
 *   only under its cap and once per signature (hook-table.mjs).
 *   `repoItem`: the repo's switches and ready labels in the hook table, as
 *   its file read when the task last read it (hook-table.mjs). `now`: the
 *   receiver's clock, which a hook's timestamp is held to and an hour's
 *   count is kept by.
 *
 * @typedef {{ path?: string | undefined, headers: Record<string, string | undefined>, body?: string | undefined, isBase64Encoded?: boolean | undefined }} Request
 *   `path`: the Function URL's raw path, a hook's (`/hooks/…`) or GitHub's.
 */

/**
 * A fire's deduplication id: the delivery's, so a redelivery is not a second
 * fire, and the session's beside it for a subscriber's, so a delivery's
 * fires are not one another's duplicates. SQS takes 128 characters; a
 * longer one is hashed.
 *
 * @param {string} delivery
 * @param {string | undefined} key
 */
const dedupId = (delivery, key) => {
  const id = key === undefined ? delivery : `${delivery}:${key}`;
  return id.length <= 128 ? id : createHash('sha256').update(id).digest('hex');
};

/**
 * Queue one fire. A queue that refused it is logged and rethrown: the
 * stack's tripwire reads the Lambda Errors metric, which a returned status
 * never reaches, and a fire the lane did not take is a delivery lost.
 *
 * @param {FireMessage} message
 * @param {string | undefined} dedupId The delivery id, so a redelivery is not a second fire; none for the schedule.
 * @param {Deps} deps
 * @returns {Promise<string>} The queued message's id.
 */
const queueFire = async (message, dedupId, deps) => {
  const { fire, ...context } = message;
  try {
    const messageId = await deps.enqueue(message, dedupId);
    deps.log('webhook-queued', { ...context, kind: fire.kind, messageId });
    return messageId;
  } catch (error) {
    deps.log('webhook-failed', { ...context, kind: fire.kind, error: String(/** @type {any} */ (error)?.stack ?? error) });
    throw error;
  }
};

/**
 * One request: a hook's, on a `/hooks/` path ({@link handleHook}; 404 for
 * one under it that names no repo and hook), or else one delivery. A
 * delivery's status is what GitHub records against it: 401 for a
 * delivery that is not GitHub's, 400 for one it could not read, 200 for one
 * that changes nothing, its fires all dropped by the repo's switches or
 * ready labels among them, 202 for one that queued a fire. A queue that refused
 * the fire leaves as a throw, and GitHub records the 502 the Function URL
 * answers with, which an operator can redeliver.
 *
 * @param {Request} request
 * @param {Deps} deps
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
export const handle = async (request, deps) => {
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = request.isBase64Encoded ? Buffer.from(request.body ?? '', 'base64') : Buffer.from(request.body ?? '', 'utf8');
  const hook = hookPath(request.path);
  if (hook === null) return { statusCode: 404, body: 'a hook path is /hooks/<owner>/<repo>/<hook>' };
  if (hook !== undefined) return handleHook(hook, headers[HOOK_HEADER], raw, deps);
  if (!verifySignature(await deps.secret(), raw, headers['x-hub-signature-256'])) {
    deps.log('webhook-refused', { delivery: headers['x-github-delivery'] ?? null });
    return { statusCode: 401, body: 'signature does not match' };
  }
  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return { statusCode: 400, body: 'body is not JSON' };
  }
  const event = headers['x-github-event'];
  const delivery = headers['x-github-delivery'];
  const decision = await switchedOn(routeEvent({ event, payload, owners: deps.owners, appId: deps.appId }), delivery, deps);
  if (decision.fires.length === 0) {
    // Never an error: an outsider who installed the App must not page anyone.
    deps.log('webhook-ignored', { level: 'info', delivery: delivery ?? null, github: event, reason: decision.reason });
    return { statusCode: 200, body: decision.reason };
  }
  // In order, each awaited: a throw leaves the rest unqueued, and GitHub's
  // redelivery queues them, the ones already taken dropped by their key.
  const queued = [];
  for (const { fire, reason, key } of decision.fires) {
    queued.push(await queueFire({
      fire,
      reason,
      ...(delivery ? { delivery } : {}),
      ...(event ? { github: event } : {}),
    }, delivery && dedupId(delivery, key), deps));
  }
  return { statusCode: 202, body: `queued ${queued.join(', ')}: ${decision.reason}` };
};

/**
 * A delivery's fires less those the repo's item in the hook table drops: a
 * selection fire for a label the item's ready labels do not list, and each
 * fire whose switch the item says is off ({@link droppedBy}). The item is
 * read once, and only for a delivery that would queue a fire. An item
 * without ready labels drops no selection fire, and one without switches
 * drops nothing by switch. A read that fails, or an item that is malformed,
 * is logged at error and drops nothing: the task still refuses a fire its
 * repo's file does not allow, and a 503 would lose the delivery, which
 * GitHub does not send again by itself. A dropped fire's reason names the
 * label or the switch, so the App's Recent Deliveries says why it went
 * nowhere.
 *
 * @param {Decision} decision
 * @param {string | undefined} delivery
 * @param {Deps} deps
 * @returns {Promise<Decision>}
 */
const switchedOn = async (decision, delivery, deps) => {
  const repo = decision.fires[0]?.fire.repo;
  if (repo === undefined) return decision;
  /** @type {import('./hook-table.mjs').Known | null} */
  let item;
  try {
    item = await deps.repoItem(repo);
  } catch (error) {
    deps.log('webhook-switches-unread', { level: 'error', delivery: delivery ?? null, repo, error: String(/** @type {any} */ (error)?.message ?? error) });
    return decision;
  }
  /** @type {Queued[]} */
  const kept = [];
  /** @type {string[]} */
  const dropped = [];
  for (const queued of decision.fires) {
    const { fire } = queued;
    const label = fire.kind === 'schedule' ? fire.label : undefined;
    if (label !== undefined && item?.ready && !item.ready.includes(label)) {
      dropped.push(`its ${fire.kind} fire, as ${label} is not one of ${repo}'s ready labels`);
      continue;
    }
    const off = droppedBy(fire, item?.switches ?? null);
    if (off === null) kept.push(queued);
    else dropped.push(`its ${fire.kind} fire, as ${repo}'s file turns ${off.join(' and ')} off`);
  }
  if (dropped.length === 0) return decision;
  const reason = `${decision.reason}; dropped ${dropped.join(', and ')}`;
  // A delivery with every fire dropped is logged once, as one that queued nothing.
  if (kept.length > 0) deps.log('webhook-dropped', { level: 'info', delivery: delivery ?? null, repo, reason });
  return { fires: kept, reason };
};

/**
 * One hook request. 401 for one whose signature is missing, malformed, does
 * not match the key for its path's repo, hook and version, or whose time is
 * more than 30 seconds ahead of the receiver's clock or more than 4 minutes
 * 25 seconds behind it; 200 for one whose owner is not
 * on the list; 401 for a hook the hook table's item does not list, or a key
 * version older than the item's; 503 for an item that could not be read; 400
 * for a body that holds no text; 413 for text too long; 429 for a fire past
 * the hook's hourly cap; 503 for a count that could not be taken; 202 for one
 * that queued its fire. A repo with no item yet is queued, under the default
 * cap, and the task decides. Nothing but a 202 queues anything, and no
 * line logs the signature or a key. The fire's deduplication id is the
 * signature, so a replay inside the queue's window is not a second fire.
 * The hour counts each signature once: a resent request takes no place and
 * is queued again, so a retry after a 502 still reaches the queue.
 *
 * @param {{ repo: string, hook: string }} target
 * @param {string | undefined} header The `Governor-Signature` header.
 * @param {Buffer} raw The raw body the caller signed.
 * @param {Deps} deps
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
const handleHook = async ({ repo, hook }, header, raw, deps) => {
  const about = { repo, hook };
  const signature = readSignature(header);
  if (signature === null) {
    deps.log('hook-refused', { ...about, reason: 'no Governor-Signature header of the form v=<version>,t=<unix seconds>,sha256=<hex>' });
    return { statusCode: 401, body: 'Governor-Signature is missing or malformed' };
  }
  if (!verifyHook(await deps.hookSecret(), { repo, hook }, signature, raw)) {
    deps.log('hook-refused', { ...about, keyVersion: signature.version, reason: 'the signature does not match the key for this repo, hook and version' });
    return { statusCode: 401, body: 'signature does not match' };
  }
  const now = (deps.now ?? Date.now)();
  const ahead = signature.t * 1000 - now;
  if (ahead > HOOK_CLOCK_AHEAD_MS || -ahead > HOOK_CLOCK_BEHIND_MS) {
    const reason = 'the signature\'s time is more than 30 seconds ahead of the receiver\'s clock or more than 4 minutes 25 seconds behind it';
    deps.log('hook-refused', { ...about, keyVersion: signature.version, t: signature.t, reason });
    return { statusCode: 401, body: reason };
  }
  const owner = repo.slice(0, repo.indexOf('/'));
  if (!ownerListed(deps.owners, owner)) {
    // Never an error: a stranger with a key of their own must not page anyone.
    deps.log('hook-ignored', { level: 'info', ...about, reason: `${repo}'s owner ${owner} is not on the owner list` });
    return { statusCode: 200, body: `${repo}'s owner is not on the owner list: nothing queued` };
  }
  /** @type {ReadonlyMap<string, import('./hook-table.mjs').Listed> | null} */
  let listed;
  try {
    listed = await deps.listedHooks(repo);
  } catch (error) {
    // Never taken for a missing item: that would queue a revoked key.
    deps.log('hook-table-unread', { level: 'error', ...about, error: String(/** @type {any} */ (error)?.message ?? error) });
    return { statusCode: 503, body: 'could not read the hook table: try again' };
  }
  const current = listed?.get(hook);
  if (listed !== null && current === undefined) {
    // A caller someone forgot: worth a look, not a page.
    deps.log('hook-refused', { level: 'warn', ...about, keyVersion: signature.version, reason: `${repo}'s config file, as governor last read it, lists no hook ${hook}` });
    return { statusCode: 401, body: `${repo} lists no hook ${hook}` };
  }
  if (current !== undefined && signature.version < current.keyVersion) {
    // Only a holder of a once-valid key can sign one: the key may have leaked.
    deps.log(HOOK_KEY_STALE, { level: 'error', ...about, keyVersion: signature.version, reason: `hook ${hook} in ${repo} was fired with key version ${signature.version}, and its file names version ${current.keyVersion}` });
    return { statusCode: 401, body: `key version ${signature.version} is revoked` };
  }
  // The caller signed it, so the operator may need to see why it went nowhere.
  const unread = (/** @type {number} */ statusCode, /** @type {string} */ body) => {
    deps.log('hook-refused', { ...about, keyVersion: signature.version, status: statusCode, reason: body });
    return { statusCode, body };
  };
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return unread(400, 'body is not JSON');
  }
  const text = body !== null && typeof body === 'object' ? body.text : undefined;
  if (typeof text !== 'string' || text.trim() === '') return unread(400, 'body holds no text: send {"text": "..."}');
  if (Buffer.byteLength(text) > HOOK_TEXT_LIMIT) return unread(413, `text is over ${HOOK_TEXT_LIMIT} bytes`);
  const fire = { ...build.hook({ hook, keyVersion: signature.version, text, at: new Date(now).toISOString() }), repo };
  // A fire too heavy for the lane's message would fail at the queue, where
  // no caller hears.
  if (fireWeight(fire) > FIRE_BUDGET) return unread(413, 'text is too long for a lane message: send less');
  // Counted last, so only a fire that would otherwise queue takes a place.
  // An item the task wrote before perHour had a ceiling may name more: held
  // to it, so an hour's set of signatures never outgrows its item.
  const cap = Math.min(current?.perHour ?? HOOK_PER_HOUR, HOOK_PER_HOUR_MAX);
  let counted;
  try {
    counted = await deps.countFire(repo, hook, now, cap, signature.hex);
  } catch (error) {
    deps.log('hook-table-uncounted', { level: 'error', ...about, error: String(/** @type {any} */ (error)?.message ?? error) });
    return { statusCode: 503, body: 'could not count the hook\'s fires: try again' };
  }
  if (counted === 'full') {
    // A flood from a valid key: worth a look, not a page.
    deps.log('hook-refused', { level: 'warn', ...about, keyVersion: signature.version, status: 429, reason: `hook ${hook} in ${repo} has had its ${cap} fires this hour` });
    return { statusCode: 429, body: `hook ${hook} takes at most ${cap} fires an hour: try again next hour` };
  }
  // A signature the hour counted already is queued again: if its first send
  // got through, the queue drops this one by its deduplication id.
  const messageId = await queueFire({ fire, reason: `hook ${hook} fired in ${repo}${counted === 'seen' ? ', sent again' : ''}` }, signature.hex, deps);
  return { statusCode: 202, body: `queued ${messageId}: hook ${hook} fired in ${repo}` };
};

/**
 * The schedule fire, invoked by the EventBridge rule with `{"kind":"schedule"}`.
 * Nothing signed it and nothing routes it: it is the fire, and it waits its
 * turn on the same lane a delivery's does.
 *
 * @param {Deps} deps
 * @returns {Promise<{ queued: boolean }>}
 */
export const handleSchedule = async (deps) => {
  await queueFire({ fire: build.schedule({}), reason: 'schedule fire' }, undefined, deps);
  return { queued: true };
};
