/**
 * What a session told its PR merged hears about the deploys: the repo's own
 * deploy targets, read from its workflows' shipping jobs, and only where
 * the repo turns deploy messages on (dispatch/merge-notice.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deployNote, deployTargets } from '../dispatch/merge-notice.mjs';

const MERGE = 'c'.repeat(40);

const deliver = `name: Deliver
on:
  push:
    branches: [main]
env:
  TICKET_LABEL_PATHS: all
jobs:
  dev:
    name: "Deploy dev at \${{ github.sha }} · deployed: dev"
    runs-on: ubuntu-latest
    steps: []
  prod:
    uses: ./.github/workflows/stage.yml
    with:
      target: prod
`;

const stage = `name: Stage
on:
  workflow_call:
    inputs:
      target:
        type: string
jobs:
  ship:
    name: "Deploy \${{ inputs.target }} at \${{ github.sha }} · deployed: \${{ inputs.target }}"
    runs-on: ubuntu-latest
    steps: []
`;

const ci = 'name: CI\non: [push]\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps: []\n';

/** A reader over `files`, by name under .github/workflows, recording the refs it read at. */
const readerOver = (files: Record<string, string>) => {
  const refs: string[] = [];
  return {
    refs,
    reader: {
      workflowFiles: async (ref: string) => {
        refs.push(ref);
        return Object.keys(files);
      },
      fileAt: async (path: string, ref: string) => {
        refs.push(ref);
        const name = path.replace('.github/workflows/', '');
        const text = files[name];
        if (text === undefined) throw new Error(`GET /contents/${path} failed: 404`);
        return text;
      },
    },
  };
};

describe('deployTargets', () => {
  test('lists the targets of the shipping jobs in the repo\'s workflows at the merge, each once, a called file\'s with its inputs', async () => {
    const { reader, refs } = readerOver({ 'ci.yml': ci, 'deliver.yml': deliver, 'stage.yml': stage });
    assert.deepEqual(await deployTargets(reader, MERGE), ['dev', 'prod']);
    assert.ok(refs.every((r) => r === MERGE), 'every file read at the merge');
  });

  test('a repo with one shipping job lists that one target', async () => {
    const own = 'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    name: "Deploy at ${{ github.sha }} · deployed: governor"\n    runs-on: ubuntu-latest\n    steps: []\n';
    assert.deepEqual(await deployTargets(readerOver({ 'ci.yml': ci, 'deploy.yml': own }).reader, MERGE), ['governor']);
  });

  test('a repo whose workflows ship nothing lists none', async () => {
    assert.deepEqual(await deployTargets(readerOver({ 'ci.yml': ci }).reader, MERGE), []);
  });

  test('a read that fails throws, so no list read short names the wrong targets', async () => {
    await assert.rejects(deployTargets(readerOver({ 'deliver.yml': deliver }).reader, MERGE), /404/);
  });
});

describe('deployNote', () => {
  test('with deployed labels on, it names each target\'s label and says the session is told as each is applied', () => {
    const note = deployNote({ deployedLabels: true, targets: ['dev', 'prod'] });
    assert.match(note, /`deployed: dev` and `deployed: prod`/);
    assert.match(note, /tells you as each label is applied/);
  });

  test('with deployed labels off, it names the targets and says the session is told as each deploy finishes', () => {
    const note = deployNote({ deployedLabels: false, targets: ['governor'] });
    assert.match(note, /deploys to governor/);
    assert.match(note, /tells you as each deploy finishes/);
    assert.doesNotMatch(note, /deployed: /);
  });

  test('three targets read as a list', () => {
    assert.match(deployNote({ deployedLabels: false, targets: ['dev', 'staging', 'prod'] }), /dev, staging and prod/);
  });

  test('where governor cannot read the targets, it names none', () => {
    for (const deployedLabels of [true, false]) {
      const note = deployNote({ deployedLabels, targets: null });
      assert.doesNotMatch(note, /dev|prod|deployed: /, note);
      assert.match(note, /tells you as each/);
    }
    assert.doesNotMatch(deployNote({ deployedLabels: false, targets: [] }), /deploys to/);
  });
});
