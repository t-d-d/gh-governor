/**
 * The wait label: with a repo's `waits.label` set, the hourly fire takes the
 * label off each open ticket whose `Blocked until:` date has passed. It
 * leaves it on a ticket whose date is still to come, whose line governor
 * cannot read, or that has no line, since a repo may use the same label for
 * waits a routine clears. Governor never adds the label.
 *
 * Where the turn runs the pass, before its sweep, is test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT_LABEL, WAIT_PROMPT, clearWaitLabels, waitPrompt } from '../dispatch/waits.mjs';
import { waitOf } from '../scripts/lib/ready-work.mjs';

const REPO = 'acme/factory';
const LABEL = 'waiting';
const NOW = Date.parse('2026-09-25T12:00:00Z');

type Row = { number: number; labels: string[]; wait?: ReturnType<typeof waitOf>['wait'] };

/** A ticket carrying the label, whose body is `body`. */
const row = (number: number, body: string): Row => ({ number, labels: [LABEL, 'enhancement'], ...waitOf(body) });

/** A reader listing `rows` for the label, recording each removal. */
const readerOf = (rows: Row[], over: Record<string, unknown> = {}) => {
  const asked: string[][] = [];
  const removed: Array<{ issue: number; label: string }> = [];
  const reader = {
    readyIssues: async (labels: readonly string[]) => { asked.push([...labels]); return rows; },
    removeLabel: async (issue: number, label: string) => { removed.push({ issue, label }); },
    ...over,
  };
  return { reader, asked, removed };
};

const logged: Array<{ event: string; context: Record<string, unknown> | undefined }> = [];
const log = (event: string, context?: Record<string, unknown>) => { logged.push({ event, context }); };

describe('clearWaitLabels: the hourly fire\'s pass over a repo\'s wait label', () => {
  test('takes the label off a ticket whose date has passed, and lists the tickets by the label alone', async () => {
    const { reader, asked, removed } = readerOf([row(7, 'Blocked until: 2026-09-20\n\nThe rest.')]);
    const result = await clearWaitLabels({ reader, repo: REPO, label: LABEL, now: NOW, log });
    assert.deepEqual(asked, [[LABEL]]);
    assert.deepEqual(removed, [{ issue: 7, label: LABEL }]);
    assert.deepEqual(result, { cleared: [7], unread: [] });
  });

  test('a time of day that has passed today frees it; one still to come today does not', async () => {
    const { reader, removed } = readerOf([row(7, 'Blocked until: 2026-09-25 11:00'), row(8, 'Blocked until: 2026-09-25 13:00')]);
    await clearWaitLabels({ reader, repo: REPO, label: LABEL, now: NOW, log });
    assert.deepEqual(removed.map((r) => r.issue), [7]);
  });

  test('leaves the label on a date still to come, an unreadable line, a relative line and no line', async () => {
    const { reader, removed } = readerOf([
      row(7, 'Blocked until: 2026-10-01'),
      row(8, 'Blocked until: next week'),
      row(9, 'Blocked until: 3 days after #12 closes'),
      row(10, 'Waits on the vendor.'),
    ]);
    const result = await clearWaitLabels({ reader, repo: REPO, label: LABEL, now: NOW, log });
    assert.deepEqual(removed, []);
    assert.deepEqual(result, { cleared: [], unread: [] });
  });

  test('a list that cannot be read is logged at error and returned as unread; nothing is removed', async () => {
    logged.length = 0;
    const { reader, removed } = readerOf([], { readyIssues: async () => { throw new Error('HTTP 502'); } });
    const result = await clearWaitLabels({ reader, repo: REPO, label: LABEL, now: NOW, log });
    assert.deepEqual(removed, []);
    assert.equal(result.unread.length, 1);
    assert.match(result.unread[0]!.error, /HTTP 502/);
    assert.equal(logged.at(-1)?.context?.level, 'error');
  });

  test('a removal that fails is logged and returned as unread, and the others still go', async () => {
    const removed: number[] = [];
    const { reader } = readerOf([row(7, 'Blocked until: 2026-09-20'), row(8, 'Blocked until: 2026-09-21')], {
      removeLabel: async (issue: number) => { if (issue === 7) throw new Error('HTTP 500'); removed.push(issue); },
    });
    const result = await clearWaitLabels({ reader, repo: REPO, label: LABEL, now: NOW, log });
    assert.deepEqual(removed, [8]);
    assert.deepEqual(result.cleared, [8]);
    assert.equal(result.unread.length, 1);
    assert.match(result.unread[0]!.error, /#7/);
  });

  test('a label already gone (404) counts as cleared', async () => {
    const { reader } = readerOf([row(7, 'Blocked until: 2026-09-20')], {
      removeLabel: async () => { throw Object.assign(new Error('Label does not exist'), { status: 404 }); },
    });
    const result = await clearWaitLabels({ reader, repo: REPO, label: LABEL, now: NOW, log });
    assert.deepEqual(result, { cleared: [7], unread: [] });
  });

  test('each outcome is logged under one event', async () => {
    logged.length = 0;
    const { reader } = readerOf([row(7, 'Blocked until: 2026-09-20')]);
    await clearWaitLabels({ reader, repo: REPO, label: LABEL, now: NOW, log });
    assert.deepEqual(logged.map((l) => l.event), [WAIT_LABEL]);
    assert.equal(logged[0]?.context?.issue, 7);
  });
});

describe('waitPrompt: the line every session is told about making a ticket wait', () => {
  test('without a label it is the plain line', () => {
    assert.equal(waitPrompt(undefined), WAIT_PROMPT);
  });

  test('with a label it names it, and says governor takes it off at the date', () => {
    const said = waitPrompt(LABEL);
    assert.ok(said.startsWith(WAIT_PROMPT), said);
    assert.ok(said.includes(`\`${LABEL}\``), said);
  });
});
