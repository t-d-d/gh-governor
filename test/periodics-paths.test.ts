/**
 * `paths` on `merges`: a limit that counts only the merges changing a file
 * one of its patterns matches. The patterns read as the human-only list's
 * do (`globMatches`, dispatch/checklist.mjs). A check reads the one list of
 * merged pull requests, shared by every limit, and reads each pull
 * request's files at most once, however many limits ask for them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../dispatch/repo-config.mjs';
import { duePeriodics, narrowOf, periodicPrompt, windowOf } from '../dispatch/periodics.mjs';
import { FILES_LISTED } from '../dispatch/checklist.mjs';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (n: number) => new Date(NOW - n * HOUR).toISOString();
const finished = async () => false;
const log = () => {};

type Row = { filename: string; status: string; previous?: string };
type Record_ = { at: string; session: string | null; baseline: boolean };
const store = (initial: Record<string, Record_>) => ({
  periodic: async (_repo: string, name: string) => initial[name] ?? null,
  recordPeriodic: async () => true,
});
const fired = (hours: number): Record_ => ({ at: hoursAgo(hours), session: 'https://claude.ai/code/session_01RUN', baseline: false });

/** A repo whose merges each changed the files given, the first merged longest ago. */
const repoOf = (merges: Array<{ number: number, files: Row[] | Error }>) => {
  const fileReads: number[] = [];
  const mergedReads: string[] = [];
  const reader = {
    defaultBranch: async () => 'main',
    mergedSince: async (_base: string, since: string) => {
      mergedReads.push(since);
      return merges.map((m, i) => ({ number: m.number, title: `Merge ${m.number}`, at: hoursAgo(merges.length - i) })).filter((m) => Date.parse(m.at) > Date.parse(since));
    },
    issuesOpenedSince: async () => [],
    issuesClosedSince: async () => [],
    pullFiles: async (n: number) => {
      fileReads.push(n);
      const files = merges.find((m) => m.number === n)?.files;
      if (files instanceof Error) throw files;
      return files ?? [];
    },
  };
  return { reader, fileReads, mergedReads };
};
const changed = (...paths: string[]): Row[] => paths.map((filename) => ({ filename, status: 'modified' }));

const check = async (repo: ReturnType<typeof repoOf>, periodics: unknown[], records: Record<string, Record_>, event: string | undefined = 'merges') => duePeriodics({
  repo: REPO,
  periodics: periodics as never,
  state: store(records),
  now: NOW,
  log,
  window: windowOf(repo.reader as never, 'main'),
  narrow: narrowOf(repo.reader as never),
  busy: finished,
  ...(event === undefined ? {} : { event: event as never }),
});

const infra = { name: 'Infra change', prompt: 'Review the infra change.', counts: { merges: 2 }, filters: { merges: { paths: ['infra/**'] } } };

describe('a merges limit with paths', () => {
  test('is not due after two merges that change only docs/, and is due after two that each change a file under infra/', async () => {
    const quiet = repoOf([{ number: 1, files: changed('docs/a.md') }, { number: 2, files: changed('docs/b.md', 'README.md') }]);
    assert.deepEqual((await check(quiet, [infra], { 'Infra change': fired(10) })).due, []);
    const busy = repoOf([{ number: 1, files: changed('infra/stack.yml') }, { number: 2, files: changed('docs/b.md') }, { number: 3, files: changed('infra/net/vpc.yml', 'docs/c.md') }]);
    const { due } = await check(busy, [infra], { 'Infra change': fired(10) });
    assert.deepEqual(due.map((d) => d.windows?.merges?.map((m) => m.number)), [[1, 3]]);
    assert.deepEqual(due[0]!.by, { count: 'merges', number: 2 });
  });

  test('a count of 1 fires on the check of the first merge that changes a matching file', async () => {
    const every = { ...infra, counts: { merges: 1 } };
    const before = repoOf([{ number: 1, files: changed('docs/a.md') }]);
    assert.deepEqual((await check(before, [every], { 'Infra change': fired(10) })).due, []);
    const after = repoOf([{ number: 1, files: changed('docs/a.md') }, { number: 2, files: changed('infra/stack.yml') }]);
    assert.deepEqual((await check(after, [every], { 'Infra change': fired(10) })).due.map((d) => d.windows?.merges?.map((m) => m.number)), [[2]]);
  });

  test('a pattern without a slash matches a file of that name at any depth, and a rename counts under its old path', async () => {
    const turn = { name: 'Turn review', prompt: 'p', counts: { merges: 1 }, filters: { merges: { paths: ['turn.mjs'] } } };
    const deep = repoOf([{ number: 1, files: changed('dispatch/turn.mjs') }]);
    assert.equal((await check(deep, [turn], { 'Turn review': fired(10) })).due.length, 1);
    const other = repoOf([{ number: 1, files: changed('dispatch/turn.mjs.bak', 'docs/turn.md') }]);
    assert.equal((await check(other, [turn], { 'Turn review': fired(10) })).due.length, 0);
    const moved = repoOf([{ number: 1, files: [{ filename: 'attic/old.yml', status: 'renamed', previous: 'infra/old.yml' }] }]);
    assert.equal((await check(moved, [{ ...infra, counts: { merges: 1 } }], { 'Infra change': fired(10) })).due.length, 1);
  });

  test('a merge whose files GitHub cut short counts as a match', async () => {
    const many = Array.from({ length: FILES_LISTED }, (_, i) => `docs/page-${i}.md`);
    const repo = repoOf([{ number: 1, files: changed(...many) }]);
    assert.equal((await check(repo, [{ ...infra, counts: { merges: 1 } }], { 'Infra change': fired(10) })).due.length, 1);
  });

  test('the prompt lists only the merges counted and names the patterns', async () => {
    const turn = { name: 'Turn review', prompt: 'Review the turn.', counts: { merges: 1 }, filters: { merges: { paths: ['dispatch/turn.mjs', 'dispatch/webhook/**'] } } };
    const repo = repoOf([{ number: 1, files: changed('docs/a.md') }, { number: 2, files: changed('dispatch/webhook/route.mjs') }]);
    const read = fired(10);
    const { due } = await check(repo, [turn], { 'Turn review': read });
    const prompt = periodicPrompt(turn.prompt, read, due[0]!.windows, turn.filters);
    assert.match(prompt, new RegExp(`Pull requests merged into the default branch that changed a file matching \`dispatch/turn\\.mjs\` or \`dispatch/webhook/\\*\\*\` since ${read.at}: 1\\n- #2 Merge 2$`));
    assert.doesNotMatch(prompt, /#1 /);
  });

  test('two limits with different paths share the one list, and a pull request both read has its files read once', async () => {
    const docs = { name: 'Docs review', prompt: 'p', counts: { merges: 1 }, filters: { merges: { paths: ['docs/**'] } } };
    const all = { name: 'Every merge', prompt: 'p', counts: { merges: 9 } };
    const repo = repoOf([{ number: 1, files: changed('infra/a.yml') }, { number: 2, files: changed('docs/a.md') }, { number: 3, files: changed('infra/b.yml') }]);
    const { due } = await check(repo, [infra, docs, all], { 'Infra change': fired(10), 'Docs review': fired(10), 'Every merge': fired(10) });
    assert.deepEqual(repo.mergedReads, [hoursAgo(10)], 'one list of merged pull requests');
    assert.deepEqual([...repo.fileReads].sort(), [1, 2, 3], 'each pull request\'s files read once');
    assert.deepEqual(due.map((d) => [d.periodic.name, d.windows?.merges?.map((m) => m.number)]), [['Infra change', [1, 3]], ['Docs review', [2]]]);
  });

  test('a files read that fails refuses the periodic for the turn and starts nothing', async () => {
    const repo = repoOf([{ number: 1, files: changed('infra/a.yml') }, { number: 2, files: new Error('GitHub refused the files') }]);
    const { due, unread } = await check(repo, [infra], { 'Infra change': fired(10) });
    assert.deepEqual(due, []);
    assert.equal(unread.length, 1);
    assert.match(unread[0]!.error, /Infra change: GitHub refused the files/);
  });

  test('the sweep reads the filtered count too', async () => {
    const repo = repoOf([{ number: 1, files: changed('infra/a.yml') }, { number: 2, files: changed('docs/a.md') }]);
    assert.deepEqual((await check(repo, [infra], { 'Infra change': fired(10) }, undefined)).due, []);
  });
});

describe('the config file\'s paths', () => {
  const file = (when: unknown) => JSON.stringify({ environment: 'env_01ASK', periodics: { sessions: { 'Infra change': { prompt: 'p', when } } } });

  test('the object form of merges takes paths, read into the periodic\'s filters', () => {
    const read = readConfig(file({ merges: { count: 10, paths: ['dispatch/turn.mjs', 'dispatch/webhook/**'] } }));
    assert.ok(read.ok, read.ok ? '' : read.fault);
    assert.deepEqual(read.config.periodics, [{ name: 'Infra change', prompt: 'p', counts: { merges: 10 }, filters: { merges: { paths: ['dispatch/turn.mjs', 'dispatch/webhook/**'] } } }]);
  });

  test('the number form, and an object without paths, carry no filter', () => {
    for (const merges of [3, { count: 3 }]) {
      const read = readConfig(file({ merges }));
      assert.ok(read.ok, read.ok ? '' : read.fault);
      assert.deepEqual(read.config.periodics, [{ name: 'Infra change', prompt: 'p', counts: { merges: 3 } }]);
    }
  });

  test('a paths that is empty, holds an empty pattern, or sits on a measure other than merges makes the file invalid', () => {
    for (const when of [
      { merges: { count: 1, paths: [] } },
      { merges: { count: 1, paths: [''] } },
      { merges: { count: 1, paths: 'infra/**' } },
      { issuesOpened: { count: 1, paths: ['infra/**'] } },
      { issuesClosed: { count: 1, paths: ['infra/**'] } },
      { days: { count: 1, paths: ['infra/**'] } },
    ]) {
      const read = readConfig(file(when));
      assert.ok(!read.ok, JSON.stringify(when));
    }
  });
});
