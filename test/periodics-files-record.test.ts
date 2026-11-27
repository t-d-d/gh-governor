/**
 * The files record: one item for each merged pull request a `paths` limit
 * has read, so each one's files are read from GitHub once. A check reads
 * the records it has, reads from GitHub only the files of the merges it
 * has none for, and writes those. A merged pull request's files never
 * change, so the write needs no condition, and a lost item costs one read.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { duePeriodics, keptFilesOf, narrowOf, windowOf } from '../dispatch/periodics.mjs';
import { FILES_LISTED } from '../dispatch/checklist.mjs';
import { FILES_RECORD_MAX_BYTES, FILES_TTL_S, STATE_TTL_ATTRIBUTE, dynamoState } from '../dispatch/turn.mjs';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (n: number) => new Date(NOW - n * HOUR).toISOString();
const finished = async () => false;

type Row = { filename: string; status: string; previous?: string; additions: number; deletions: number };
type Kept = { files: Array<{ filename: string; previous?: string; additions: number; deletions: number }>; cut: boolean };
const fired = { at: hoursAgo(10), session: 'https://claude.ai/code/session_01RUN', baseline: false };

/** A repo whose merges each changed the files given, the first merged longest ago, and a state table holding the records given. */
const repoOf = (merges: Array<{ number: number, files: Row[] }>, held: Record<number, Kept> = {}, { readFails = false, writeFails = false } = {}) => {
  const fileReads: number[] = [];
  const recordReads: number[] = [];
  const written: Array<{ repo: string, number: number, record: Kept }> = [];
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
    periodic: async () => fired,
    recordPeriodic: async () => true,
    mergedFiles: async (repo: string, n: number) => {
      assert.equal(repo, REPO);
      recordReads.push(n);
      if (readFails) throw new Error('ProvisionedThroughputExceededException');
      return records.get(n) ?? null;
    },
    recordMergedFiles: async (repo: string, n: number, record: Kept) => {
      if (writeFails) throw new Error('AccessDeniedException');
      written.push({ repo, number: n, record });
      records.set(n, record);
    },
  };
  return { reader, state, fileReads, recordReads, written, records };
};
const changed = (...paths: string[]): Row[] => paths.map((filename) => ({ filename, status: 'modified', additions: 3, deletions: 1 }));
const keptOf = (rows: Row[], cut = false): Kept => ({ files: rows.map(({ filename, previous, additions, deletions }) => ({ filename, ...(previous === undefined ? {} : { previous }), additions, deletions })), cut });

const logs: Array<{ event: string, context?: Record<string, unknown> }> = [];
const log = (event: string, context?: Record<string, unknown>) => { logs.push({ event, ...(context === undefined ? {} : { context }) }); };

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

const infra = { name: 'Infra change', prompt: 'Review the infra change.', counts: { merges: 2 }, filters: { merges: { paths: ['infra/**'] } } };

describe('the files record behind a paths limit', () => {
  const five = [
    { number: 1, files: changed('infra/a.yml') },
    { number: 2, files: changed('docs/a.md') },
    { number: 3, files: changed('docs/b.md') },
    { number: 4, files: changed('infra/b.yml') },
    { number: 5, files: changed('infra/c.yml') },
  ];
  const fourHeld = () => Object.fromEntries(five.slice(0, 4).map((m) => [m.number, keptOf(m.files)]));

  test('a check whose window holds five merges, four with a record, reads one files list from GitHub and writes one record', async () => {
    const repo = repoOf(five, fourHeld());
    const { due } = await check(repo, [infra]);
    assert.deepEqual(repo.fileReads, [5]);
    assert.deepEqual(repo.written, [{ repo: REPO, number: 5, record: keptOf(five[4]!.files) }]);
    assert.deepEqual(due.map((d) => d.windows?.merges?.map((m) => m.number)), [[1, 4, 5]]);
  });

  test('a second check over the same window reads no files list from GitHub', async () => {
    const repo = repoOf(five, fourHeld());
    await check(repo, [infra]);
    repo.fileReads.length = 0;
    repo.written.length = 0;
    const { due } = await check(repo, [infra]);
    assert.deepEqual(repo.fileReads, []);
    assert.deepEqual(repo.written, []);
    assert.deepEqual(due.map((d) => d.windows?.merges?.map((m) => m.number)), [[1, 4, 5]]);
  });

  test('a record carries the paths, the renamed-from paths, the line counts and the cut-short mark', async () => {
    const moved: Row = { filename: 'attic/old.yml', status: 'renamed', previous: 'infra/old.yml', additions: 0, deletions: 0 };
    const edited: Row = { filename: 'docs/a.md', status: 'modified', additions: 12, deletions: 4 };
    const repo = repoOf([{ number: 7, files: [moved, edited] }]);
    await check(repo, [{ ...infra, counts: { merges: 1 } }]);
    assert.deepEqual(repo.written[0]?.record, {
      files: [{ filename: 'attic/old.yml', previous: 'infra/old.yml', additions: 0, deletions: 0 }, { filename: 'docs/a.md', additions: 12, deletions: 4 }],
      cut: false,
    });
    const many = Array.from({ length: FILES_LISTED }, (_, i) => `docs/page-${i}.md`);
    const long = repoOf([{ number: 8, files: changed(...many) }]);
    await check(long, [{ ...infra, counts: { merges: 1 } }]);
    assert.equal(long.written[0]?.record.cut, true);
  });

  test('a merge whose list is too large to keep counts as a match on the check that reads it, as on every later one', async () => {
    const long = 'x'.repeat(200);
    const rows = Array.from({ length: Math.ceil(FILES_RECORD_MAX_BYTES / 200) + 1 }, (_, i) => ({ filename: `docs/${long}/${i}.md`, status: 'modified', additions: 1, deletions: 0 }));
    const repo = repoOf([{ number: 1, files: rows }]);
    const first = await check(repo, [{ ...infra, counts: { merges: 1 } }]);
    assert.deepEqual(repo.written, [{ repo: REPO, number: 1, record: { files: [], cut: true } }]);
    assert.equal(first.due.length, 1);
  });

  test('a merge whose record carries the cut-short mark counts as a match', async () => {
    const repo = repoOf([{ number: 1, files: changed('docs/a.md') }], { 1: keptOf(changed('docs/a.md'), true) });
    const { due } = await check(repo, [{ ...infra, counts: { merges: 1 } }]);
    assert.deepEqual(repo.fileReads, []);
    assert.equal(due.length, 1);
  });

  test('a missing record is read from GitHub and written, and the periodic\'s count is the same as with it', async () => {
    const all = Object.fromEntries(five.map((m) => [m.number, keptOf(m.files)]));
    const withRecords = await check(repoOf(five, all), [infra]);
    const lost = repoOf(five);
    const without = await check(lost, [infra]);
    assert.deepEqual(lost.fileReads, [1, 2, 3, 4, 5]);
    assert.deepEqual(lost.written.map((w) => w.number), [1, 2, 3, 4, 5]);
    assert.deepEqual(without.due.map((d) => [d.by, d.windows?.merges?.map((m) => m.number)]), withRecords.due.map((d) => [d.by, d.windows?.merges?.map((m) => m.number)]));
  });

  test('a read of the records that fails refuses the periodic for the turn, and is not taken for a missing record', async () => {
    const repo = repoOf(five, {}, { readFails: true });
    const { due, unread } = await check(repo, [infra]);
    assert.deepEqual(due, []);
    assert.deepEqual(repo.fileReads, [], 'no files list is read in its place');
    assert.equal(unread.length, 1);
    assert.match(unread[0]!.error, /Infra change: ProvisionedThroughputExceededException/);
  });

  test('a write that fails is logged at warn and the count stands: a missing record costs one read next time', async () => {
    logs.length = 0;
    const repo = repoOf(five, fourHeld(), { writeFails: true });
    const { due, unread } = await check(repo, [infra]);
    assert.deepEqual(unread, []);
    assert.deepEqual(due.map((d) => d.windows?.merges?.map((m) => m.number)), [[1, 4, 5]]);
    const line = logs.find((l) => l.event === 'dispatch-files-unrecorded');
    assert.equal(line?.context?.level, 'warn');
    assert.equal(line?.context?.pr, 5);
    assert.match(String(line?.context?.error), /AccessDeniedException/);
  });

  test('the sweep and the periodics fire both keep the record', () => {
    for (const file of ['dispatch/sweep.mjs', 'dispatch/periodics-fire.mjs']) {
      const source = readFileSync(file, 'utf8');
      assert.match(source, /narrowOf\(reader, keptFilesOf\(ctx\.state, repo, ctx\.log\)\)/, file);
    }
  });
});

describe('the files record in the state table', () => {
  const RECORD: Kept = { files: [{ filename: 'attic/old.yml', previous: 'infra/old.yml', additions: 0, deletions: 0 }, { filename: 'docs/a.md', additions: 12, deletions: 4 }], cut: false };

  test('is the item files#<repo> / <number>, put with no condition, expiring 90 days on', async () => {
    const sent: Array<{ name: string; input: Record<string, any> }> = [];
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, any> }) => { sent.push({ name: command.constructor.name, input: command.input }); return {}; } };
    const state = dynamoState(client as never, 'T');
    const before = Math.floor(Date.now() / 1000);
    await state.recordMergedFiles(REPO, 42, RECORD);
    assert.equal(FILES_TTL_S, 90 * 24 * 60 * 60);
    assert.equal(sent[0]?.name, 'PutItemCommand');
    const input = sent[0]!.input;
    assert.equal(input.TableName, 'T');
    assert.equal(input.ConditionExpression, undefined, 'two writes of one record hold the same facts');
    assert.deepEqual({ pk: input.Item.pk, sk: input.Item.sk }, { pk: { S: 'files#acme/factory' }, sk: { S: '42' } });
    const ttl = Number(input.Item[STATE_TTL_ATTRIBUTE].N);
    assert.ok(ttl >= before + FILES_TTL_S && ttl <= Math.floor(Date.now() / 1000) + FILES_TTL_S, 'expires 90 days on');
  });

  test('reads back what it wrote, consistently; a missing item is null', async () => {
    const items = new Map<string, any>();
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
        if (command.constructor.name === 'PutItemCommand') { items.set(`${command.input.Item.pk.S} ${command.input.Item.sk.S}`, command.input.Item); return {}; }
        assert.equal(command.constructor.name, 'GetItemCommand');
        assert.equal(command.input.ConsistentRead, true);
        const item = items.get(`${command.input.Key.pk.S} ${command.input.Key.sk.S}`);
        return item === undefined ? {} : { Item: item };
      },
    };
    const state = dynamoState(client as never, 'T');
    assert.equal(await state.mergedFiles(REPO, 42), null);
    await state.recordMergedFiles(REPO, 42, RECORD);
    assert.deepEqual(await state.mergedFiles(REPO, 42), RECORD);
    await state.recordMergedFiles(REPO, 43, { files: [], cut: true });
    assert.deepEqual(await state.mergedFiles(REPO, 43), { files: [], cut: true });
  });

  test('a record too large for an item keeps only the cut-short mark, which counts as a match', async () => {
    const sent: Array<Record<string, any>> = [];
    const client = { send: async (command: { input: Record<string, any> }) => { sent.push(command.input); return {}; } };
    const state = dynamoState(client as never, 'T');
    const long = 'x'.repeat(200);
    const files = Array.from({ length: Math.ceil(FILES_RECORD_MAX_BYTES / 200) + 1 }, (_, i) => ({ filename: `${long}/${i}`, additions: 1, deletions: 0 }));
    await state.recordMergedFiles(REPO, 9, { files, cut: false });
    assert.equal(sent[0]?.Item.cut.BOOL, true);
    assert.equal(JSON.parse(sent[0]?.Item.files.S).length, 0);
  });

  test('a read that fails throws, and a malformed item is a failed read, never a missing one', async () => {
    const failing = dynamoState({ send: async () => { throw new Error('AccessDeniedException'); } } as never, 'T');
    await assert.rejects(failing.mergedFiles(REPO, 1), /AccessDeniedException/);
    for (const item of [
      { files: { S: 'not json' }, cut: { BOOL: false } },
      { files: { S: '[{"filename":"a"}]' }, cut: { BOOL: false } },
      { files: { S: '[]' } },
      { cut: { BOOL: false } },
    ]) {
      const malformed = dynamoState({ send: async () => ({ Item: { pk: { S: 'files#acme/factory' }, sk: { S: '1' }, ...item } }) } as never, 'T');
      await assert.rejects(malformed.mergedFiles(REPO, 1), /malformed/, JSON.stringify(item));
    }
    // The error names the item, not the whole of a list up to the size cap.
    const large = dynamoState({ send: async () => ({ Item: { pk: { S: 'files#acme/factory' }, sk: { S: '1' }, files: { S: `[${'x'.repeat(FILES_RECORD_MAX_BYTES)}` }, cut: { BOOL: false } } }) } as never, 'T');
    await assert.rejects(large.mergedFiles(REPO, 1), (error: Error) => /malformed/.test(error.message) && error.message.length < 2000);
  });
});
