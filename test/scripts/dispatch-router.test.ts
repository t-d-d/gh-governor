/**
 * What a schedule fire starts.
 *
 * The schedule case walks `scripts/lib/ready-work.mjs`'s ordered candidates
 * with async GitHub reads, and a fire can follow another within minutes (a
 * webhook burst, a run by hand beside the schedule), so an issue dispatched
 * recently is skipped even while its worker has not yet claimed it. The
 * record of a dispatch is a marker comment on the issue, which also carries
 * the session URL: the in-flight list lives in GitHub, not in a UI.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_WINDOW_MS, dispatchMarker } from '../../dispatch/webhook/fire.mjs';
import { planSchedule } from '../../scripts/lib/dispatch-router.mjs';
import { promptFor, sessionName } from '../../scripts/lib/dispatch-prompt.mjs';

/** The factory's labels: two ready labels, and the claim. */
const FACTORY_LABELS = { ready: ['workflow: ready for development', 'mode: afk'], claim: 'workflow: under development' };

const REPO = 'acme/factory';
const NOW = Date.parse('2026-09-25T12:00:00Z');

const issue = (number: number, labels: string[], over: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  created_at: `2026-09-${String(number).padStart(2, '0')}T00:00:00Z`,
  labels,
  ...over,
});

const READY = ['workflow: ready for development', 'mode: afk', 'type: bug'];

/** A reader over fixed rows, recording what was asked. */
const fakeReader = (rows: {
  issues: ReturnType<typeof issue>[];
  blockers?: Record<number, { number: number; state: string; title: string }[]>;
  blocking?: Record<number, { number: number; state: string; title: string }[]>;
  parents?: Record<number, { number: number; state: string; labels: string[] } | null>;
  comments?: Record<number, { id: number; body: string; created_at: string }[]>;
}) => {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      readyIssues: async () => rows.issues,
      blockers: async (n: number) => {
        asked.push(`blockers ${n}`);
        return rows.blockers?.[n] ?? [];
      },
      blocking: async (n: number) => {
        asked.push(`blocking ${n}`);
        return rows.blocking?.[n] ?? [];
      },
      parent: async (n: number) => {
        asked.push(`parent ${n}`);
        return rows.parents?.[n] ?? null;
      },
      comments: async (n: number, options?: { since?: string }) => {
        asked.push(`comments ${n}${options?.since ? ` since ${options.since}` : ''}`);
        return rows.comments?.[n] ?? [];
      },
    },
  };
};

describe('planSchedule', () => {
  test('picks the eligible issues in the selector\'s order, up to the cap', async () => {
    const { reader } = fakeReader({
      issues: [
        issue(5, ['workflow: ready for development', 'mode: afk', 'type: enhancement']),
        issue(7, READY),
        issue(9, ['workflow: ready for development', 'mode: hitl', 'type: bug']),
      ],
    });
    const plan = await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 2, now: NOW });
    assert.deepEqual(plan.map((d) => d.issue), [7, 5]);
    assert.equal(plan[0]?.prompt, promptFor(7, 'Issue 7', REPO, FACTORY_LABELS.claim));
    assert.equal(plan[0]?.sessionName, sessionName(7, 'Issue 7'));
  });

  test('skips an issue with an open blocker or a parked parent, asking only as far as the cap needs', async () => {
    const { reader, asked } = fakeReader({
      issues: [issue(3, READY), issue(4, READY), issue(6, READY), issue(8, READY)],
      blockers: { 3: [{ number: 1, state: 'open', title: 'Blocker' }] },
      parents: { 4: { number: 2, state: 'open', labels: ['type: prd'] } },
    });
    const plan = await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 1, now: NOW });
    assert.deepEqual(plan.map((d) => d.issue), [6]);
    // #8 is eligible and ranked after #6, so only an early stop at the cap
    // leaves it unread.
    assert.ok(!asked.some((a) => / 8\b/.test(a)), `asked about an issue past the cap: ${asked.join('; ')}`);
  });

  test('skips an issue dispatched inside the window, so a burst of fires starts one session', async () => {
    const at = new Date(NOW - 5 * 60_000).toISOString();
    const { reader, asked } = fakeReader({
      issues: [issue(3, READY), issue(4, READY)],
      comments: { 3: [{ id: 1, body: dispatchMarker({ at, sessionUrl: null }), created_at: at }] },
    });
    const plan = await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 1, now: NOW });
    assert.deepEqual(plan.map((d) => d.issue), [4]);
    // Only the window's comments are asked for: a marker older than the
    // window would not count, and a long thread's page would hide the newest.
    assert.ok(asked.includes(`comments 3 since ${new Date(NOW - DISPATCH_WINDOW_MS).toISOString()}`), asked.join('; '));
  });

  test('an issue dispatched before the window is selectable again: a session that never started is retried', async () => {
    const at = new Date(NOW - DISPATCH_WINDOW_MS - 60_000).toISOString();
    const { reader } = fakeReader({
      issues: [issue(3, READY)],
      comments: { 3: [{ id: 1, body: dispatchMarker({ at, sessionUrl: null }), created_at: at }] },
    });
    const plan = await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 1, now: NOW });
    assert.deepEqual(plan.map((d) => d.issue), [3]);
  });

  test('nothing eligible is an empty plan, not an error', async () => {
    const { reader } = fakeReader({ issues: [] });
    assert.deepEqual(await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 1, now: NOW }), []);
  });
});

/**
 * A fire the receiver queues for one issue labelled ready dispatches that
 * issue and no other: the full selection, cap included, is the sweep's,
 * and running it on every label change is how a batch of labels became a
 * batch of sessions twice over.
 */
describe('a targeted schedule fire', () => {
  test('planSchedule dispatches the named issue alone when it is selectable, and nothing when it is not', async () => {
    const { reader } = fakeReader({
      issues: [issue(3, READY), issue(4, READY), issue(6, READY)],
      blockers: { 4: [{ number: 1, state: 'open', title: 'Blocker' }] },
    });
    assert.deepEqual((await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 2, now: NOW, only: [6] })).map((d) => d.issue), [6]);
    assert.deepEqual(await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 2, now: NOW, only: [4] }), [], 'a blocked issue is not dispatched because it was labelled');
    assert.deepEqual(await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 2, now: NOW, only: [99] }), [], 'an issue the selection does not list is not dispatched');
  });

  test('planSchedule takes a list: the selectable ones in the selector\'s order, up to the cap', async () => {
    const { reader } = fakeReader({
      issues: [
        issue(5, ['workflow: ready for development', 'mode: afk', 'type: enhancement']),
        issue(3, READY),
        issue(4, READY),
        issue(6, READY),
        issue(8, READY),
      ],
      blockers: { 4: [{ number: 1, state: 'open', title: 'Blocker' }] },
    });
    assert.deepEqual((await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 5, now: NOW, only: [5, 4, 3, 99] })).map((d) => d.issue), [3, 5]);
    assert.deepEqual((await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 1, now: NOW, only: [5, 3] })).map((d) => d.issue), [3]);
    assert.deepEqual(await planSchedule({ sources: [{ reader, repo: REPO, labels: FACTORY_LABELS }], cap: 2, now: NOW, only: [] }), [], 'an empty list is nothing, not the sweep');
  });
});

/**
 * Every served repo's ready tickets in one queue: the selector's
 * order (type, then oldest) runs over all of them, each repo's tickets read
 * with its own labels and reader.
 */
describe('planSchedule over several repos', () => {
  const ASKME = 't-d-d/askme-mcp';
  const askme = { ready: ['mode: afk'], claim: 'claimed' };

  test('ranks every repo\'s tickets together, each through its own reader and labels', async () => {
    const factory = fakeReader({ issues: [issue(5, ['workflow: ready for development', 'mode: afk', 'type: enhancement']), issue(7, READY)] });
    const asked: string[][] = [];
    const other = fakeReader({ issues: [issue(2, ['mode: afk', 'type: bug']), issue(3, ['mode: afk', 'claimed', 'type: bug'])] });
    const reader = { ...other.reader, readyIssues: async (labels?: readonly string[]) => { asked.push([...(labels ?? [])]); return other.reader.readyIssues(); } };
    const plan = await planSchedule({
      sources: [{ reader: factory.reader, repo: REPO, labels: FACTORY_LABELS }, { reader, repo: ASKME, labels: askme }],
      cap: 3,
      now: NOW,
    });
    assert.deepEqual(plan.map((d) => `${d.repo}#${d.issue}`), [`${ASKME}#2`, `${REPO}#7`, `${REPO}#5`], 'bugs first, oldest first, across repos; a ticket carrying its repo\'s claim label is dropped');
    assert.deepEqual(asked, [['mode: afk']]);
    assert.equal(plan[0]?.prompt, promptFor(2, 'Issue 2', ASKME, 'claimed'));
    assert.match(plan[0]!.prompt, /`claimed` for you/);
  });

  test('each ticket opens with its own repo\'s pickup prompt, below the line naming it', async () => {
    const factory = fakeReader({ issues: [issue(7, READY)] });
    const other = fakeReader({ issues: [issue(2, ['mode: afk', 'type: bug'])] });
    const plan = await planSchedule({
      sources: [{ reader: factory.reader, repo: REPO, labels: FACTORY_LABELS }, { reader: other.reader, repo: ASKME, labels: askme, prompts: { pickup: 'Fix #{issue} in {repo}; it carries `{claim}`.' } }],
      cap: 2,
      now: NOW,
    });
    assert.equal(plan[0]?.prompt, "Pickup #2 'Issue 2'\n\nFix #2 in t-d-d/askme-mcp; it carries `claimed`.");
    assert.equal(plan[1]?.prompt, promptFor(7, 'Issue 7', REPO, FACTORY_LABELS.claim));
  });
});
