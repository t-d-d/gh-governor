/**
 * The starter kit a new repo copies into its own `.github/` (examples/starter/):
 * a config file that names its JSON Schema, lists every switch, and turns on
 * pickup, the heartbeat and three periodics; a dark-factory file a repo copies
 * in its place, with every switch but hooks on and the review's merge on; the
 * workflow that calls the
 * heartbeat checker, and the workflow that calls the config check on pull
 * requests. Its prompts are plain text that
 * works without any skill, and each acts on the window governor writes under
 * it (dispatch/periodics.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { CONFIG_PATH, GENERIC_SWITCHES, namesEnvironment, readConfig } from '../dispatch/repo-config.mjs';
import { readConfig as checkerReadConfig } from '../checker/heartbeat-check.mjs';
import { globMatches } from '../dispatch/checklist.mjs';

const STARTER = 'examples/starter/';
const CONFIG_FILE = `${STARTER}${CONFIG_PATH}`;
const DARK_FILE = `${STARTER}.github/dispatch.dark-factory.json`;
const WORKFLOW_FILE = `${STARTER}.github/workflows/heartbeat.yml`;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The commit the starter kit's config check is pinned to. */
const checkPin = () => {
  const check = yaml.load(read(`${STARTER}.github/workflows/config-check.yml`)) as { jobs: Record<string, { uses?: string }> };
  return Object.values(check.jobs).map((j) => /^t-d-d\/gh-governor\/\.github\/workflows\/config-check\.yml@([0-9a-f]{40})$/.exec(String(j.uses))?.[1]);
};

/** The commit a config file's `$schema` names, or null when it names no schema of this repo's. */
const schemaCommit = (text: string) => {
  const { $schema } = JSON.parse(text) as { $schema?: unknown };
  return /^https:\/\/raw\.githubusercontent\.com\/t-d-d\/gh-governor\/([0-9a-f]{40})\/schema\/dispatch\.schema\.json$/.exec(String($schema))?.[1] ?? null;
};

describe('the starter kit\'s config file', () => {
  const text = read(CONFIG_FILE);
  const got = readConfig(text);

  test('is valid against configSchema', () => {
    assert.ok(got.ok, JSON.stringify(got));
  });

  test('turns on pickup, the heartbeat in governor\'s own shape, and periodics', () => {
    assert.ok(got.ok);
    const { features, heartbeat } = got.config;
    assert.equal(features.pickup, true);
    assert.equal(features.heartbeat, true);
    assert.equal(features.periodics, true);
    assert.ok(heartbeat !== undefined && Number.isInteger(heartbeat.issue));
    assert.equal(heartbeat.marker, undefined, 'the older shape keeps only a last-run line, not a line per fire');
  });

  test('lists every switch, the six it turns on true and the rest false', () => {
    const { features } = JSON.parse(text) as { features: Record<string, unknown> };
    assert.deepEqual(Object.keys(features).sort(), [...GENERIC_SWITCHES].sort(), 'a new switch is added to the starter file');
    const on = ['pickup', 'summons', 'prMessages', 'subscribeMessages', 'heartbeat', 'periodics'];
    for (const name of GENERIC_SWITCHES) assert.equal(features[name], on.includes(name), name);
  });

  test('names its JSON Schema at the commit the config check is pinned to', () => {
    const commit = schemaCommit(text);
    assert.ok(commit !== null, text);
    assert.deepEqual(checkPin(), [commit], 'bump $schema and the config check together');
  });

  test('names its environment by a placeholder name, never an id', () => {
    assert.ok(got.ok);
    assert.equal(got.config.environment, 'my-env');
    assert.ok(namesEnvironment(got.config.environment));
  });

  test('has a code review on merges, a ticket review on issues opened, and a weekly review on its day limit alone', () => {
    assert.ok(got.ok);
    const shapes = got.config.periodics.map((p) => ({ counts: Object.keys(p.counts ?? {}), days: p.days }));
    assert.deepEqual(shapes, [
      { counts: ['merges'], days: 7 },
      { counts: ['issuesOpened'], days: 7 },
      { counts: [], days: 7 },
    ]);
  });

  test('its prompts are plain text, call no skill, act on the window governor lists, and sign off', () => {
    const file = JSON.parse(text) as { periodics: Array<{ name: string, prompt: unknown }> };
    for (const { name, prompt } of file.periodics) {
      assert.equal(typeof prompt, 'string', `${name}: a prompt file is the repo's own`);
      const p = String(prompt);
      assert.doesNotMatch(p, /skill|CLAUDE\.md/i, `${name}: the starter kit ships no skills`);
      assert.match(p, /governor lists below|governor gives below/, `${name}: acts on the window governor writes under it`);
      assert.match(p, /`Signing off\.`/, `${name}: a run that never signs off holds the next fire`);
    }
  });

  test('reads in the heartbeat checker, which watches pickup and every periodic', () => {
    const checked = checkerReadConfig(text);
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.notEqual(checked.config.pickupHours, null);
    assert.equal(checked.config.periodics.length, 3);
  });
});

describe('the starter kit\'s dark-factory config file', () => {
  const text = read(DARK_FILE);
  const got = readConfig(text);

  test('is valid against configSchema', () => {
    assert.ok(got.ok, JSON.stringify(got));
  });

  test('lists every switch, with every one but hooks on', () => {
    const { features } = JSON.parse(text) as { features: Record<string, unknown> };
    assert.deepEqual(Object.keys(features).sort(), [...GENERIC_SWITCHES].sort(), 'a new switch is added to the dark-factory file');
    for (const name of GENERIC_SWITCHES) assert.equal(features[name], name !== 'hooks', name);
  });

  test('names its JSON Schema at the commit the config check is pinned to', () => {
    const commit = schemaCommit(text);
    assert.ok(commit !== null, text);
    assert.deepEqual(checkPin(), [commit], 'bump $schema in both files and the config check together');
  });

  test('keeps the starter file\'s placeholders and periodics', () => {
    assert.ok(got.ok);
    const starter = readConfig(read(CONFIG_FILE));
    assert.ok(starter.ok);
    assert.equal(got.config.environment, 'my-env');
    assert.deepEqual(got.config.heartbeat, starter.config.heartbeat);
    assert.deepEqual(got.config.periodics, starter.config.periodics);
  });

  test('names the CI workflow ciMessages needs', () => {
    assert.ok(got.ok);
    assert.match(String(got.config.workflows.ci), /^\.github\/workflows\/[^/]+\.ya?ml$/);
  });

  test('reviews with a plain-text checklist and merges a pass', () => {
    assert.ok(got.ok);
    const review = got.config.review;
    assert.ok(review !== undefined);
    assert.equal(review.merge, true);
    assert.equal(typeof review.checklist, 'string', 'a checklist file is the repo\'s own');
    assert.doesNotMatch(String(review.checklist), /skill/i, 'the starter kit ships no skills');
  });

  test('leaves CLAUDE.md, the skills, the workflows, this file and the infrastructure to a person, each with its reason', () => {
    assert.ok(got.ok);
    const humanOnly = got.config.review?.humanOnly ?? [];
    for (const path of ['CLAUDE.md', '.claude/settings.json', '.github/workflows/ci.yml', '.github/dispatch.json', 'infra/main.tf']) {
      assert.ok(humanOnly.some((e) => globMatches(e.glob, path)), `${path} waits for a person`);
    }
    for (const entry of humanOnly) assert.ok(entry.reason.length > 0, entry.glob);
  });

  test('keeps hooks off and lists none', () => {
    assert.ok(got.ok);
    assert.deepEqual(got.config.hooks, []);
  });

  test('reads in the heartbeat checker, which watches pickup and every periodic', () => {
    const checked = checkerReadConfig(text);
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.notEqual(checked.config.pickupHours, null);
    assert.equal(checked.config.periodics.length, 3);
  });
});

describe('the starter kit\'s workflow', () => {
  const workflow = yaml.load(read(WORKFLOW_FILE)) as {
    on: Record<string, unknown>,
    permissions: Record<string, string>,
    jobs: Record<string, { uses?: string, with?: Record<string, unknown> }>,
  };
  const checker = yaml.load(read('.github/workflows/heartbeat-check.yml')) as {
    on: { workflow_call: { inputs: Record<string, unknown> } },
  };

  test('calls the checker pinned to a commit of gh-governor', () => {
    const uses = Object.values(workflow.jobs).map((j) => j.uses);
    assert.equal(uses.length, 1);
    assert.match(String(uses[0]), /^t-d-d\/gh-governor\/\.github\/workflows\/heartbeat-check\.yml@[0-9a-f]{40}$/);
  });

  test('passes only inputs the checker takes, on a schedule, with the permissions it needs', () => {
    const inputs = Object.keys(checker.on.workflow_call.inputs);
    for (const job of Object.values(workflow.jobs)) {
      for (const key of Object.keys(job.with ?? {})) assert.ok(inputs.includes(key), `the checker takes no input ${key}`);
    }
    assert.ok('schedule' in workflow.on);
    assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'write' });
  });
});

describe('the starter kit\'s config check', () => {
  const text = read(`${STARTER}.github/workflows/config-check.yml`);
  const workflow = yaml.load(text) as {
    on: { pull_request?: { paths?: string[] } },
    permissions: Record<string, string>,
    jobs: Record<string, { uses?: string, with?: Record<string, unknown> }>,
  };
  const check = yaml.load(read('.github/workflows/config-check.yml')) as {
    on: { workflow_call: { inputs: Record<string, unknown> } },
  };

  test('calls the check pinned to a commit of gh-governor, and passes that same commit', () => {
    const jobs = Object.values(workflow.jobs);
    assert.equal(jobs.length, 1);
    const m = /^t-d-d\/gh-governor\/\.github\/workflows\/config-check\.yml@([0-9a-f]{40})$/.exec(String(jobs[0]?.uses));
    assert.ok(m !== null, String(jobs[0]?.uses));
    assert.equal(jobs[0]?.with?.commit, m[1], 'the commit input is the commit after @');
  });

  test('passes only inputs the check takes, with contents: read alone', () => {
    const inputs = Object.keys(check.on.workflow_call.inputs);
    for (const job of Object.values(workflow.jobs)) {
      for (const key of Object.keys(job.with ?? {})) assert.ok(inputs.includes(key), `the check takes no input ${key}`);
    }
    assert.deepEqual(workflow.permissions, { contents: 'read' });
  });

  test('runs on pull requests that change the config file, and tells a repo with prompt files to add their paths', () => {
    assert.deepEqual(Object.keys(workflow.on), ['pull_request']);
    assert.ok(workflow.on.pull_request?.paths?.includes(CONFIG_PATH));
    assert.match(text, /# .*prompts? (live )?in files[\s\S]*paths/i);
  });
});

test('docs/serving-a-repo.md describes the config check beside the heartbeat checker', () => {
  const readme = read('docs/serving-a-repo.md');
  const at = readme.indexOf('### The config check');
  assert.ok(at > readme.indexOf('### The heartbeat checker'), 'a section of its own after the heartbeat checker\'s');
  const section = readme.slice(at, readme.indexOf('\n## ', at));
  assert.match(section, /\.github\/workflows\/config-check\.yml/);
  assert.match(section, /commit: <commit>/);
  const optIn = readme.slice(readme.indexOf('## How a repo opts in'), readme.indexOf('### The schema'));
  assert.match(optIn, /config-check\.yml/);
});

test('docs/serving-a-repo.md\'s "How a repo opts in" points at the starter kit and the heartbeat issue\'s marker', () => {
  const readme = read('docs/serving-a-repo.md');
  const section = readme.slice(readme.indexOf('## How a repo opts in'), readme.indexOf('### The schema'));
  assert.match(section, /\(\.\.\/examples\/starter\/?\)/);
  assert.match(section, /<!-- governor:heartbeat -->/);
});

test('docs/serving-a-repo.md\'s starter kit section says the file names its schema and lists every switch', () => {
  const readme = read('docs/serving-a-repo.md');
  const at = readme.indexOf('### The starter kit');
  const section = readme.slice(at, readme.indexOf('\n### ', at + 1));
  assert.match(section, /`\$schema`/);
  assert.match(section, /every switch/);
});

test('docs/serving-a-repo.md\'s starter kit section says the kit has two policies and when to pick each', () => {
  const doc = read('docs/serving-a-repo.md');
  const at = doc.indexOf('### The starter kit');
  const section = doc.slice(at, doc.indexOf('\n### ', at + 1));
  assert.match(section, /two policies/);
  assert.match(section, /`\.github\/dispatch\.dark-factory\.json`/);
  assert.match(section, /`merge`/);
  assert.match(section, /hook/i, 'says how to add a hook');
});

test('the README\'s "Run your own" step points at the dark-factory file, not the test fixture', () => {
  const readme = read('README.md');
  const at = readme.indexOf('## Run your own');
  const section = readme.slice(at, readme.indexOf('\n## ', at + 1));
  assert.match(section, /\(examples\/starter\/\.github\/dispatch\.dark-factory\.json\)/);
  assert.doesNotMatch(section, /test\/fixtures/);
});
