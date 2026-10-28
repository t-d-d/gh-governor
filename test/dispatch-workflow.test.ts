/**
 * Who hears of a shipping job, or a red run, on main, and what:
 * planWorkflow read off what dispatch/coverage.mjs covers. Each case reads a fire's coverage through an injected reader and
 * plans from it; sending what the plan names, the cursor write and the logs
 * are dispatch/turn.mjs's, tested in test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coverageOf } from '../dispatch/coverage.mjs';
import { planWorkflow } from '../dispatch/workflow.mjs';
import { subscribeLine } from '../dispatch/webhook/subscribe.mjs';
import { UNATTENDED } from '../dispatch/webhook/fire.mjs';
import { FINAL_LABELS, FACTORY_WORKFLOWS, WORKFLOW_PATHS, headMerge, workflowFile } from './helpers/dispatch-workflows.ts';
import { CONFIG_PATH } from '../dispatch/repo-config.mjs';
import { factoryFile } from './helpers/factory.ts';

/** The factory's own file's prompts: the texts these cases read are the factory's. */
const PROMPTS = JSON.parse(factoryFile(CONFIG_PATH)).prompts;

const REPO = 'acme/factory';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const SESSION = 'https://claude.ai/code/session_01WROTEIT';
const JOB_URL = `https://github.com/${REPO}/actions/runs/500/job/1`;

const footer = (session: string) => `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${session}`;
const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/${REPO}/pull/${number}`,
  body: `The change.${footer(SESSION)}`,
  merged_at: '2026-09-25T11:00:00Z',
  merge_commit_sha: SHA,
  head: '',
  ...over,
});
const runRow = (id: number, conclusion: string, over: Record<string, unknown> = {}) => ({ id, status: 'completed', conclusion, event: 'push', head_branch: 'main', head_sha: `sha${id}`, html_url: `https://github.com/${REPO}/actions/runs/${id}`, created_at: new Date(NOW - (500 - id) * 60_000).toISOString(), ...over });
/** A red run of `name` on main (a workflow fire). */
const fire = (name: string, conclusion: string, over: Record<string, unknown> = {}) => ({
  kind: 'workflow' as const, name, path: WORKFLOW_PATHS[name], branch: 'main', event: 'push', runId: 500, url: `https://github.com/${REPO}/actions/runs/500`, conclusion, headSha: SHA, ...over,
});
/** The job of `workflow`'s run 500 that earned `label`, succeeded (a job fire); its name carries `commit` where one is given. */
const jobFire = (workflow: string, label: string, over: Record<string, unknown> = {}, commit = SHA) => ({
  kind: 'job' as const, name: `Publish at ${commit} · ${label}`, workflow, branch: 'main', runId: 500, jobId: 1, url: JOB_URL, headSha: SHA, label, commit, ...over,
});
const jobs = [
  { name: 'backend', conclusion: 'failure', html_url: `https://github.com/${REPO}/actions/runs/500/job/1` },
  { name: 'web', conclusion: 'success', html_url: `https://github.com/${REPO}/actions/runs/500/job/2` },
];
/** A marked job that succeeded, for `label`, at the commit the run's head names. */
const marked = (label: string, id = 500, conclusion = 'success') => ({ name: `Publish at sha${id} · ${label}`, conclusion, html_url: `https://x/${id}/job/1` });
const DEV = 'deployed: dev';
const PROD = 'deployed: prod';
/** Every run's jobs: both Deliver stages, green. */
const green = async (id: number) => [marked(DEV, id), marked(PROD, id)];

/** A reader answering coverage's reads, recording which it was asked. */
const reader = (over: Record<string, unknown> = {}) => {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      run: async (id: number) => { asked.push(`run ${id}`); return { ...runRow(id, 'success', { head_sha: SHA }), path: WORKFLOW_PATHS.Deliver, run_attempt: 1 }; },
      fileAt: async (path: string) => { asked.push(`file ${path}`); return workflowFile(path); },
      pullsForCommit: async (sha: string) => { asked.push(`pulls ${sha}`); return sha === SHA ? [pr(799)] : []; },
      runJobs: async (id: number) => { asked.push(`jobs ${id}`); return jobs; },
      workflowRuns: async (file: string) => { asked.push(`runs ${file}`); return [runRow(501, 'failure'), runRow(500, 'failure'), runRow(499, 'cancelled'), runRow(498, 'success')]; },
      compareCommits: async (base: string, head: string) => { asked.push(`compare ${base}...${head}`); return headMerge(base, head); },
      pullFiles: async () => [],
      ...over,
    },
  };
};

type Cursor = { runId: number; commit: string; created: string } | null;
type Invocation = ReturnType<typeof fire> | ReturnType<typeof jobFire>;
/** The plan for `invocation`, from a reading of what it covers. */
const planOf = async (invocation: Invocation, r: ReturnType<typeof reader>, { cursor = async () => null, onBranch }: { cursor?: () => Promise<Cursor>; onBranch?: (branch: string) => Promise<string | null> } = {}) => {
  const coverage = await coverageOf({ invocation: invocation as never, reader: r.reader as never, repo: REPO, workflows: FACTORY_WORKFLOWS, sleep: async () => {}, cursor, ...(onBranch === undefined ? {} : { onBranch }) });
  return planWorkflow({ invocation: invocation as never, coverage, prompts: PROMPTS, workflows: FACTORY_WORKFLOWS });
};
/** A reader for a green Deliver run 500 at SHA after a green run 498: the job fires' usual ground. */
const delivered = (over: Record<string, unknown> = {}) => reader({
  runJobs: green,
  workflowRuns: async () => [runRow(500, 'success', { head_sha: SHA }), runRow(498, 'success', { head_sha: 'shaB' })],
  ...over,
});

describe('planWorkflow — a red CI run', () => {
  test('one suspect: its session is asked for a fix on a new branch, naming the run and the failed jobs, with a fresh session as the fallback', async () => {
    const r = reader();
    const plan = await planOf(fire('CI', 'failure'), r);
    assert.ok(r.asked.includes('runs ci.yml'), r.asked.join(', '));
    assert.equal(plan.notes.length, 1);
    const [note] = plan.notes;
    assert.equal(note!.session, SESSION);
    assert.deepEqual(note!.prs, [799]);
    assert.equal(note!.closing, false);
    for (const want of [/actions\/runs\/500/, /backend/, /PR #799/, /new branch/i, /ops-tooling/]) assert.match(note!.text, want);
    assert.doesNotMatch(note!.text, /\bweb\b/, 'a job that passed is not a failed job');
    assert.ok(!note!.text.includes(UNATTENDED), 'a message to a session that exists says nothing of who attends it (#883)');
    assert.match(note!.fallback!.prompt, /actions\/runs\/500/);
    assert.match(note!.fallback!.prompt, /backend/);
    assert.ok(note!.fallback!.prompt.includes(UNATTENDED), 'a session the dispatcher starts has nobody at it (#883)');
    assert.match(note!.fallback!.sessionName, /#799/);
    assert.equal(note!.fallback!.issue, 799);
    assert.equal(plan.triage, null);
  });

  test('after a red, a timed-out, or a red behind a run dispatched by hand, tells nobody and reads no PR: its breaker was told', async () => {
    for (const runs of [
      [runRow(500, 'failure'), runRow(499, 'cancelled'), runRow(498, 'failure'), runRow(497, 'success')],
      [runRow(500, 'failure'), runRow(499, 'timed_out'), runRow(498, 'success')],
      [runRow(500, 'failure'), runRow(499, 'success', { event: 'workflow_dispatch' }), runRow(498, 'failure'), runRow(497, 'success')],
    ]) {
      const r = reader({ workflowRuns: async () => runs });
      const plan = await planOf(fire('CI', 'failure'), r);
      assert.deepEqual(plan.notes, []);
      assert.equal(plan.triage, null);
      assert.match(String(plan.reason), /already red/);
      assert.ok(!r.asked.some((a) => a.startsWith('pulls')), 'no PR is read for a run that names no breaker');
      assert.equal(plan.advance?.runId, 500, 'the red run is planned: the next one starts past it');
    }
  });

  /**
   * CI cancels a run on main when the next push lands, so one red run can
   * cover several merges. Telling each would set several sessions on one
   * break: one fresh session gets the run and the suspects instead.
   */
  test('two suspects: one fresh session gets the run and both, and no session is told', async () => {
    const r = reader({
      workflowRuns: async () => [runRow(500, 'failure', { head_sha: SHA }), runRow(499, 'cancelled'), runRow(498, 'success', { head_sha: 'shaG' })],
      compareCommits: async () => [{ sha: 'm1', message: 'Merge pull request #767 from acme/claude/one' }, { sha: SHA, message: 'Merge pull request #799 from acme/claude/two' }],
      pullsForCommit: async (sha: string) => (sha === 'm1' ? [pr(767, { merge_commit_sha: 'm1', body: `One.${footer('https://claude.ai/code/session_01ONE')}` })] : sha === SHA ? [pr(799)] : []),
    });
    const plan = await planOf(fire('CI', 'failure'), r);
    assert.deepEqual(plan.notes, [], 'no suspect\'s session is told');
    for (const want of [/PR #767/, /PR #799/, /actions\/runs\/500/, /backend/, /new branch/i, /comment on the/i]) assert.match(plan.triage!.prompt, want);
    assert.ok(plan.triage!.prompt.includes(UNATTENDED), 'a triage session is one the dispatcher starts (#883)');
    assert.match(plan.triage!.sessionName, /^CI red \w+: 2 merges$/);
    assert.equal(plan.advance?.runId, 500);
  });

  test('one suspect Dependabot raised: no session wrote it, so one fresh session gets the run and owns the fix', async () => {
    const bump = pr(799, { title: 'Bump the pip group across 1 directory with 3 updates', body: 'Bumps the pip group with 3 updates.', head: 'dependabot/pip/normalize-lambda/pip-5c28d0fd8d', author: 'dependabot[bot]' });
    const plan = await planOf(fire('CI', 'failure'), reader({ pullsForCommit: async (sha: string) => (sha === SHA ? [bump] : []) }), { onBranch: async () => null });
    assert.deepEqual(plan.notes, [], 'no session to tell');
    assert.ok(plan.triage, 'one fresh session owns the fix');
    for (const want of [/PR #799/, /Dependabot/, /actions\/runs\/500/, /backend/, /new branch/i, /revert/i]) assert.match(plan.triage!.prompt, want);
    assert.ok(plan.triage!.prompt.includes(UNATTENDED), 'a triage session is one the dispatcher starts (#883)');
    assert.match(plan.triage!.sessionName, /^CI red #799 Bump/);
    assert.equal(plan.advance?.runId, 500);
  });

  test('one suspect a person or a gone local session raised still tells nobody: only Dependabot\'s merge has no one to ask', async () => {
    const plan = await planOf(fire('CI', 'failure'), reader({ pullsForCommit: async (sha: string) => (sha === SHA ? [pr(799, { body: 'A person wrote this.', author: 'a-member' })] : []) }), { onBranch: async () => null });
    assert.deepEqual(plan.notes, []);
    assert.equal(plan.triage, null);
    assert.equal(plan.unnamed[0]?.pr, 799);
  });

  // A red run newer than the cursor was never planned, so its merges are suspects too.
  test('past a red run newer than the cursor, its merges are suspects too; after a red run a turn planned, nobody is told', async () => {
    const MERGE_R = 'f'.repeat(40);
    const over = (runs: unknown[]) => ({
      workflowRuns: async () => runs,
      compareCommits: async (base: string, head: string) => (base === 'shaB'
        ? [{ sha: MERGE_R, message: 'Merge pull request #804 from acme/r' }, { sha: head, message: 'Merge pull request #799 from acme/x' }]
        : [{ sha: head, message: 'Merge pull request #799 from acme/x' }]),
      pullsForCommit: async (sha: string) => (sha === SHA ? [pr(799)] : sha === MERGE_R ? [pr(804, { merge_commit_sha: MERGE_R, merged_at: '2026-09-25T10:00:00Z' })] : []),
    });
    const reds = [runRow(500, 'failure', { head_sha: SHA }), runRow(499, 'failure', { head_sha: 'shaR' }), runRow(498, 'success', { head_sha: 'shaB' }), runRow(497, 'failure', { head_sha: 'shaO' })];
    const past = await planOf(fire('CI', 'failure'), reader(over(reds)), { cursor: async () => ({ runId: 497, commit: 'shaO', created: runRow(497, 'success').created_at }) });
    assert.equal(past.reason, null, String(past.reason));
    assert.match(past.triage!.prompt, /PR #804/);
    assert.match(past.triage!.prompt, /PR #799/);
    assert.deepEqual(past.advance, { runId: 500, commit: SHA, created: runRow(500, 'success').created_at });

    const planned = await planOf(fire('CI', 'failure'), reader(over(reds.slice(0, 3))), { cursor: async () => ({ runId: 499, commit: 'shaR', created: '' }) });
    assert.match(String(planned.reason), /already red/);
    assert.equal(planned.advance?.runId, 500);
  });

  test('a run whose commit merged no PR tells nobody and says why', async () => {
    for (const pullsForCommit of [
      async () => [],
      async () => [pr(799, { merge_commit_sha: 'other' })],
      async () => [pr(799, { merged_at: null })],
    ]) {
      const plan = await planOf(fire('CI', 'failure'), reader({ pullsForCommit }));
      assert.deepEqual(plan.notes, []);
      assert.match(String(plan.reason), /no merged PR/);
    }
  });

  test('a green CI run tells nobody and moves no cursor', async () => {
    const plan = await planOf(fire('CI', 'success'), reader());
    assert.deepEqual([plan.notes, plan.triage, plan.advance], [[], null, null]);
  });

  // A re-run of a red run that fails again completes the same run id again.
  test('a later attempt reads nothing and tells nobody: the first attempt did', async () => {
    const r = reader();
    const plan = await planOf(fire('CI', 'failure', { runAttempt: 2 }), r);
    assert.deepEqual(r.asked, []);
    assert.deepEqual(plan.notes, []);
    assert.equal(plan.triage, null);
    assert.match(String(plan.reason), /attempt 2/);
  });
});

describe('planWorkflow — a deploy', () => {
  // The news is a job's, so the message says which job published it.
  test('a green dev job tells the PR its change is on dev, naming the workflow, the job and the deploy/dev tag, asks for sign-off, and has no fallback', async () => {
    const plan = await planOf(jobFire('Deliver', DEV), delivered());
    assert.equal(plan.notes.length, 1);
    const [note] = plan.notes;
    assert.deepEqual([note!.session, note!.prs, note!.closing], [SESSION, [799], true]);
    assert.match(note!.text, /^Your change is on dev: Deliver published it \(https:\/\/github\.com\/acme\/factory\/actions\/runs\/500\/job\/1\), and the deploy\/dev tag is on a1b2c3d4e5f6\./m);
    for (const want of [/PR #799/, /`dev deploy`/]) assert.match(note!.text, want);
    assert.doesNotMatch(note!.text, /finished green/);
    assert.ok(!note!.text.includes(UNATTENDED), 'a deploy note goes to a session that exists (#883)');
    assert.equal(note!.fallback, undefined, 'a gone session owes nothing');
    assert.equal(plan.advance?.runId, 500);
  });

  test('a job re-run attempt is planned like any: the cursor, not the attempt, keeps it to once', async () => {
    const plan = await planOf(jobFire('Deliver', DEV, { runAttempt: 2 }), delivered());
    assert.equal(plan.notes.length, 1);
    const planned = await planOf(jobFire('Deliver', DEV, { runAttempt: 2 }), delivered(), { cursor: async () => ({ runId: 500, commit: SHA, created: '' }) });
    assert.deepEqual([planned.notes, planned.advance], [[], null]);
    assert.match(String(planned.reason), /cursor/);
  });

  /**
   * A session signs off once its change is on dev, so the sessions of the
   * merges a prod stage ships are gone by the time it runs. A red Deliver
   * run is a failed release whichever stage failed, so its target is prod:
   * one fresh session with every merge it shipped since the last prod.
   */
  test('a red Deliver run tells no session and plans one triage session with the merges it shipped since the last green prod stage', async () => {
    const plan = await planOf(fire('Deliver', 'failure'), reader({ runJobs: async (id: number) => (id === 500 ? [marked(DEV), marked(PROD, 500, 'failure')] : green(id)) }));
    assert.deepEqual(plan.notes, [], 'its merges\' sessions signed off at dev');
    for (const want of [/The prod deploy failed \(Deliver\)/, /deploy\/prod did not move/, /PR #799/, /actions\/runs\/500/, /Publish at sha500 · deployed: prod/, /new branch/i, /issue/i]) assert.match(plan.triage!.prompt, want);
    assert.ok(plan.triage!.prompt.includes(UNATTENDED), 'a triage session is one the dispatcher starts (#883)');
    assert.match(plan.triage!.sessionName, /^Prod deploy red \w+: 1 merge$/);
    assert.equal(plan.advance, null, 'a red run advances no cursor');
  });

  // A failed rollback: the compare from the baseline's commit holds nothing, and the PR at its head is still the news.
  test('a red Deliver run of a commit its baseline already covers still plans its triage session', async () => {
    const plan = await planOf(fire('Deliver', 'failure'), reader({
      runJobs: async (id: number) => (id === 500 ? [marked(PROD, 500, 'failure')] : green(id)),
      workflowRuns: async () => [runRow(500, 'failure', { head_sha: SHA }), runRow(498, 'success', { head_sha: 'f'.repeat(40) })],
      compareCommits: async () => [],
    }));
    assert.deepEqual(plan.notes, []);
    assert.match(plan.triage!.sessionName, /^Prod deploy red /);
  });

  /** A prod stage ships every change since the last one, so every PR merged in that range hears it is live. */
  test('a green prod job tells every PR merged since the last green prod job, reading only the merges\' PRs', async () => {
    const r = reader({
      runJobs: green,
      workflowRuns: async (file: string) => { r.asked.push(`runs ${file}`); return [runRow(500, 'success', { head_sha: SHA }), runRow(499, 'failure', { head_sha: 'shaF' }), runRow(498, 'success', { head_sha: 'shaP' })]; },
      compareCommits: async (base: string, head: string) => { r.asked.push(`compare ${base}...${head}`); return [
        { sha: 'm1', message: 'Merge pull request #767 from acme/claude/one\n\nOne' },
        { sha: 'c1', message: 'A commit on a branch' },
        { sha: 'm2', message: "Merge remote-tracking branch 'origin/main' into claude/two" },
        { sha: SHA, message: 'Merge pull request #799 from acme/claude/two' },
      ]; },
      pullsForCommit: async (sha: string) => {
        r.asked.push(`pulls ${sha}`);
        if (sha === 'm1') return [pr(767, { merge_commit_sha: 'm1', body: `One.${footer('https://claude.ai/code/session_01ONE')}` })];
        return sha === SHA ? [pr(799)] : [];
      },
    });
    const plan = await planOf(jobFire('Deliver', PROD), r);
    assert.ok(r.asked.includes('runs deliver.yml'), r.asked.join(', '));
    assert.ok(r.asked.includes(`compare shaP...${SHA}`), r.asked.join(', '));
    assert.deepEqual(r.asked.filter((a) => a.startsWith('pulls')).sort(), ['pulls m1', `pulls ${SHA}`].sort(), 'only the merges of a PR are read');
    assert.deepEqual(plan.notes.map((n) => [n.session, n.prs]).sort(), [['https://claude.ai/code/session_01ONE', [767]], [SESSION, [799]]]);
    assert.ok(plan.notes.every((n) => /on prod: Deliver published it/.test(n.text) && /deploy\/prod/.test(n.text) && n.closing));
  });

  // A run that stopped after dev is no baseline for prod.
  test('a prod job\'s range runs from the last run whose prod job succeeded, across a run that shipped dev alone', async () => {
    const r = reader({
      runJobs: async (id: number) => (id === 499 ? [marked(DEV, 499), marked(PROD, 499, 'skipped')] : green(id)),
      workflowRuns: async () => [runRow(500, 'success', { head_sha: SHA }), runRow(499, 'success', { head_sha: 'shaR' }), runRow(498, 'success', { head_sha: 'shaB' })],
      compareCommits: async (base: string, head: string) => { r.asked.push(`compare ${base}...${head}`); return [{ sha: 'm1', message: 'Merge pull request #767 from acme/claude/one' }, { sha: head, message: 'Merge pull request #799 from acme/claude/two' }]; },
      pullsForCommit: async (sha: string) => (sha === 'm1' ? [pr(767, { merge_commit_sha: 'm1', body: `One.${footer('https://claude.ai/code/session_01ONE')}` })] : sha === SHA ? [pr(799)] : []),
    });
    const plan = await planOf(jobFire('Deliver', PROD), r);
    assert.ok(r.asked.includes(`compare shaB...${SHA}`), r.asked.join(', '));
    assert.equal(plan.range?.baseline.id, 498);
    assert.equal(plan.notes.length, 2);
  });

  // A list holding the run holds every run between it and its baseline, so it is trusted whatever range it yields.
  test('a dev job from a days-old baseline over many merges tells each', async () => {
    const merges = Array.from({ length: 35 }, (_, i) => ({ sha: i === 34 ? SHA : `m${i}`, message: `Merge pull request #${711 + i} from acme/claude/x` }));
    const plan = await planOf(jobFire('Deliver', DEV), reader({
      runJobs: green,
      workflowRuns: async () => [runRow(500, 'success', { head_sha: SHA }), runRow(498, 'success', { head_sha: 'shaB', created_at: new Date(NOW - 3 * 86_400_000).toISOString() })],
      compareCommits: async () => merges,
      pullsForCommit: async (sha: string) => {
        const i = merges.findIndex((m) => m.sha === sha);
        return i < 0 ? [] : [pr(711 + i, { merge_commit_sha: sha, body: `PR.${footer(`https://claude.ai/code/session_01N${i}`)}` })];
      },
    }));
    assert.equal(plan.notes.length, 35);
    assert.equal(plan.range?.merges, 35);
  });

  test('a PR naming no session is unnamed, with why, and nobody is told', async () => {
    const plan = await planOf(jobFire('Deliver', DEV), delivered({ pullsForCommit: async () => [pr(799, { body: 'A person wrote this.' })] }));
    assert.deepEqual(plan.notes, []);
    assert.equal(plan.unnamed[0]?.pr, 799);
    assert.match(String(plan.unnamed[0]?.reason), /names no session/);
  });

  test('a reading that stopped short tells nobody and moves no cursor: a stale runs list pages, a cursor it cannot read pages, a job of the cursor\'s commit does neither', async () => {
    const stale = await planOf(jobFire('Deliver', DEV), delivered({ workflowRuns: async () => [runRow(497, 'success')] }));
    assert.deepEqual([stale.notes, stale.advance], [[], null]);
    assert.equal(stale.stale?.newest?.id, 497);

    for (const [invocation, name] of [[fire('CI', 'failure'), 'CI'], [jobFire('Deliver', DEV), 'Deliver']] as const) {
      const unread = await planOf(invocation, reader({ runJobs: green, workflowRuns: async () => [runRow(500, name === 'CI' ? 'failure' : 'success', { head_sha: SHA }), runRow(498, 'success', { head_sha: 'shaB' })] }), { cursor: async () => { throw new Error('AccessDeniedException: dynamodb:GetItem'); } });
      assert.deepEqual([unread.notes, unread.triage, unread.advance], [[], null, null], name);
      assert.match(String(unread.reason), /AccessDeniedException/, name);
      assert.deepEqual(unread.stale, { newest: null }, `${name}: pages as a stale list does`);
    }

    const again = await planOf(jobFire('Deliver', DEV), delivered({ workflowRuns: async () => [runRow(500, 'success', { head_sha: SHA }), runRow(499, 'success', { head_sha: SHA })] }), { cursor: async () => ({ runId: 499, commit: SHA, created: '' }) });
    assert.deepEqual([again.notes, again.advance, again.stale], [[], null, null]);
    assert.match(String(again.reason), /shipped no merge since run 499/);
  });

  test('a red run of a target a merge starts, from the cursor, tells each PR it shipped, and leaves the cursor', async () => {
    const MERGE_R = 'f'.repeat(40);
    const DISPATCHER = FINAL_LABELS['Dispatch stack']!;
    const plan = await planOf(fire('Dispatch stack', 'failure'), reader({
      runJobs: async (id: number) => [marked(DISPATCHER, id, id === 500 ? 'failure' : 'success')],
      workflowRuns: async () => [runRow(500, 'failure', { head_sha: SHA }), runRow(499, 'success', { head_sha: 'shaR' }), runRow(498, 'success', { head_sha: 'shaB' })],
      compareCommits: async () => [{ sha: MERGE_R, message: 'Merge pull request #804 from acme/r' }, { sha: SHA, message: 'Merge pull request #799 from acme/x' }],
      pullsForCommit: async (sha: string) => (sha === SHA ? [pr(799)] : sha === MERGE_R ? [pr(804, { merge_commit_sha: MERGE_R, merged_at: '2026-09-25T10:00:00Z', body: `Other.${footer('https://claude.ai/code/session_01REFUSED')}` })] : []),
      pullFiles: async () => [{ filename: 'dispatch/turn.mjs', status: 'modified' }],
    }), { cursor: async () => ({ runId: 498, commit: 'shaB', created: '' }) });
    assert.equal(plan.range?.baseline.id, 498);
    assert.equal(plan.notes.length, 2);
    assert.equal(plan.advance, null);
  });
});

/** A merged PR's subscribers to `ci` and `deploys` hear of the runs on main the way its owner does, without the owner's fallback. */
describe('planWorkflow — a run\'s subscribers', () => {
  const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';
  const body = (events: Parameters<typeof subscribeLine>[1]) => `The change.\n\n${subscribeLine(REVIEWER, events)}${footer(SESSION)}`;
  const watched = (prBody: string, over: Record<string, unknown> = {}) => delivered({ pullsForCommit: async (sha: string) => (sha === SHA ? [pr(799, { body: prBody })] : []), ...over });
  const DISPATCHER = FINAL_LABELS['Dispatch stack']!;
  /** A red Dispatch stack run 500, after a green 498. */
  const redDispatcher = (prBody: string) => watched(prBody, {
    runJobs: async (id: number) => [marked(DISPATCHER, id, id === 500 ? 'failure' : 'success')],
    workflowRuns: async () => [runRow(500, 'failure', { head_sha: SHA }), runRow(498, 'success', { head_sha: 'shaB' })],
    pullFiles: async () => [{ filename: 'dispatch/turn.mjs', status: 'modified' }],
  });

  test('a subscriber to ci and deploys hears of each with no Unattended line: its session exists', async () => {
    for (const [invocation, name, r] of [
      [fire('CI', 'failure'), 'CI', watched(body(['ci', 'deploys']), { workflowRuns: async () => [runRow(500, 'failure', { head_sha: SHA }), runRow(498, 'success')], runJobs: async () => jobs })],
      [jobFire('Deliver', DEV), 'Deliver dev', watched(body(['ci', 'deploys']))],
      [fire('Dispatch stack', 'failure'), 'Dispatch stack red', redDispatcher(body(['ci', 'deploys']))],
    ] as const) {
      const plan = await planOf(invocation, r);
      assert.deepEqual(plan.notes.map((n) => n.session).sort(), [SESSION, REVIEWER].sort(), `${name}: ${plan.reason}`);
      for (const n of plan.notes) assert.ok(!n.text.includes(UNATTENDED), `${name} to ${n.session}`);
    }
  });

  test('a subscriber to deploys hears a dev job after the owner, told whose PR it is and which job published it', async () => {
    const plan = await planOf(jobFire('Deliver', DEV), watched(body(['deploys'])));
    assert.deepEqual(plan.notes.map((n) => n.session), [SESSION, REVIEWER]);
    assert.match(plan.notes[0]!.text, /Your change is on dev/);
    assert.match(plan.notes[1]!.text, /^PR #799, which you subscribe to, is on dev: Deliver published it \(https:\/\/github\.com\/acme\/factory\/actions\/runs\/500\/job\/1\), and the deploy\/dev tag is on a1b2c3d4e5f6\./m);
    assert.doesNotMatch(plan.notes[1]!.text, /Your change/);
    assert.match(plan.notes[1]!.text, /own session has been told/);
    assert.deepEqual(plan.notes[1]!.subscribed, [799], 'a refusal drops it from the PR');
  });

  test('a subscriber to a PR no session owns is not told an owner heard too', async () => {
    const plan = await planOf(jobFire('Deliver', DEV), watched(`A person's change.\n\n${subscribeLine(REVIEWER, ['deploys'])}`));
    assert.deepEqual(plan.notes.map((n) => n.session), [REVIEWER]);
    assert.doesNotMatch(plan.notes[0]!.text, /own session has been told/);
  });

  test('a subscriber to ci hears a red main with no fallback; one subscribed only to deploys hears nothing of it', async () => {
    const redCi = (prBody: string) => watched(prBody, { workflowRuns: async () => [runRow(500, 'failure', { head_sha: SHA }), runRow(498, 'success')], runJobs: async () => jobs });
    const ci = await planOf(fire('CI', 'failure'), redCi(body(['ci'])));
    assert.deepEqual(ci.notes.map((n) => [n.session, n.fallback === undefined]), [[SESSION, false], [REVIEWER, true]], 'only the owner\'s refusal starts a fix session');
    assert.deepEqual(ci.notes[1]!.subscribed, [799]);

    const deploysOnly = await planOf(fire('CI', 'failure'), redCi(body(['deploys'])));
    assert.deepEqual(deploysOnly.notes.map((n) => n.session), [SESSION]);
  });

  test('every green job, dev or prod, asks each session to sign off; a red run does not', async () => {
    for (const label of [DEV, PROD]) {
      const plan = await planOf(jobFire('Deliver', label), watched(body(['deploys'])));
      assert.deepEqual(plan.notes.map((n) => n.closing), [true, true], label);
    }
    const red = await planOf(fire('Dispatch stack', 'failure'), redDispatcher(body(['deploys'])));
    assert.deepEqual(red.notes.map((n) => n.closing), [false, false]);
  });
});

/**
 * A session hears of a run once, every PR of its in the run's range
 * named, with one report asked for, on the newest.
 */
describe('planWorkflow — one note per session for a run over several PRs', () => {
  const OWNER = SESSION;
  const OTHER = 'https://claude.ai/code/session_01OTHERONE';
  const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';
  const DISPATCHER = FINAL_LABELS['Dispatch stack']!;
  /** `prs`, merged in number order, each by its own commit, the last at the run's head. */
  const over = (prs: Array<{ number: number; body: string }>, conclusion: string) => {
    const shas = prs.map((p, i) => (i === prs.length - 1 ? SHA : `m${p.number}`));
    const pulls = prs.map((p, i) => pr(p.number, { title: `The change ${p.number}`, body: p.body, merge_commit_sha: shas[i], merged_at: `2026-09-26T${String(p.number - 748).padStart(2, '0')}:00:00Z` }));
    return reader({
      pullsForCommit: async (sha: string) => pulls.filter((p) => p.merge_commit_sha === sha),
      runJobs: async (id: number) => (conclusion === 'success' ? green(id) : [{ ...marked(DISPATCHER, id, id === 500 ? 'failure' : 'success'), html_url: 'https://x/job/1' }]),
      workflowRuns: async () => [runRow(500, conclusion, { head_sha: SHA }), runRow(490, 'success', { head_sha: 'shaP' })],
      compareCommits: async () => shas.map((sha, i) => ({ sha, message: `Merge pull request #${prs[i]!.number} from acme/claude/x` })),
      pullFiles: async () => [{ filename: 'dispatch/turn.mjs', status: 'modified' }],
    });
  };

  test('a red run over three PRs of one session is one note naming all three, asking for one report on the newest', async () => {
    const prs = [767, 786, 799].map((number) => ({ number, body: `The change.${footer(OWNER)}` }));
    const plan = await planOf(fire('Dispatch stack', 'failure'), over(prs, 'failure'));
    assert.equal(plan.notes.length, 1, String(plan.reason));
    assert.deepEqual(plan.notes[0]!.prs, [767, 786, 799]);
    const { text } = plan.notes[0]!;
    for (const n of [767, 786, 799]) assert.match(text, new RegExp(`PR #${n}: The change ${n} \\(https://github\\.com/${REPO}/pull/${n}\\)`));
    assert.match(text, /Publish at sha500 · deployed: the dispatcher \(https:\/\/x\/job\/1\)/, 'the failed job');
    assert.match(text, /on PR #799\b/, 'the report goes on the newest');
    assert.doesNotMatch(text, /on PR #439[05]\b/);
  });

  test('a green dev job over PRs of two sessions tells each once, with only its own PRs', async () => {
    const plan = await planOf(jobFire('Deliver', DEV), over([
      { number: 767, body: `One.${footer(OWNER)}` },
      { number: 786, body: `Two.${footer(OTHER)}` },
      { number: 799, body: `Three.${footer(OWNER)}` },
    ], 'success'));
    assert.deepEqual(plan.notes.map((n) => n.session).sort(), [OTHER, OWNER].sort());
    const own = plan.notes.find((n) => n.session === OWNER)!;
    assert.deepEqual(own.prs, [767, 799]);
    assert.doesNotMatch(own.text, /PR #786: The change/);
    assert.match(own.text, /^Your changes are on dev: Deliver published them \(https:\/\/github\.com\/acme\/factory\/actions\/runs\/500\/job\/1\), and the deploy\/dev tag is on a1b2c3d4e5f6\./m);
    assert.match(own.text, /`dev deploy`/);
    assert.match(own.text, /on PR #799\b/);
    const other = plan.notes.find((n) => n.session === OTHER)!;
    assert.match(other.text, /Your change is on dev/, 'a single-PR session reads as before');
    assert.match(other.text, /on PR #786\b/);
  });

  test('a session subscribed to several of the run\'s PRs is one note naming each, dropped from each on a refusal', async () => {
    const prs = [767, 786].map((number) => ({ number, body: `The change.\n\n${subscribeLine(REVIEWER, ['deploys'])}${footer(number === 767 ? OWNER : OTHER)}` }));
    const plan = await planOf(jobFire('Deliver', DEV), over(prs, 'success'));
    const toReviewer = plan.notes.filter((n) => n.session === REVIEWER);
    assert.equal(toReviewer.length, 1);
    assert.match(toReviewer[0]!.text, /^PRs #767, #786, which you subscribe to, are on dev: Deliver published them \(https:\/\/github\.com\/acme\/factory\/actions\/runs\/500\/job\/1\)/m);
    assert.match(toReviewer[0]!.text, /PR #767/);
    assert.match(toReviewer[0]!.text, /PR #786/);
    assert.deepEqual(toReviewer[0]!.subscribed, [767, 786]);
  });

  test('a session owning one PR and subscribed to another is one note, told which is its own', async () => {
    const plan = await planOf(jobFire('Deliver', DEV), over([
      { number: 767, body: `One.\n\n${subscribeLine(OWNER, ['deploys'])}${footer(OTHER)}` },
      { number: 799, body: `Two.${footer(OWNER)}` },
    ], 'success'));
    const own = plan.notes.filter((n) => n.session === OWNER);
    assert.equal(own.length, 1);
    assert.match(own[0]!.text, /Your change is on dev/);
    assert.match(own[0]!.text, /PR #799/);
    assert.match(own[0]!.text, /subscribe[\s\S]*PR #767/i);
    assert.match(own[0]!.text, /on PR #799\b/);
    assert.match(own[0]!.text, /The PR's own session has been told too/, 'the PR it subscribes to has an owner, told too');
    assert.deepEqual(own[0]!.subscribed, [767]);
  });

  test('a subscriber to several PRs, only some with an owner, is told whose own session heard it', async () => {
    const plan = await planOf(jobFire('Deliver', DEV), over([
      { number: 767, body: `One.\n\n${subscribeLine(REVIEWER, ['deploys'])}${footer(OWNER)}` },
      { number: 786, body: `A person wrote this.\n\n${subscribeLine(REVIEWER, ['deploys'])}` },
    ], 'success'));
    const toReviewer = plan.notes.filter((n) => n.session === REVIEWER);
    assert.equal(toReviewer.length, 1);
    assert.match(toReviewer[0]!.text, /PR #767's own session has been told too/);
    assert.doesNotMatch(toReviewer[0]!.text, /each of PRs #767\b/);
  });
});

/**
 * A PR's sessions hear of every deploy target that ships
 * its change, read from the job's marker and the `TICKET_LABEL_PATHS` each
 * workflow file declares, not from a list of workflow names. A
 * green job tells the PRs whose files the target's paths pick; a red run of
 * a target a merge starts tells them too; a red hand-dispatched release
 * tells nobody. Every success asks for sign-off, "unless you know otherwise".
 */
describe('planWorkflow — every deploy target that ships a PR\'s change', () => {
  const BASE = 'b'.repeat(40);
  const OTHER = 'e'.repeat(40);
  const SHIPS: Record<string, string> = {
    'Dispatch stack': 'Build the image, apply the stack, probe the task',
    'Android release': 'Publish to Play testing track',
    Deliver: 'prod / Publish (prod)',
  };
  const pathOf = (name: string) => WORKFLOW_PATHS[name]!;
  /**
   * Run 500 of `name`'s workflow, at SHA, with its last green run 490 at
   * BASE; run 495 is a probe-only run. PR 4400 merged at SHA, 4401 at OTHER.
   */
  const target = (name: string, conclusion: string, { files, runs, red = conclusion === 'failure' }: { files: Record<number, string[]>; runs?: Array<{ id: number; head_sha: string }>; red?: boolean }) => reader({
    run: async (id: number) => ({ ...runRow(id, conclusion, { head_sha: SHA }), path: pathOf(name), run_attempt: 1 }),
    // Each run's shipping job names the commit the run is at; a probe-only run's job carries no marker.
    runJobs: async (id: number) => [{ name: `${id === 495 ? 'Probe only: ' : ''}${SHIPS[name] ?? 'deploy'} at ${(runs ?? []).find((r) => r.id === id)?.head_sha ?? (id === 500 ? SHA : BASE)}${id === 495 ? '' : ` · ${FINAL_LABELS[name]}`}`, conclusion: id === 500 && red ? 'failure' : 'success', html_url: `https://x/${id}/job/1` }],
    workflowRuns: async () => runs ?? [runRow(500, conclusion, { head_sha: SHA }), runRow(490, 'success', { head_sha: BASE })],
    compareCommits: async (base: string, head: string) => (base === BASE && head === SHA
      ? [{ sha: OTHER, message: 'Merge pull request #804 from acme/b' }, { sha: SHA, message: 'Merge pull request #799 from acme/a' }]
      : []),
    pullsForCommit: async (sha: string) => (sha === SHA ? [pr(799)] : sha === OTHER ? [pr(804, { merge_commit_sha: OTHER })] : []),
    pullFiles: async (n: number) => (files[n] ?? []).map((filename) => ({ filename, status: 'modified' })),
  });
  /** The job fire for `name`'s shipping job in run 500. */
  const shipped = (name: string) => jobFire(name, FINAL_LABELS[name]!, { name: `${SHIPS[name]} at ${SHA} · ${FINAL_LABELS[name]}`, url: 'https://x/500/job/1' });

  test('a green Dispatch stack job tells the PR that changed the dispatcher its change is on the dispatcher, and the PR that did not nothing', async () => {
    const plan = await planOf(shipped('Dispatch stack'), target('Dispatch stack', 'success', { files: { 799: ['dispatch/turn.mjs'], 804: ['src/me.ts'] } }));
    assert.equal(plan.notes.length, 1, String(plan.reason));
    assert.deepEqual(plan.notes[0]!.prs, [799]);
    assert.match(plan.notes[0]!.text, /^Your change is on the dispatcher: Dispatch stack published it \(https:\/\/x\/500\/job\/1\), built from a1b2c3d4e5f6\./m);
    assert.doesNotMatch(plan.notes[0]!.text, /PR #804/);
    assert.match(plan.notes[0]!.text, /`dispatcher deploy`/);
    assert.equal(plan.notes[0]!.closing, true);
  });

  test('a green run that shipped nothing, as a probe-only Dispatch stack run, is no baseline: the next real job covers its merges', async () => {
    const plan = await planOf(shipped('Dispatch stack'), target('Dispatch stack', 'success', {
      files: { 799: ['dispatch/turn.mjs'] },
      runs: [runRow(500, 'success', { head_sha: SHA }), runRow(495, 'success', { head_sha: SHA }), runRow(490, 'success', { head_sha: BASE })],
    }));
    assert.equal(plan.notes.length, 1, String(plan.reason));
    assert.equal(plan.range?.baseline.id, 490);
  });

  test('a red Dispatch stack run tells the PR that changed the dispatcher, as a red dev deploy does', async () => {
    const plan = await planOf(fire('Dispatch stack', 'failure'), target('Dispatch stack', 'failure', { files: { 799: ['scripts/lib/github-app.mjs'], 804: ['scripts/operator-x.mjs'] } }));
    assert.equal(plan.notes.length, 1, String(plan.reason));
    assert.match(plan.notes[0]!.text, /^The dispatcher deploy after your pull request merged failed \(Dispatch stack\); a1b2c3d4e5f6 did not reach the dispatcher\./m);
    assert.match(plan.notes[0]!.text, /Failed jobs:/);
    assert.equal(plan.notes[0]!.closing, false);
    assert.equal(plan.triage, null);
  });

  test('a red probe-only Dispatch stack run deployed nothing, so no PR hears that its deploy failed', async () => {
    const r = target('Dispatch stack', 'failure', { files: { 799: ['dispatch/turn.mjs'] } });
    r.reader.runJobs = async () => [{ name: 'Probe only: Build the image, apply the stack, probe the task', conclusion: 'failure', html_url: 'x' }];
    // A probe-only run is a hand dispatch: a red run a merge started is news whichever job stopped it.
    r.reader.workflowRuns = async () => [runRow(500, 'failure', { head_sha: SHA, event: 'workflow_dispatch' }), runRow(498, 'success', { head_sha: 'f'.repeat(40) })];
    const plan = await planOf(fire('Dispatch stack', 'failure'), r);
    assert.deepEqual([plan.notes, plan.triage], [[], null]);
    assert.match(String(plan.reason), /deployed nothing/);
  });

  test('every green job asks for sign-off unless the session knows otherwise, and reads no workflow file but its own', async () => {
    for (const name of ['Deliver', 'Dispatch stack']) {
      const r = target(name, 'success', { files: { 799: ['dispatch/turn.mjs'] } });
      const plan = await planOf(shipped(name), r);
      assert.ok(plan.notes.length >= 1 && plan.notes.every((n) => n.closing), `${name}: the session judges whether dev and the dispatcher both have it (${plan.reason})`);
      assert.ok(plan.notes.every((n) => !/Not yet on/.test(n.text)), name);
      assert.deepEqual([...new Set(r.asked.filter((a) => a.startsWith('file')))], [`file ${pathOf(name)}`], `${name}: no other workflow is read to reckon the sign-off`);
    }
  });

  test('a green release dispatched by hand tells the PRs its paths pick', async () => {
    const plan = await planOf(shipped('Android release'), target('Android release', 'success', { files: { 799: ['clients/android/app/build.gradle.kts'], 804: ['src/me.ts'] } }));
    assert.equal(plan.notes.length, 1, String(plan.reason));
    assert.match(plan.notes[0]!.text, /Your change is on the play track: Android release published it \(https:\/\/x\/500\/job\/1\)/);
    assert.equal(plan.notes[0]!.closing, true);
  });

  test('a red release dispatched by hand tells nobody and starts nothing: whoever dispatched it is watching it', async () => {
    const plan = await planOf(fire('Android release', 'failure'), target('Android release', 'failure', { files: { 799: ['clients/android/app/build.gradle.kts'] } }));
    assert.deepEqual([plan.notes, plan.triage], [[], null]);
    assert.match(String(plan.reason), /dispatched by hand/);
  });

  test('a red Deliver run, dispatched by hand or after a merge, still plans its one triage session: its target is prod', async () => {
    for (const event of ['workflow_dispatch', 'workflow_run']) {
      const plan = await planOf(fire('Deliver', 'failure'), target('Deliver', 'failure', { files: {}, runs: [runRow(500, 'failure', { head_sha: SHA, event }), runRow(490, 'success', { head_sha: BASE, event })] }));
      assert.deepEqual(plan.notes, [], event);
      assert.match(plan.triage!.sessionName, /^Prod deploy red \w+: 2 merges$/, event);
    }
  });

  test('a workflow whose file names no shipping job tells nobody of a red run, whatever it is named', async () => {
    const r = target('Deliver', 'failure', { files: {} });
    r.reader.fileAt = async () => 'name: Deliver\non:\n  push:\nenv:\n  TICKET_LABEL_PATHS: all\njobs:\n  a:\n    name: Build\n    runs-on: ubuntu-latest\n    steps: []\n';
    const plan = await planOf(fire('Deliver', 'failure'), r);
    assert.deepEqual(plan.notes, []);
    assert.match(String(plan.reason), /declares no deploy target/);
  });

  test('a green job building its baseline\'s commit, or one its baseline covers, ships no merge: the PR at its head is not told again', async () => {
    for (const built of [SHA, 'f'.repeat(40)]) {
      const plan = await planOf(shipped('Dispatch stack'), target('Dispatch stack', 'success', {
        files: { 799: ['dispatch/turn.mjs'] },
        runs: [runRow(500, 'success', { head_sha: SHA }), runRow(490, 'success', { head_sha: built })],
      }));
      assert.deepEqual(plan.notes, []);
      assert.match(String(plan.reason), /shipped no merge since run 490/);
      assert.equal(plan.advance, null);
    }
  });
});

describe('planWorkflow — another repo\'s workflows', () => {
  /** What coverage read of a red run on trunk: `shipped` merged and picked, each its own session's. */
  const covered = (shipped: ReturnType<typeof pr>[], label: string | null) => ({
    reason: null, stale: null, workflow: 'release.yml', label, declared: label === null ? null : {}, jobs,
    from: null, at: null, baseline: { id: 498, commit: 'b', created: '', conclusion: 'success', url: 'u' },
    range: { baseline: { id: 498, commit: 'b', created: '' }, end: SHA, merges: shipped.length }, merges: [],
    shipped, picked: shipped, closes: new Map(),
    sessions: async (prs: unknown[]) => ({ sessions: new Map([['S', { session: 'S', own: prs, subscribed: [] }]]), owned: new Set(), unnamed: [] }),
  });
  const onTrunk = (name: string, path: string) => fire(name, 'failure', { path, branch: 'trunk' });

  test('a triaged target\'s session names, as where its merges were, only the tagged targets no triage holds', async () => {
    const workflows = { ci: '.github/workflows/gate.yml', triage: ['staging', 'prod'], tags: { dev: 'release/dev', staging: 'release/staging', prod: 'release/prod' } };
    const plan = await planWorkflow({ invocation: onTrunk('Release', '.github/workflows/release.yml') as never, coverage: covered([pr(799)], 'deployed: prod') as never, workflows });
    assert.match(plan.triage!.prompt, /signed off once their changes were on dev and every other target a merge deploys/);
  });

  test('a red run on trunk with no merged PR says trunk, not main', async () => {
    const workflows = { ci: '.github/workflows/gate.yml', triage: [], tags: {} };
    const ci = await planWorkflow({ invocation: onTrunk('Gate', '.github/workflows/gate.yml') as never, coverage: covered([], null) as never, workflows });
    const deploy = await planWorkflow({ invocation: onTrunk('Release', '.github/workflows/release.yml') as never, coverage: covered([], 'deployed: dev') as never, workflows });
    for (const plan of [ci, deploy]) {
      assert.match(String(plan.reason), /a commit pushed to trunk/);
      assert.doesNotMatch(String(plan.reason), /\bmain\b/);
    }
  });
});
