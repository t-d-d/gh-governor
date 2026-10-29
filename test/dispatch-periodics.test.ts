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
import { DAY_MS, duePeriodics, periodicPrompt } from '../dispatch/periodics.mjs';
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

  test('or saying this is the first run, where the record is the baseline', () => {
    const text = periodicPrompt('Run a retro.', { at: '2026-10-20T12:00:00.000Z', session: null, baseline: true });
    assert.equal(text, 'Run a retro.\n\nThis is the first run of this periodic that governor has a record of.');
  });
});

type Record_ = { at: string; session: string | null; baseline: boolean };

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
    const { due, unread } = await duePeriodics({ repo: REPO, periodics: [RETRO, { name: 'Daily', prompt: 'x', days: 1 }], state, now: NOW, log });
    assert.deepEqual(due.map((d) => d.periodic.name), ['Weekly retro']);
    assert.equal(due[0]?.due, NOW);
    assert.deepEqual(unread, []);
    assert.deepEqual(state.writes, []);
  });

  test('with no record, the baseline is now, and nothing is due', async () => {
    const state = store();
    const { due } = await duePeriodics({ repo: REPO, periodics: [RETRO], state, now: NOW, log });
    assert.deepEqual(due, []);
    assert.deepEqual(state.writes, [{ name: 'Weekly retro', record: { at: new Date(NOW).toISOString(), session: null, baseline: true } }]);
  });

  test('a read that fails refuses that periodic, and is never a missing record', async () => {
    const state = store({ 'Weekly retro': new Error('AccessDeniedException'), Daily: { at: ago(2), session: 's', baseline: false } });
    const { due, unread } = await duePeriodics({ repo: REPO, periodics: [RETRO, { name: 'Daily', prompt: 'x', days: 1 }], state, now: NOW, log });
    assert.deepEqual(due.map((d) => d.periodic.name), ['Daily']);
    assert.deepEqual(state.writes, []);
    assert.equal(unread.length, 1);
    assert.match(unread[0]!.error, /Weekly retro.*AccessDeniedException/);
  });

  test('a baseline write that fails is logged, and nothing starts', async () => {
    const state = { ...store(), recordPeriodic: async () => { throw new Error('ProvisionedThroughputExceeded'); } };
    logged.length = 0;
    const { due, unread } = await duePeriodics({ repo: REPO, periodics: [RETRO], state, now: NOW, log });
    assert.deepEqual(due, []);
    assert.equal(unread.length, 1);
    assert.ok(logged.some((l) => l.level === 'error' && /ProvisionedThroughputExceeded/.test(String(l.error))));
  });
});
