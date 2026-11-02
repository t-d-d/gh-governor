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
    const ticket = { number: 7, title: 'Issue 7', body: '', state: 'open', labels, pull: false };
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
