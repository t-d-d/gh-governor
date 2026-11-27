/**
 * The files a `paths` limit's merges changed, listed under the prompt:
 * a totals line, then each matching file with the number of counted
 * merges that changed it and its lines added and deleted over them. The
 * check has already read every counted merge's files to count it, so the
 * list makes no read of its own.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LISTED_MAX, duePeriodics, keptFilesOf, narrowOf, periodicPrompt, windowOf } from '../dispatch/periodics.mjs';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (n: number) => new Date(NOW - n * HOUR).toISOString();
const finished = async () => false;
const log = () => {};

type Row = { filename: string; status: string; previous?: string; additions: number; deletions: number };
type Kept = { files: Array<{ filename: string; previous?: string; additions: number; deletions: number }>; cut: boolean };
const read = { at: hoursAgo(10), session: 'https://claude.ai/code/session_01RUN', baseline: false };

/** A repo whose merges each changed the files given, the first merged longest ago, and a state table holding the records given. */
const repoOf = (merges: Array<{ number: number, files: Row[] }>, held: Record<number, Kept> = {}) => {
  const fileReads: number[] = [];
  const recordReads: number[] = [];
  const records = new Map<number, Kept>(Object.entries(held).map(([n, r]) => [Number(n), r]));
  const reader = {
    defaultBranch: async () => 'main',
    mergedSince: async (_base: string, since: string) => merges.map((m, i) => ({ number: m.number, title: `Merge ${m.number}`, at: hoursAgo(merges.length - i) })).filter((m) => Date.parse(m.at) > Date.parse(since)),
    issuesOpenedSince: async () => [],
    issuesClosedSince: async () => [],
    pullFiles: async (n: number) => {
      fileReads.push(n);
      return merges.find((m) => m.number === n)?.files ?? [];
    },
  };
  const state = {
    periodic: async () => read,
    recordPeriodic: async () => true,
    mergedFiles: async (_repo: string, n: number) => {
      recordReads.push(n);
      return records.get(n) ?? null;
    },
    recordMergedFiles: async (_repo: string, n: number, record: Kept) => { records.set(n, record); },
  };
  return { reader, state, fileReads, recordReads };
};
const file = (filename: string, additions = 3, deletions = 1): Row => ({ filename, status: 'modified', additions, deletions });

const check = async (repo: ReturnType<typeof repoOf>, periodics: unknown[]) => duePeriodics({
  repo: REPO,
  periodics: periodics as never,
  state: repo.state,
  now: NOW,
  log,
  window: windowOf(repo.reader as never, 'main'),
  narrow: narrowOf(repo.reader as never, keptFilesOf(repo.state as never, REPO, log)),
  busy: finished,
  event: 'merges' as never,
});

/** The prompt the first due periodic's launch carries. */
const promptOf = async (repo: ReturnType<typeof repoOf>, periodic: { prompt: string, filters?: unknown }) => {
  const { due, unread } = await check(repo, [periodic]);
  assert.deepEqual(unread, []);
  assert.equal(due.length, 1);
  return periodicPrompt(periodic.prompt, due[0]!.read, due[0]!.windows, periodic.filters as never, due[0]!.details);
};

const infra = { name: 'Infra change', prompt: 'Review the infra change.', counts: { merges: 1 }, filters: { merges: { paths: ['infra/**'] } } };

describe('the files under a paths limit\'s merges', () => {
  test('a totals line, then one line for each matching file, most merges first, a tie to more lines, then the path', async () => {
    const repo = repoOf([
      { number: 1, files: [file('infra/b.yml', 1, 1), file('infra/a.yml', 1, 1), file('infra/big.yml', 50, 50)] },
      { number: 2, files: [file('infra/net.yml', 2, 0), file('infra/b.yml', 1, 0), file('infra/a.yml', 1, 0)] },
    ]);
    const prompt = await promptOf(repo, infra);
    const merges = `Pull requests merged into the default branch that changed a file matching \`infra/**\` since ${read.at}: 2\n- #1 Merge 1\n- #2 Merge 2`;
    const files = [
      'Files matching these patterns that the counted merges changed: 4, across 2 merges.',
      '- `infra/a.yml`: 2 merges, +2 -1',
      '- `infra/b.yml`: 2 merges, +2 -1',
      '- `infra/big.yml`: 1 merge, +50 -50',
      '- `infra/net.yml`: 1 merge, +2 -0',
    ].join('\n');
    assert.ok(prompt.endsWith(`${merges}\n\n${files}`), prompt);
  });

  test('a file two counted merges changed shows 2 merges and the sum of its lines added and deleted', async () => {
    const repo = repoOf([{ number: 1, files: [file('infra/a.yml', 10, 4)] }, { number: 2, files: [file('infra/a.yml', 5, 7)] }]);
    assert.match(await promptOf(repo, infra), /^- `infra\/a\.yml`: 2 merges, \+15 -11$/m);
  });

  test('a file that matches no pattern is not listed, nor is a merge the filter left out', async () => {
    const repo = repoOf([{ number: 1, files: [file('docs/x.md')] }, { number: 2, files: [file('infra/a.yml'), file('docs/a.md')] }]);
    const prompt = await promptOf(repo, infra);
    assert.match(prompt, /changed: 1, across 1 merge\.$/m);
    assert.doesNotMatch(prompt, /docs\//);
  });

  test('a rename is listed under its new path where only its old path matches', async () => {
    const repo = repoOf([{ number: 1, files: [{ filename: 'attic/old.yml', previous: 'infra/old.yml', status: 'renamed', additions: 0, deletions: 0 }] }]);
    assert.match(await promptOf(repo, infra), /^- `attic\/old\.yml`: 1 merge, \+0 -0$/m);
  });

  test('more files than the cap end in a line that says how many more', async () => {
    const many = Array.from({ length: LISTED_MAX + 7 }, (_, i) => file(`infra/f-${String(i).padStart(3, '0')}.yml`));
    const prompt = await promptOf(repoOf([{ number: 1, files: many }]), infra);
    assert.equal(prompt.match(/^- `infra\/f-/gm)?.length, LISTED_MAX);
    assert.match(prompt, /^- and 7 more files$/m);
    assert.match(prompt, new RegExp(`changed: ${LISTED_MAX + 7}, across 1 merge\\.$`, 'm'));
  });

  test('a counted merge whose record carries the cut mark adds the files it holds, and the totals line says the list is not whole', async () => {
    const held = {
      1: { files: [{ filename: 'infra/a.yml', additions: 2, deletions: 2 }, { filename: 'docs/a.md', additions: 1, deletions: 1 }], cut: true },
      2: { files: [], cut: true },
    };
    const repo = repoOf([{ number: 1, files: [] }, { number: 2, files: [] }, { number: 3, files: [file('infra/a.yml', 1, 0)] }], held);
    const prompt = await promptOf(repo, infra);
    assert.match(prompt, /^Files matching these patterns that the counted merges changed: 1, across 3 merges\. The list is not whole: it is missing files for 2 merges\.$/m);
    assert.match(prompt, /^- `infra\/a\.yml`: 2 merges, \+3 -2$/m);
    assert.doesNotMatch(prompt, /docs\//);
  });

  test('a merges limit without paths gets no files list and makes no files read', async () => {
    const repo = repoOf([{ number: 1, files: [file('infra/a.yml')] }]);
    const every = { name: 'Every merge', prompt: 'Review.', counts: { merges: 1 } };
    const prompt = await promptOf(repo, every);
    assert.doesNotMatch(prompt, /Files matching/);
    assert.deepEqual(repo.fileReads, []);
    assert.deepEqual(repo.recordReads, []);
  });

  test('listing the files makes no read the check had not already made', async () => {
    const repo = repoOf([{ number: 1, files: [file('infra/a.yml')] }, { number: 2, files: [file('docs/a.md')] }, { number: 3, files: [file('infra/b.yml')] }]);
    const { due } = await check(repo, [infra]);
    assert.deepEqual(repo.fileReads, [1, 2, 3], 'each merge\'s files read once, to count it');
    assert.deepEqual(repo.recordReads, [1, 2, 3], 'each merge\'s record read once');
    assert.match(periodicPrompt(infra.prompt, due[0]!.read, due[0]!.windows, infra.filters as never, due[0]!.details), /changed: 2, across 2 merges/);
    assert.deepEqual(repo.fileReads, [1, 2, 3]);
    assert.deepEqual(repo.recordReads, [1, 2, 3]);
  });

  test('the launch\'s prompt carries the list', async () => {
    const { periodicLaunch } = await import('../dispatch/periodics.mjs');
    const repo = repoOf([{ number: 1, files: [file('infra/a.yml')] }]);
    const { due } = await check(repo, [infra]);
    const config = { environment: 'env_x', periodics: [infra] };
    const launch = periodicLaunch({ config: config as never, state: repo.state as never, log, beats: [], unread: [] }, REPO, due[0]!);
    assert.match(launch.asked.prompt, /^- `infra\/a\.yml`: 1 merge, \+3 -1$/m);
  });
});

describe('how a session reads more history than the lists show', () => {
  test('the starter kit\'s Code review prompt says its clone is shallow and how to fetch since the last fire', () => {
    for (const path of ['examples/starter/.github/governor.json', 'examples/starter/.github/governor.dark-factory.json']) {
      const prompt: string = JSON.parse(readFileSync(path, 'utf8')).periodics.sessions['Code review'].prompt;
      assert.match(prompt, /shallow/, path);
      assert.match(prompt, /git fetch --shallow-since/, path);
    }
  });

  test('docs/serving-a-repo.md says so too', () => {
    const doc = readFileSync('docs/serving-a-repo.md', 'utf8');
    assert.match(doc, /shallow/);
    assert.match(doc, /git fetch --shallow-since/);
  });
});
