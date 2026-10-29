/**
 * The starter a new repo copies into its own `.github/` (examples/starter/):
 * a config file with pickup, the heartbeat and three periodics, and the
 * workflow that calls the heartbeat checker. Its prompts are plain text that
 * works without any skill, and each acts on the window governor writes under
 * it (dispatch/periodics.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { CONFIG_PATH, configSchema, namesEnvironment, readConfig } from '../dispatch/repo-config.mjs';
import { readConfig as checkerReadConfig } from '../checker/heartbeat-check.mjs';
import { scanText } from '../scripts/public-repo-scan.mjs';

const STARTER = 'examples/starter/';
const CONFIG_FILE = `${STARTER}${CONFIG_PATH}`;
const WORKFLOW_FILE = `${STARTER}.github/workflows/heartbeat.yml`;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the starter config file', () => {
  const text = read(CONFIG_FILE);

  test('is valid against configSchema', () => {
    const parsed = configSchema.safeParse(JSON.parse(text));
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    const got = readConfig(text);
    assert.ok(got.ok, JSON.stringify(got));
  });

  test('turns on pickup, the heartbeat in governor\'s own shape, and periodics', () => {
    const got = readConfig(text);
    assert.ok(got.ok);
    const { features, heartbeat } = got.config;
    assert.equal(features.pickup, true);
    assert.equal(features.heartbeat, true);
    assert.equal(features.periodics, true);
    assert.ok(heartbeat !== undefined && Number.isInteger(heartbeat.issue));
    assert.equal(heartbeat.marker, undefined, 'the older shape keeps only a last-run line, not a line per fire');
  });

  test('names its environment by a placeholder name, never an id', () => {
    const got = readConfig(text);
    assert.ok(got.ok);
    assert.equal(got.config.environment, 'my-env');
    assert.ok(namesEnvironment(got.config.environment));
  });

  test('has a code review on merges, a ticket review on issues opened, and a weekly review on its day limit alone', () => {
    const got = readConfig(text);
    assert.ok(got.ok);
    const shapes = got.config.periodics.map((p) => ({ counts: Object.keys(p.counts ?? {}), days: p.days }));
    assert.deepEqual(shapes, [
      { counts: ['merges'], days: shapes[0]?.days },
      { counts: ['issuesOpened'], days: shapes[1]?.days },
      { counts: [], days: 7 },
    ]);
  });

  test('its prompts are plain text, call no skill, act on the window governor lists, and sign off', () => {
    const file = JSON.parse(text) as { periodics: Array<{ name: string, prompt: unknown }> };
    for (const { name, prompt } of file.periodics) {
      assert.equal(typeof prompt, 'string', `${name}: a prompt file is the repo's own`);
      const p = String(prompt);
      assert.doesNotMatch(p, /skill|CLAUDE\.md/i, `${name}: the starter ships no skills`);
      assert.match(p, /governor lists below|governor gives below/, `${name}: acts on the window governor writes under it`);
      assert.match(p, /`Signing off\.`/, `${name}: a run that never signs off holds the next fire`);
    }
  });

  test('reads in the heartbeat checker, which watches pickup and every periodic', () => {
    const got = checkerReadConfig(text);
    assert.ok(got.ok, JSON.stringify(got));
    assert.notEqual(got.config.pickupHours, null);
    assert.equal(got.config.periodics.length, 3);
  });
});

describe('the starter workflow', () => {
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

test('the public-repo scan finds nothing in the starter', () => {
  for (const path of [CONFIG_FILE, WORKFLOW_FILE]) assert.deepEqual(scanText(path, read(path)), []);
});

test('the README\'s "How a repo opts in" points at the starter and the heartbeat issue\'s marker', () => {
  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('## How a repo opts in'), readme.indexOf('### The schema'));
  assert.match(section, /\(examples\/starter\/?\)/);
  assert.match(section, /<!-- governor:heartbeat -->/);
});
