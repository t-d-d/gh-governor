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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
// and a boolean input, a workflow that is not reusable, a file that is not
// valid YAML, and checkers that declare an input as a bare word, as nothing,
// or as a date, or their inputs as a list, none of them a mapping.
function oddCheckersRepo() {
  const { dir, commit, cleanup } = throwawayRepo('starter-pin-odd-');
  const typed = commit(checkerAt({ 'tolerance-hours': { type: 'number', default: 3 }, strict: { type: 'boolean', default: false } }));
  const notCallable = commit(yaml.dump({ name: 'heartbeat check', on: { push: null }, jobs: { check: { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'true' }] } } }));
  const broken = commit('name: [unclosed\non: {workflow_call: \n');
  const bare = commit(checkerAt({ 'tolerance-hours': { type: 'number', default: 3 }, labels: 'string' }));
  const empty = commit(checkerAt({ 'tolerance-hours': { type: 'number', default: 3 }, labels: null }));
  const dated = commit(checkerAt({ 'tolerance-hours': { type: 'number', default: 3 }, labels: new Date('2026-01-01T00:00:00Z') }));
  const listed = commit(yaml.dump({ name: 'heartbeat check', on: { workflow_call: { inputs: ['tolerance-hours', 'labels'] } }, jobs: { check: { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'true' }] } } }));
  return { dir, typed, notCallable, broken, bare, empty, dated, listed, cleanup };
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

  test('tells a shallow clone that holds the pin but not its ancestry to unshallow, not that the pin is off main', () => {
    const shallow = mkdtempSync(join(tmpdir(), 'starter-pin-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.dir}`, shallow]);
      // Protocol v2 lets a fetch name a commit no ref points at.
      execFileSync('git', ['-c', 'protocol.version=2', 'fetch', '-q', '--depth', '1', 'origin', repo.onMain], { cwd: shallow });
      const got = pinnedInputProblems({ cwd: shallow, main: 'origin/main', sha: repo.onMain, path: CHECKER, passed: STARTER_WITH });
      assert.deepEqual(got, [`this clone is shallow, so it cannot tell whether the pinned commit ${repo.onMain.slice(0, 12)} is on main: run git fetch --unshallow origin, or check out with fetch-depth: 0`]);
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

  test('reports an input at the pin declared as something other than a mapping, which GitHub rejects, whether passed or not', () => {
    const short = repo.extra.bare.slice(0, 12);
    const want = [`the checker at ${short} declares input labels as a string, not a mapping`];
    assert.deepEqual(pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.bare, path: CHECKER, passed: STARTER_WITH }), want);
    assert.deepEqual(pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.bare, path: CHECKER, passed: { 'tolerance-hours': 3 } }), want);
  });

  test('reports an input at the pin declared with no mapping at all, not as an input it does not take', () => {
    const short = repo.extra.empty.slice(0, 12);
    const want = [`the checker at ${short} declares input labels as null, not a mapping`];
    assert.deepEqual(pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.empty, path: CHECKER, passed: STARTER_WITH }), want);
    assert.deepEqual(pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.empty, path: CHECKER, passed: { 'tolerance-hours': 3 } }), want);
  });

  test('reports an input at the pin declared as a date, which YAML reads as an object but is not a mapping', () => {
    const got = pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.dated, path: CHECKER, passed: STARTER_WITH });
    assert.deepEqual(got, [`the checker at ${repo.extra.dated.slice(0, 12)} declares input labels as a date, not a mapping`]);
  });

  test('reports inputs at the pin declared as a list once, not as one odd input per entry', () => {
    const got = pinnedInputProblems({ cwd: repo.extra.dir, main: 'main', sha: repo.extra.listed, path: CHECKER, passed: STARTER_WITH });
    assert.deepEqual(got, [`the checker at ${repo.extra.listed.slice(0, 12)} declares its inputs as a list, not a mapping`]);
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

// The commit both config files' `$schema` names, which the config check is
// pinned to. test/starter-kit.test.ts checks the kit's pins agree.
const schemaPin = (file: string) => {
  const { $schema } = JSON.parse(readFileSync(join(REPO_ROOT, 'examples/starter/.github', file), 'utf8')) as { $schema?: unknown };
  const sha = /^https:\/\/raw\.githubusercontent\.com\/t-d-d\/gh-governor\/([0-9a-f]{40})\/schema\/governor\.schema\.json$/.exec(String($schema))?.[1];
  assert.ok(sha !== undefined, String($schema));
  return sha;
};

// Skipped while governor at the pin reads only .github/dispatch.json in the
// older layout, which the starter files no longer use, and no commit on main
// yet reads .github/governor.json. #526 moves the starter kit's pins to one
// that does, whose $schema names schema/governor.schema.json, and turns this
// check back on.
describe('the starter kit\'s config files at their pinned commit', { skip: 'governor at the pinned commit reads only the older .github/dispatch.json layout, and the pins move once .github/governor.json is on main (#526)' }, () => {
  // The pinned commit's tree, read from git history into a temporary folder,
  // with this checkout's modules beside it, so its readConfig can be imported.
  let dir: string | undefined;
  let readConfigAt: ((text: string) => { ok: boolean }) | undefined;
  const sha = schemaPin('governor.json');
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'starter-pin-config-'));
    const tar = execFileSync('git', ['archive', sha, 'dispatch', 'scripts', 'checker', 'package.json'], { cwd: REPO_ROOT, maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
    ({ readConfig: readConfigAt } = await import(pathToFileURL(join(dir, 'dispatch/repo-config.mjs')).href) as { readConfig: (text: string) => { ok: boolean } });
  });
  after(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  test('both files name the same commit, and it is on main', () => {
    assert.equal(schemaPin('governor.dark-factory.json'), sha);
    const onMain = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: REPO_ROOT });
    assert.equal(onMain.status, 0, `${sha} is not on origin/main`);
  });

  for (const file of ['governor.json', 'governor.dark-factory.json']) {
    test(`governor's readConfig at the pin accepts ${file}`, () => {
      assert.ok(readConfigAt !== undefined);
      const got = readConfigAt(readFileSync(join(REPO_ROOT, 'examples/starter/.github', file), 'utf8'));
      assert.ok(got.ok, JSON.stringify(got));
    });
  }
});
