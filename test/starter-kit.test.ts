/**
 * The starter kit a new repo copies into its own `.github/` (examples/starter/):
 * a config file that names its JSON Schema, lists every feature's section, and turns on
 * pickup, the heartbeat and three periodics; a dark-factory file a repo copies
 * in its place, with every feature but hooks on and the review's merge on; the
 * workflow that calls the heartbeat checker; the workflow that calls the
 * config check on pull requests; and the CLAUDE.md that carries the session
 * rules block. Its prompts are plain text that
 * works without any skill, and each acts on the window governor writes under
 * it (dispatch/periodics.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { CONFIG_PATH, GENERIC_SWITCHES, SECTIONS, namesEnvironment, readConfig, turnsOn } from '../dispatch/repo-config.mjs';
import { readConfig as checkerReadConfig } from '../checker/heartbeat-check.mjs';
import { globMatches } from '../dispatch/checklist.mjs';

const STARTER = 'examples/starter/';
const CONFIG_FILE = `${STARTER}${CONFIG_PATH}`;
const DARK_FILE = `${STARTER}.github/governor.dark-factory.json`;
const WORKFLOW_FILE = `${STARTER}.github/workflows/heartbeat.yml`;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The feature sections a file lists, in the file's order, each on unless it sets `"enabled": false`. */
const sectionsOf = (text: string) => {
  const file = JSON.parse(text) as Record<string, unknown>;
  return Object.fromEntries(SECTIONS.filter((name) => name in file).map((name) => [name, (file[name] as { enabled?: unknown }).enabled !== false]));
};

/** The commit the starter kit's config check is pinned to. */
const checkPin = () => {
  const check = yaml.load(read(`${STARTER}.github/workflows/config-check.yml`)) as { jobs: Record<string, { uses?: string }> };
  return Object.values(check.jobs).map((j) => /^t-d-d\/gh-governor\/\.github\/workflows\/config-check\.yml@([0-9a-f]{40})$/.exec(String(j.uses))?.[1]);
};

/** The commit the starter kit's heartbeat workflow is pinned to. */
const heartbeatPin = () => {
  const beat = yaml.load(read(WORKFLOW_FILE)) as { jobs: Record<string, { uses?: string }> };
  return Object.values(beat.jobs).map((j) => /^t-d-d\/gh-governor\/\.github\/workflows\/heartbeat-check\.yml@([0-9a-f]{40})$/.exec(String(j.uses))?.[1]);
};

/** The commit a config file's `$schema` names, or null when it names no schema of this repo's. */
const schemaCommit = (text: string) => {
  const { $schema } = JSON.parse(text) as { $schema?: unknown };
  return /^https:\/\/raw\.githubusercontent\.com\/t-d-d\/gh-governor\/([0-9a-f]{40})\/schema\/governor\.schema\.json$/.exec(String($schema))?.[1] ?? null;
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
    assert.deepEqual(Object.keys((JSON.parse(text) as { heartbeat: object }).heartbeat), ['issue']);
  });

  test('lists every feature\'s section, the seven it turns on with no enabled and the rest with "enabled": false', () => {
    const sections = sectionsOf(text);
    assert.deepEqual(Object.keys(sections).sort(), [...SECTIONS].sort(), 'a new feature\'s section is added to the starter file');
    const on = ['pickup', 'summons', 'prMessages', 'subscribeMessages', 'heartbeat', 'periodics', 'signOff'];
    for (const name of SECTIONS) assert.equal(sections[name], on.includes(name), name);
    const file = JSON.parse(text) as Record<string, Record<string, unknown>>;
    for (const name of on) assert.equal('enabled' in (file[name] ?? {}), false, `${name}: a section is on by being there`);
    assert.ok(got.ok);
    for (const name of GENERIC_SWITCHES) assert.equal(turnsOn(got.config, name), on.includes(name), name);
  });

  test('names its JSON Schema at the commit the config check is pinned to', () => {
    const commit = schemaCommit(text);
    assert.ok(commit !== null, text);
    assert.deepEqual(checkPin(), [commit], 'bump $schema and the config check together');
    assert.deepEqual(heartbeatPin(), [commit], 'bump the heartbeat checker with them');
  });

  test('names its environment by a placeholder name, never an id', () => {
    assert.ok(got.ok);
    assert.equal(got.config.environment, 'my-env');
    assert.ok(namesEnvironment(got.config.environment));
  });

  test('has a code review on merges, a backlog review on issues opened, and a weekly review on its day limit alone', () => {
    assert.ok(got.ok);
    const shapes = got.config.periodics.map((p) => ({ name: p.name, counts: Object.keys(p.counts ?? {}), days: p.days }));
    assert.deepEqual(shapes, [
      { name: 'Code review', counts: ['merges'], days: 7 },
      { name: 'Backlog review', counts: ['issuesOpened'], days: 7 },
      { name: 'Weekly review', counts: [], days: 7 },
    ]);
  });

  test('its backlog review lists the stuck tickets: none reviewed, held by a review, and claimed with no open pull request', () => {
    assert.ok(got.ok);
    const backlog = got.config.periodics.find((p) => p.name === 'Backlog review');
    const prompt = String(backlog?.prompt);
    assert.match(prompt, /only where the file turns issue reviews on, open ones no issue review ran on/, 'with the reviews off, every open ticket would read as stuck');
    assert.match(prompt, /Leave out the heartbeat issue, the wait ticket/, 'no issue review reads governor\'s own records');
    assert.match(prompt, /`failure` or `neutral`/);
    assert.match(prompt, /claimed[^.]*no open pull request/);
  });

  test('keeps issue reviews off with "enabled": false, keeps no features section, and keeps its ready and exclude labels in pickup', () => {
    assert.ok(got.ok);
    assert.deepEqual((JSON.parse(text) as Record<string, unknown>).issueReviews, { enabled: false });
    assert.equal(turnsOn(got.config, 'issueReviews'), false);
    const file = JSON.parse(text) as Record<string, unknown>;
    for (const gone of ['features', 'labels', 'prompts', 'review']) assert.equal(gone in file, false, `${gone} is not in the layout`);
    assert.deepEqual(got.config.labels, { ready: ['mode: afk'], claim: 'claimed', claimRemoves: [], exclude: ['type: prd'] });
  });

  test('its prompts are plain text, call no skill, act on the window governor lists, and sign off', () => {
    const file = JSON.parse(text) as { periodics: { sessions: Record<string, { prompt: unknown }> } };
    for (const [name, { prompt }] of Object.entries(file.periodics.sessions)) {
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

  test('lists every feature\'s section, with every one but hooks on', () => {
    const sections = sectionsOf(text);
    assert.deepEqual(Object.keys(sections).sort(), [...SECTIONS].sort(), 'a new feature\'s section is added to the dark-factory file');
    for (const name of SECTIONS) assert.equal(sections[name], name !== 'hooks', name);
    assert.deepEqual((JSON.parse(text) as Record<string, unknown>).hooks, { enabled: false });
    assert.ok(got.ok);
    for (const name of GENERIC_SWITCHES) assert.equal(turnsOn(got.config, name), name !== 'hooks', name);
  });

  test('names its JSON Schema at the commit the config check is pinned to', () => {
    const commit = schemaCommit(text);
    assert.ok(commit !== null, text);
    assert.deepEqual(checkPin(), [commit], 'bump $schema in both files and the config check together');
  });

  test('names the same commit as the heartbeat checker\'s pin', () => {
    const workflow = yaml.load(read(WORKFLOW_FILE)) as { jobs: Record<string, { uses?: string }> };
    const pins = Object.values(workflow.jobs).map((j) => /@([0-9a-f]{40})$/.exec(String(j.uses))?.[1]);
    assert.deepEqual(pins, [schemaCommit(text)], 'move every pin in the kit together');
  });

  test('keeps the starter file\'s placeholders and periodics', () => {
    assert.ok(got.ok);
    const starter = readConfig(read(CONFIG_FILE));
    assert.ok(starter.ok);
    assert.equal(got.config.environment, 'my-env');
    const { ready, exclude, ...rest } = got.config.labels;
    const { ready: starterReady, exclude: starterExclude, ...starterRest } = starter.config.labels;
    assert.deepEqual(rest, starterRest);
    assert.deepEqual(starterReady, ['mode: afk']);
    assert.deepEqual(ready, ['triage: build'], 'readiness is the review\'s label, and a ticket is ready once the triage review or a person adds it');
    assert.deepEqual(exclude, [...starterExclude, 'mode: human', 'triage: needs a person'], 'a person\'s hold and a ticket the review doubts both wait for a person');
    assert.deepEqual(got.config.pickup, starter.config.pickup);
    assert.deepEqual(got.config.heartbeat, starter.config.heartbeat);
    assert.deepEqual(got.config.periodics, starter.config.periodics);
  });

  test('reviews every ticket before pickup builds it, with checks per type and a label per conclusion', () => {
    assert.ok(got.ok);
    assert.equal(turnsOn(got.config, 'issueReviews'), true);
    assert.equal(got.config.issueReviews?.enabled, undefined, 'the section turns the reviews on');
    const reviews = got.config.issueReviews?.reviews ?? [];
    assert.equal(reviews.length, 1);
    const triage = reviews[0];
    assert.ok(triage !== undefined);
    assert.equal(triage.name, 'triage');
    assert.deepEqual(triage.when, { exclude: ['claimed'] });
    assert.equal(triage.prompt, undefined, 'governor\'s default checklist is the review\'s prompt: the starter kit ships no skills');
    assert.deepEqual(triage.conclusions, { success: ['triage: passed'], failure: ['triage: needs edit'], neutral: ['triage: needs a person'] });
    const types = triage.byLabel ?? [];
    assert.deepEqual(types.map((t) => t.labels), [['type: prd'], ['type: bug', 'bug'], ['type: enhancement']]);
    for (const t of types) {
      assert.equal(typeof t.prompt, 'string', `${t.labels[0]}: a prompt file is the repo's own`);
      assert.doesNotMatch(String(t.prompt), /skill/i, `${t.labels[0]}: the starter kit ships no skills`);
    }
    const [prd, bug, enhancement] = types;
    assert.match(String(prd?.prompt), /many pull requests/);
    assert.match(String(bug?.prompt), /reproduce[\s\S]*one pull request's work/);
    assert.match(String(enhancement?.prompt), /one pull request's work[\s\S]*reviewer checks it is done/);
    assert.equal(prd?.conclusions, undefined);
    assert.deepEqual(bug?.conclusions, { success: ['triage: build'] }, 'a bug that passes is built with no person');
    assert.equal(enhancement?.conclusions, undefined);
    const conclusionLabels = [triage.conclusions, ...types.map((t) => t.conclusions ?? {})].flatMap((c) => Object.values(c).flat());
    assert.ok(got.config.labels.ready.every((l) => conclusionLabels.includes(l)), 'each ready label is one the review adds');
    assert.ok(conclusionLabels.every((l) => l.startsWith('triage: ')), 'the review adds and removes only labels of its own');
    assert.ok(conclusionLabels.every((l) => !['mode: afk', 'mode: human'].includes(l)), 'no review changes a person\'s mode label');
    assert.ok(triage.conclusions.neutral.every((l) => got.config.labels.exclude.includes(l)), 'pickup never takes a ticket the review doubts');
  });

  test('names the CI workflow ciMessages needs', () => {
    assert.ok(got.ok);
    assert.match(String(got.config.workflows.ci), /^\.github\/workflows\/[^/]+\.ya?ml$/);
  });

  test('reviews with a plain-text checklist that checks every test, and merges a pass', () => {
    assert.ok(got.ok);
    const review = got.config.review;
    assert.ok(review !== undefined);
    assert.equal(review.merge, true);
    assert.equal(typeof review.checklist, 'string', 'a checklist file is the repo\'s own');
    assert.doesNotMatch(String(review.checklist), /skill/i, 'the starter kit ships no skills');
    assert.doesNotMatch(String(review.checklist), /stop at the first/i, 'the review prompt asks the model to check every later test too');
  });

  test('leaves CLAUDE.md, the skills, the workflows, this file and the infrastructure to a person, each with its reason', () => {
    assert.ok(got.ok);
    const humanOnly = got.config.review?.humanOnly ?? [];
    for (const path of ['CLAUDE.md', 'src/CLAUDE.md', '.claude/settings.json', '.github/workflows/ci.yml', '.github/actions/test/action.yml', '.github/governor.json', 'infra/main.tf']) {
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

  test('runs on pull requests that change the config file or an issue template, and tells a repo with prompt files to add their paths', () => {
    assert.deepEqual(Object.keys(workflow.on), ['pull_request']);
    assert.ok(workflow.on.pull_request?.paths?.includes(CONFIG_PATH));
    assert.ok(workflow.on.pull_request?.paths?.includes('.github/ISSUE_TEMPLATE/**'), JSON.stringify(workflow.on.pull_request?.paths));
    for (const single of ['ISSUE_TEMPLATE.md', '.github/ISSUE_TEMPLATE.md', 'docs/ISSUE_TEMPLATE.md']) {
      assert.ok(workflow.on.pull_request?.paths?.includes(single), single);
    }
    assert.match(text, /# .*prompts? (live )?in files[\s\S]*paths/i);
  });

  test('runs on pull requests that change CLAUDE.md, and tells a repo that sets sessionRules.file to add its path', () => {
    assert.ok(workflow.on.pull_request?.paths?.includes('CLAUDE.md'), JSON.stringify(workflow.on.pull_request?.paths));
    const end = text.indexOf('\nname:');
    assert.ok(end > 0, 'the workflow opens with a comment header before name:');
    assert.match(text.slice(0, end), /# .*sessionRules\.file[\s\S]*paths/, text.slice(0, end));
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

test('docs/serving-a-repo.md\'s starter kit section says the file names its schema and lists every feature\'s section', () => {
  const readme = read('docs/serving-a-repo.md');
  const at = readme.indexOf('### The starter kit');
  const section = readme.slice(at, readme.indexOf('\n### ', at + 1));
  assert.match(section, /`\$schema`/);
  assert.match(section, /every feature's section/);
  assert.match(section, /`\{ "enabled": false \}`/);
});

test('docs/serving-a-repo.md\'s starter kit section says the kit has two policies and when to pick each', () => {
  const doc = read('docs/serving-a-repo.md');
  const at = doc.indexOf('### The starter kit');
  const section = doc.slice(at, doc.indexOf('\n### ', at + 1));
  assert.match(section, /two policies/);
  assert.match(section, /`\.github\/governor\.dark-factory\.json`/);
  assert.match(section, /`merge`/);
  assert.match(section, /hook/i, 'says how to add a hook');
});

test('the README\'s "Run your own" step points at the dark-factory file, not the test fixture', () => {
  const readme = read('README.md');
  const at = readme.indexOf('## Run your own');
  const section = readme.slice(at, readme.indexOf('\n## ', at + 1));
  assert.match(section, /\(examples\/starter\/\.github\/governor\.dark-factory\.json\)/);
  assert.doesNotMatch(section, /test\/fixtures/);
});

test('docs/serving-a-repo.md\'s starter kit section describes the triage review and the backlog review', () => {
  const doc = read('docs/serving-a-repo.md');
  const at = doc.indexOf('### The starter kit');
  const section = doc.slice(at, doc.indexOf('\n### ', at + 1));
  assert.match(section, /`triage` issue review/);
  for (const label of ['triage: build', 'triage: passed', 'triage: needs edit', 'triage: needs a person', 'mode: human']) assert.ok(section.includes(`\`${label}\``), label);
  assert.match(section, /a backlog review every 5 issues opened/);
  assert.match(section, /where issue reviews are on, open ones no issue review ran on/);
  assert.match(section, /issue reviews are off[^.]*`issueReviews` section sets `"enabled": false`/);
  assert.match(section, /adding `mode: human`, and no review run takes it off/);
  assert.match(section, /claimed ones with no open pull request/);
  assert.doesNotMatch(section, /issue review every/);
});

test('the README names the backlog review, not a periodic ticket review', () => {
  assert.match(read('README.md'), /weekly backlog review/);
  assert.doesNotMatch(read('README.md'), /weekly ticket review/);
});
