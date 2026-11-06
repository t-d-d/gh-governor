/**
 * A summons on an issue (#541, under PRD #535): an `@claude` comment, or the
 * ticket assigned to `claude`, is judged by `trust.start` first, as before.
 * Where the ticket's spec owner or any of its builders is live, it starts
 * nothing: each live role gets a notice, and hears the comment itself as
 * any comment. Whether a role is live is learned by sending: a session that
 * refuses as archived leaves its role vacant. Where neither role is live,
 * `trust.task` judges as before, and one fresh session starts, whose link
 * governor writes into the ticket's body as its owner link, so the next
 * summons reaches it.
 *
 * The receiver carries the ticket's state, labels and spec owner on the
 * summons fire, read from the payload, as it does on a ticket fire.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, type RepoConfig } from '../dispatch/repo-config.mjs';
import { planDispatch } from '../dispatch/dispatch-fire.mjs';
import { launchPlan } from '../dispatch/launch-plan.mjs';
import { dispatchMarker, parseFire } from '../dispatch/webhook/fire.mjs';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { relinkSession, sessionNamedIn } from '../dispatch/webhook/subscribe.mjs';
import { factoryFile } from './helpers/factory.ts';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const APP_ID = 4242;
const FILE = JSON.parse(factoryFile('.github/governor.json'));
const configOf = (file: Record<string, unknown>) => {
  const read = readConfig(JSON.stringify(file));
  assert.ok(read.ok, JSON.stringify(read));
  return read.config as RepoConfig;
};
const CONFIG = configOf(FILE);
const CLAIM = CONFIG.labels.claim;
const SPEC = 'https://claude.ai/code/session_01SPECOWNER';
const BUILDER = 'https://claude.ai/code/session_01BUILDER';
const FRESH = 'https://claude.ai/code/session_01FRESH';
const MARKER = dispatchMarker({ at: new Date(NOW - 60_000).toISOString(), sessionUrl: BUILDER });
const SPEC_BODY = `The spec.\n\n${SPEC}`;

/** An issue as a webhook payload carries it. */
const issue = ({ body = SPEC_BODY, labels = ['mode: afk'], state = 'open' } = {}) => ({
  number: 7,
  title: 'A ticket',
  body,
  state,
  html_url: `https://github.com/${REPO}/issues/7`,
  labels: labels.map((name) => ({ name })),
  user: { login: 'tdickinson', type: 'User' },
  author_association: 'OWNER',
  assignees: [],
});

/** The one dispatch fire a delivery routes to, as the lane would carry it. */
const summonsOf = (event: string, payload: Record<string, unknown>) => {
  const routed = routeEvent({ event, owners: ['acme'], appId: APP_ID, payload: { repository: { full_name: REPO }, ...payload } });
  const found = routed.fires.map((f) => f.fire as Record<string, unknown>).filter((f) => f.kind === 'dispatch');
  assert.equal(found.length, 1, JSON.stringify(routed));
  return parseFire(found[0]) as unknown as Record<string, unknown>;
};

/** An `@claude` comment on ticket 7 by `writer`. */
const commented = (over: Parameters<typeof issue>[0] = {}, writer = 'OWNER') => summonsOf('issue_comment', {
  action: 'created',
  issue: issue(over),
  comment: { id: 91, body: '@claude does this need the empty case too?', html_url: `https://github.com/${REPO}/issues/7#issuecomment-91`, user: { login: 'pat', type: 'User' }, author_association: writer },
});

/** Ticket 7 assigned to `claude` by `pat`. */
const assigned = (over: Parameters<typeof issue>[0] = {}) => summonsOf('issues', {
  action: 'assigned',
  issue: issue(over),
  assignee: { login: 'claude', type: 'User' },
  sender: { login: 'pat', type: 'User' },
});

type Sent = { session: string, text: string, opts: Record<string, unknown> };

/**
 * A `TurnContext` whose reader holds ticket 7: `comments` its thread,
 * `closing` the open PRs that close it, `owners` each PR's owner.
 * `archived` sessions refuse; `faulted` ones fail without a refusal.
 */
const context = ({ config = CONFIG, comments = [{ body: MARKER }] as Array<{ body: string }>, closing = [] as number[], owners = {} as Record<number, string>, archived = [] as string[], faulted = [] as string[], fails = null as string | null, body = SPEC_BODY } = {}) => {
  const sent: Sent[] = [];
  const reads: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const written: Array<{ op: string, issue: number, text: string }> = [];
  const started: Array<Record<string, unknown>> = [];
  const failing = (name: string) => { if (fails === name) throw new Error('HTTP 502'); };
  const reader = {
    openClosing: async (n: number) => { reads.push(`open closing ${n}`); failing('openClosing'); return closing.map((number) => ({ number, title: `PR ${number}`, html_url: `u${number}` })); },
    closure: async (n: number) => { reads.push(`closure ${n}`); return { pr: null }; },
    allComments: async (n: number) => { reads.push(`thread ${n}`); failing('allComments'); return comments.map((c) => ({ ...c, ours: true })); },
    issue: async (n: number) => { reads.push(`issue ${n}`); return { number: n, body, pull: false }; },
    updateIssue: async (n: number, { body: text }: { body: string }) => { written.push({ op: 'body', issue: n, text }); },
    comment: async (n: number, text: string) => { written.push({ op: 'comment', issue: n, text }); },
  };
  const ctx = {
    readerFor: async () => reader,
    configOf: () => config,
    served: [],
    bare: false,
    prompts: config.prompts,
    delivery: () => ({
      ownerOf: async (pr: number) => ({ session: owners[pr] ?? null }),
      deliver: async ({ session }: { session: string }, text: string, opts: Record<string, unknown>) => {
        sent.push({ session, text, opts });
        const gone = archived.includes(session);
        const faults = faulted.includes(session);
        return { ok: !gone && !faults, answered: !faults, refused: gone, sessionUrl: session, error: gone ? `cloud session ${session} is archived and cannot accept new messages` : faults ? 'claude exited 1: HTTP 503' : null, fallback: null, dropped: null, skipped: null, relinked: null };
      },
    }),
    storeLogin: async () => true,
    state: {},
    start: async (asked: Record<string, unknown>) => { started.push(asked); return { outcome: 'dispatched', sessionUrl: FRESH, status: 0, output: '' }; },
    open: async () => true,
    claims: new Set<string>(),
    beats: [],
    now: () => NOW,
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    sleep: async () => {},
    cap: 2,
  };
  return { ctx: ctx as never, sent, reads, logged, written, started };
};

const to = (sent: Sent[]) => sent.map((s) => s.session);

describe('a summons on an issue: the receiver carries the ticket', () => {
  test('an @claude comment on an issue names its state, labels and spec owner', () => {
    const fire = commented({ labels: [CLAIM] });
    assert.deepEqual(fire.ticket, { state: 'open', labels: [CLAIM], owner: SPEC });
    assert.equal(fire.on, 7);
  });

  test('an assignment to claude names them too', () => {
    const fire = assigned();
    assert.deepEqual(fire.ticket, { state: 'open', labels: ['mode: afk'], owner: SPEC });
    assert.equal(fire.assigner, 'pat');
  });

  test('a person\'s issue that names no session carries no spec owner', () => {
    assert.deepEqual(commented({ body: 'Please look at the empty case.' }).ticket, { state: 'open', labels: ['mode: afk'] });
  });

  test('a summons on a PR carries no ticket', () => {
    const fire = summonsOf('issue_comment', {
      action: 'created',
      issue: { ...issue({ body: 'A PR naming no session.' }), pull_request: { url: 'p' } },
      comment: { id: 92, body: '@claude why?', html_url: 'h', user: { login: 'pat', type: 'User' }, author_association: 'OWNER' },
    });
    assert.equal(fire.ticket, undefined);
  });
});

describe('a summons on an issue starts nothing beside a live spec owner or builder', () => {
  test('an @claude comment on a ticket whose spec owner is live starts no session, and the spec owner hears of it', async () => {
    const { ctx, sent, reads } = context();
    const plan = await planDispatch(commented() as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(to(sent), [SPEC]);
    assert.match(sent[0]!.text, /no session starts/i);
    assert.match(sent[0]!.text, /You are its spec owner\./);
    assert.deepEqual(sent[0]!.opts.on, [7]);
    assert.deepEqual(reads, [], 'an unclaimed ticket\'s spec owner is the only role: nothing is read');
    assert.equal(plan.result.messaged.ok, true);
  });

  test('on a claimed ticket whose builder is live and spec owner archived, no session starts and the builder hears of it', async () => {
    const { ctx, sent } = context({ archived: [SPEC] });
    const plan = await planDispatch(commented({ labels: [CLAIM] }) as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(to(sent), [SPEC, BUILDER]);
    assert.match(sent[1]!.text, /You are its builder\./);
  });

  test('on a claimed ticket a person wrote, a live builder alone keeps a session from starting', async () => {
    const { ctx, sent } = context();
    const plan = await planDispatch(commented({ body: 'Please look at the empty case.', labels: [CLAIM] }) as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(to(sent), [BUILDER]);
  });

  test('a builder found by its open PR is sent with the PR, so the session on its branch can take it', async () => {
    const PR_OWNER = 'https://claude.ai/code/session_01PROWNER';
    const { ctx, sent } = context({ closing: [12], owners: { 12: PR_OWNER }, archived: [SPEC] });
    const plan = await planDispatch(commented({ labels: [CLAIM] }) as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(to(sent), [SPEC, PR_OWNER]);
    assert.deepEqual(sent[1]!.opts.owns, [12]);
  });

  test('an assignment to claude follows the same rule, and the notice names who assigned it', async () => {
    const { ctx, sent } = context();
    const plan = await planDispatch(assigned() as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(to(sent), [SPEC]);
    assert.match(sent[0]!.text, /pat assigned #7 to claude/);
  });

  test('an assignment to claude on a claimed ticket whose roles are archived starts one session', async () => {
    const { ctx } = context({ archived: [SPEC, BUILDER] });
    const plan = await planDispatch(assigned({ labels: [CLAIM] }) as never, ctx) as any;
    assert.equal(plan.launches.length, 1);
  });
});

describe('a summons on an issue where neither role is live', () => {
  test('one session starts on the ticket, unclaimed, and its link becomes the body\'s owner link', async () => {
    const { ctx, sent, written, started } = context({ archived: [SPEC] });
    const plan = await planDispatch(commented() as never, ctx) as any;
    assert.deepEqual(to(sent), [SPEC]);
    assert.equal(plan.launches.length, 1);
    assert.equal(plan.launches[0].issue, 7);
    assert.equal(plan.launches[0].claim, false);
    await launchPlan(plan, ctx, NOW);
    assert.equal(started.length, 1);
    const body = written.find((w) => w.op === 'body');
    assert.ok(body !== undefined, JSON.stringify(written));
    assert.equal(body.text, relinkSession(SPEC_BODY, FRESH));
    assert.ok(!written.some((w) => w.op === 'comment'), 'a summoned session is the spec owner, and leaves no dispatch comment');
  });

  test('a second @claude then reaches the session it started, and starts no other', async () => {
    const body = relinkSession(SPEC_BODY, FRESH);
    assert.equal(sessionNamedIn(body), FRESH);
    const { ctx, sent } = context({ archived: [SPEC], body });
    const plan = await planDispatch(commented({ body }) as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(to(sent), [FRESH]);
  });

  test('on a person\'s issue that names no session, one session starts, nobody is sent anything, and its link is written into the body', async () => {
    const PERSON = 'Please look at the empty case.';
    const { ctx, sent, reads, written } = context({ body: PERSON });
    const plan = await planDispatch(commented({ body: PERSON }) as never, ctx) as any;
    assert.deepEqual(sent, []);
    assert.deepEqual(reads, []);
    assert.equal(plan.launches.length, 1);
    await launchPlan(plan, ctx, NOW);
    assert.equal(sessionNamedIn(written.find((w) => w.op === 'body')!.text), FRESH);
  });

  test('on a claimed ticket whose builder and spec owner are both archived, one session starts', async () => {
    const { ctx, sent } = context({ archived: [SPEC, BUILDER] });
    const plan = await planDispatch(commented({ labels: [CLAIM] }) as never, ctx) as any;
    assert.deepEqual(to(sent), [SPEC, BUILDER]);
    assert.equal(plan.launches.length, 1);
  });

  test('trust.task still judges the author where neither role is live', async () => {
    const config = configOf({ ...FILE, trust: { task: ['MEMBER'] } });
    const { ctx, sent, written } = context({ config, archived: [SPEC] });
    const plan = await planDispatch(commented() as never, ctx) as any;
    assert.deepEqual(to(sent), [SPEC]);
    assert.deepEqual(plan.launches, []);
    assert.equal(written.filter((w) => w.op === 'comment').length, 1);
  });

  test('a live spec owner keeps a session from starting even where trust.task would refuse the author', async () => {
    const config = configOf({ ...FILE, trust: { task: ['MEMBER'] } });
    const { ctx, sent, written } = context({ config });
    const plan = await planDispatch(commented() as never, ctx) as any;
    assert.deepEqual(to(sent), [SPEC]);
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(written, []);
  });
});

describe('a summons on an issue that reaches no session', () => {
  test('one trust.start refuses reaches no session and starts nothing, as before', async () => {
    const config = configOf({ ...FILE, trust: { start: ['OWNER'] } });
    const { ctx, sent, written } = context({ config, comments: [] });
    const plan = await planDispatch(commented({}, 'COLLABORATOR') as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(sent, []);
    assert.equal(written.filter((w) => w.op === 'comment').length, 1);
  });

  test('a builder lookup that fails starts nothing and fails the turn', async () => {
    const { ctx, sent } = context({ fails: 'openClosing', archived: [SPEC] });
    const plan = await planDispatch(commented({ labels: [CLAIM] }) as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(sent, []);
    assert.equal(plan.result.messaged.ok, false);
    assert.match(String(plan.result.messaged.error), /502/);
  });

  test('a send that fails without a refusal starts nothing beside a session that may be live, and fails the turn', async () => {
    const { ctx } = context({ faulted: [SPEC] });
    const plan = await planDispatch(commented() as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.equal(plan.result.messaged.ok, false);
    assert.equal(plan.result.messaged.refused, false);
  });

  test('a writer trust.relay leaves out reaches no role, and nothing starts beside a role the ticket names', async () => {
    const config = configOf({ ...FILE, trust: { relay: ['OWNER', 'BOT'], task: ['OWNER'] } });
    const { ctx, sent } = context({ config });
    const plan = await planDispatch(commented({}, 'MEMBER') as never, ctx) as any;
    assert.deepEqual(plan.launches, []);
    assert.deepEqual(sent, []);
  });

  test('a fire queued before the receiver named the ticket starts a session as before', async () => {
    const { ctx, sent } = context();
    const { ticket: _ticket, ...old } = commented();
    const plan = await planDispatch(old as never, ctx) as any;
    assert.deepEqual(sent, []);
    assert.equal(plan.launches.length, 1);
    assert.equal(plan.launches[0].issue, null);
  });
});
