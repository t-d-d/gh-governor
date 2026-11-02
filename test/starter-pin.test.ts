/**
 * The starter kit's two workflows each call a workflow of this repo pinned
 * to a commit: the heartbeat checker and the config check. The inputs each
 * passes have to match the called workflow as it is at that commit, not as
 * it is on the current tree: a change could rename an input, update the
 * starter's `with:` to match and leave the pin behind, and a repo copying the
 * starter would then call a workflow that rejects it.
 *
 * The check reads the pinned commit from git history, so the gate's
 * checkout fetches the whole history (.github/workflows/gate.yml).
 *
 * test/starter-kit.test.ts still checks the same inputs against each called
 * workflow on the current tree, so the starter works once its pin moves.
 * Between the two, one pull request cannot rename an input. Add the new input
 * beside the old one, then move the pin and the starter's `with:` to it, then
 * drop the old one. Every repo already pinned keeps working at each step.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { pinnedInputProblems } from './helpers/pinned-workflow.ts';
import { REPO_ROOT } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';

const CHECKER = '.github/workflows/heartbeat-check.yml';

const checkerAt = (inputs: Record<string, unknown>) => yaml.dump({
  name: 'heartbeat check',
  on: { workflow_call: { inputs } },
  jobs: { check: { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'true' }] } },
});

const TODAY = {
  'tolerance-hours': { type: 'number', default: 3 },
  labels: { type: 'string', default: '' },
};

// An empty git repo on main in a temporary folder, and a way to commit a new
// text for the checker and get the commit back.
function throwawayRepo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (text: string) => {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, CHECKER), text);
    git('add', '.');
    git('commit', '-qm', 'checker');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  return { dir, git, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A throwaway repo: main holds the checker with today's inputs, then one that
// adds a required input; a side branch holds one that renamed an input. A test
// can pin any of the three commits.
function fixtureRepo() {
  const { dir, git, commit, cleanup } = throwawayRepo('starter-pin-');
  const onMain = commit(checkerAt(TODAY));
  const renamed = commit(checkerAt({ 'tolerance-hours': TODAY['tolerance-hours'], 'issue-labels': { type: 'string', default: '' } }));
  git('branch', '-q', 'side');
  git('reset', '-q', '--hard', onMain);
  const required = commit(checkerAt({ ...TODAY, repo: { type: 'string', required: true } }));
  return { dir, onMain, renamed, required, cleanup };
}

// A second throwaway repo whose main holds, in turn: a checker with a number
// and a boolean input, a workflow that is not reusable, and a file that is
// not valid YAML.
function oddCheckersRepo() {
  const { dir, commit, cleanup } = throwawayRepo('starter-pin-odd-');
  const typed = commit(checkerAt({ 'tolerance-hours': { type: 'number', default: 3 }, strict: { type: 'boolean', default: false } }));
  const notCallable = commit(yaml.dump({ name: 'heartbeat check', on: { push: null }, jobs: { check: { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'true' }] } } }));
  const broken = commit('name: [unclosed\non: {workflow_call: \n');
  return { dir, typed, notCallable, broken, cleanup };
}

const STARTER_WITH = { 'tolerance-hours': 3, labels: 'heartbeat' };

describe('pinnedInputProblems', () => {
  // Every test only reads the repo, so one serves them all.
  let repo: ReturnType<typeof fixtureRepo> & { extra: ReturnType<typeof oddCheckersRepo> };
  let main: ReturnType<typeof fixtureRepo> | undefined;
  let extra: ReturnType<typeof oddCheckersRepo> | undefined;
  before(() => {
    main = fixtureRepo();
    extra = oddCheckersRepo();
    repo = { ...main, extra };
  });
  // Either repo may be missing if building the other threw.
  after(() => { main?.cleanup(); extra?.cleanup(); });

  test('finds nothing when the pin is on main and takes every input passed', () => {
    assert.deepEqual(pinnedInputProblems({ cwd: repo.dir, main: 'main', sha: repo.onMain, path: CHECKER, passed: STARTER_WITH }), []);
  });

  test('reports a pinned commit that is not on main', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'main', sha: repo.renamed, path: CHECKER, passed: { 'tolerance-hours': 3, 'issue-labels': 'x' } });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.match(got[0] ?? '', /not on main/);
  });

  test('reports an input passed that the checker at the pin does not take, though the current tree does', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'side', sha: repo.renamed, path: CHECKER, passed: STARTER_WITH });
    assert.deepEqual(got, [`the checker at ${repo.renamed.slice(0, 12)} takes no input labels`]);
  });

  test('reports a required input at the pin that is not passed', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'main', sha: repo.required, path: CHECKER, passed: STARTER_WITH });
    assert.deepEqual(got, [`the checker at ${repo.required.slice(0, 12)} requires input repo`]);
  });

  test('reports a value whose type the input at the pin does not declare', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'main', sha: repo.onMain, path: CHECKER, passed: { 'tolerance-hours': 'three' } });
    assert.deepEqual(got, [`the checker at ${repo.onMain.slice(0, 12)} takes tolerance-hours as a number, not a string`]);
  });

  test('reports a pinned commit the clone does not hold, and says how to fetch it', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'main', sha: 'f'.repeat(40), path: CHECKER, passed: STARTER_WITH });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.match(got[0] ?? '', /not in this clone.*git fetch/);
  });

  test('tells a full clone missing the pin to run git fetch origin, which git accepts there, not --unshallow', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'main', sha: 'f'.repeat(40), path: CHECKER, passed: STARTER_WITH });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.match(got[0] ?? '', /run git fetch origin\b/);
    assert.doesNotMatch(got[0] ?? '', /--unshallow/);
  });

  test('tells a shallow clone missing the pin to run git fetch --unshallow origin', () => {
    const shallow = mkdtempSync(join(tmpdir(), 'starter-pin-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.dir}`, shallow]);
      const got = pinnedInputProblems({ cwd: shallow, main: 'origin/main', sha: repo.onMain, path: CHECKER, passed: STARTER_WITH });
      assert.equal(got.length, 1, JSON.stringify(got));
      assert.match(got[0] ?? '', /git fetch --unshallow origin/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  test('accepts an expression passed to a number or boolean input, as GitHub does', () => {
    const got = pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.typed, path: CHECKER, passed: { 'tolerance-hours': '${{ vars.HOURS }}', strict: '${{ inputs.strict }}' } });
    assert.deepEqual(got, []);
  });

  test('reports two expressions joined by text, which GitHub reads as a string, passed to a number input', () => {
    const got = pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.typed, path: CHECKER, passed: { 'tolerance-hours': '${{ vars.A }}-${{ vars.B }}' } });
    assert.deepEqual(got, [`the checker at ${repo.extra.typed.slice(0, 12)} takes tolerance-hours as a number, not a string`]);
  });

  test('reports a null value as null, not as an object', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'main', sha: repo.onMain, path: CHECKER, passed: { labels: null } });
    assert.deepEqual(got, [`the checker at ${repo.onMain.slice(0, 12)} takes labels as a string, not null`]);
  });

  test('reports a file at the pin that is not a reusable workflow, even when no inputs are passed', () => {
    const got = pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.notCallable, path: CHECKER, passed: {} });
    assert.deepEqual(got, [`${CHECKER} at ${repo.extra.notCallable.slice(0, 12)} is not a reusable workflow: it has no on: workflow_call`]);
  });

  test('reports a file at the pin that is not valid YAML as a sentence, without throwing', () => {
    const got = pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.broken, path: CHECKER, passed: STARTER_WITH });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.match(got[0] ?? '', new RegExp(`^${CHECKER} at ${repo.extra.broken.slice(0, 12)} is not valid YAML`));
  });

  test('reports a main ref the clone does not hold', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'origin/main', sha: repo.onMain, path: CHECKER, passed: STARTER_WITH });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.match(got[0] ?? '', /no origin\/main in this clone/);
  });
});

// The one job in a starter workflow that calls `workflow` pinned to a commit of
// this repo, and the problems pinnedInputProblems finds with it.
function starterPinProblems(starter: string, workflow: string) {
  const { workflow: doc } = loadWorkflow(join(REPO_ROOT, 'examples/starter/.github/workflows', starter));
  const jobs = Object.values(doc.jobs as Record<string, { uses?: string, with?: Record<string, unknown> }>);
  assert.equal(jobs.length, 1);
  const path = `.github/workflows/${workflow}`;
  const uses = String(jobs[0]?.uses);
  const prefix = `t-d-d/gh-governor/${path}@`;
  assert.ok(uses.startsWith(prefix), uses);
  const sha = uses.slice(prefix.length);
  assert.match(sha, /^[0-9a-f]{40}$/);
  return pinnedInputProblems({ cwd: REPO_ROOT, main: 'origin/main', sha, path, passed: jobs[0]?.with ?? {} });
}

describe('the starter kit\'s heartbeat workflow at its pinned commit', () => {
  test('passes only inputs the checker at the pin takes, and the pin is on main', () => {
    assert.deepEqual(starterPinProblems('heartbeat.yml', 'heartbeat-check.yml'), []);
  });
});

describe('the starter kit\'s config check at its pinned commit', () => {
  test('passes only inputs the check at the pin takes, and the pin is on main', () => {
    assert.deepEqual(starterPinProblems('config-check.yml', 'config-check.yml'), []);
  });
});

describe('the gate\'s checkout', () => {
  test('the gate checks out the whole history, so the pinned commit is there to read', () => {
    const gate = yaml.load(readFileSync(join(REPO_ROOT, '.github/workflows/gate.yml'), 'utf8')) as {
      jobs: { gate: { steps: Array<{ uses?: string, with?: Record<string, unknown> }> } },
    };
    const checkout = gate.jobs.gate.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['fetch-depth'], 0);
  });
});
