/**
 * Periodics: recurring sessions a repo lists in its config file, each with a
 * name, a prompt and a day limit. The schema and the prompt files are
 * dispatch/repo-config.mjs's; when one is due, its record and the line
 * governor writes under its prompt are dispatch/periodics.mjs's. The turn
 * that starts them is in test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, GENERIC_SWITCHES, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
import { DAY_MS, HOUR_MS, LISTED_MAX, SWEEP_GRACE_MS, duePeriodics, periodicPrompt, windowOf } from '../dispatch/periodics.mjs';
import { factoryFile } from './helpers/factory.ts';

const BASE = { environment: 'env_01ASK', labels: { ready: ['mode: afk'], claim: 'claimed' } };
const RETRO = { name: 'Weekly retro', prompt: 'Run a retro over the week.', days: 7 };
const file = (over: Record<string, unknown>) => JSON.stringify({ ...BASE, features: { periodics: true }, periodics: [RETRO], ...over });
const NOW = Date.parse('2026-10-27T12:00:00Z');
const REPO = 'acme/factory';

describe('the config file\'s periodics', () => {
  test('periodics is a switch', () => {
    assert.ok(GENERIC_SWITCHES.includes('periodics'));
  });

  test('a periodic has a name, a prompt and a day limit', () => {
    const read = readConfig(file({}));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.periodics, [RETRO]);
  });

  test('with the switch on, the file lists at least one periodic', () => {
    for (const over of [{ periodics: undefined }, { periodics: [] }]) {
      const read = readConfig(file(over));
      assert.ok(!read.ok, JSON.stringify(over));
      assert.match(read.fault, /periodics/);
    }
  });

  test('with the switch off, the file needs none, and a file valid today stays valid', () => {
    const read = readConfig(JSON.stringify({ ...BASE, features: { pickup: true } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.periodics, []);
  });

  test('names are unique in the file', () => {
    const read = readConfig(file({ periodics: [RETRO, { ...RETRO, prompt: 'Another.' }] }));
    assert.ok(!read.ok);
    assert.match(read.fault, /Weekly retro/);
  });

  test('a day limit is whole days, at least one, and required', () => {
    for (const days of [0, -1, 1.5, '7', undefined]) {
      const read = readConfig(file({ periodics: [{ ...RETRO, days }] }));
      assert.ok(!read.ok, String(days));
      assert.match(read.fault, /days/, String(days));
    }
    assert.ok(readConfig(file({ periodics: [{ ...RETRO, days: 1 }] })).ok);
  });

  test('a name is one line, and the prompt is text or a file', () => {
    for (const periodic of [{ ...RETRO, name: '' }, { ...RETRO, name: 'Weekly\nretro' }, { ...RETRO, prompt: '' }, { ...RETRO, prompt: { path: 'x.md' } }, { ...RETRO, prompt: { file: '../x.md' } }, { ...RETRO, extra: true }]) {
      assert.ok(!readConfig(file({ periodics: [periodic] })).ok, JSON.stringify(periodic));
    }
    assert.ok(readConfig(file({ periodics: [{ ...RETRO, prompt: { file: '.claude/retro.md' } }] })).ok);
  });

  test('a prompt file is read from the default branch, and a missing or empty one is a fault naming the periodic and path', async () => {
    const read = readConfig(file({ periodics: [{ ...RETRO, prompt: { file: '.claude/retro.md' } }] }));
    assert.ok(read.ok);
    const files: Record<string, string | null> = { '.claude/retro.md': '---\nname: retro\n---\n\nRun the retro.\n' };
    const resolved = await resolveFiles(read.config, async (path) => files[path] ?? null);
    assert.ok(resolved.ok, JSON.stringify(resolved));
    assert.deepEqual(resolved.config.periodics, [{ ...RETRO, prompt: 'Run the retro.' }]);
    for (const text of [null, '   \n']) {
      files['.claude/retro.md'] = text;
      const bad = await resolveFiles(read.config, async (path) => files[path] ?? null);
      assert.ok(!bad.ok);
      assert.match(bad.fault, /periodics\.Weekly retro\.prompt: \.claude\/retro\.md is (not on the default branch|empty)/);
    }
  });

  test('a read that fails is no missing file: it throws', async () => {
    const read = readConfig(file({ periodics: [{ ...RETRO, prompt: { file: '.claude/retro.md' } }] }));
    assert.ok(read.ok);
    await assert.rejects(resolveFiles(read.config, async () => { throw new Error('502'); }), /502/);
  });

  test('a periodic may add a count for merges, issues opened and issues closed, each a whole number of at least one, and a minimum gap in hours', () => {
    const counted = { ...RETRO, counts: { merges: 20, issuesOpened: 5, issuesClosed: 1 }, gapHours: 4 };
    const read = readConfig(file({ periodics: [counted] }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.periodics, [counted]);
    for (const periodic of [
      { ...RETRO, counts: { merges: 0 } },
      { ...RETRO, counts: { merges: 1.5 } },
      { ...RETRO, counts: { merges: '20' } },
      { ...RETRO, counts: { pushes: 3 } },
      { ...RETRO, counts: {} },
      { ...RETRO, gapHours: 0 },
      { ...RETRO, gapHours: 2.5 },
    ]) {
      assert.ok(!readConfig(file({ periodics: [periodic] })).ok, JSON.stringify(periodic));
    }
  });

  test('a periodic with counts still needs its day limit', () => {
    const { days: _days, ...dayless } = RETRO;
    const read = readConfig(file({ periodics: [{ ...dayless, counts: { merges: 20 } }] }));
    assert.ok(!read.ok);
    assert.match(read.fault, /days/);
  });

  test('the factory turns periodics on', () => {
    const read = readConfig(factoryFile(CONFIG_PATH));
    assert.ok(read.ok);
    assert.equal(read.config.features.periodics, true);
    assert.ok(read.config.periodics.length > 0);
  });
});

describe('periodicPrompt', () => {
  test('the periodic\'s prompt, then a line giving the last fire\'s time', () => {
    const text = periodicPrompt('Run a retro.', { at: '2026-10-20T12:00:00.000Z', session: 'https://claude.ai/code/session_01OLD', baseline: false });
    assert.equal(text, 'Run a retro.\n\nThis periodic last fired at 2026-10-20T12:00:00.000Z.');
  });

  test('or that its last day limit found nothing to do', () => {
    const text = periodicPrompt('Review.', { at: '2026-10-20T12:00:00.000Z', session: null, baseline: false, nothing: true });
    assert.equal(text, 'Review.\n\nThis periodic last came due at 2026-10-20T12:00:00.000Z with nothing to do, so it did not run then.');
  });

  test('then what was counted since the last fire\'s time, each item by number and title', () => {
    const text = periodicPrompt('Review.', { at: '2026-10-20T12:00:00.000Z', session: 's', baseline: false }, {
      merges: [{ number: 12, title: 'Grant the role', at: '2026-10-21T00:00:00Z' }, { number: 15, title: 'Two\nlines', at: '2026-10-22T00:00:00Z' }],
      issuesOpened: [],
    });
    assert.equal(text, [
      'Review.',
      '',
      'This periodic last fired at 2026-10-20T12:00:00.000Z.',
      '',
      'Pull requests merged into the default branch since 2026-10-20T12:00:00.000Z: 2',
      '- #12 Grant the role',
      '- #15 Two lines',
      '',
      'Issues opened since 2026-10-20T12:00:00.000Z: none',
    ].join('\n'));
  });

  test('a long list stops at its limit and says how many more', () => {
    const merges = Array.from({ length: LISTED_MAX + 3 }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, at: '2026-10-21T00:00:00Z' }));
    const text = periodicPrompt('Review.', { at: '2026-10-20T12:00:00.000Z', session: 's', baseline: false }, { merges });
    assert.match(text, new RegExp(`: ${LISTED_MAX + 3}\n`));
    assert.ok(text.includes(`- #${LISTED_MAX} PR ${LISTED_MAX}\n- and 3 more`));
    assert.ok(!text.includes(`#${LISTED_MAX + 1} `));
  });

  test('or saying this is the first run, where the record is the baseline', () => {
    const text = periodicPrompt('Run a retro.', { at: '2026-10-20T12:00:00.000Z', session: null, baseline: true });
    assert.equal(text, 'Run a retro.\n\nThis is the first run of this periodic that governor has a record of.');
  });
});

type Record_ = { at: string; session: string | null; baseline: boolean; nothing?: true; lastRun?: string };

/** Every last run's session reads finished: archived, or gone. */
const finished = async () => false;

/** The state table's periodic records, with the table's conditional write. */
const store = (initial: Record<string, Record_ | Error> = {}) => {
  const records = new Map<string, Record_ | Error>(Object.entries(initial));
  const writes: Array<{ name: string; record: Record_ }> = [];
  return {
    records,
    writes,
    periodic: async (_repo: string, name: string) => {
      const held = records.get(name);
      if (held instanceof Error) throw held;
      return held ?? null;
    },
    recordPeriodic: async (_repo: string, name: string, read: Record_ | null, record: Record_) => {
      const held = records.get(name) ?? null;
      if (JSON.stringify(held) !== JSON.stringify(read)) return false;
      records.set(name, record);
      writes.push({ name, record });
      return true;
    },
  };
};

describe('duePeriodics', () => {
  const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
  const logged: Array<Record<string, unknown>> = [];
  const log = (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); };

  test('one past its day limit since its last fire is due; one inside it is not', async () => {
    const state = store({ 'Weekly retro': { at: ago(7), session: 's', baseline: false }, Daily: { at: ago(0.5), session: 's', baseline: false } });
    const { due, unread } = await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO, { name: 'Daily', prompt: 'x', days: 1 }], state, now: NOW, log });
    assert.deepEqual(due.map((d) => d.periodic.name), ['Weekly retro']);
    assert.equal(due[0]?.due, NOW);
    assert.deepEqual(unread, []);
    assert.deepEqual(state.writes, []);
  });

  // The record holds the launch's time, minutes after the sweep read it.
  // The sweep a day limit later reads it a little short of the limit, and
  // must still fire it, or each run slips a sweep and the slips add up.
  test('the sweep nearest the day limit fires it: within half the two-hourly interval, never earlier', async () => {
    const minutes = (n: number) => n * 60 * 1000;
    const near = store({ 'Weekly retro': { at: new Date(NOW - 7 * DAY_MS + minutes(5)).toISOString(), session: 's', baseline: false } });
    assert.equal((await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO], state: near, now: NOW, log })).due.length, 1);
    const edge = store({ 'Weekly retro': { at: new Date(NOW - 7 * DAY_MS + minutes(60)).toISOString(), session: 's', baseline: false } });
    assert.equal((await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO], state: edge, now: NOW, log })).due.length, 1);
    const early = store({ 'Weekly retro': { at: new Date(NOW - 7 * DAY_MS + minutes(61)).toISOString(), session: 's', baseline: false } });
    assert.equal((await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO], state: early, now: NOW, log })).due.length, 0, 'the sweep after is nearer');
    assert.equal(SWEEP_GRACE_MS, minutes(60));
  });

  test('with no record, the baseline is now, and nothing is due', async () => {
    const state = store();
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO], state, now: NOW, log });
    assert.deepEqual(due, []);
    assert.deepEqual(state.writes, [{ name: 'Weekly retro', record: { at: new Date(NOW).toISOString(), session: null, baseline: true } }]);
  });

  test('a read that fails refuses that periodic, and is never a missing record', async () => {
    const state = store({ 'Weekly retro': new Error('AccessDeniedException'), Daily: { at: ago(2), session: 's', baseline: false } });
    const { due, unread } = await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO, { name: 'Daily', prompt: 'x', days: 1 }], state, now: NOW, log });
    assert.deepEqual(due.map((d) => d.periodic.name), ['Daily']);
    assert.deepEqual(state.writes, []);
    assert.equal(unread.length, 1);
    assert.match(unread[0]!.error, /Weekly retro.*AccessDeniedException/);
  });

  test('a baseline write that fails is logged, and nothing starts', async () => {
    const state = { ...store(), recordPeriodic: async () => { throw new Error('ProvisionedThroughputExceeded'); } };
    logged.length = 0;
    const { due, unread } = await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO], state, now: NOW, log });
    assert.deepEqual(due, []);
    assert.equal(unread.length, 1);
    assert.ok(logged.some((l) => l.level === 'error' && /ProvisionedThroughputExceeded/.test(String(l.error))));
  });
});

describe('duePeriodics — counts and the minimum gap', () => {
  const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
  const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR_MS).toISOString();
  const logged: Array<Record<string, unknown>> = [];
  const log = (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); };
  const REVIEW = { name: 'Code review', prompt: 'Review the merges.', days: 7, counts: { merges: 3 }, gapHours: 4 };
  const item = (number: number) => ({ number, title: `Item ${number}`, at: hoursAgo(1) });
  /** A window over fixed lists, recording each read. */
  const windows = (lists: Partial<Record<string, ReturnType<typeof item>[]>>) => {
    const reads: Array<{ kind: string; since: string }> = [];
    return { reads, window: async (kind: string, since: string) => { reads.push({ kind, since }); return lists[kind] ?? []; } };
  };

  test('an event fires a periodic once its count since the last fire reaches its number', async () => {
    const state = store({ 'Code review': { at: ago(1), session: 's', baseline: false } });
    const short = windows({ merges: [item(1), item(2)] });
    assert.deepEqual((await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: short.window, event: 'merges' })).due, []);
    assert.deepEqual(short.reads, [{ kind: 'merges', since: ago(1) }], 'read afresh, since the last fire');
    const reached = windows({ merges: [item(1), item(2), item(3)] });
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: reached.window, event: 'merges' });
    assert.deepEqual(due.map((d) => [d.periodic.name, d.windows]), [['Code review', { merges: [item(1), item(2), item(3)] }]]);
    assert.deepEqual(state.writes, []);
  });

  test('an event reads only the periodics that count its kind, and no day limit', async () => {
    const state = store({ 'Weekly retro': { at: ago(9), session: 's', baseline: false }, 'Code review': { at: ago(9), session: 's', baseline: false } });
    const read = windows({});
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO, REVIEW], state, now: NOW, log, window: read.window, event: 'issuesOpened' });
    assert.deepEqual(due, []);
    assert.deepEqual(read.reads, []);
    assert.deepEqual(state.writes, []);
  });

  test('once one count fires it, the prompt reads every count it keeps', async () => {
    const both = { ...REVIEW, counts: { merges: 3, issuesClosed: 10 } };
    const state = store({ 'Code review': { at: ago(1), session: 's', baseline: false } });
    const read = windows({ merges: [item(1), item(2), item(3)], issuesClosed: [item(4)] });
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [both], state, now: NOW, log, window: read.window, event: 'merges' });
    assert.deepEqual(due[0]?.windows, { merges: [item(1), item(2), item(3)], issuesClosed: [item(4)] });
  });

  test('a periodic never fires inside its minimum gap, and a count reached there fires on the first event or sweep after it', async () => {
    const reached = windows({ merges: [item(1), item(2), item(3)] });
    const inside = store({ 'Code review': { at: hoursAgo(3), session: 's', baseline: false } });
    assert.deepEqual((await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state: inside, now: NOW, log, window: reached.window, event: 'merges' })).due, []);
    assert.deepEqual((await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state: inside, now: NOW, log, window: reached.window })).due, []);
    assert.deepEqual(reached.reads, [], 'nothing read inside the gap');
    const after = store({ 'Code review': { at: hoursAgo(4), session: 's', baseline: false } });
    assert.equal((await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state: after, now: NOW, log, window: reached.window })).due.length, 1, 'the sweep after the gap');
    assert.equal((await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state: after, now: NOW, log, window: reached.window, event: 'merges' })).due.length, 1, 'the event after the gap');
  });

  test('a nothing-to-do record keeps the last run\'s time, and the gap runs from it', async () => {
    const reached = windows({ merges: [item(1), item(2), item(3)] });
    const long = { ...REVIEW, days: 1, gapHours: 48 };
    const after = store({ 'Code review': { at: hoursAgo(1), session: null, baseline: false, nothing: true, lastRun: hoursAgo(25) } });
    assert.deepEqual((await duePeriodics({ repo: REPO, open: finished, periodics: [long], state: after, now: NOW, log, window: reached.window, event: 'merges' })).due, [], 'inside the gap since the last run');
    const empty = windows({});
    const twice = store({ 'Code review': { at: ago(1), session: null, baseline: false, nothing: true, lastRun: ago(2) } });
    await duePeriodics({ repo: REPO, open: finished, periodics: [{ ...REVIEW, days: 1 }], state: twice, now: NOW, log, window: empty.window });
    assert.equal(twice.writes[0]?.record.lastRun, ago(2), 'carried over a second nothing to do');
  });

  test('a due periodic with counts is stamped as of the windows\' read, so nothing that lands before its launch is lost', async () => {
    const state = store({ 'Code review': { at: ago(1), session: 's', baseline: false } });
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: windows({ merges: [item(1), item(2), item(3)] }).window });
    assert.equal(due[0]?.asOf, new Date(NOW).toISOString());
    const plain = store({ 'Weekly retro': { at: ago(7), session: 's', baseline: false } });
    assert.equal((await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO], state: plain, now: NOW, log })).due[0]?.asOf, undefined, 'a day limit alone records its launch');
  });

  test('the gap holds a day limit too', async () => {
    const daily = { ...RETRO, days: 1, gapHours: 30 };
    const state = store({ 'Weekly retro': { at: hoursAgo(26), session: 's', baseline: false } });
    assert.deepEqual((await duePeriodics({ repo: REPO, open: finished, periodics: [daily], state, now: NOW, log })).due, []);
  });

  test('the gap is between runs: a baseline or a day limit with nothing to do opens none', async () => {
    const reached = windows({ merges: [item(1), item(2), item(3)] });
    for (const record of [{ at: hoursAgo(1), session: null, baseline: true }, { at: hoursAgo(1), session: null, baseline: false, nothing: true as const }] as Record_[]) {
      const state = store({ 'Code review': record });
      assert.equal((await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: reached.window, event: 'merges' })).due.length, 1, JSON.stringify(record));
    }
  });

  test('the sweep fires a count reached before the day limit', async () => {
    const state = store({ 'Code review': { at: ago(1), session: 's', baseline: false } });
    const read = windows({ merges: [item(1), item(2), item(3)] });
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: read.window });
    assert.deepEqual(due.map((d) => d.windows), [{ merges: [item(1), item(2), item(3)] }]);
  });

  test('at its day limit, a periodic with counts fires on whatever was counted, short of its number', async () => {
    const state = store({ 'Code review': { at: ago(7), session: 's', baseline: false } });
    const read = windows({ merges: [item(1)] });
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: read.window });
    assert.deepEqual(due.map((d) => d.windows), [{ merges: [item(1)] }]);
    assert.deepEqual(state.writes, []);
  });

  test('at its day limit, a periodic with counts whose window is empty starts nothing, and records nothing to do as its fire', async () => {
    const state = store({ 'Code review': { at: ago(7), session: 's', baseline: false } });
    const read = windows({});
    logged.length = 0;
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: read.window });
    assert.deepEqual(due, []);
    assert.deepEqual(state.writes, [{ name: 'Code review', record: { at: new Date(NOW).toISOString(), session: null, baseline: false, nothing: true, lastRun: ago(7) } }]);
    assert.ok(logged.some((l) => l.event === 'dispatch-periodic' && l.outcome === 'nothing to do'), JSON.stringify(logged));
  });

  test('a periodic with only a day limit always starts, and reads no window', async () => {
    const state = store({ 'Weekly retro': { at: ago(7), session: 's', baseline: false } });
    const read = windows({});
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [RETRO], state, now: NOW, log, window: read.window });
    assert.equal(due.length, 1);
    assert.equal(due[0]?.windows, undefined);
    assert.deepEqual(read.reads, []);
  });

  test('with no record, an event writes the baseline and starts nothing', async () => {
    const state = store();
    const read = windows({ merges: [item(1), item(2), item(3)] });
    const { due } = await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: read.window, event: 'merges' });
    assert.deepEqual(due, []);
    assert.deepEqual(state.writes, [{ name: 'Code review', record: { at: new Date(NOW).toISOString(), session: null, baseline: true } }]);
  });

  test('a window that cannot be read refuses that periodic for the turn, and is never an empty window', async () => {
    const state = store({ 'Code review': { at: ago(7), session: 's', baseline: false } });
    logged.length = 0;
    const { due, unread } = await duePeriodics({ repo: REPO, open: finished, periodics: [REVIEW], state, now: NOW, log, window: async () => { throw new Error('502 Bad Gateway'); } });
    assert.deepEqual(due, []);
    assert.deepEqual(state.writes, [], 'no nothing-to-do over a window it could not read');
    assert.match(unread[0]?.error ?? '', /Code review.*502/);
    assert.ok(logged.some((l) => l.event === 'dispatch-periodic-unread' && l.level === 'error'));
  });
});

describe('duePeriodics: the hold while the last run is open', () => {
  const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
  const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR_MS).toISOString();
  const logged: Array<Record<string, unknown>> = [];
  const log = (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); };
  const OLD = 'https://claude.ai/code/session_01OLD';
  const REVIEW = { name: 'Code review', prompt: 'Review the merges.', days: 7, counts: { merges: 3 } };
  const item = (number: number) => ({ number, title: `Item ${number}`, at: hoursAgo(1) });
  const merges = (n: number) => async () => Array.from({ length: n }, (_, i) => item(i + 1));
  /** Whether each session reads open, recording each read. */
  const sessions = (openOnes: string[]) => {
    const reads: string[] = [];
    return { reads, open: async (session: string) => { reads.push(session); return openOnes.includes(session); } };
  };

  test('a periodic due by its day limit, its last run\'s session still open, starts nothing and logs the fire held, naming that session', async () => {
    const state = store({ 'Weekly retro': { at: ago(7), session: OLD, baseline: false } });
    const read = sessions([OLD]);
    logged.length = 0;
    const { due, unread } = await duePeriodics({ repo: REPO, periodics: [RETRO], state, now: NOW, log, open: read.open });
    assert.deepEqual(due, []);
    assert.deepEqual(unread, []);
    assert.deepEqual(read.reads, [OLD]);
    assert.deepEqual(state.writes, [], 'a held fire leaves the last fire\'s time where it was');
    assert.ok(logged.some((l) => l.event === 'dispatch-periodic' && l.outcome === 'held' && l.periodic === 'Weekly retro' && l.session === OLD), JSON.stringify(logged));
  });

  test('a periodic due by its count is held too, and its count keeps growing until the first check after the run ends fires it', async () => {
    const state = store({ 'Code review': { at: ago(1), session: OLD, baseline: false } });
    const held = sessions([OLD]);
    assert.deepEqual((await duePeriodics({ repo: REPO, periodics: [REVIEW], state, now: NOW, log, open: held.open, window: merges(3), event: 'merges' })).due, []);
    assert.deepEqual((await duePeriodics({ repo: REPO, periodics: [REVIEW], state, now: NOW, log, open: held.open, window: merges(5), event: 'merges' })).due, []);
    assert.deepEqual(state.writes, []);
    const ended = sessions([]);
    const { due } = await duePeriodics({ repo: REPO, periodics: [REVIEW], state, now: NOW, log, open: ended.open, window: merges(6), event: 'merges' });
    assert.deepEqual(due.map((d) => [d.periodic.name, d.windows?.merges?.length, d.read.at]), [['Code review', 6, ago(1)]], 'counted since the fire before the hold');
  });

  test('a day limit on empty windows, its last run\'s session still open, is held too, and writes no nothing-to-do over that session', async () => {
    const state = store({ 'Code review': { at: ago(7), session: OLD, baseline: false } });
    const read = sessions([OLD]);
    logged.length = 0;
    const { due, unread } = await duePeriodics({ repo: REPO, periodics: [REVIEW], state, now: NOW, log, open: read.open, window: merges(0) });
    assert.deepEqual(due, []);
    assert.deepEqual(unread, []);
    assert.deepEqual(state.writes, [], 'a nothing-to-do record names no session, so the next count would start a second run over the open one');
    assert.ok(logged.some((l) => l.event === 'dispatch-periodic' && l.outcome === 'held' && l.session === OLD), JSON.stringify(logged));
  });

  test('a periodic not yet due reads no session', async () => {
    const state = store({ 'Weekly retro': { at: ago(2), session: OLD, baseline: false }, 'Code review': { at: ago(1), session: OLD, baseline: false } });
    const read = sessions([OLD]);
    await duePeriodics({ repo: REPO, periodics: [RETRO, REVIEW], state, now: NOW, log, open: read.open, window: merges(1) });
    assert.deepEqual(read.reads, []);
  });

  test('a run whose record has no session, from an unconfirmed launch, counts as finished', async () => {
    const state = store({ 'Weekly retro': { at: ago(7), session: null, baseline: false } });
    const read = sessions([]);
    const { due } = await duePeriodics({ repo: REPO, periodics: [RETRO], state, now: NOW, log, open: read.open });
    assert.equal(due.length, 1);
    assert.deepEqual(read.reads, [], 'no session to read');
  });

  test('a failed read of the session refuses that periodic for the turn, and is never taken for a finished run', async () => {
    const state = store({ 'Weekly retro': { at: ago(7), session: OLD, baseline: false }, Daily: { at: ago(2), session: null, baseline: false } });
    logged.length = 0;
    const { due, unread } = await duePeriodics({ repo: REPO, periodics: [RETRO, { name: 'Daily', prompt: 'x', days: 1 }], state, now: NOW, log, open: async () => { throw new Error('GET /v1/code/sessions/cse_01OLD: 503'); } });
    assert.deepEqual(due.map((d) => d.periodic.name), ['Daily']);
    assert.deepEqual(state.writes, []);
    assert.match(unread[0]?.error ?? '', /Weekly retro.*503/);
    assert.ok(logged.some((l) => l.event === 'dispatch-periodic-unread' && l.level === 'error' && l.periodic === 'Weekly retro'), JSON.stringify(logged));
  });
});

describe('windowOf', () => {
  const reader = () => {
    const calls: string[] = [];
    return {
      calls,
      reader: {
        defaultBranch: async () => { calls.push('defaultBranch'); return 'trunk'; },
        mergedSince: async (base: string, since: string) => { calls.push(`merged ${base} ${since}`); return []; },
        issuesOpenedSince: async (since: string) => { calls.push(`opened ${since}`); return []; },
        issuesClosedSince: async (since: string) => { calls.push(`closed ${since}`); return []; },
      },
    };
  };

  test('reads each kind through the repo\'s reader, merges into the default branch, read once', async () => {
    const { calls, reader: r } = reader();
    const window = windowOf(r);
    await window('merges', 'T1');
    await window('merges', 'T2');
    await window('issuesOpened', 'T1');
    await window('issuesClosed', 'T1');
    assert.deepEqual(calls, ['defaultBranch', 'merged trunk T1', 'merged trunk T2', 'opened T1', 'closed T1']);
  });

  test('a fire that names the default branch saves the read', async () => {
    const { calls, reader: r } = reader();
    await windowOf(r, 'main')('merges', 'T1');
    assert.deepEqual(calls, ['merged main T1']);
  });
});
