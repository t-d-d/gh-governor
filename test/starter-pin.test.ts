/**
 * The starter kit's workflow calls the heartbeat checker pinned to a commit
 * of this repo. The inputs it passes have to match the checker as it is at
 * that commit, not as it is on the current tree: a change could rename an
 * input, update the starter's `with:` to match and leave the pin behind, and
 * a repo copying the starter would then call a checker that rejects it.
 *
 * The check reads the pinned commit from git history, so the gate's
 * checkout fetches the whole history (.github/workflows/gate.yml).
 *
 * test/starter-kit.test.ts still checks the same inputs against the checker
 * on the current tree, so the starter works once its pin moves. Between the
 * two, one pull request cannot rename an input. Add the new input beside the
 * old one, then move the pin and the starter's `with:` to it, then drop the
 * old one. Every repo already pinned keeps working at each step.
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

// A throwaway repo: main holds the checker with today's inputs, then one that
// adds a required input; a side branch holds one that renamed an input. A test
// can pin any of the three commits.
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'starter-pin-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (inputs: Record<string, unknown>) => {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, CHECKER), checkerAt(inputs));
    git('add', '.');
    git('commit', '-qm', 'checker');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const onMain = commit(TODAY);
  const renamed = commit({ 'tolerance-hours': TODAY['tolerance-hours'], 'issue-labels': { type: 'string', default: '' } });
  git('branch', '-q', 'side');
  git('reset', '-q', '--hard', onMain);
  const required = commit({ ...TODAY, repo: { type: 'string', required: true } });
  return { dir, onMain, renamed, required, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const STARTER_WITH = { 'tolerance-hours': 3, labels: 'heartbeat' };

describe('pinnedInputProblems', () => {
  // Every test only reads the repo, so one serves them all.
  let repo: ReturnType<typeof fixtureRepo>;
  before(() => { repo = fixtureRepo(); });
  after(() => repo.cleanup());

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

  test('reports a main ref the clone does not hold', () => {
    const got = pinnedInputProblems({ cwd: repo.dir, main: 'origin/main', sha: repo.onMain, path: CHECKER, passed: STARTER_WITH });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.match(got[0] ?? '', /no origin\/main in this clone/);
  });
});

describe('the starter kit\'s heartbeat workflow at its pinned commit', () => {
  test('passes only inputs the checker at the pin takes, and the pin is on main', () => {
    const workflow = yaml.load(readFileSync(join(REPO_ROOT, 'examples/starter/.github/workflows/heartbeat.yml'), 'utf8')) as {
      jobs: Record<string, { uses?: string, with?: Record<string, unknown> }>,
    };
    const jobs = Object.values(workflow.jobs);
    assert.equal(jobs.length, 1);
    const m = /^t-d-d\/gh-governor\/(\.github\/workflows\/heartbeat-check\.yml)@([0-9a-f]{40})$/.exec(String(jobs[0]?.uses));
    assert.ok(m !== null, String(jobs[0]?.uses));
    const [, path, sha] = m;
    assert.deepEqual(pinnedInputProblems({ cwd: REPO_ROOT, main: 'origin/main', sha: String(sha), path: String(path), passed: jobs[0]?.with ?? {} }), []);
  });

  test('the gate checks out the whole history, so the pinned commit is there to read', () => {
    const gate = yaml.load(readFileSync(join(REPO_ROOT, '.github/workflows/gate.yml'), 'utf8')) as {
      jobs: { gate: { steps: Array<{ uses?: string, with?: Record<string, unknown> }> } },
    };
    const checkout = gate.jobs.gate.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['fetch-depth'], 0);
  });
});
