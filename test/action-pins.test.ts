/**
 * Every action governor's own workflows run that lives outside this repo is
 * named by its full commit, with the tag it was taken from in a comment
 * beside it. A tag can be moved by whoever controls the action's repo, and
 * the deploy job holds an administrator role in governor's account, so a
 * moved tag would run their code with that role. A commit cannot move.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

const DIRS = ['.github/workflows', '.github/actions'];

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(name) ? [path] : [];
  });
}

/**
 * The `uses:` lines in a workflow or action file that name an action outside
 * this repo by anything but a 40-character commit with a tag comment.
 */
export function unpinned(text: string): string[] {
  const bad: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const ref = m[2] as string;
    const comment = m[3];
    if (ref.startsWith('./')) continue;
    const at = ref.lastIndexOf('@');
    const commit = at < 0 ? '' : ref.slice(at + 1);
    if (!/^[0-9a-f]{40}$/.test(commit) || !/^#\s*v\d/.test(comment ?? '')) bad.push(line.trim());
  }
  return bad;
}

describe('third-party actions are named by their commit', () => {
  test('a tag, a branch, a short commit or a missing tag comment is refused', () => {
    const sha = 'e1253824e5c10ff9df46874f81ed3ec929e19cfd';
    assert.deepEqual(unpinned('      - uses: actions/checkout@v5'), ['- uses: actions/checkout@v5']);
    assert.deepEqual(unpinned('        uses: aws-actions/configure-aws-credentials@main # v6'), ['uses: aws-actions/configure-aws-credentials@main # v6']);
    assert.deepEqual(unpinned('      - uses: actions/checkout@e1253824'), ['- uses: actions/checkout@e1253824']);
    assert.deepEqual(unpinned(`      - uses: actions/checkout@${sha}`), [`- uses: actions/checkout@${sha}`]);
    assert.deepEqual(unpinned('      - uses: docker://alpine:3'), ['- uses: docker://alpine:3']);
  });

  test('a full commit with its tag beside it, a local action, and a comment line pass', () => {
    const sha = 'e1253824e5c10ff9df46874f81ed3ec929e19cfd';
    assert.deepEqual(unpinned(`      - uses: actions/checkout@${sha} # v6.3.0`), []);
    assert.deepEqual(unpinned(`        uses: 'actions/checkout@${sha}' # v6.3.0`), []);
    assert.deepEqual(unpinned('        uses: ./.github/actions/image'), []);
    assert.deepEqual(unpinned('#   uses: t-d-d/gh-governor/.github/workflows/heartbeat-check.yml@<commit>'), []);
  });

  test('every workflow and action in .github names each outside action by its commit', () => {
    const files = DIRS.flatMap((dir) => yamlFiles(join(REPO_ROOT, dir)));
    assert.ok(files.length > 0, 'found the workflow files');
    const found = files.flatMap((path) =>
      unpinned(readFileSync(path, 'utf8')).map((line) => `${relative(REPO_ROOT, path)}: ${line}`));
    assert.deepEqual(found, []);
  });
});
