/**
 * The planners for the fire kinds that start sessions, each called as
 * `(invocation, ctx)` with a `TurnContext` (dispatch/turn.mjs). A planner
 * returns the launches it wants started, with the record each moves once
 * started, or the turn's whole answer where it starts nothing. These tests
 * hand it a reader fake, a state fake and a config, not the turn harness.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, sessionName } from '../scripts/lib/dispatch-prompt.mjs';
import { readConfig } from '../dispatch/repo-config.mjs';
import { hookPrompt, planHook } from '../dispatch/hooks.mjs';
import { redRunPrompt } from '../dispatch/workflow.mjs';
import { planDispatch } from '../dispatch/dispatch-fire.mjs';
import { DEFAULT_SESSION_NAME, hookSource } from '../dispatch/deliveries.mjs';
import { planUnblocked } from '../dispatch/unblocked-fire.mjs';
import { specPrompt } from '../dispatch/unblocked.mjs';
import { planSweep } from '../dispatch/sweep.mjs';
import { periodicPrompt } from '../dispatch/periodics.mjs';
import { waitSpecPrompt } from '../dispatch/waits.mjs';
import { dispatchMarker } from '../dispatch/webhook/fire.mjs';
import { factoryFile } from './helpers/factory.ts';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const FILE = JSON.parse(factoryFile('.github/dispatch.json'));
const CONFIG = (() => {
  const read = readConfig(JSON.stringify(FILE));
  assert.ok(read.ok);
  return read.config;
})();
const HOOK = (FILE.hooks as Array<{ name: string, prompt: string, keyVersion: number }>)[0]!;

type Logged = { event: string } & Record<string, unknown>;
type HookRecord = { session: string, at: string };

/** A `TurnContext` with fakes, each overridable, and what the planner did through it. */
const context = (over: Record<string, unknown> = {}) => {
  const logged: Logged[] = [];
  const records = new Map<string, HookRecord>();
  const writes: Array<{ repo: string, name: string, read: HookRecord | null, record: HookRecord }> = [];
  const sent: Array<{ session: string, text: string, source: unknown }> = [];
  const stored: number[] = [];
  const readers: string[] = [];
  const ctx = {
    readerFor: async (repo: string) => {
      readers.push(repo);
      return { workflowRuns: async () => [] };
    },
    configOf: (repo: string) => {
      assert.equal(repo, REPO);
      return CONFIG;
    },
    served: [],
    bare: false,
    prompts: FILE.prompts,
    delivery: () => ({
      deliver: async ({ session }: { session: string }, text: string, { source }: { source: unknown }) => {
        sent.push({ session, text, source });
        return { ok: true, answered: true, refused: false, sessionUrl: session, error: null, fallback: null, dropped: null, skipped: null };
      },
    }),
    storeLogin: async () => {
      stored.push(1);
      return true;
    },
    state: {
      hookSession: async (repo: string, name: string) => records.get(`${repo}#${name}`) ?? null,
      recordHookSession: async (repo: string, name: string, read: HookRecord | null, record: HookRecord) => {
        writes.push({ repo, name, read, record });
        records.set(`${repo}#${name}`, record);
        return true;
      },
    },
    start: async () => { throw new Error('a planner starts nothing'); },
    open: async () => true,
    claims: new Set<string>(),
    beats: [],
    now: () => NOW,
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    sleep: async () => {},
    cap: 2,
    ...over,
  };
  return { ctx: ctx as never, logged, records, writes, sent, stored, readers };
};

describe('planHook: a hook fire\'s plan', () => {
  const AT = '2026-09-25T11:58:00.000Z';
  const fire = (over: Record<string, unknown> = {}) => ({ kind: 'hook', hook: HOOK.name, keyVersion: HOOK.keyVersion, text: 'ALARM: api 5xx', at: AT, repo: REPO, ...over }) as never;
  const URL = 'https://claude.ai/code/session_01NEW';
  const OPEN = { session: 'https://claude.ai/code/session_01OPEN', at: '2026-09-25T11:40:00.000Z' };

  test('with no record, plans one unclaimed launch named after the hook, on its prompt, that holds nothing', async () => {
    const { ctx, sent } = context();
    const plan = await planHook(fire(), ctx) as any;
    assert.ok(!('answer' in plan));
    assert.equal(plan.launches.length, 1);
    const [only] = plan.launches;
    assert.deepEqual({ ...only, started: undefined }, {
      repo: REPO,
      issue: null,
      claim: false,
      holdsRepo: false,
      asked: { prompt: hookPrompt(HOOK.prompt, fire()), sessionName: HOOK.name, model: DEFAULT_MODEL },
      started: undefined,
    });
    assert.equal(typeof only.started, 'function');
    assert.deepEqual(plan.unread, []);
    assert.deepEqual(sent, [], 'nothing is messaged');
  });

  test('started writes the record naming the session, over the record read, and only where the launch printed one', async () => {
    const { ctx, writes, logged } = context();
    const plan = await planHook(fire(), ctx) as any;
    await plan.launches[0].started({ outcome: 'unconfirmed', sessionUrl: null, status: null, output: '' }, AT);
    assert.deepEqual(writes, [], 'no session to name');
    await plan.launches[0].started({ outcome: 'dispatched', sessionUrl: URL, status: 0, output: '' }, AT);
    assert.deepEqual(writes, [{ repo: REPO, name: HOOK.name, read: null, record: { session: URL, at: AT } }]);
    assert.ok(logged.some((l) => l.event === 'dispatch-hook' && l.outcome === 'recorded' && l.sessionUrl === URL), JSON.stringify(logged));
    assert.deepEqual(plan.unread, []);
  });

  test('a record that moved since it was read, or a write that fails, lands in the plan\'s unread, so the turn fails', async () => {
    for (const recordHookSession of [async () => false, async () => { throw new Error('throttled'); }]) {
      const { ctx, logged } = context({ state: { hookSession: async () => null, recordHookSession } });
      const plan = await planHook(fire(), ctx) as any;
      await plan.launches[0].started({ outcome: 'dispatched', sessionUrl: URL, status: 0, output: '' }, AT);
      assert.equal(plan.unread.length, 1);
      assert.equal(plan.unread[0].repo, REPO);
      assert.match(plan.unread[0].error, new RegExp(`hook ${HOOK.name}`));
      assert.equal(logged.find((l) => l.event === 'dispatch-hook-unrecorded')?.level, 'error');
    }
  });

  test('done fails the turn for a hook launch the window left unstarted, and does nothing for one that ran', async () => {
    const { ctx, logged } = context();
    const plan = await planHook(fire(), ctx) as any;
    await plan.done({ dispatched: [], left: [] });
    assert.deepEqual(plan.unread, []);
    await plan.done({ dispatched: [], left: plan.launches });
    assert.deepEqual(plan.unread, [{ repo: REPO, error: `hook ${HOOK.name}: out of time, its session was not started` }]);
    const line = logged.find((l) => l.event === 'dispatch-hook-unstarted');
    assert.equal(line?.level, 'error');
    assert.equal(line?.hook, HOOK.name);
  });

  test('while the last session is open, the fire goes into it as a message, the login is stored, and the answer starts nothing', async () => {
    const { ctx, records, sent, stored, logged } = context();
    records.set(`${REPO}#${HOOK.name}`, OPEN);
    const plan = await planHook(fire(), ctx) as any;
    assert.deepEqual(Object.keys(plan), ['answer']);
    assert.deepEqual(plan.answer.kind, 'hook');
    assert.deepEqual(plan.answer.dispatched, []);
    assert.equal(plan.answer.messaged.ok, true);
    assert.equal(plan.answer.loginStored, true);
    assert.deepEqual(sent.map((s) => s.session), [OPEN.session]);
    assert.deepEqual(sent[0]!.source, hookSource(HOOK.name), 'the hook\'s relay line, not GitHub\'s');
    assert.equal(stored.length, 1);
    assert.ok(logged.some((l) => l.event === 'dispatch-hook' && l.outcome === 'messaged'));
  });

  test('a send the CLI refused as archived plans a new session over the record read; any other failure answers, starting nothing', async () => {
    const refused = { ok: false, answered: true, refused: true, sessionUrl: OPEN.session, error: 'archived', fallback: null, dropped: null, skipped: null };
    const failed = { ...refused, refused: false, answered: false, error: 'timed out' };
    for (const [told, starts] of [[refused, true], [failed, false]] as const) {
      const { ctx, records, stored } = context({ delivery: () => ({ deliver: async () => told }) });
      records.set(`${REPO}#${HOOK.name}`, OPEN);
      const plan = await planHook(fire(), ctx) as any;
      assert.equal(stored.length, 1, 'the login is stored either way');
      if (starts) {
        assert.equal(plan.launches.length, 1);
        assert.equal(plan.launches[0].asked.sessionName, HOOK.name);
      } else {
        assert.equal(plan.answer.messaged, told);
      }
    }
  });

  test('an archived or gone last session plans a new one, and its record is written over the one read', async () => {
    const { ctx, records, writes } = context({ open: async () => false });
    records.set(`${REPO}#${HOOK.name}`, OPEN);
    const plan = await planHook(fire(), ctx) as any;
    await plan.launches[0].started({ outcome: 'dispatched', sessionUrl: URL, status: 0, output: '' }, AT);
    assert.deepEqual(writes.map((w) => w.read), [OPEN]);
  });

  test('a read that fails, of the record or of the session, refuses the fire', async () => {
    const unreadRecord = context({ state: { hookSession: async () => { throw new Error('throttled'); }, recordHookSession: async () => true } });
    await assert.rejects(planHook(fire(), unreadRecord.ctx), /throttled/);
    const unreadSession = context({ open: async () => { throw new Error('502'); } });
    unreadSession.records.set(`${REPO}#${HOOK.name}`, OPEN);
    await assert.rejects(planHook(fire(), unreadSession.ctx), new RegExp(`hook ${HOOK.name}: its last session ${OPEN.session} could not be read: 502`));
  });

  test('a hook the file does not list, or a stale key version, refuses the fire', async () => {
    await assert.rejects(planHook(fire({ hook: 'operator-gone' }), context().ctx), /lists no hook operator-gone/);
    await assert.rejects(planHook(fire({ keyVersion: HOOK.keyVersion + 1 }), context().ctx), /key version/);
  });

  test('a fire that names no repo is refused', async () => {
    await assert.rejects(planHook(fire({ repo: undefined }), context().ctx), /names no repo/);
  });
});

describe('planDispatch: a dispatch fire\'s plan', () => {
  const run = (id: number, conclusion: string) => ({ id, status: 'completed', conclusion, event: 'schedule', head_branch: 'main', head_sha: `sha${id}`, html_url: `https://github.com/${REPO}/actions/runs/${id}`, created_at: new Date(NOW - (500 - id) * 60_000).toISOString() });
  const scheduled = { kind: 'dispatch', prompt: 'look into it', sessionName: 'Scheduled Emulator red', scheduled: { workflowId: 77, runId: 500, branch: 'main' }, repo: REPO } as never;
  const withRuns = (rows: unknown[]) => context({ readerFor: async () => ({ workflowRuns: async () => rows }) });

  test('a dispatch by hand plans one launch on the fire\'s own prompt, name and model, and reads nothing', async () => {
    const { ctx, readers } = context();
    const named = await planDispatch({ kind: 'dispatch', prompt: 'do the thing', sessionName: 'By hand', model: 'some-model', repo: REPO } as never, ctx) as any;
    assert.deepEqual(named, { launches: [{ repo: REPO, issue: null, claim: false, holdsRepo: false, asked: { prompt: 'do the thing', sessionName: 'By hand', model: 'some-model' } }], unread: [] });
    const bare = await planDispatch({ kind: 'dispatch', prompt: 'do the thing', repo: REPO } as never, ctx) as any;
    assert.deepEqual(bare.launches[0].asked, { prompt: 'do the thing', sessionName: DEFAULT_SESSION_NAME, model: DEFAULT_MODEL });
    assert.deepEqual(readers, []);
  });

  test('a red scheduled run after a green plans one launch on the fire\'s facts and the repo\'s instruction', async () => {
    const { ctx } = withRuns([run(500, 'failure'), run(499, 'success')]);
    const plan = await planDispatch(scheduled, ctx) as any;
    assert.equal(plan.launches.length, 1);
    assert.deepEqual(plan.launches[0].asked, { prompt: redRunPrompt('look into it', FILE.prompts), sessionName: 'Scheduled Emulator red', model: DEFAULT_MODEL });
  });

  test('a red scheduled run after a red plans nothing, and says why', async () => {
    const { ctx, logged } = withRuns([run(500, 'failure'), run(499, 'failure')]);
    const plan = await planDispatch(scheduled, ctx) as any;
    assert.deepEqual(plan, { launches: [], unread: [] });
    assert.ok(logged.some((l) => l.event === 'dispatch-launch' && l.outcome === 'skipped' && /499.*failure/.test(String(l.reason))), JSON.stringify(logged));
  });

  test('a runs list it cannot read plans the launch: a second session costs less than none on a red', async () => {
    const { ctx, logged } = context({ readerFor: async () => ({ workflowRuns: async () => { throw new Error('502'); } }) });
    const plan = await planDispatch(scheduled, ctx) as any;
    assert.equal(plan.launches.length, 1);
    assert.ok(logged.some((l) => l.event === 'dispatch-scheduled-unread'));
  });

  test('a fire that names no repo is refused', async () => {
    await assert.rejects(planDispatch({ kind: 'dispatch', prompt: 'x' } as never, context().ctx), /names no repo/);
  });
});

describe('planUnblocked: an unblocked fire\'s plan', () => {
  const READY = CONFIG.labels.ready;
  const CLAIM = CONFIG.labels.claim;
  const SESSION = 'https://claude.ai/code/session_01WORK';
  const blocker = { repo: 'acme/tools', number: 41, title: 'The parser', reason: 'completed' };
  const fire = (over: Record<string, unknown> = {}) => ({ kind: 'unblocked', repo: REPO, issue: 7, blocker, pr: { number: 52, title: 'Parse it', url: 'https://github.com/acme/tools/pull/52' }, ...over }) as never;
  /** A context whose reader holds ticket 7, with `labels`, `rows` as its blockers and `comments` as its thread. */
  const ticketContext = ({ labels = [...READY] as string[], rows = [{ number: 41, state: 'closed', title: 'The parser' }], comments = [] as Array<{ body: string }>, over = {} as Record<string, unknown> } = {}) => {
    const posted: Array<{ issue: number, body: string }> = [];
    const ticket = { number: 7, title: 'Issue 7', body: '', state: 'open', labels, pull: false, association: 'MEMBER' };
    const reader = {
      ticket: async () => ticket,
      blockers: async () => rows,
      readyIssues: async () => [ticket],
      comments: async () => comments,
      allComments: async () => comments.map((c) => ({ ...c, ours: true })),
      comment: async (issue: number, body: string) => { posted.push({ issue, body }); },
      removeLabel: async () => {},
      labelRemovals: async () => [],
    };
    return { ...context({ readerFor: async () => reader, ...over }), posted };
  };

  test('a ready ticket plans one launch that claims it and holds its repo, on the ready prompt, and its result carries the row', async () => {
    const { ctx, sent } = ticketContext();
    const plan = await planUnblocked(fire(), ctx) as any;
    assert.ok(!('answer' in plan));
    assert.equal(plan.launches.length, 1);
    const [only] = plan.launches;
    assert.deepEqual({ repo: only.repo, issue: only.issue, claim: only.claim, holdsRepo: only.holdsRepo, model: only.asked.model }, { repo: REPO, issue: 7, claim: true, holdsRepo: true, model: DEFAULT_MODEL });
    assert.match(only.asked.prompt, /acme\/tools#41/);
    assert.equal(only.started, undefined, 'the ready launch moves no record of its own');
    assert.deepEqual(plan.result, { row: 'ready' });
    assert.deepEqual(plan.unread, []);
    assert.deepEqual(sent, []);
  });

  test('a ticket not ready plans a spec session that claims nothing but holds its repo', async () => {
    const { ctx } = ticketContext({ labels: ['type: bug'] });
    const plan = await planUnblocked(fire(), ctx) as any;
    assert.equal(plan.launches.length, 1);
    const [only] = plan.launches;
    assert.deepEqual({ issue: only.issue, claim: only.claim, holdsRepo: only.holdsRepo }, { issue: 7, claim: false, holdsRepo: true });
    assert.deepEqual(only.asked, {
      prompt: specPrompt({ fire: fire(), title: 'Issue 7', labels: CONFIG.labels, prompts: FILE.prompts }),
      sessionName: sessionName(7, 'Issue 7'),
      model: DEFAULT_MODEL,
    });
    assert.deepEqual(plan.result, { row: 'not-ready' });
  });

  test('with DispatchCap 0, a ready ticket plans nothing, and the result still carries the row', async () => {
    const { ctx, logged } = ticketContext({ over: { cap: 0 } });
    const plan = await planUnblocked(fire(), ctx) as any;
    assert.deepEqual(plan, { launches: [], unread: [], result: { row: 'ready' } });
    assert.ok(logged.some((l) => l.event === 'dispatch-unblocked' && l.outcome === 'not started'));
  });

  test('a claimed ticket\'s session gets the message, the login is stored, and the answer starts nothing', async () => {
    const marker = dispatchMarker({ at: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(), sessionUrl: SESSION });
    const { ctx, sent, stored } = ticketContext({ labels: [CLAIM, 'mode: afk'], comments: [{ body: marker }] });
    const plan = await planUnblocked(fire(), ctx) as any;
    assert.deepEqual(Object.keys(plan), ['answer']);
    const { messaged, ...rest } = plan.answer;
    assert.deepEqual(rest, { kind: 'unblocked', row: 'claimed', commented: false, dispatched: [], loginStored: true });
    assert.equal(messaged.ok, true);
    assert.deepEqual(sent.map((s) => s.session), [SESSION]);
    assert.equal(stored.length, 1);
  });

  test('a ticket still blocked by another open issue answers with its row, and starts nothing', async () => {
    const { ctx } = ticketContext({ rows: [{ number: 41, state: 'closed', title: 'x' }, { number: 43, state: 'open', title: 'y' }] });
    const plan = await planUnblocked(fire(), ctx) as any;
    assert.deepEqual(plan, { answer: { kind: 'unblocked', row: 'blocked', dispatched: [] } });
  });

  test('a not-planned close comments on the ticket and answers', async () => {
    const { ctx, posted } = ticketContext({ labels: ['type: bug'] });
    const plan = await planUnblocked(fire({ blocker: { ...blocker, reason: 'not_planned' } }), ctx) as any;
    assert.deepEqual(plan, { answer: { kind: 'unblocked', row: 'not-planned', commented: true, dispatched: [] } });
    assert.equal(posted.length, 1);
  });

  test('a repo turning neither pickup nor unblocked on refuses the fire in its answer', async () => {
    const off = { ...CONFIG, features: { ...CONFIG.features, pickup: false, unblocked: false } };
    const { ctx } = ticketContext({ over: { configOf: () => off } });
    const plan = await planUnblocked(fire(), ctx) as any;
    assert.deepEqual(plan, { answer: { kind: 'unblocked', refusal: `${REPO}'s .github/dispatch.json turns neither pickup nor unblocked on`, dispatched: [] } });
  });

  test('a fire that names no repo is refused', async () => {
    await assert.rejects(planUnblocked(fire({ repo: undefined }), ticketContext().ctx), /names no repo/);
  });
});

describe('planSweep: the bare schedule fire\'s plan', () => {
  const RETRO = (FILE.periodics as Array<{ name: string, prompt: string, days: number }>)[0]!;
  // One periodic, a heartbeat in governor's own block and no wait ticket, so
  // the fakes need no window, marker or sidebar reads.
  const SWEPT = (() => {
    const { waits: _waits, ...rest } = FILE;
    const read = readConfig(JSON.stringify({ ...rest, periodics: [RETRO], heartbeat: { issue: 412 } }));
    assert.ok(read.ok);
    return read.config;
  })();
  const LAST_FIRE = { at: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(), session: null, baseline: false };
  const URL = 'https://claude.ai/code/session_01SWEPT';
  const READY_TICKET = { number: 5, title: 'Issue 5', body: '', state: 'open', labels: [...SWEPT.labels.ready], created_at: '2026-09-20T00:00:00Z', openBlockers: 0, pull: false, association: 'MEMBER' };
  const WAITING = { number: 9, title: 'Issue 9', body: 'Blocked until: 2026-09-20', state: 'open', labels: ['type: bug'], wait: { until: '2026-09-20' }, openBlockers: 0, pull: false };

  /** A bare fire's context over one served repo, its reader and its state, each overridable. */
  const sweepContext = ({ waits = [] as Array<{ issue: number, until: string }>, over = {} as Record<string, unknown> } = {}) => {
    const swept: Array<{ repo: string, at: string }> = [];
    const fired: Array<{ repo: string, name: string, read: unknown, record: unknown }> = [];
    const dropped: Array<{ repo: string, issue: number, until: string }> = [];
    const tickets = new Map<number, unknown>([[5, READY_TICKET], [9, WAITING]]);
    const reader = {
      readyIssues: async () => [READY_TICKET],
      ticket: async (n: number) => tickets.get(n),
      blockers: async () => [],
      comments: async () => [],
      allComments: async () => [],
      comment: async () => {},
    };
    const beats: unknown[] = [];
    const made = context({
      readerFor: async () => reader,
      configOf: () => SWEPT,
      served: [{ repo: REPO, config: SWEPT }],
      bare: true,
      prompts: {},
      beats,
      state: {
        sweep: async () => null,
        recordSweep: async (repo: string, at: string) => { swept.push({ repo, at }); return true; },
        periodic: async () => LAST_FIRE,
        recordPeriodic: async (repo: string, name: string, read: unknown, record: unknown) => { fired.push({ repo, name, read, record }); return true; },
        waits: async () => waits,
        dropWait: async (repo: string, issue: number, until: string) => { dropped.push({ repo, issue, until }); return true; },
      },
      ...over,
    });
    return { ...made, swept, fired, dropped, beats };
  };
  const fire = { kind: 'schedule' } as never;
  const ran = (planned: any, outcome: string, sessionUrl: string | null = outcome === 'failed' ? null : URL) => ({ repo: planned.repo, issue: planned.issue, outcome, sessionUrl, planned });

  test('plans the due periodics first, then the ready tickets, then the ended waits\' spec sessions', async () => {
    const { ctx } = sweepContext({ waits: [{ issue: 9, until: '2026-09-20' }] });
    const plan = await planSweep(fire, ctx) as any;
    assert.ok(!('answer' in plan));
    const [periodic, ticket, spec, ...rest] = plan.launches;
    assert.deepEqual(rest, []);
    assert.deepEqual({ ...periodic, started: undefined }, {
      repo: REPO,
      issue: null,
      claim: false,
      holdsRepo: true,
      periodic: RETRO.name,
      asked: { prompt: periodicPrompt(RETRO.prompt, LAST_FIRE), sessionName: RETRO.name, model: DEFAULT_MODEL },
      started: undefined,
    });
    assert.deepEqual({ repo: ticket.repo, issue: ticket.issue, claim: ticket.claim, holdsRepo: ticket.holdsRepo, sessionName: ticket.asked.sessionName }, { repo: REPO, issue: 5, claim: true, holdsRepo: true, sessionName: sessionName(5, 'Issue 5') });
    assert.deepEqual({ ...spec, started: undefined }, {
      repo: REPO,
      issue: 9,
      claim: false,
      holdsRepo: true,
      asked: { prompt: waitSpecPrompt({ issue: 9, title: 'Issue 9', until: '2026-09-20', labels: SWEPT.labels, prompts: SWEPT.prompts as never }), sessionName: sessionName(9, 'Issue 9'), model: DEFAULT_MODEL },
      started: undefined,
    });
    assert.deepEqual(plan.unread, []);
  });

  test('a periodic\'s started records the fire over the record read and adds its heartbeat line, and a failed launch writes neither', async () => {
    const { ctx, fired, beats } = sweepContext();
    const plan = await planSweep(fire, ctx) as any;
    const periodic = plan.launches[0];
    await periodic.started({ outcome: 'failed', sessionUrl: null, status: 1, output: '' }, '2026-09-25T12:01:00.000Z');
    assert.deepEqual(fired, []);
    assert.deepEqual(beats, []);
    await periodic.started({ outcome: 'dispatched', sessionUrl: URL, status: 0, output: '' }, '2026-09-25T12:01:00.000Z');
    assert.deepEqual(fired, [{ repo: REPO, name: RETRO.name, read: LAST_FIRE, record: { at: '2026-09-25T12:01:00.000Z', session: URL, baseline: false } }]);
    assert.deepEqual(beats, [{ repo: REPO, beat: { periodics: [{ name: RETRO.name, at: '2026-09-25T12:01:00.000Z', by: { days: 7 }, session: URL, state: 'open' }] } }]);
  });

  test('an ended wait\'s started drops its item once the session started, and a failed launch leaves it', async () => {
    const { ctx, dropped } = sweepContext({ waits: [{ issue: 9, until: '2026-09-20' }] });
    const plan = await planSweep(fire, ctx) as any;
    const spec = plan.launches[2];
    await spec.started({ outcome: 'failed', sessionUrl: null, status: 1, output: '' }, '2026-09-25T12:01:00.000Z');
    assert.deepEqual(dropped, []);
    await spec.started({ outcome: 'unconfirmed', sessionUrl: null, status: null, output: '' }, '2026-09-25T12:01:00.000Z');
    assert.deepEqual(dropped, [{ repo: REPO, issue: 9, until: '2026-09-20' }]);
  });

  test('done records the sweep and adds pickup\'s heartbeat line once a launch started', async () => {
    const { ctx, swept, beats } = sweepContext();
    const plan = await planSweep(fire, ctx) as any;
    const [, ticket] = plan.launches;
    await plan.done({ dispatched: [ran(ticket, 'dispatched')], left: [] });
    assert.deepEqual(swept, [{ repo: REPO, at: new Date(NOW).toISOString() }]);
    assert.deepEqual(beats, [{ repo: REPO, beat: { pickup: { at: new Date(NOW).toISOString(), started: 1 } } }]);
    assert.deepEqual(plan.unread, []);
    assert.equal(plan.result.heartbeat, false, 'the { issue } shape\'s line is run\'s to write');
  });

  test('done leaves the sweep unrecorded where a ticket\'s launch failed or the window left it, and writes pickup\'s line all the same', async () => {
    for (const how of ['failed', 'left']) {
      const { ctx, swept, beats, logged } = sweepContext();
      const plan = await planSweep(fire, ctx) as any;
      const [periodic, ticket] = plan.launches;
      if (how === 'failed') await ticket.started({ outcome: 'failed', sessionUrl: null, status: 1, output: '' }, '2026-09-25T12:01:00.000Z');
      const dispatched = how === 'failed' ? [ran(periodic, 'dispatched'), ran(ticket, 'failed')] : [ran(periodic, 'dispatched')];
      await plan.done({ dispatched, left: how === 'left' ? [ticket] : [] });
      assert.deepEqual(swept, [], how);
      assert.ok(logged.some((l) => l.event === 'dispatch-pickup' && l.outcome === 'swept, with tickets left for the next fire, so not recorded'), how);
      assert.equal(beats.filter((b: any) => b.beat.pickup !== undefined).length, 1, how);
    }
  });

  test('done records nothing, and writes no pickup line, where every claim or launch failed', async () => {
    const { ctx, swept, beats } = sweepContext();
    const plan = await planSweep(fire, ctx) as any;
    const [periodic, ticket] = plan.launches;
    await plan.done({ dispatched: [ran(periodic, 'failed'), ran(ticket, 'failed')], left: [] });
    assert.deepEqual(swept, []);
    assert.deepEqual(beats, []);
  });

  test('a repo whose last sweep is too recent is not swept, and its periodics still plan', async () => {
    const { ctx, logged } = sweepContext();
    (ctx as any).state.sweep = async () => new Date(NOW - 60 * 60 * 1000).toISOString();
    const plan = await planSweep(fire, ctx) as any;
    assert.deepEqual(plan.launches.map((l: any) => l.issue), [null]);
    assert.ok(logged.some((l) => l.event === 'dispatch-pickup' && l.outcome === 'not due'));
  });

  test('with DispatchCap 0, plans nothing', async () => {
    const { ctx } = sweepContext({ over: { cap: 0 } });
    const plan = await planSweep(fire, ctx) as any;
    assert.deepEqual(plan.launches, []);
  });
});
