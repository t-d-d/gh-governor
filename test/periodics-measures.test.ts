/**
 * A periodic's measures: one table (dispatch/webhook/measures.mjs) holds
 * each thing a limit can count, the webhook events that wake it, how its
 * window is read, its wording under the prompt and on the heartbeat, and
 * the filters its object form takes. The schema's keys, the receiver's
 * periodics fires, the fire's parser, the window reads and the prompt all
 * come from it, so a new measure is one entry.
 *
 * A check reads each measure's list once, from the oldest last fire among
 * the periodics it reads, and each limit counts the rows after its own.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEASURES, measureNames } from '../dispatch/webhook/measures.mjs';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { parseFire } from '../dispatch/webhook/fire.mjs';
import { duePeriodics, periodicPrompt, windowOf } from '../dispatch/periodics.mjs';
import { HEARTBEAT_MARKER, readHeartbeat, stampHeartbeat } from '../dispatch/heartbeat.mjs';

const REPO = 'acme/factory';
const OWNERS = ['acme'];
const NOW = Date.parse('2026-10-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (n: number) => new Date(NOW - n * HOUR).toISOString();
const member = { login: 't-d-d', type: 'User' };
const repository = { full_name: REPO, default_branch: 'main' };
const issue = { number: 717, title: 'A ticket', body: 'The work.', user: member, author_association: 'OWNER', labels: [], state: 'open', html_url: `https://github.com/${REPO}/issues/717` };
const finished = async () => false;
const log = () => {};

type Record_ = { at: string; session: string | null; baseline: boolean };
const store = (initial: Record<string, Record_>) => ({
  periodic: async (_repo: string, name: string) => initial[name] ?? null,
  recordPeriodic: async () => true,
});

/** The files that once each kept a list of measures. */
const READERS = [
  'dispatch/webhook/route.mjs',
  'dispatch/webhook/fire.mjs',
  'dispatch/periodics.mjs',
  'dispatch/periodics-fire.mjs',
  'dispatch/sweep.mjs',
  'dispatch/repo-config.mjs',
  'dispatch/heartbeat.mjs',
];

describe('fitness: a measure is one entry in the measures table, and nothing else names one (hooks-and-routines.md)', () => {
  test('no file that reads the table names a measure of its own, as a string or a key', () => {
    for (const path of READERS) {
      const text = readFileSync(path, 'utf8');
      for (const name of measureNames()) {
        const quoted = new RegExp(`(['"\`])${name}\\1`);
        const keyed = new RegExp(`^\\s*${name}\\s*:`, 'm');
        assert.ok(!quoted.test(text), `${path} names the measure ${name} as a string`);
        assert.ok(!keyed.test(text), `${path} names the measure ${name} as a key`);
      }
    }
  });

  test('the committed schema\'s when takes the table\'s measures and the time limits, and nothing else', () => {
    const schema = readFileSync('schema/governor.schema.json', 'utf8');
    const whens: string[][] = [];
    JSON.parse(schema, (key, value) => {
      // A periodic's when, which holds its time limits; an issue review's when is another thing.
      if (key === 'when' && value?.properties?.days !== undefined) whens.push(Object.keys(value.properties).sort());
      return value;
    });
    assert.ok(whens.length > 0, 'the schema has a periodic\'s when');
    for (const keys of whens) assert.deepEqual(keys, ['days', 'hours', ...measureNames()].sort());
  });

  test('the fire\'s parser takes the table\'s measures as counted, and refuses any other', () => {
    for (const name of measureNames()) assert.equal((parseFire({ kind: 'periodics', counted: name, repo: REPO }) as { counted: string }).counted, name);
    assert.throws(() => parseFire({ kind: 'periodics', counted: 'pushes', repo: REPO }), /counted/);
  });

  test('the receiver queues a periodics fire only for a measure in the table', () => {
    const deliveries: Array<[string, unknown]> = [
      ['pull_request', { action: 'closed', pull_request: { number: 724, title: 'A change', body: 'x', user: member, author_association: 'OWNER', merged: true, merge_commit_sha: '3'.repeat(40), base: { ref: 'main' }, head: { ref: 'claude/x', sha: 'a'.repeat(40) } }, sender: member, repository }],
      ['issues', { action: 'opened', issue, sender: member, repository }],
      ['issues', { action: 'closed', issue: { ...issue, state: 'closed' }, sender: member, repository }],
      ['issues', { action: 'reopened', issue, sender: member, repository }],
    ];
    for (const [event, payload] of deliveries) {
      for (const f of routeEvent({ event, payload, owners: OWNERS }).fires.filter((q) => q.fire.kind === 'periodics')) {
        assert.ok(measureNames().includes((f.fire as { counted: string }).counted), JSON.stringify(f.fire));
      }
    }
  });

  test('each entry holds its events, its window, its wording and its filters', () => {
    for (const m of MEASURES) {
      assert.equal(typeof m.wakes, 'function', m.name);
      assert.equal(typeof m.read, 'function', m.name);
      assert.ok(m.heading.length > 0 && m.describe.length > 0, m.name);
      assert.equal(m.line.length, 2, m.name);
      for (const [name, filter] of Object.entries(m.filters)) {
        assert.ok(filter.describe.length > 0, `${m.name}.${name} says what it does`);
        assert.equal(typeof filter.heading, 'function', `${m.name}.${name} says how the prompt names it`);
        assert.equal(typeof filter.keep, 'function', `${m.name}.${name} says which rows it keeps`);
      }
    }
  });

  test('merges declares paths, and no other measure does', () => {
    assert.deepEqual(MEASURES.map((m) => [m.name, Object.keys(m.filters)]), [['merges', ['paths']], ['issuesOpened', []], ['issuesClosed', []]]);
  });

  test('no file that reads the table names a filter of its own, as a string or a key', () => {
    const filters = [...new Set(MEASURES.flatMap((m) => Object.keys(m.filters)))];
    for (const path of READERS) {
      const text = readFileSync(path, 'utf8');
      for (const name of filters) {
        assert.ok(!new RegExp(`(['"\`])${name}\\1`).test(text), `${path} names the filter ${name} as a string`);
        assert.ok(!new RegExp(`^\\s*${name}\\s*:`, 'm').test(text), `${path} names the filter ${name} as a key`);
      }
    }
  });

  test('the committed schema\'s merges takes paths in its object form', () => {
    const schema = readFileSync('schema/governor.schema.json', 'utf8');
    let found = false;
    JSON.parse(schema, (key, value) => {
      if (key === 'when' && value?.properties?.days !== undefined) {
        const object = value.properties.merges.anyOf.find((s: { type?: string }) => s.type === 'object');
        assert.deepEqual(Object.keys(object.properties), ['count', 'paths']);
        assert.equal(value.properties.issuesOpened.anyOf.find((s: { type?: string }) => s.type === 'object').properties.paths, undefined);
        found = true;
      }
      return value;
    });
    assert.ok(found);
  });
});

describe('a measure added to the table alone', () => {
  const FAKE = {
    name: 'issuesReopened',
    wakes: (event: string, payload: { action?: string }) => (event === 'issues' && payload?.action === 'reopened' ? {} : null),
    read: (reader: { issuesReopenedSince: (since: string) => Promise<unknown[]> }, since: string) => reader.issuesReopenedSince(since),
    heading: 'Issues reopened',
    describe: 'Issues reopened since the last fire.',
    line: ['issue reopened', 'issues reopened'],
    filters: {},
  };
  const withFake = async (run: () => Promise<void> | void) => {
    (MEASURES as unknown[]).push(FAKE);
    try {
      await run();
    } finally {
      (MEASURES as unknown[]).pop();
    }
  };

  test('the receiver queues a periodics fire for its event, and the parser takes it', () => withFake(() => {
    const { fires } = routeEvent({ event: 'issues', payload: { action: 'reopened', issue, sender: member, repository }, owners: OWNERS });
    const counted = fires.filter((f) => f.fire.kind === 'periodics').map((f) => f.fire);
    assert.deepEqual(counted, [{ kind: 'periodics', counted: 'issuesReopened', repo: REPO }]);
    assert.deepEqual(parseFire(counted[0]), { kind: 'periodics', counted: 'issuesReopened', repo: REPO });
  }));

  test('the check reads its window, and the prompt lists it', () => withFake(async () => {
    const reads: string[] = [];
    const reader = {
      defaultBranch: async () => 'main',
      mergedSince: async () => [],
      issuesOpenedSince: async () => [],
      issuesClosedSince: async () => [],
      issuesReopenedSince: async (since: string) => { reads.push(since); return [{ number: 9, title: 'Back again', at: hoursAgo(1) }]; },
    };
    const periodic = { name: 'Reopen review', prompt: 'Look at what came back.', counts: { issuesReopened: 1 } };
    const read = { at: hoursAgo(5), session: 's', baseline: false };
    const { due } = await duePeriodics({ repo: REPO, periodics: [periodic as never], state: store({ 'Reopen review': read }), now: NOW, log, window: windowOf(reader as never), busy: finished, event: 'issuesReopened' as never });
    assert.deepEqual(reads, [hoursAgo(5)]);
    assert.equal(due.length, 1);
    const prompt = periodicPrompt(periodic.prompt, read, due[0]!.windows);
    assert.match(prompt, new RegExp(`Issues reopened since ${hoursAgo(5)}: 1\\n- #9 Back again`));
  }));

  test('the heartbeat writes its line in its own words, and reads it back', () => withFake(() => {
    const line = { name: 'Reopen review', at: hoursAgo(1), by: { count: 'issuesReopened', number: 3 }, session: 'https://claude.ai/code/session_01RUN', state: 'open' };
    const body = stampHeartbeat(`${HEARTBEAT_MARKER}\n`, { periodics: [line as never] });
    assert.match(body, /, by 3 issues reopened, /);
    assert.deepEqual(readHeartbeat(body).periodics, [line]);
  }));
});

describe('one list read shared by every limit', () => {
  const item = (number: number, hours: number) => ({ number, title: `Merge ${number}`, at: hoursAgo(hours) });

  test('two periodics that count merges, with different last fires, make one read, and each counts the rows after its own last fire', async () => {
    const reads: Array<{ kind: string; since: string }> = [];
    const merged = [item(1, 9), item(2, 7), item(3, 3), item(4, 2)];
    const window = async (kind: string, since: string) => {
      reads.push({ kind, since });
      return merged.filter((m) => Date.parse(m.at) > Date.parse(since));
    };
    const early = { name: 'Early', prompt: 'p', counts: { merges: 4 } };
    const late = { name: 'Late', prompt: 'p', counts: { merges: 2 } };
    const state = store({ Early: { at: hoursAgo(10), session: 's', baseline: false }, Late: { at: hoursAgo(5), session: 's', baseline: false } });
    const { due } = await duePeriodics({ repo: REPO, periodics: [early, late] as never, state, now: NOW, log, window: window as never, busy: finished, event: 'merges' as never });
    assert.deepEqual(reads, [{ kind: 'merges', since: hoursAgo(10) }], 'one read, from the oldest last fire');
    assert.deepEqual(due.map((d) => [d.periodic.name, d.windows?.merges?.map((m) => m.number)]), [['Early', [1, 2, 3, 4]], ['Late', [3, 4]]]);
  });

  test('the sweep shares the read too, and a periodic with no record gets its baseline and reads nothing', async () => {
    const reads: Array<{ kind: string; since: string }> = [];
    const window = async (kind: string, since: string) => { reads.push({ kind, since }); return [item(1, 1)]; };
    const a = { name: 'A', prompt: 'p', counts: { merges: 1 } };
    const b = { name: 'B', prompt: 'p', counts: { merges: 1 } };
    const fresh = { name: 'Fresh', prompt: 'p', counts: { merges: 1 } };
    const state = store({ A: { at: hoursAgo(4), session: 's', baseline: false }, B: { at: hoursAgo(2), session: 's', baseline: false } });
    const { due } = await duePeriodics({ repo: REPO, periodics: [a, b, fresh] as never, state, now: NOW, log, window: window as never, busy: finished });
    assert.deepEqual(reads, [{ kind: 'merges', since: hoursAgo(4) }]);
    assert.deepEqual(due.map((d) => d.periodic.name), ['A', 'B']);
  });

  test('on an event\'s turn, another measure\'s list starts from the oldest last fire among the periodics the event brings due', async () => {
    const reads: Array<{ kind: string; since: string }> = [];
    const lists: Record<string, ReturnType<typeof item>[]> = { merges: [item(1, 1)], issuesOpened: [item(2, 1)] };
    const window = async (kind: string, since: string) => { reads.push({ kind, since }); return lists[kind] ?? []; };
    const slow = { name: 'Slow', prompt: 'p', counts: { merges: 500, issuesOpened: 5 } };
    const quick = { name: 'Quick', prompt: 'p', counts: { merges: 1, issuesOpened: 1 } };
    const state = store({ Slow: { at: hoursAgo(1400), session: 's', baseline: false }, Quick: { at: hoursAgo(2), session: 's', baseline: false } });
    const { due } = await duePeriodics({ repo: REPO, periodics: [slow, quick] as never, state, now: NOW, log, window: window as never, busy: finished, event: 'merges' as never });
    assert.deepEqual(due.map((d) => d.periodic.name), ['Quick']);
    assert.deepEqual(reads, [{ kind: 'merges', since: hoursAgo(1400) }, { kind: 'issuesOpened', since: hoursAgo(2) }]);
  });

  test('a shared read that fails refuses every periodic that counts on it', async () => {
    const window = async () => { throw new Error('GitHub refused the list'); };
    const a = { name: 'A', prompt: 'p', counts: { merges: 1 } };
    const b = { name: 'B', prompt: 'p', counts: { merges: 1 } };
    const state = store({ A: { at: hoursAgo(4), session: 's', baseline: false }, B: { at: hoursAgo(2), session: 's', baseline: false } });
    const { due, unread } = await duePeriodics({ repo: REPO, periodics: [a, b] as never, state, now: NOW, log, window: window as never, busy: finished, event: 'merges' as never });
    assert.deepEqual(due, []);
    assert.equal(unread.length, 2);
  });
});
