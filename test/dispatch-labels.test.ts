/**
 * What a workflow file declares about its deploy target,
 * and what a run's jobs say it shipped. The range a run covers, and which tickets in it
 * get the label, are test/dispatch-coverage.test.ts's.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { globMatches, pathsMatch, shippingLabelsOf, ticketLabelOf } from '../dispatch/labels.mjs';
import { builtCommit, shippedNothing, shipsAs } from '../dispatch/runs.mjs';

const HEAD = 'c'.repeat(40);

const file = (env: string, on = 'on:\n  workflow_dispatch:\n') => `name: W\n${on}${env}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n`;

describe('ticketLabelOf', () => {
  test('reads which tickets get the label: every one, the trigger paths, or globs one per line', () => {
    assert.deepEqual(ticketLabelOf(file('env:\n  TICKET_LABEL_PATHS: all\n')), { paths: 'all', merge: false });
    assert.deepEqual(
      ticketLabelOf(file('env:\n  TICKET_LABEL_PATHS: trigger\n', 'on:\n  push:\n    branches: [main]\n    paths:\n      - dispatch/**\n      - scripts/**\n')),
      { paths: ['dispatch/**', 'scripts/**'], merge: true },
    );
    assert.deepEqual(
      ticketLabelOf(file('env:\n  TICKET_LABEL_PATHS: |\n    clients/apple/**\n\n    clients/shared/**\n')),
      { paths: ['clients/apple/**', 'clients/shared/**'], merge: false },
    );
  });

  test('a target a push to main or a finished workflow starts is one a merge starts; one only dispatched by hand is not', () => {
    const env = 'env:\n  TICKET_LABEL_PATHS: all\n';
    assert.equal(ticketLabelOf(file(env, 'on:\n  workflow_run:\n    workflows: ["CI"]\n    types: [completed]\n  workflow_dispatch:\n'))?.merge, true);
    assert.equal(ticketLabelOf(file(env, 'on:\n  push:\n    branches: [main]\n'))?.merge, true);
    assert.equal(ticketLabelOf(file(env, 'on:\n  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"\n'))?.merge, false);
    assert.equal(ticketLabelOf(file(env, 'on: push\n'))?.merge, true, 'the one-event form');
    assert.equal(ticketLabelOf(file(env, 'on: [push, workflow_dispatch]\n'))?.merge, true, 'the list form');
    assert.equal(ticketLabelOf(file(env, 'on: [workflow_dispatch]\n'))?.merge, false);
  });

  // The label is the shipping job's name's, not the file's env.
  test('TICKET_LABEL and TICKET_LABEL_JOBS are retired: a file still declaring them is read for its paths alone', () => {
    assert.deepEqual(
      ticketLabelOf(file("env:\n  TICKET_LABEL: 'deployed: x'\n  TICKET_LABEL_PATHS: all\n  TICKET_LABEL_JOBS: |\n    Publish to A at\n")),
      { paths: 'all', merge: false },
    );
    assert.equal(ticketLabelOf(file("env:\n  TICKET_LABEL: 'deployed: dev'\n")), null, 'a label with no paths picks nothing');
  });

  test('a file declaring no paths, a trigger with no push paths, or no YAML at all, declares nothing', () => {
    for (const text of [
      file(''),
      file('env:\n  OTHER: x\n'),
      file('env:\n  TICKET_LABEL_PATHS: trigger\n'),
      file("env:\n  TICKET_LABEL_PATHS: ''\n"),
      file('env:\n  TICKET_LABEL_PATHS:\n    - a\n'),
      ': not yaml: [',
    ]) {
      assert.equal(ticketLabelOf(text), null, text);
    }
  });
});

/**
 * A red run's target is its final stage's: the labels the
 * file's jobs earn, in job order, a `uses:` job's read from the called
 * file with the caller's `with:` put in for `${{ inputs.<k> }}`.
 */
describe('shippingLabelsOf', () => {
  const DELIVER = [
    'name: Deliver',
    'on:',
    '  workflow_run:',
    '    workflows: [CI]',
    '    types: [completed]',
    'env:',
    '  TICKET_LABEL_PATHS: all',
    'jobs:',
    '  train:',
    '    name: Resolve the train',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '  dev:',
    '    needs: train',
    '    uses: ./.github/workflows/deploy-stage.yml',
    '    with:',
    '      stage: dev',
    '      head_sha: ${{ needs.train.outputs.commit }}',
    '  gate:',
    '    needs: dev',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '  e2e:',
    '    needs: gate',
    '    uses: ./.github/workflows/e2e.yml',
    '  prod:',
    '    needs: e2e',
    '    uses: ./.github/workflows/deploy-stage.yml',
    '    with:',
    '      stage: prod',
    '      head_sha: ${{ needs.train.outputs.commit }}',
    '',
  ].join('\n');
  const STAGE = [
    'name: Deploy Stage',
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      stage:',
    '        type: string',
    'jobs:',
    '  deploy-stack:',
    '    name: Deploy stack (${{ inputs.stage }})',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '  publish:',
    // Quoted: `: ` inside a plain scalar is a mapping to YAML.
    '    name: "Publish (${{ inputs.stage }}) at ${{ inputs.head_sha }} · deployed: ${{ inputs.stage }}"',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '',
  ].join('\n');
  const E2E = 'name: E2E\non:\n  workflow_call:\njobs:\n  suite:\n    name: Run the members\n    runs-on: ubuntu-latest\n    steps: []\n';
  const files: Record<string, string> = { 'deploy-stage.yml': STAGE, 'e2e.yml': E2E };

  test('reads each job\'s label in job order, a uses: job\'s from the called file with the caller\'s inputs put in', async () => {
    const fetched: string[] = [];
    const labels = await shippingLabelsOf(DELIVER, async (file) => { fetched.push(file); return files[file]!; });
    assert.deepEqual(labels, ['deployed: dev', 'deployed: prod']);
    assert.deepEqual(fetched, ['deploy-stage.yml', 'e2e.yml'], 'each called file is read once, in job order: deliver.yml calls deploy-stage.yml twice');
  });

  test('a job named with the marker in the file itself needs no fetch', async () => {
    const text = "name: Dispatch stack\non:\n  push:\njobs:\n  deploy:\n    name: \"${{ inputs.probe_only && 'Probe only: ' || '' }}Build the image, apply the stack, probe the task at ${{ github.sha }} · deployed: the dispatcher\"\n    runs-on: ubuntu-latest\n    steps: []\n";
    assert.deepEqual(await shippingLabelsOf(text, async () => { throw new Error('no fetch'); }), ['deployed: the dispatcher']);
  });

  test('a name that is one expression earns the label in its literal, but not a format() placeholder', async () => {
    const named = (name: string) => `name: Stack\non:\n  push:\njobs:\n  deploy:\n    name: "${name}"\n    runs-on: ubuntu-latest\n    steps: []\n`;
    const none = async () => { throw new Error('no fetch'); };
    assert.deepEqual(await shippingLabelsOf(named("${{ inputs.probe_only && 'Probe only' || format('Apply at {0} · deployed: dispatcher', github.sha) }}"), none), ['deployed: dispatcher']);
    // The target is an argument: the literal names no label, only where one goes.
    assert.deepEqual(await shippingLabelsOf(named("${{ format('Publish at {0} · deployed: {1}', github.sha, inputs.stage) }}"), none), []);
    // Text outside the expression leaves the marker in the literal all the same,
    // and the name's tail is the expression's residue, not a target.
    assert.deepEqual(await shippingLabelsOf(named("Stack: ${{ inputs.probe_only && 'Probe only' || format('Apply at {0} · deployed: dispatcher', github.sha) }}"), none), ['deployed: dispatcher']);
    // The marker ends the name: text after the expression ends the run's name
    // instead, so the literal's marker is not where the run's label comes from.
    assert.deepEqual(await shippingLabelsOf(named("${{ format('Apply at {0} · deployed: dispatcher', github.sha) }} (probe)"), none), []);
    assert.deepEqual(await shippingLabelsOf(named("${{ inputs.ok && 'Apply · deployed: x' || 'Probe' }} · deployed: y"), none), []);
  });

  test('an input the caller leaves unset leaves the label unresolved, which earns nothing; a file with no marked job declares no target', async () => {
    const unset = DELIVER.replace('      stage: prod\n', '');
    assert.deepEqual(await shippingLabelsOf(unset, async (file) => files[file]!), ['deployed: dev']);
    assert.deepEqual(await shippingLabelsOf('name: CI\non:\n  push:\njobs:\n  backend:\n    runs-on: ubuntu-latest\n    steps: []\n', async () => ''), []);
    assert.deepEqual(await shippingLabelsOf(': not yaml: [', async () => ''), []);
  });

  test('a called file that cannot be read throws: a target read short would name the wrong stage', async () => {
    await assert.rejects(shippingLabelsOf(DELIVER, async () => { throw new Error('GET /contents failed: 502'); }), /502/);
  });
});

describe('globMatches', () => {
  test('`**` crosses directories, `*` does not, and the rest is literal', () => {
    assert.ok(globMatches('clients/android/**', 'clients/android/app/src/Main.kt'));
    assert.ok(globMatches('server.json', 'server.json'));
    assert.ok(globMatches('clients/shared/*.css', 'clients/shared/tokens.css'));
    assert.ok(globMatches('.github/workflows/deploy.yml', '.github/workflows/deploy.yml'));
    assert.ok(!globMatches('clients/shared/*.css', 'clients/shared/fonts/a.css'));
    assert.ok(!globMatches('server.json', 'clients/server.json'));
    assert.ok(!globMatches('.github/workflows/deploy.yml', '.github/workflows/dispatchXyml'));
    assert.ok(!globMatches('clients/android/**', 'clients/androidx/a'));
  });

  test('`**/` matches no directory too, as GitHub reads it', () => {
    assert.ok(globMatches('dispatch/**/x.mjs', 'dispatch/x.mjs'));
    assert.ok(globMatches('dispatch/**/x.mjs', 'dispatch/a/b/x.mjs'));
    assert.ok(globMatches('**/x.mjs', 'x.mjs'));
    assert.ok(!globMatches('dispatch/**/x.mjs', 'dispatchx.mjs'));
  });
});

describe('pathsMatch', () => {
  test('a path matches as a workflow `paths` list reads it: the last pattern it matches wins, and `!` excludes', () => {
    const paths = ['scripts/**', '!scripts/e2e/**', 'scripts/e2e/keep.mjs'];
    assert.ok(pathsMatch(paths, 'scripts/a.mjs'));
    assert.ok(!pathsMatch(paths, 'scripts/e2e/a.mjs'));
    assert.ok(pathsMatch(paths, 'scripts/e2e/keep.mjs'));
    assert.ok(!pathsMatch(paths, 'src/a.ts'));
  });
});

describe('shippedNothing', () => {
  const job = (name: string, conclusion = 'success') => ({ name, conclusion, html_url: '' });
  const DEV = `dev / Publish (dev) at ${HEAD} · deployed: dev`;
  const PROD = `prod / Publish (prod) at ${HEAD} · deployed: prod`;

  test('a run shipped a label when a job marked with it succeeded', () => {
    assert.equal(shippedNothing([job('Resolve'), job(DEV), job(PROD, 'skipped')], 'deployed: dev'), null);
    assert.match(String(shippedNothing([job('Resolve'), job(DEV), job(PROD, 'skipped')], 'deployed: prod')), /deployed: prod/);
    assert.match(String(shippedNothing([job(`Dry run: Publish (dev) at ${HEAD}`)], 'deployed: dev')), /deployed: dev/, 'a dry run drops the marker');
    assert.match(String(shippedNothing([job('Resolve')], 'deployed: dev')), /deployed: dev/);
    assert.match(String(shippedNothing([], 'deployed: dev')), /no job/);
  });

  test('with no label asked for, any marked job that succeeded will do; an unmarked one says nothing', () => {
    assert.equal(shippedNothing([job('Resolve'), job(PROD)]), null);
    assert.notEqual(shippedNothing([job('Resolve'), job('deploy-dev / publish')]), null);
    assert.notEqual(shippedNothing([job(DEV, 'failure')]), null);
  });

  test('shipsAs reads the marker, for one label or any', () => {
    assert.ok(shipsAs(job(DEV)));
    assert.ok(shipsAs(job(DEV), 'deployed: dev'));
    assert.ok(!shipsAs(job(DEV), 'deployed: prod'));
    assert.ok(!shipsAs(job('Publish (dev)')));
  });
});

describe('builtCommit', () => {
  test('the commit a marked job that succeeded names, for the label asked or any, else the run head', () => {
    const sha = 'd'.repeat(40);
    const other = 'e'.repeat(40);
    assert.equal(builtCommit([{ name: `Apple release at ${sha} · deployed: app store connect`, conclusion: 'success', html_url: '' }], HEAD), sha);
    assert.equal(builtCommit([{ name: 'Apple release at abc1234 · deployed: app store connect', conclusion: 'success', html_url: '' }], HEAD), 'abc1234');
    assert.equal(builtCommit([{ name: `dev / Publish (dev) at ${sha} · deployed: dev`, conclusion: 'success', html_url: '' }, { name: `prod / Publish (prod) at ${other} · deployed: prod`, conclusion: 'success', html_url: '' }], HEAD, 'deployed: prod'), other);
    assert.equal(builtCommit([{ name: `Other at ${sha}`, conclusion: 'success', html_url: '' }], HEAD), HEAD, 'a job with no marker names nothing');
    assert.equal(builtCommit([{ name: `Apple release at ${sha} · deployed: x`, conclusion: 'skipped', html_url: '' }], HEAD), HEAD, 'a skipped job built nothing');
    assert.equal(builtCommit([{ name: 'Publish to Play testing track · deployed: play track', conclusion: 'success', html_url: '' }], HEAD), HEAD, 'a marker naming no commit built the head');
  });
});
