/**
 * What a finished run on the default branch tells whom: the
 * workflow turn's plan.
 *
 * The receiver queues a `job` fire for every shipping job that succeeded on
 * the default branch, and a `workflow` fire for every run that failed
 * (dispatch/webhook/route.mjs); the turn plans messages here for
 * a red CI, for a shipping job (its name carries the label, `deployed:
 * <target>`, and its file `TICKET_LABEL_PATHS`) and for a red
 * run of a workflow whose jobs earn one, from what dispatch/coverage.mjs
 * read of the fire: the
 * merges it covers, the PRs its paths pick, and each PR's sessions, the one
 * its body's Claude Code footer names (the owner a remark on the PR
 * reaches) and each subscribed to `ci` or to `deploys` (webhook/subscribe.mjs). A PR whose body names none was raised from a local session, and
 * its owner is the live session holding its head branch. The turn
 * labels tickets from the same reading. A subscriber is told the PR is not
 * its own, and gets no fallback.
 *
 * - A red CI run (the repo's `workflows.ci`) is its merges' to
 *   fix only when the CI run before it on the default branch was green.
 *   One that failed after a failure was broken already, and its
 *   breaker was told. With one suspect, its session is asked for a fix on a
 *   new branch, with a fallback, so an archived session's fix is still
 *   started. With several, none is told: one fresh session gets the run and
 *   the suspects, finds the culprit and owns the fix, so one break is one
 *   session's. One suspect Dependabot raised has no session, and the review
 *   merged it with nobody watching: one fresh session owns its fix too.
 * - A shipping job tells each PR it shipped whose files the target's paths
 *   pick (every PR for `all`) that its change is on the target, naming the
 *   job; a red run tells them the deploy after its merge failed. No
 *   fallback: a gone session owes no
 *   check. Every success asks for sign-off (the turn's standing line),
 *   unless the session knows otherwise: one whose change another target a
 *   merge starts (`on.push` or `on.workflow_run`) has still to ship waits
 *   for it by the github-tooling rule, since it knows from its own diff
 *   what it changed. Sessions sign off before a target the repo's config
 *   triages (`workflows.triage`, a repo's prod, say), so a failed deploy to one
 *   tells none of its merges' sessions: one fresh
 *   session gets the run and every merge it shipped, and owns the fix. A
 *   failed release dispatched by hand tells nobody: whoever dispatched it
 *   is watching it.
 *
 * A session hears of a run once: one message naming every PR of its
 * in the run's range, those it wrote apart from those it subscribes to, and
 * asking for one report, on the newest it wrote. One message is one
 * standing-line search, so a busy range does not spend the App's search
 * limit a PR at a time.
 *
 * A run covers every PR merged since its baseline (dispatch/coverage.mjs).
 * A reading that stopped short (a stale runs list, a cursor that cannot be
 * read, no baseline) tells nobody; the plan's `stale`
 * says when the turn logs it as its own event for an alarm to count.
 *
 * Each label's cursor under its workflow (dispatch/runs.mjs) is
 * the newest run whose news a turn planned: a green job's range, a red CI's
 * suspects. A refused turn leaves it. The plan names the cursor a
 * turn moves to (`advance`), which the turn writes after its sends.
 *
 * `planWorkflow` reads nothing but the branch lookups of the PRs it tells
 * and writes nothing; dispatch/turn.mjs sends what it plans.
 */

import { byMerge } from './coverage.mjs';
import { NO_WORKFLOWS, isCi } from './repo-config.mjs';
import { short } from './runs.mjs';
import { DEPENDABOT, FAILED, LABEL_PREFIX, UNATTENDED } from './webhook/fire.mjs';
import { oneLine } from './webhook/mention.mjs';
import { instruction } from './prompts.mjs';

/**
 * @typedef {Record<string, string | undefined>} Prompts A served repo's config file's prompts (dispatch/prompts.mjs).
 * @typedef {import('./repo-config.mjs').Workflows} Workflows A served repo's config file's `workflows`.
 * @typedef {Workflows['tags']} Tags The tag each target's deploy moves.
 */

/**
 * @typedef {import('./webhook/fire.mjs').WorkflowFire} WorkflowFire
 * @typedef {import('./webhook/fire.mjs').JobFire} JobFire
 * @typedef {WorkflowFire & { job?: string }} RunView
 *   What the texts read of a fire: a workflow fire as it is, or a job fire
 *   as the green run it is of, with `job`, the job's page.
 * @typedef {import('../scripts/lib/github-app.mjs').PullRow} PullRow
 * @typedef {import('../scripts/lib/github-app.mjs').JobRow} JobRow
 * @typedef {import('../scripts/lib/github-app.mjs').RunRow} RunRow
 * @typedef {{
 *   run: (runId: number) => Promise<import('../scripts/lib/github-app.mjs').RunDetail>,
 *   pullsForCommit: (sha: string) => Promise<PullRow[]>,
 *   runJobs: (runId: number) => Promise<JobRow[]>,
 *   workflowRuns: (file: string, options: { page?: number }) => Promise<RunRow[]>,
 *   compareCommits: (base: string, head: string) => Promise<import('../scripts/lib/github-app.mjs').CommitRow[]>,
 *   fileAt: (path: string, ref: string) => Promise<string>,
 *   pullFiles: (n: number) => Promise<import('../scripts/lib/github-app.mjs').FileRow[]>,
 * }} WorkflowReader
 * @typedef {{ prs: number[], subscribed: number[], session: string, closing: boolean, text: string, fallback?: { prompt: string, sessionName: string, issue: number } }} Note
 *   `prs`: every PR the message is about, oldest merge first; `subscribed`:
 *   those of them the session did not write, which a refusal drops it from.
 * @typedef {import('./coverage.mjs').Range} Range
 * @typedef {import('./coverage.mjs').Coverage} Coverage
 * @typedef {{ newest: { id: number, created: string } | null }} Stale
 * @typedef {{ reason: string | null, notes: Note[], unnamed: Array<{ pr: number, reason: string }>, triage: { prompt: string, sessionName: string } | null, range: Range | null, stale: Stale | null, advance: import('./runs.mjs').Cursor | null }} Plan
 *   `advance`: the workflow's cursor once the turn has sent, when it planned this run's news.
 */

/** A target without its article, for `<target> deploy`: `the dispatcher` is `dispatcher`. @param {string} target */
const bare = (target) => target.replace(/^the /, '');

/** @param {string} reason @param {Range | null} [range] @returns {Plan} */
const nobody = (reason, range = null) => ({ reason, notes: [], unnamed: [], triage: null, range, stale: null, advance: null });

/** @param {JobRow[]} failed */
export const jobList = (failed) =>
  (failed.length === 0 ? ['- none named; the run page says what stopped it'] : failed.map((j) => `- ${j.name} (${j.html_url})`));

/** @param {PullRow} pr */
const prLine = (pr) => `PR #${pr.number}: ${oneLine(pr.title)} (${pr.html_url})`;


/**
 * What a subscriber to a merged PR hears instead of its owner's text: the
 * same facts, with a heading and a close that say the PR is not its own.
 * `told`: whose own session has been told too, where a session wrote one.
 *
 * @param {string} heading
 * @param {string[]} facts
 * @param {string | null} told
 * @param {Prompts} prompts
 */
const subscriberText = (heading, facts, told, prompts) => [
  heading,
  '',
  ...facts,
  '',
  `${told === null ? '' : `${told} has been told too. `}${instruction(prompts, 'subscribed')}`,
].join('\n');

/**
 * @param {WorkflowFire} run
 * @param {PullRow} pr
 * @param {JobRow[]} failed
 * @param {boolean} owned
 * @param {Prompts} prompts
 */
const breakerSubscriberText = (run, pr, failed, owned, prompts) => subscriberText(
  `${run.name} on ${run.branch} failed after PR #${pr.number}, which you subscribe to, merged, and the ${run.name} run before it was green.`,
  [prLine(pr), `Run: ${run.url}, commit ${short(run.headSha)}`, 'Failed jobs:', ...jobList(failed)],
  owned ? "The PR's own session" : null,
  prompts,
);

/**
 * @param {WorkflowFire} run
 * @param {PullRow} pr
 * @param {JobRow[]} failed
 * @param {Prompts} prompts
 */
const breakerText = (run, pr, failed, prompts) => [
  `${run.name} on ${run.branch} failed after your pull request merged, and the ${run.name} run before it was green: your merge is the likely cause.`,
  '',
  prLine(pr),
  `Run: ${run.url}, commit ${short(run.headSha)}`,
  'Failed jobs:',
  ...jobList(failed),
  '',
  instruction(prompts, 'ciBreaker', { pr: pr.number }),
].join('\n');

/**
 * The prompt for the one fresh session a red run with several suspects
 * gets: it finds the culprit among them and owns the fix.
 *
 * @param {WorkflowFire} run
 * @param {PullRow[]} suspects
 * @param {JobRow[]} failed
 * @param {Prompts} prompts
 */
const triageText = (run, suspects, failed, prompts) => [
  `${run.name} on ${run.branch} failed, and the ${run.name} run before it was green. The run tested ${suspects.length} merges; one of them is the likely cause. None of their sessions has been told: this fix is yours.`,
  '',
  `Run: ${run.url}, commit ${short(run.headSha)}`,
  'Failed jobs:',
  ...jobList(failed),
  'Merges it tested:',
  ...suspects.map((p) => `- ${prLine(p)}`),
  '',
  instruction(prompts, 'ciTriage'),
  UNATTENDED,
].join('\n');

/**
 * The prompt for the one fresh session a red run gets when its one suspect
 * is a Dependabot bump: no session wrote it to be asked.
 *
 * @param {WorkflowFire} run
 * @param {PullRow} pr
 * @param {JobRow[]} failed
 * @param {Prompts} prompts
 */
const bumpTriageText = (run, pr, failed, prompts) => [
  `${run.name} on ${run.branch} failed after a Dependabot bump merged, and the ${run.name} run before it was green: the bump is the likely cause. No session wrote it: this fix is yours.`,
  '',
  prLine(pr),
  `Run: ${run.url}, commit ${short(run.headSha)}`,
  'Failed jobs:',
  ...jobList(failed),
  '',
  instruction(prompts, 'ciBumpTriage', { pr: pr.number }),
  UNATTENDED,
].join('\n');

/**
 * Where a triaged target's merges were when their sessions signed off:
 * each tagged target no triage holds, and every other target a merge
 * deploys. Sessions sign off before any triaged target.
 *
 * @param {Workflows} workflows
 */
const shippedBefore = ({ triage, tags }) => [...Object.keys(tags).filter((t) => !triage.includes(t)), 'every other target a merge deploys'].join(' and ');

/**
 * The prompt for the one fresh session a failed deploy to a target the
 * repo triages gets: the sessions of the merges it shipped signed off once
 * each was on every other target a merge deploys.
 *
 * @param {WorkflowFire} run
 * @param {string} target
 * @param {Workflows} workflows
 * @param {PullRow[]} shipped
 * @param {JobRow[]} failed
 * @param {Prompts} prompts
 */
const prodTriageText = (run, target, workflows, shipped, failed, prompts) => [
  `The ${bare(target)} deploy failed (${run.name})${notShipped(target, run.headSha, workflows.tags)} It shipped ${shipped.length === 1 ? 'one merge' : `${shipped.length} merges`} since the last successful ${bare(target)} deploy. Their sessions signed off once their changes were on ${shippedBefore(workflows)}: this fix is yours.`,
  '',
  `Run: ${run.url}`,
  'Failed jobs:',
  ...jobList(failed),
  'Merges it shipped:',
  ...shipped.map((p) => `- ${prLine(p)}`),
  '',
  instruction(prompts, 'prodTriage'),
  UNATTENDED,
].join('\n');

/** @param {PullRow[]} prs The last merged. */
const newest = (prs) => /** @type {PullRow} */ (prs[prs.length - 1]);

/** @param {PullRow[]} prs */
const prList = (prs) => (prs.length === 1 ? [prLine(newest(prs))] : prs.map((p) => `- ${prLine(p)}`));

/** @param {PullRow[]} prs */
const numbers = (prs) => prs.map((p) => `#${p.number}`).join(', ');

/**
 * Whose own session, of the `prs` a subscriber hears of, has been told too:
 * `told`, those of them a session wrote. Null when none.
 *
 * @param {PullRow[]} prs
 * @param {PullRow[]} told
 */
const toldToo = (prs, told) => {
  if (told.length === 0) return null;
  if (prs.length === 1) return "The PR's own session";
  if (told.length === prs.length) return "Each PR's own session";
  return told.length === 1 ? `PR #${told[0]?.number}'s own session` : `The own session of each of PRs ${numbers(told)}`;
};

/**
 * What a deploy tells a session that wrote some of the PRs it shipped and
 * subscribes to others: the ones it subscribes to, apart from its own.
 * `told`: those of them whose own session has been told too.
 *
 * @param {PullRow[]} subscribed
 * @param {PullRow[]} told
 */
const alsoSubscribed = (subscribed, told) => {
  if (subscribed.length === 0) return [];
  const whose = toldToo(subscribed, told);
  return [
    '',
    `It also covers ${subscribed.length === 1 ? 'a PR' : 'PRs'} you subscribe to, not your own; act on ${subscribed.length === 1 ? 'it' : 'them'} only for a check you promised:`,
    ...subscribed.map((p) => `- ${prLine(p)}`),
    ...(whose === null ? [] : [`${whose} has been told too.`]),
  ];
};

/**
 * Where a PR's change is: a tagged target bare (`dev`), any other with its
 * article (`the dispatcher`).
 *
 * @param {string} target
 * @param {Tags} tags
 */
const onTarget = (target, tags) => (Object.hasOwn(tags, target) || target.startsWith('the ') ? target : `the ${target}`);

/** The page a green note points at: the job's, where the fire was a job's, else the run's. @param {RunView} run */
const pageOf = (run) => (run.job === undefined ? [`Run: ${run.url}`] : [`Job: ${run.job}`]);

/**
 * What a green run says of the commit it shipped, and a red one of the
 * commit it did not: the tag the repo's config names for the target, where
 * it names one.
 *
 * @param {string} target
 * @param {string} sha
 * @param {Tags} tags
 */
const shippedAt = (target, sha, tags) => (Object.hasOwn(tags, target) ? `, and the ${tags[target]} tag is on ${short(sha)}.` : `, built from ${short(sha)}.`);

/** @param {string} target @param {string} sha @param {Tags} tags */
const notShipped = (target, sha, tags) => (Object.hasOwn(tags, target) ? `; ${tags[target]} did not move to ${short(sha)}.` : `; ${short(sha)} did not reach ${onTarget(target, tags)}.`);

/**
 * A deploy's message to a session that subscribes to every PR it names and
 * wrote none. `told`: the PRs whose own session has been told too.
 *
 * @param {RunView} run
 * @param {{ target: string, end: string, tags: Tags }} at
 * @param {PullRow[]} prs
 * @param {JobRow[]} failed
 * @param {PullRow[]} told
 * @param {Prompts} prompts
 */
const deploySubscriberText = (run, { target, end, tags }, prs, failed, told, prompts) => {
  const one = prs.length === 1;
  const which = one ? `PR #${prs[0]?.number}, which you subscribe to,` : `PRs ${numbers(prs)}, which you subscribe to,`;
  const heading = run.conclusion === 'success'
    ? `${which} ${one ? 'is' : 'are'} on ${onTarget(target, tags)}: ${run.name} published ${one ? 'it' : 'them'} (${run.job ?? run.url})${shippedAt(target, end, tags)}`
    : `The ${bare(target)} deploy after ${which} merged failed (${run.name})${notShipped(target, end, tags)}`;
  const facts = [...prList(prs), ...pageOf(run), ...(run.conclusion === 'success' ? [] : ['Failed jobs:', ...jobList(failed)])];
  return subscriberText(heading, facts, toldToo(prs, told), prompts);
};

/**
 * A deploy's message to a session that wrote `own`, oldest merge first: one
 * report asked for, on the newest. A green one names the job that
 * published the change: the news is the job's, not a run's.
 *
 * @param {RunView} run
 * @param {{ target: string, end: string, tags: Tags }} at
 * @param {PullRow[]} own
 * @param {PullRow[]} subscribed
 * @param {JobRow[]} failed
 * @param {PullRow[]} told Those of `subscribed` whose own session has been told too.
 * @param {Prompts} prompts
 */
const deployText = (run, { target, end, tags }, own, subscribed, failed, told, prompts) => {
  const one = own.length === 1;
  const last = newest(own).number;
  if (run.conclusion === 'success') {
    return [
      one
        ? `Your change is on ${onTarget(target, tags)}: ${run.name} published it (${run.job ?? run.url})${shippedAt(target, end, tags)}`
        : `Your changes are on ${onTarget(target, tags)}: ${run.name} published them (${run.job ?? run.url})${shippedAt(target, end, tags)}`,
      '',
      ...prList(own),
      ...pageOf(run),
      ...alsoSubscribed(subscribed, told),
      '',
      instruction(prompts, one ? 'deployGreen' : 'deployGreenMany', { pr: last, target: bare(target) }),
    ].join('\n');
  }
  return [
    one
      ? `The ${bare(target)} deploy after your pull request merged failed (${run.name})${notShipped(target, end, tags)}`
      : `The ${bare(target)} deploy after ${own.length} of your pull requests merged failed (${run.name})${notShipped(target, end, tags)}`,
    '',
    ...prList(own),
    `Run: ${run.url}`,
    'Failed jobs:',
    ...jobList(failed),
    ...alsoSubscribed(subscribed, told),
    '',
    instruction(prompts, one ? 'deployRed' : 'deployRedMany', { pr: last }),
  ].join('\n');
};

/**
 * Who hears of `invocation`, and what: a shipping job that succeeded, a red
 * CI run, or a red run of a workflow whose jobs earn a label, read off what
 * it covers. A job fire is read as the green run it is of, with the job's
 * page; its attempt is not held against it, since a re-run's first attempt
 * never succeeded, and the cursor keeps a re-fire to once
 * (dispatch/coverage.mjs).
 *
 * @param {{ invocation: WorkflowFire | JobFire, coverage: Coverage, prompts?: Prompts, workflows?: Workflows }} args
 *   `prompts`: the repo's config file's, which replace each text's
 *   instruction. `workflows`: its CI, triage targets and tags.
 * @returns {Promise<Plan>}
 */
export const planWorkflow = async ({ invocation, coverage, prompts = {}, workflows = NO_WORKFLOWS }) => {
  if (invocation.kind === 'job') {
    const { workflow, branch, runId, url, headSha, runAttempt } = invocation;
    return planTarget({ kind: 'workflow', name: workflow, branch, runId, url, conclusion: 'success', headSha, job: url, ...(runAttempt === undefined ? {} : { runAttempt }) }, coverage, prompts, workflows);
  }
  const run = invocation;
  const { name, runId, conclusion } = run;
  // A re-run completes the same run again; its first attempt told whom it
  // had to, and a second telling is a second session on one break.
  if ((run.runAttempt ?? 1) > 1) return nobody(`${name} run ${runId} attempt ${run.runAttempt}: its first attempt was told`);
  if (isCi(run, workflows)) {
    return conclusion === 'failure' ? planCi(run, coverage, prompts) : nobody(`${name} run ${runId} ended ${conclusion}: nothing to tell`);
  }
  if (conclusion !== 'failure') return nobody(`${name} run ${runId} ended ${conclusion}: ${conclusion === 'success' ? 'each shipping job in it is told on its own' : 'nothing to tell'}`);
  return planTarget(run, coverage, prompts, workflows);
};

/**
 * A reading that stopped short tells nobody: a stale list or an unread
 * cursor as its own event, the rest with the range it read, if any.
 *
 * @param {Coverage} coverage One whose `reason` is set.
 * @returns {Plan}
 */
const stoppedShort = ({ reason, stale, range }) => ({ ...nobody(String(reason), range), stale });

/**
 * A red CI run: its one suspect's session, or one fresh session for
 * several.
 *
 * @param {WorkflowFire} run
 * @param {Coverage} coverage
 * @param {Prompts} prompts
 * @returns {Promise<Plan>}
 */
const planCi = async (run, coverage, prompts) => {
  const { name, runId, headSha } = run;
  if (coverage.reason !== null) return stoppedShort(coverage);
  const { baseline, at: advance, range, shipped: pulls } = coverage;
  if (baseline === null) return nobody(`${name} run ${runId}: no baseline`);
  if (baseline.conclusion !== 'success') return { ...nobody(`${name} on ${run.branch} was already red before run ${runId} (${baseline.url}): its breaker was told`), advance };
  const failed = coverage.jobs.filter((j) => FAILED.has(String(j.conclusion)));
  if (pulls.length === 0) return { ...nobody(`${name} run ${runId}: no merged PR at ${short(headSha)}, so nobody to tell (a commit pushed to ${run.branch})`, range), advance };
  // Several suspects: telling each would set several sessions on one break.
  if (pulls.length > 1) {
    return {
      reason: null,
      notes: [],
      unnamed: [],
      triage: { prompt: triageText(run, pulls, failed, prompts), sessionName: oneLine(`${name} red ${short(headSha)}: ${pulls.length} merges`).slice(0, 100) },
      range,
      stale: null,
      advance,
    };
  }
  const bump = /** @type {PullRow} */ (pulls[0]);
  if (bump.author === DEPENDABOT) {
    return {
      reason: null,
      notes: [],
      unnamed: [],
      triage: { prompt: bumpTriageText(run, bump, failed, prompts), sessionName: oneLine(`${name} red #${bump.number} ${bump.title}`).slice(0, 100) },
      range,
      stale: null,
      advance,
    };
  }
  const { sessions, owned, unnamed } = await coverage.sessions(pulls, 'ci');
  /** @type {Plan} */
  const plan = { reason: null, notes: [], unnamed, triage: null, range, stale: null, advance };
  // A red CI run tells only a run of one merge, so each session has the one PR.
  for (const { session, own, subscribed } of sessions.values()) {
    const note = { prs: [...own, ...subscribed].map((p) => p.number), subscribed: subscribed.map((p) => p.number), session, closing: false };
    const pr = newest([...own, ...subscribed]);
    if (own.length === 0) {
      plan.notes.push({ ...note, text: breakerSubscriberText(run, pr, failed, owned.has(pr.number), prompts) });
    } else {
      const text = breakerText(run, pr, failed, prompts);
      plan.notes.push({
        ...note,
        text,
        fallback: {
          prompt: `${text}\nThe session that wrote PR #${pr.number} is gone; this fix is yours.\n${UNATTENDED}`,
          sessionName: oneLine(`${name} red #${pr.number} ${pr.title}`).slice(0, 100),
          issue: pr.number,
        },
      });
    }
  }
  return plan;
};

/**
 * A shipping job that succeeded, or a red run of a workflow whose jobs earn
 * a label: the sessions of the merges it shipped, or
 * failed to, that its paths pick.
 *
 * @param {RunView} run
 * @param {Coverage} coverage
 * @param {Prompts} prompts
 * @param {Workflows} workflows
 * @returns {Promise<Plan>}
 */
const planTarget = async (run, coverage, prompts, workflows) => {
  const { triage, tags } = workflows;
  const { name, runId, conclusion, headSha } = run;
  if (coverage.reason !== null) return stoppedShort(coverage);
  const { label, declared, range, picked: pulls } = coverage;
  if (label === null || declared === null || range === null) return nobody(`${name} run ${runId}: no deploy target`);
  const target = label.slice(LABEL_PREFIX.length);
  const { end } = range;
  const failed = coverage.jobs.filter((j) => FAILED.has(String(j.conclusion)));
  // A green job's news is planned from here; a red run's merges are still
  // owed the next green job's.
  const advance = conclusion === 'success' ? coverage.at : null;
  if (coverage.shipped.length === 0) return { ...nobody(`${name} run ${runId}: no merged PR at ${short(end)}, so nobody to tell (a dispatch, or a commit pushed to ${run.branch})`, range), advance };
  if (pulls.length === 0) return { ...nobody(`${name} run ${runId}: no merge it covers changed a file ${coverage.workflow} picks for ${label}, so nobody to tell`, range), advance };
  if (triage.includes(target) && conclusion === 'failure') {
    const sorted = [...pulls].sort(byMerge);
    const deploy = bare(target);
    return {
      reason: null,
      notes: [],
      unnamed: [],
      triage: { prompt: prodTriageText(run, target, workflows, sorted, failed, prompts), sessionName: oneLine(`${deploy.charAt(0).toUpperCase()}${deploy.slice(1)} deploy red ${short(headSha)}: ${sorted.length} merge${sorted.length === 1 ? '' : 's'}`).slice(0, 100) },
      range,
      stale: null,
      advance,
    };
  }

  const { sessions, owned, unnamed } = await coverage.sessions(pulls, 'deploys');
  /** @type {Plan} */
  const plan = { reason: null, notes: [], unnamed, triage: null, range, stale: null, advance };
  for (const { session, own, subscribed } of sessions.values()) {
    const prs = [...own, ...subscribed].sort(byMerge);
    const told = subscribed.filter((p) => owned.has(p.number));
    plan.notes.push({
      prs: prs.map((p) => p.number),
      subscribed: subscribed.map((p) => p.number),
      session,
      // Every success asks, "unless you know otherwise": a session whose
      // change another target still has to ship waits for it by the
      // github-tooling rule.
      closing: conclusion === 'success',
      text: own.length === 0
        ? deploySubscriberText(run, { target, end, tags }, subscribed, failed, told, prompts)
        : deployText(run, { target, end, tags }, own, subscribed, failed, told, prompts),
    });
  }
  return plan;
};

/**
 * The prompt a red scheduled run's fresh session opens with: the facts the
 * receiver wrote (dispatch/webhook/route.mjs), then the repo's
 * `redScheduledRun` prompt or the default. The task adds the instruction:
 * the receiver reads no config file.
 *
 * @param {string} facts
 * @param {Prompts} [prompts]
 */
export const redRunPrompt = (facts, prompts = {}) => [facts, '', instruction(prompts, 'redScheduledRun'), UNATTENDED].join('\n');
