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
import { CAP_ZERO_REASON, CLAIM_STRANDED, REPO_SKIPPED, ROUTINE_REFUSED, SCHEDULE_LAUNCH_WINDOW_MS, launchPlan } from '../dispatch/launch-plan.mjs';
import { readConfig } from '../dispatch/repo-config.mjs';
import { PICKUP_FAILED_HOLD_MS, PICKUP_FAILED_UNRECORDED } from '../dispatch/pickup.mjs';
import { LAUNCH_FAILED_EVENT, LAUNCH_FAILED_MARKER } from '../dispatch/launch-failed.mjs';
import { SPEC_OWNER } from '../dispatch/deliveries.mjs';
import { relinkSession } from '../dispatch/webhook/subscribe.mjs';
import { factoryFile } from './helpers/factory.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'acme/factory';
const OTHER = 'acme/other';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const CONFIG = (() => {
  const read = readConfig(factoryFile('.github/governor.json'));
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
  failRecord?: boolean,
  comments?: (issue: number) => Array<{ id: number, body: string, created_at: string, ours: boolean }>,
} = {}) => {
  const logged: Logged[] = [];
  /** The failed-launch records put, each with what the ticket's labels had been written by then. */
  const held: Array<{ repo: string, issue: number, until: string, writesBefore: number }> = [];
  const writes: Write[] = [];
  const asked: Array<Record<string, unknown>> = [];
  const write = async (w: Write) => {
    writes.push(w);
    if (over.failWrite?.(w) === true) throw new Error(`${w.op} refused`);
  };
  const ctx = {
    readerFor: async (repo: string) => ({
      ticket: async (issue: number) => ({ number: issue, title: `Issue ${issue}`, body: '', state: 'open', labels: over.labels?.(repo, issue) ?? READY, pull: false, association: 'MEMBER', openBlockers: 0 }),
      blockers: async () => [],
      ensureLabel: (label: string) => write({ repo, op: 'ensure', label }),
      addLabels: (issue: number, labels: string[]) => write({ repo, op: 'add', issue, labels }),
      removeLabel: (issue: number, label: string) => write({ repo, op: 'remove', issue, label }),
      comment: (issue: number, text: string) => write({ repo, op: 'comment', issue, text }),
      allComments: async (issue: number) => over.comments?.(issue) ?? [],
      issue: async (issue: number) => ({ number: issue, body: 'The spec.', pull: false }),
      updateIssue: (issue: number, { body }: { body: string }) => write({ repo, op: 'body', issue, text: body }),
    }),
    configOf: () => CONFIG,
    start: async (a: Record<string, unknown>) => {
      asked.push(a);
      return over.launched?.(a) ?? { outcome: 'dispatched', sessionUrl: URL_OF(Number(a.issue ?? 0)), status: 0, output: '' };
    },
    claims: new Set<string>(),
    now: () => NOW,
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    state: {
      recordFailedLaunch: async (repo: string, issue: number, until: string) => {
        if (over.failRecord === true) throw new Error('ProvisionedThroughputExceededException');
        held.push({ repo, issue, until, writesBefore: writes.length });
      },
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof launchPlan>[1], logged, writes, asked, held };
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

  test('a spec session is not claimed and leaves no dispatch comment: its ticket\'s body names it as the owner', async () => {
    const { ctx, writes } = context();
    await launchPlan(plan([ticket(6, REPO, { claim: false, holdsRepo: false })]), ctx, NOW);
    assert.deepEqual(writes.map((w) => w.op), ['body']);
    assert.equal(writes[0]!.text, relinkSession('The spec.', URL_OF(6)));
  });

  test('a spec session whose body write is refused is logged at error, and the plan goes on', async () => {
    const { ctx, logged } = context({ failWrite: (w) => w.op === 'body' });
    const ran = await launchPlan(plan([ticket(6, REPO, { claim: false, holdsRepo: false }), ticket(7)]), ctx, NOW);
    assert.deepEqual(ran.map((r) => r.issue), [6, 7]);
    const said = logged.find((l) => l.event === SPEC_OWNER);
    assert.equal(said?.level, 'error', JSON.stringify(logged));
    assert.equal(said?.issue, 6);
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
    assert.ok(!writes.some((w) => w.issue === 9 && w.op === 'comment' && w.text!.includes('governor:dispatched')), 'no dispatch marker');
    assert.ok(logged.some((l) => l.event === REPO_SKIPPED && l.repo === REPO && l.issue === 9 && l.level === 'error'));
    assert.deepEqual(ran.map((r) => [r.issue, r.outcome]), [[9, 'failed'], [11, 'dispatched']]);
    assert.deepEqual(heard?.left.map((l) => l.issue), [10]);
  });

  // A ready label put back after a launch that started nothing queues a
  // selection fire like any other. The record keeps that fire from launching
  // the ticket again inside the hour, whoever's label it was, so it is put
  // before the labels go back.
  test('a failed launch puts the ticket\'s failed-launch record, an hour long, before its ready labels go back', async () => {
    const { ctx, writes, held } = context({ launched: () => ({ outcome: 'failed', sessionUrl: null, status: 1, output: 'no' }) });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.deepEqual(held.map(({ repo, issue, until }) => ({ repo, issue, until })), [{ repo: REPO, issue: 9, until: new Date(NOW + PICKUP_FAILED_HOLD_MS).toISOString() }]);
    assert.equal(PICKUP_FAILED_HOLD_MS, 60 * 60 * 1000, 'an hour');
    const putBack = writes.findIndex((w) => w.issue === 9 && w.op === 'add' && JSON.stringify(w.labels) === JSON.stringify(CONFIG.labels.claimRemoves));
    assert.ok(putBack >= held[0]!.writesBefore, 'the record stands before the labels go back');
  });

  test('a launch that started, or a ticket not claimed, puts no failed-launch record', async () => {
    const { ctx, held } = context();
    await launchPlan(plan([ticket(5)]), ctx, NOW);
    const failing = context({ launched: () => ({ outcome: 'failed', sessionUrl: null, status: 1, output: 'no' }) });
    await launchPlan(plan([ticket(6, REPO, { claim: false })]), failing.ctx, NOW);
    assert.deepEqual([...held, ...failing.held], []);
  });

  // A claim that fails part way has taken a ready label off, and its release
  // puts it back, which queues a selection fire like any other. Without the
  // record that fire would claim again at once, and fail the same way.
  test('a claim that fails after taking a ready label off puts the failed-launch record before the labels go back', async () => {
    const { ctx, writes, held, asked } = context({ failWrite: (w) => w.op === 'remove' && w.label === CONFIG.labels.claimRemoves[0] });
    await launchPlan(plan([ticket(8)]), ctx, NOW);
    assert.deepEqual(asked, []);
    assert.deepEqual(held.map(({ repo, issue, until }) => ({ repo, issue, until })), [{ repo: REPO, issue: 8, until: new Date(NOW + PICKUP_FAILED_HOLD_MS).toISOString() }]);
    const putBack = writes.findIndex((w) => w.issue === 8 && w.op === 'add' && JSON.stringify(w.labels) === JSON.stringify(CONFIG.labels.claimRemoves));
    assert.ok(putBack >= held[0]!.writesBefore, 'the record stands before the labels go back');
  });

  test('a failed-launch record that cannot be put is logged at error, and the ticket is still released', async () => {
    const { ctx, writes, logged } = context({ failRecord: true, launched: () => ({ outcome: 'failed', sessionUrl: null, status: 1, output: 'no' }) });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.ok(writes.some((w) => w.issue === 9 && w.op === 'remove' && w.label === CLAIM), 'released');
    const said = logged.find((l) => l.event === PICKUP_FAILED_UNRECORDED);
    assert.equal(said?.level, 'error', JSON.stringify(logged));
    assert.equal(said?.issue, 9);
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

  // The spec owners' messages go once the loop ends. A send that hangs
  // until the deadline must not hold back the stranded-claim lines.
  test('a spec owner message that never returns still lets the stranded claim be logged', async () => {
    const owner = 'https://claude.ai/code/session_01SPECOWNER';
    const { ctx, logged } = context({ launched: (a) => (a.issue === 18 ? { outcome: 'unconfirmed', sessionUrl: null, status: 0, output: '' } : { outcome: 'dispatched', sessionUrl: URL_OF(Number(a.issue)), status: 0, output: '' }) });
    const reader = ctx.readerFor;
    const sent: string[] = [];
    Object.assign(ctx, {
      readerFor: async (repo: string) => {
        const r = await reader(repo);
        return { ...r, ticket: async (n: number) => ({ ...(await r.ticket(n)), body: `The spec.\n\n${owner}` }) };
      },
      delivery: () => ({ deliver: ({ session }: { session: string }) => { sent.push(session); return new Promise(() => {}); } }),
    });
    void launchPlan(plan([ticket(17), ticket(18)]), ctx, NOW);
    for (let i = 0; i < 20 && sent.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [owner]);
    assert.deepEqual(logged.filter((l) => l.event === CLAIM_STRANDED).map((l) => l.issue), [18]);
  });

  test('a launch that throws still sends the messages of the launches before it, and the throw goes on', async () => {
    const owner = 'https://claude.ai/code/session_01SPECOWNER';
    const { ctx } = context({ launched: (a) => { if (a.issue === 20) throw new Error('launcher down'); return { outcome: 'dispatched', sessionUrl: URL_OF(Number(a.issue)), status: 0, output: '' }; } });
    const reader = ctx.readerFor;
    const sent: Array<{ session: string, text: string }> = [];
    Object.assign(ctx, {
      readerFor: async (repo: string) => {
        const r = await reader(repo);
        return { ...r, ticket: async (n: number) => ({ ...(await r.ticket(n)), body: `The spec.\n\n${owner}` }) };
      },
      delivery: () => ({ deliver: async ({ session }: { session: string }, text: string) => { sent.push({ session, text }); return { ok: true, refused: false, error: null }; } }),
    });
    await assert.rejects(launchPlan(plan([ticket(19), ticket(20)]), ctx, NOW), /launcher down/);
    assert.deepEqual(sent.map((s) => s.session), [owner]);
    assert.match(sent[0]!.text, /\[#19 .*\]\(https:\/\/github\.com\/acme\/factory\/issues\/19\) has \[a new builder\]\(https:\/\/claude\.ai\/code\/session_19\)/);
  });
});

describe('a ticket whose launch or claim failed is told so on its thread', () => {
  const FAILED = { outcome: 'failed', sessionUrl: null, status: 1, output: 'Error: Cloud session create failed: env_01SECRETENV account 4242' };
  const UNTIL = new Date(NOW + PICKUP_FAILED_HOLD_MS).toISOString();
  const said = (writes: Write[], issue: number) => writes.filter((w) => w.op === 'comment' && w.issue === issue && w.text!.startsWith(LAUNCH_FAILED_MARKER));

  test('a failed launch whose record was put gets one comment naming the hold\'s end and the launcher\'s log line', async () => {
    const { ctx, writes, held } = context({ launched: () => FAILED });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    const posted = said(writes, 9);
    assert.equal(posted.length, 1, JSON.stringify(writes));
    const text = posted[0]!.text!;
    assert.ok(text.startsWith(`${LAUNCH_FAILED_MARKER}${UNTIL} -->`));
    assert.match(text, /could not start a session/);
    assert.match(text, /no session is working on it/);
    assert.ok(text.includes(UNTIL));
    assert.match(text, /`dispatch-launcher-output`/);
    assert.ok(!text.includes('`dispatch-claim`'));
    assert.equal(held.length, 1);
  });

  test('the comment quotes none of the launcher\'s output', async () => {
    const { ctx, writes } = context({ launched: () => FAILED });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    const text = said(writes, 9)[0]!.text!;
    for (const piece of ['Cloud session create failed', 'env_01SECRETENV', '4242']) assert.ok(!text.includes(piece), piece);
  });

  test('a failed claim whose record was put gets one comment naming the claim\'s log line', async () => {
    const { ctx, writes } = context({ failWrite: (w) => w.op === 'remove' && w.label === CONFIG.labels.claimRemoves[0] });
    await launchPlan(plan([ticket(8)]), ctx, NOW);
    const posted = said(writes, 8);
    assert.equal(posted.length, 1, JSON.stringify(writes));
    assert.match(posted[0]!.text!, /`dispatch-claim`/);
    assert.ok(!posted[0]!.text!.includes('`dispatch-launcher-output`'));
  });

  test('a second failure, with no launch since, posts no second comment', async () => {
    const earlier = { id: 1, body: `${LAUNCH_FAILED_MARKER}2026-09-25T11:00:00.000Z -->\nGovernor could not start a session.`, created_at: '2026-09-25T10:00:00Z', ours: true };
    const person = { id: 2, body: 'Why has this not started?', created_at: '2026-09-25T11:30:00Z', ours: false };
    const { ctx, writes, logged } = context({ launched: () => FAILED, comments: () => [earlier, person] });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.deepEqual(said(writes, 9), []);
    assert.ok(writes.some((w) => w.issue === 9 && w.op === 'remove' && w.label === CLAIM), 'still released');
    assert.ok(logged.some((l) => l.event === LAUNCH_FAILED_EVENT && l.issue === 9 && l.outcome === 'already said'), JSON.stringify(logged));
  });

  test('a launch that started a session since the last failure ends the run: the next failure is said again', async () => {
    const earlier = { id: 1, body: `${LAUNCH_FAILED_MARKER}2026-09-24T11:00:00.000Z -->\nGovernor could not start a session.`, created_at: '2026-09-24T10:00:00Z', ours: true };
    const dispatched = { id: 2, body: '<!-- governor:dispatched 2026-09-24T12:00:00.000Z -->\nDispatched to https://claude.ai/code/session_01LATER at 2026-09-24T12:00:00.000Z.', created_at: '2026-09-24T12:00:00Z', ours: true };
    const { ctx, writes } = context({ launched: () => FAILED, comments: () => [earlier, dispatched] });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.equal(said(writes, 9).length, 1);
  });

  test('a failed-launch marker in someone else\'s comment is text: the failure is said', async () => {
    const copied = { id: 1, body: `${LAUNCH_FAILED_MARKER}2026-09-25T11:00:00.000Z -->`, created_at: '2026-09-25T10:00:00Z', ours: false };
    const { ctx, writes } = context({ launched: () => FAILED, comments: () => [copied] });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.equal(said(writes, 9).length, 1);
  });

  test('where the record could not be put, no comment is posted', async () => {
    const { ctx, writes } = context({ failRecord: true, launched: () => FAILED });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.deepEqual(said(writes, 9), []);
  });

  test('a comment that fails is logged at error, and the release still runs', async () => {
    const { ctx, writes, logged } = context({ launched: () => FAILED, failWrite: (w) => w.op === 'comment' });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.ok(writes.some((w) => w.issue === 9 && w.op === 'remove' && w.label === CLAIM), 'released');
    assert.ok(writes.some((w) => w.issue === 9 && w.op === 'add' && JSON.stringify(w.labels) === JSON.stringify(CONFIG.labels.claimRemoves)), 'ready labels back');
    const line = logged.find((l) => l.event === LAUNCH_FAILED_EVENT && l.issue === 9);
    assert.equal(line?.level, 'error', JSON.stringify(logged));
  });

  test('a thread that cannot be read posts no comment, is logged at error, and the release still runs', async () => {
    const { ctx, writes, logged } = context({ launched: () => FAILED, comments: () => { throw new Error('502'); } });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.deepEqual(said(writes, 9), []);
    assert.ok(writes.some((w) => w.issue === 9 && w.op === 'remove' && w.label === CLAIM), 'released');
    assert.equal(logged.find((l) => l.event === LAUNCH_FAILED_EVENT && l.issue === 9)?.level, 'error');
  });

  test('the ticket\'s spec owner is told the comment', async () => {
    const owner = 'https://claude.ai/code/session_01SPECOWNER';
    const { ctx, writes } = context({ launched: () => FAILED });
    const reader = ctx.readerFor;
    const sent: Array<{ session: string, text: string }> = [];
    Object.assign(ctx, {
      readerFor: async (repo: string) => {
        const r = await reader(repo);
        return { ...r, ticket: async (n: number) => ({ ...(await r.ticket(n)), body: `The spec.\n\n${owner}` }) };
      },
      delivery: () => ({ deliver: async ({ session }: { session: string }, text: string) => { sent.push({ session, text }); return { ok: true, refused: false, error: null }; } }),
    });
    await launchPlan(plan([ticket(9)]), ctx, NOW);
    assert.equal(said(writes, 9).length, 1);
    assert.deepEqual(sent.map((s) => s.session), [owner]);
    assert.match(sent[0]!.text, /could not start a session/);
    assert.ok(!sent[0]!.text.includes(LAUNCH_FAILED_MARKER), 'the marker is governor\'s');
  });
});

describe('the reason a cap of 0 gives', () => {
  test('is written once, in dispatch/launch-plan.mjs, and no other code spells it out', () => {
    const root = join(import.meta.dirname, '..');
    const files = ['dispatch', 'scripts'].flatMap((dir) => (readdirSync(join(root, dir), { recursive: true }) as string[]).filter((f) => f.endsWith('.mjs')).map((f) => join(dir, f)));
    const holding = files.filter((f) => readFileSync(join(root, f), 'utf8').includes(CAP_ZERO_REASON));
    assert.deepEqual(holding, [join('dispatch', 'launch-plan.mjs')]);
    assert.match(CAP_ZERO_REASON, /^DispatchCap is 0/);
  });
});
