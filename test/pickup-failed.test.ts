/**
 * A launch that started nothing puts its ticket's failed-launch record,
 * `pickup-failed#<repo>` / `<issue>`, for an hour (dispatch/pickup.mjs).
 * The selection (`planSchedule`, scripts/lib/dispatch-router.mjs) skips a
 * ticket whose record stands, however its ready labels came back: governor
 * puts them back after the failure, and a ready label queues a selection
 * fire whoever added it (dispatch/webhook/route.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule } from '../scripts/lib/dispatch-router.mjs';
import { failedLaunchesOf, PICKUP_FAILED_HOLD_MS } from '../dispatch/pickup.mjs';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const LABELS = { ready: ['mode: afk'], claim: 'claimed', claimRemoves: ['mode: afk'], exclude: [] };
const UNTIL = new Date(NOW + 30 * 60 * 1000).toISOString();

const row = (number: number) => ({ number, title: `Issue ${number}`, body: '', state: 'open', labels: ['mode: afk'], created_at: `2026-09-${10 + number}T00:00:00Z`, openBlockers: 0, pull: false, association: 'MEMBER' });
const reader = { readyIssues: async () => [row(5), row(6)], ticket: async (n: number) => row(n), blockers: async () => [] };

describe('the selection skips a ticket whose launch failed inside the hour', () => {
  test('the sweep passes over it, and it takes no place under the cap', async () => {
    const heldFailed: unknown[] = [];
    const plan = await planSchedule({ sources: [{ repo: REPO, reader: reader as never, labels: LABELS, failed: new Map([[5, UNTIL]]) }], cap: 1, now: NOW, heldFailed: heldFailed as never });
    assert.deepEqual(plan.map((d) => d.issue), [6]);
    assert.deepEqual(heldFailed, [{ repo: REPO, issue: 5, until: UNTIL }]);
  });

  test('a fire naming the ticket starts nothing', async () => {
    const heldFailed: unknown[] = [];
    const plan = await planSchedule({ sources: [{ repo: REPO, reader: reader as never, labels: LABELS, failed: new Map([[5, UNTIL]]) }], cap: 1, now: NOW, only: [5], heldFailed: heldFailed as never });
    assert.deepEqual(plan, []);
    assert.deepEqual(heldFailed, [{ repo: REPO, issue: 5, until: UNTIL }]);
  });

  test('with no record, the ticket is picked up as before', async () => {
    const plan = await planSchedule({ sources: [{ repo: REPO, reader: reader as never, labels: LABELS }], cap: 1, now: NOW, only: [5] });
    assert.deepEqual(plan.map((d) => d.issue), [5]);
  });
});

describe('failedLaunchesOf', () => {
  test('reads the repo\'s records and keeps only those still standing', async () => {
    const asked: string[] = [];
    const state = { failedLaunches: async (repo: string) => { asked.push(repo); return [{ issue: 5, until: UNTIL }, { issue: 6, until: new Date(NOW).toISOString() }, { issue: 7, until: new Date(NOW - 1).toISOString() }]; } };
    const held = await failedLaunchesOf(state as never, REPO, NOW);
    assert.deepEqual(asked, [REPO]);
    assert.deepEqual([...held], [[5, UNTIL]]);
  });

  test('a read that fails throws: never read as no record', async () => {
    const state = { failedLaunches: async () => { throw new Error('AccessDeniedException'); } };
    await assert.rejects(failedLaunchesOf(state as never, REPO, NOW), /AccessDeniedException/);
  });

  test('the guard holds for an hour', () => {
    assert.equal(PICKUP_FAILED_HOLD_MS, 60 * 60 * 1000);
  });
});
