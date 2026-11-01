/**
 * Every action governor's own workflows run that lives outside this repo is
 * named by its full commit, with the tag it was taken from in a comment
 * beside it. A tag can be moved by whoever controls the action's repo, and
 * the deploy job holds an administrator role in governor's account, so a
 * moved tag would run their code with that role. A commit cannot move.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import yaml from 'js-yaml';
import { REPO_ROOT } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';

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
  for (const line of text.split(/\r?\n/)) {
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

const PINNED = /@[0-9a-f]{40}$/;

/**
 * The `uses:` values in a parsed workflow or action, at a job, a job's step or
 * a composite action's step, that name an outside action by anything but a
 * full commit. The line scan above can miss a `uses:` written in a form it
 * does not read, such as a flow mapping; the parsed file cannot.
 */
export function unpinnedRefs(doc: unknown): string[] {
  const d = (doc ?? {}) as { jobs?: Record<string, any>; runs?: { steps?: any[] } };
  const jobs = Object.values(d.jobs ?? {});
  const refs = [
    ...jobs.flatMap((job) => [job?.uses, ...(job?.steps ?? []).map((s: any) => s?.uses)]),
    ...(d.runs?.steps ?? []).map((s) => s?.uses),
  ];
  return refs.filter((ref): ref is string =>
    typeof ref === 'string' && !ref.startsWith('./') && !PINNED.test(ref));
}

describe('third-party actions are named by their commit', () => {
  test('a tag, a branch, a short commit or a missing tag comment is refused', () => {
    const sha = 'e1253824e5c10ff9df46874f81ed3ec929e19cfd';
    assert.deepEqual(unpinned('      - uses: actions/checkout@v5'), ['- uses: actions/checkout@v5']);
    assert.deepEqual(unpinned('        uses: aws-actions/configure-aws-credentials@main # v6'), ['uses: aws-actions/configure-aws-credentials@main # v6']);
    assert.deepEqual(unpinned('      - uses: actions/checkout@e1253824'), ['- uses: actions/checkout@e1253824']);
    assert.deepEqual(unpinned(`      - uses: actions/checkout@${sha}`), [`- uses: actions/checkout@${sha}`]);
    assert.deepEqual(unpinned('      - uses: docker://alpine:3'), ['- uses: docker://alpine:3']);
    assert.deepEqual(unpinned('      - uses: actions/checkout@v5 # v5\r\n'), ['- uses: actions/checkout@v5 # v5']);
  });

  test('a tag the line scan cannot read, as in a flow mapping, is still refused', () => {
    const sha = 'e1253824e5c10ff9df46874f81ed3ec929e19cfd';
    const workflow = yaml.load([
      'jobs:',
      '  build:',
      '    steps:',
      '      - { uses: actions/checkout@v5 }',
      `      - uses: actions/setup-node@${sha} # v6.5.0`,
      '      - uses: ./.github/actions/image',
      '  called:',
      '    uses: acme/factory/.github/workflows/ci.yml@main',
    ].join('\n'));
    assert.deepEqual(unpinnedRefs(workflow), ['actions/checkout@v5', 'acme/factory/.github/workflows/ci.yml@main']);
    const action = yaml.load('runs:\n  using: composite\n  steps:\n    - uses: docker/build-push-action@v7\n');
    assert.deepEqual(unpinnedRefs(action), ['docker/build-push-action@v7']);
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
    const found = files.flatMap((path) => {
      const { raw, workflow } = loadWorkflow(path);
      return [...unpinned(raw), ...unpinnedRefs(workflow)].map((line) => `${relative(REPO_ROOT, path)}: ${line}`);
    });
    assert.deepEqual(found, []);
  });
});

/** The directories a Dependabot entry watches: one `directory`, or a `directories` list. */
function watched(entry: { directory?: string; directories?: string[] }): string[] {
  return [...(entry.directory ? [entry.directory] : []), ...(entry.directories ?? [])];
}

/**
 * Whether a list of Dependabot directories reaches a folder. An entry is a
 * path, a path ending in `/*` for the folders one level below it, or a path
 * ending in `/**` for that path and every folder below it. A trailing slash
 * is ignored.
 */
function covers(patterns: string[], dir: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const d = trim(dir);
  return patterns.map(trim).some((p) => {
    if (p.endsWith('/**')) {
      const base = p.slice(0, -3);
      return d === (base || '/') || d.startsWith(`${base}/`);
    }
    if (p.endsWith('/*')) {
      const base = p.slice(0, -1);
      return d.startsWith(base) && d.length > base.length && !d.slice(base.length).includes('/');
    }
    return p === d;
  });
}

describe('Dependabot moves the pinned commits forward', () => {
  test('a path, a one-level glob and a deep glob each reach the folders they name', () => {
    assert.ok(covers(['/'], '/'));
    assert.ok(covers(['/.github/actions/image/'], '/.github/actions/image'));
    assert.ok(covers(['/.github/actions/*'], '/.github/actions/image'));
    assert.ok(!covers(['/.github/actions/*'], '/.github/actions/grp/inner'));
    assert.ok(!covers(['/.github/actions/*'], '/.github/actions'));
    assert.ok(covers(['/**'], '/'));
    assert.ok(covers(['/**'], '/.github/actions/grp/inner'));
    assert.ok(covers(['/.github/actions/**'], '/.github/actions/grp/inner'));
    assert.ok(!covers(['/.github/actions/**'], '/'));
  });

  test('a github-actions entry watches the workflows and every local action', () => {
    const config = yaml.load(readFileSync(join(REPO_ROOT, '.github/dependabot.yml'), 'utf8')) as {
      version?: number;
      updates?: { 'package-ecosystem'?: string; directory?: string; directories?: string[]; schedule?: { interval?: string } }[];
    };
    assert.equal(config.version, 2);
    const entries = (config.updates ?? []).filter((u) => u['package-ecosystem'] === 'github-actions');
    assert.equal(entries.length, 1, 'one github-actions entry');
    const entry = entries[0]!;
    assert.ok(entry.schedule?.interval, 'the entry has a schedule');
    const patterns = watched(entry);
    // Dependabot reads .github/workflows from the root directory, "/".
    assert.ok(covers(patterns, '/'), 'the root, and so .github/workflows, is watched');
    // A composite action is any folder holding an action.yml, at any depth,
    // since a `/*` glob reaches only one level down.
    const actions = yamlFiles(join(REPO_ROOT, '.github/actions'))
      .filter((path) => /^action\.ya?ml$/.test(basename(path)))
      .map((path) => `/${relative(REPO_ROOT, dirname(path))}`);
    assert.ok(actions.length > 0, 'found the local actions');
    assert.deepEqual(actions.filter((dir) => !covers(patterns, dir)), []);
  });
});
