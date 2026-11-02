/**
 * `launchPlan` (dispatch/launch-plan.mjs) starts what a planner planned: it
 * claims each picked-up ticket, starts its session through the launcher's
 * `start`, moves the launch's record through `started`, and then marks the
 * ticket or releases it. A failed launch that holds its repo skips the
 * repo's later launches, the launch window cuts the rest, and the plan's
 * `done` hears what ran and what was left. A claim no marker covers is
 * logged stranded, whatever the loop threw. These tests hand it a plan and
 * fakes, not the turn harness.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_STRANDED, REPO_SKIPPED, ROUTINE_REFUSED, SCHEDULE_LAUNCH_WINDOW_MS, launchPlan } from '../dispatch/launch-plan.mjs';
import { readConfig } from '../dispatch/repo-config.mjs';
import { factoryFile } from './helpers/factory.ts';

const REPO = 'acme/factory';
const OTHER = 'acme/other';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const CONFIG = (() => {
  const read = readConfig(factoryFile('.github/dispatch.json'));
  assert.ok(read.ok);
  return read.config;
})();
const { ready: READY, claim: CLAIM } = CONFIG.labels;
const URL_OF = (n: number) => `https://claude.ai/code/session_${n}`;

type Logged = { event: string } & Record<string, unknown>;
type Write = { repo: string, op: string, issue?: number, labels?: string[], label?: string, text?: string };
type Started = { outcome: string, sessionUrl: string | null, status: number | null, output: string, refused?: boolean, missing?: string[] };

/** A `TurnContext` with fakes, and what `launchPlan` did through it. */
const context = (over: {
  labels?: (repo: string, issue: number) => string[],
  launched?: (asked: Record<string, unknown>) => Started,
  failWrite?: (write: Write) => boolean,
} = {}) => {
  const logged: Logged[] = [];
  const writes: Write[] = [];
  const asked: Array<Record<string, unknown>> = [];
  const write = async (w: Write) => {
    writes.push(w);
    if (over.failWrite?.(w) === true) throw new Error(`${w.op} refused`);
  };
  const ctx = {
    readerFor: async (repo: string) => ({
      ticket: async (issue: number) => ({ number: issue, title: `Issue ${issue}`, body: '', state: 'open', labels: over.labels?.(repo, issue) ?? READY, pull: false, openBlockers: 0 }),
      blockers: async () => [],
      ensureLabel: (label: string) => write({ repo, op: 'ensure', label }),
      addLabels: (issue: number, labels: string[]) => write({ repo, op: 'add', issue, labels }),
      removeLabel: (issue: number, label: string) => write({ repo, op: 'remove', issue, label }),
      comment: (issue: number, text: string) => write({ repo, op: 'comment', issue, text }),
    }),
    configOf: () => CONFIG,
    start: async (a: Record<string, unknown>) => {
      asked.push(a);
      return over.launched?.(a) ?? { outcome: 'dispatched', sessionUrl: URL_OF(Number(a.issue ?? 0)), status: 0, output: '' };
    },
    claims: new Set<string>(),
    now: () => NOW,
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
  };
  return { ctx: ctx as unknown as Parameters<typeof launchPlan>[1], logged, writes, asked };
};

/** A planned launch of a picked-up ticket. */
const ticket = (issue: number, repo = REPO, extra: Record<string, unknown> = {}) => ({
  repo, issue, claim: true, holdsRepo: true, asked: { prompt: `work on #${issue}`, sessionName: `ticket-${issue}`, issue }, ...extra,
});

type Plan = Parameters<typeof launchPlan>[0];

/** A plan of `launches`, with `done` where given. */
const plan = (launches: unknown[], done?: (ran: { dispatched: unknown[], left: unknown[] }) => Promise<void>) => ({ launches, unread: [], ...(done === undefined ? {} : { done }) }) as unknown as Plan;

describe('launchPlan starts every launch a plan holds', () => {
  test('a picked-up ticket is claimed, launched on its repo, recorded, and marked', async () => {
    const { ctx, logged, writes, asked } = context();
    const started: Array<{ outcome: Started, firedAt: string }> = [];
    const ran = await launchPlan(plan([ticket(5, REPO, { started: async (outcome: Started, firedAt: string) => { started.push({ outcome, firedAt }); } })]), ctx, NOW);
    assert.deepEqual(writes.slice(0, 3), [
      { repo: REPO, op: 'ensure', label: CLAIM },
      { repo: REPO, op: 'add', issue: 5, labels: [CLAIM] },
      ...CONFIG.labels.claimRemoves.map((label) => ({ repo: REPO, op: 'remove', issue: 5, label })),
    ]);
    assert.deepEqual(asked, [{ prompt: 'work on #5', sessionName: 'ticket-5', issue: 5, repo: REPO }]);
    assert.equal(started.length, 1);
    assert.equal(started[0]!.firedAt, new Date(NOW).toISOString());
    const marker = writes.at(-1)!;
    assert.equal(marker.op, 'comment');
    assert.match(marker.text!, new RegExp(URL_OF(5)));
    assert.ok(logged.some((l) => l.event === 'dispatch-launch' && l.issue === 5 && l.sessionUrl === URL_OF(5) && l.sessionName === 'ticket-5'));
    assert.deepEqual(ran.map(({ repo, issue, outcome, sessionUrl }) => ({ repo, issue, outcome, sessionUrl })), [{ repo: REPO, issue: 5, outcome: 'dispatched', sessionUrl: URL_OF(5) }]);
    assert.equal(ctx.claims.size, 0);
    assert.ok(!logged.some((l) => l.event === CLAIM_STRANDED));
  });

  test('a spec session is not claimed, and its ticket is still marked', async () => {
    const { ctx, writes } = context();
    await launchPlan(plan([ticket(6, REPO, { claim: false, holdsRepo: false })]), ctx, NOW);
    assert.deepEqual(writes.map((w) => w.op), ['comment']);
  });

  test('a ticket no longer ready is skipped untouched: no launch, and nothing in what ran', async () => {
    const { ctx, writes, asked, logged } = context({ labels: () => [CLAIM] });
    const ran = await launchPlan(plan([ticket(7)]), ctx, NOW);
    assert.deepEqual(writes, []);
    assert.deepEqual(asked, []);
    assert.deepEqual(ran, []);
    assert.ok(logged.some((l) => l.event === 'dispatch-claim' && l.outcome === 'skipped' && l.issue === 7));
  });

  test('a claim that fails is released, starts nothing, and reaches done as failed', async () => {
    const { ctx, writes, asked } = context({ failWrite: (w) => w.op === 'add' && w.labels?.[0] === CLAIM });
    let heard: { dispatched: unknown[], left: unknown[] } | undefined;
    const ran = await launchPlan(plan([ticket(8)], async (r) => { heard = r; }), ctx, NOW);
    assert.deepEqual(asked, []);
    assert.ok(writes.some((w) => w.op === 'remove' && w.label === CLAIM), JSON.stringify(writes));
    assert.deepEqual(ran.map(({ outcome, issue }) => ({ outcome, issue })), [{ outcome: 'failed', issue: 8 }]);
    assert.equal(heard?.dispatched.length, 1);
  });

  test('a failed launch releases its ticket and skips its repo: its later launches reach done as left', async () => {
    const { ctx, writes, asked, logged } = context({ launched: (a) => (a.issue === 9 ? { outcome: 'failed', sessionUrl: null, status: 1, output: 'no' } : { outcome: 'dispatched', sessionUrl: URL_OF(Number(a.issue)), status: 0, output: '' }) });
    let heard: { dispatched: unknown[], left: Array<{ issue: number }> } | undefined;
    const ran = await launchPlan(plan([ticket(9), ticket(10), ticket(11, OTHER)], async (r) => { heard = r as typeof heard; }), ctx, NOW);
    assert.deepEqual(asked.map((a) => a.issue), [9, 11]);
    assert.ok(writes.some((w) => w.issue === 9 && w.op === 'remove' && w.label === CLAIM), 'the claim comes off');
    assert.ok(writes.some((w) => w.issue === 9 && w.op === 'add' && JSON.stringify(w.labels) === JSON.stringify(CONFIG.labels.claimRemoves)), 'the ready labels go back');
    assert.ok(!writes.some((w) => w.issue === 9 && w.op === 'comment'), 'no marker');
    assert.ok(logged.some((l) => l.event === REPO_SKIPPED && l.repo === REPO && l.issue === 9 && l.level === 'error'));
    assert.deepEqual(ran.map((r) => [r.issue, r.outcome]), [[9, 'failed'], [11, 'dispatched']]);
    assert.deepEqual(heard?.left.map((l) => l.issue), [10]);
  });

  test('past the launch window, nothing starts and every launch reaches done as left', async () => {
    const { ctx, asked, logged } = context();
    let heard: { dispatched: unknown[], left: unknown[] } | undefined;
    const ran = await launchPlan(plan([ticket(12), ticket(13)], async (r) => { heard = r; }), ctx, NOW - SCHEDULE_LAUNCH_WINDOW_MS - 1);
    assert.deepEqual(asked, []);
    assert.deepEqual(ran, []);
    assert.equal(heard?.left.length, 2);
    assert.ok(logged.some((l) => l.event === 'dispatch-launch' && Array.isArray(l.undispatched) && l.undispatched.length === 2));
  });

  test('a routine the routines API refused moves no record and skips nothing', async () => {
    const periodic = { repo: REPO, issue: null, claim: false, holdsRepo: true, periodic: 'triage', asked: { prompt: 'triage', sessionName: 'triage' } };
    const { ctx, logged, asked } = context({ launched: (a) => (a.sessionName === 'triage' ? { outcome: 'failed', sessionUrl: null, status: null, output: 'refused', refused: true } : { outcome: 'dispatched', sessionUrl: URL_OF(14), status: 0, output: '' }) });
    let moved = 0;
    const ran = await launchPlan(plan([{ ...periodic, started: async () => { moved += 1; } }, ticket(14)]), ctx, NOW);
    assert.equal(moved, 0);
    assert.ok(logged.some((l) => l.event === ROUTINE_REFUSED && l.periodic === 'triage'));
    assert.deepEqual(asked.map((a) => a.sessionName), ['triage', 'ticket-14']);
    assert.deepEqual(ran.map((r) => r.issue), [14]);
  });

  test('a launch that printed no session leaves its claim stranded, logged once and cleared', async () => {
    const { ctx, logged, writes } = context({ launched: () => ({ outcome: 'unconfirmed', sessionUrl: null, status: 0, output: '' }) });
    await launchPlan(plan([ticket(15)]), ctx, NOW);
    assert.ok(writes.some((w) => w.op === 'comment' && w.issue === 15));
    assert.deepEqual(logged.filter((l) => l.event === CLAIM_STRANDED).map((l) => [l.repo, l.issue]), [[REPO, 15]]);
    assert.equal(ctx.claims.size, 0);
  });

  test('a launch that throws still logs the stranded claim, and the throw goes on', async () => {
    const { ctx, logged } = context({ launched: () => { throw new Error('launcher down'); } });
    await assert.rejects(launchPlan(plan([ticket(16)]), ctx, NOW), /launcher down/);
    assert.deepEqual(logged.filter((l) => l.event === CLAIM_STRANDED).map((l) => l.issue), [16]);
    assert.equal(ctx.claims.size, 0);
  });
});
