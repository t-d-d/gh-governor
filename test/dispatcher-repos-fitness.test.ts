/**
 * The dispatcher serves a repo only when an owner on its list installed the
 * App and the repo's default branch carries a valid config file, and a turn
 * acts only on its fire's repo (docs/constraints/dispatcher-repos.md).
 * These hold the rule across dispatch/repos.mjs,
 * dispatch/repo-config.mjs and dispatch/turn.mjs:
 *
 * - the factory's own config file passes the committed schema;
 * - a repo without the file, or with one that fails the schema, is not
 *   served;
 * - a turn calls GitHub only for its fire's repo (the bare schedule fire
 *   excepted), against a fake GitHub that fails any path under another;
 * - an unlisted owner's delivery queues nothing and logs no error, for every
 *   delivery shape the receiver routes (dispatch/webhook/route.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, GENERIC_SWITCHES, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
import { repoServed, servedRepos } from '../dispatch/repos.mjs';
import { run } from '../dispatch/turn.mjs';
import { githubReader } from '../scripts/lib/github-app.mjs';
import { storedLogin } from '../scripts/lib/claude-login.mjs';
import { createHmac } from 'node:crypto';
import { HOOK_EVENTS, handle, routeEvent } from '../dispatch/webhook/route.mjs';
import { PROMPTS, instruction } from '../dispatch/prompts.mjs';
import { planWorkflow, redRunPrompt } from '../dispatch/workflow.mjs';
import { handoffText, unreadText } from '../dispatch/handoff.mjs';
import { standingLine } from '../dispatch/deliveries.mjs';
import { promptFor } from '../scripts/lib/dispatch-prompt.mjs';
import { DEPENDABOT, UNATTENDED } from '../dispatch/webhook/fire.mjs';
import { conflictMessage } from '../dispatch/conflicts.mjs';
import { MESSAGE_RUN_URL as RUN_URL, MESSAGE_SHA as SHA, FACTORY_WORKFLOWS, coverageOver as coverageOf, mergedPull as pull } from './helpers/dispatch-workflows.ts';
import { factoryFile } from './helpers/factory.ts';

const FACTORY = 'acme/factory';
const ASKME = 't-d-d/askme-mcp';
const FACTORY_FILE = factoryFile(CONFIG_PATH);
const ASKME_FILE = JSON.stringify({ environment: 'env_01ASK', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { pickup: true, summons: true, prMessages: true, subscribeMessages: true } });
const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('fitness: the factory\'s config file, shaped like a served repo\'s, passes the committed schema (dispatcher-repos.md)', () => {
  test('every feature on', () => {
    const read = readConfig(FACTORY_FILE);
    assert.ok(read.ok, JSON.stringify(read));
    // Every switch the schema knows, not only the ones the file lists: a new
    // switch the file leaves out would read off.
    for (const name of GENERIC_SWITCHES) assert.equal(read.config.features[name], true, name);
  });
});

describe('fitness: a repo without the file, or with a file that fails the schema, is not served (dispatcher-repos.md)', () => {
  const reads = (file: string | null) => ({
    owners: ['acme', 't-d-d'],
    token: async () => 'ghs',
    config: async () => file,
    environments: async () => ({ environments: [{ environment_id: 'env_01ASK', name: 'askme' }] }),
    log: () => {},
  });

  test('by the bare schedule fire or a fire naming it', async () => {
    for (const file of [null, '{', '{}', JSON.stringify({ ...JSON.parse(ASKME_FILE), features: { heartbeat: true } }), JSON.stringify({ ...JSON.parse(ASKME_FILE), environment: 'nowhere' })]) {
      const listed = await servedRepos({ ...reads(file), installations: async () => [{ account: 't-d-d', repos: [ASKME] }] });
      assert.deepEqual(listed.served, [], String(file));
      assert.equal(await repoServed({ ...reads(file), repo: ASKME }), null, String(file));
    }
  });
});

/**
 * A fake GitHub over fetch: every path under a repo but `repo` fails and is
 * recorded; the rest answer as an empty repo with one ready ticket.
 */
const fakeGitHub = (repo: string, file: string) => {
  const strays: string[] = [];
  const seen: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? 'GET';
    seen.push(`${method} ${pathname}`);
    const under = /^\/repos\/([^/]+\/[^/]+)/.exec(pathname)?.[1];
    if (under !== undefined && under !== repo) {
      strays.push(`${method} ${pathname}`);
      return new Response('{"message":"another repo"}', { status: 500 });
    }
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const rest = pathname.slice(`/repos/${repo}`.length);
    if (rest === '/contents/.github/dispatch.json') return json({ type: 'file', encoding: 'base64', content: Buffer.from(file).toString('base64') });
    if (rest === '/issues' && method === 'GET') return json([{ number: 2, title: 'Issue 2', state: 'open', created_at: '2026-08-01T00:00:00Z', labels: JSON.parse(file).labels.ready.map((name: string) => ({ name })) }]);
    if (rest === '/issues/2' && method === 'GET') return json({ number: 2, title: 'Issue 2', state: 'open', body: '', labels: JSON.parse(file).labels.ready.map((name: string) => ({ name })) });
    if (/^\/labels\//.test(rest)) return json({ message: 'Not Found' }, 404);
    if (method === 'GET') return json([]);
    return json({});
  };
  return { strays, seen, fetch: fetch as unknown as typeof globalThis.fetch };
};

/** The turn's dependencies with GitHub real over `fetch`, everything else a fake. */
const depsOver = (fetch: typeof globalThis.fetch) => {
  const login = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'sk-ant-ort01-r', expiresAt: NOW + 3_600_000, scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'] } });
  let onDisk: string | null = null;
  const sleep = async () => {};
  return {
    owners: ['acme', 't-d-d'],
    installations: async () => { throw new Error('a fire naming its repo lists no installations'); },
    configFile: (repo: string, token: string) => githubReader({ token, repo, fetch, sleep }).configFile(),
    cap: 2,
    now: () => NOW,
    sleep,
    log: () => {},
    secret: { get: async () => storedLogin(login, { accountUuid: 'a', organizationUuid: 'o' }), put: async () => {} },
    githubToken: async () => 'ghs_t',
    appId: async () => 1,
    reader: (token: string, appId: number, repo: string) => githubReader({ token, repo, appId, fetch, sleep }),
    workspace: { prepare: () => {}, writeLogin: (t: string) => { onDisk = t; }, readLogin: () => onDisk, useAccount: () => {} },
    launch: async () => ({ status: 0, output: 'https://claude.ai/code/session_01ABC' }),
    probe: async () => ({ ok: true, detail: '' }),
    message: async () => ({ status: 0, output: JSON.stringify({ ok: true, session_id: 'session_01ABC' }) }),
    skill: () => '',
    review: async () => ({ status: 1, output: '' }),
    transcript: async () => ({ skipped: 'none' }),
    archive: async () => ({ status: 200, body: '{}' }),
    sessions: { list: async () => ({ data: [] }), get: async () => null, events: async () => ({ data: [] }) },
    state: { cursor: async () => null, advance: async () => true, delivered: async () => ({ told: [], failed: [] }), record: async () => {}, sweep: async () => null, recordSweep: async () => true },
  };
};

describe('fitness: a turn calls GitHub only for its fire\'s repo (dispatcher-repos.md)', () => {
  for (const [repo, file, fires] of [
    [ASKME, ASKME_FILE, [{ kind: 'schedule', repo: ASKME }, { kind: 'dispatch', repo: ASKME, prompt: 'hello' }, { kind: 'message', repo: ASKME, session: 'session_01ABC', text: 'hi' }]],
    [FACTORY, FACTORY_FILE, [{ kind: 'schedule', repo: FACTORY, issue: 2 }, { kind: 'review', repo: FACTORY, pr: 3 }, { kind: 'message', repo: FACTORY, session: 'session_01ABC', text: 'hi' }]],
  ] as const) {
    for (const fire of fires) {
      test(`${JSON.stringify(fire)} reads and writes under ${repo} alone`, async () => {
        const github = fakeGitHub(repo, file);
        await run(fire, depsOver(github.fetch) as never).catch(() => {});
        assert.deepEqual(github.strays, []);
        // The turn's error is swallowed: a turn that threw before reaching
        // GitHub would make no stray call and pass vacuously.
        assert.ok(github.seen.includes(`GET /repos/${repo}/contents/${CONFIG_PATH}`), `the turn never read its repo's config: ${github.seen.join('; ')}`);
        // A dispatch by hand reads its repo's config and launches: nothing more.
        if (fire.kind !== 'dispatch') assert.ok(github.seen.some((c) => !c.endsWith(`/contents/${CONFIG_PATH}`)), `the turn reached GitHub past its config read: ${github.seen.join('; ')}`);
      });
    }
  }

  // The stack names no repo of its own, so the bare fire has none to fall back to.
  test('the bare schedule fire sweeps the served repos the installations list, and no other', async () => {
    const github = fakeGitHub(ASKME, ASKME_FILE);
    const launched: string[] = [];
    await run({ kind: 'schedule' }, {
      ...depsOver(github.fetch),
      installations: async () => [{ account: 't-d-d', repos: [ASKME] }],
      launch: async ({ repo }: { repo: string }) => { launched.push(repo); return { status: 0, output: 'https://claude.ai/code/session_01ABC' }; },
    } as never);
    assert.deepEqual(github.strays, []);
    assert.deepEqual(launched, [ASKME]);
  });

  test('the fake fails a path under another repo, so a stray call is seen', async () => {
    const github = fakeGitHub(ASKME, ASKME_FILE);
    await run({ kind: 'schedule', repo: FACTORY }, depsOver(github.fetch) as never).catch(() => {});
    assert.ok(github.strays.length > 0);
  });
});

/**
 * An unlisted owner queues nothing (dispatcher-repos.md). The App is public, so
 * anyone can install it and its webhook delivers their events here: the
 * owner list is the one guard on the login's allowance. Every delivery shape
 * the receiver routes is replayed from an unlisted owner's repo, and must
 * queue no fire and log no error; each is first shown to queue one as
 * the factory's, so a fixture that routes nowhere cannot pass for a gated one.
 * HOOK_EVENTS names every event the App subscribes to, and each has a
 * fixture here, so a new event lands with one.
 */
describe('fitness: an unlisted owner queues nothing (dispatcher-repos.md)', () => {
  const SECRET = 'whsec_fitness';
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const OWNER = 'https://claude.ai/code/session_01OWNERAAA';
  const WATCHER = 'https://claude.ai/code/session_01WATCHES';
  const person = { login: 'someone', type: 'User' };
  const body = `The change.\n\n<!-- governor:subscribe ${WATCHER} -->\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${OWNER}`;
  const pr = { number: 12, title: 'A change', html_url: 'https://github.com/x/y/pull/12', body, head: { ref: 'claude/x', sha: SHA }, base: { ref: 'main' } };
  const prIssue = { number: 12, title: 'A change', html_url: 'https://github.com/x/y/pull/12', body, pull_request: { url: 'x' } };
  const issue = { number: 4, title: 'An issue', html_url: 'https://github.com/x/y/issues/4', body: `Filed.\n\n<!-- governor:subscribe ${WATCHER} -->\n\n${OWNER}`, labels: [], user: person, author_association: 'OWNER', assignees: [] };
  const mention = (over: Record<string, unknown> = {}) => ({ id: 7, body: '@claude look at this', html_url: 'https://github.com/x/y/issues/4#c7', user: person, author_association: 'MEMBER', ...over });
  const run = (over: Record<string, unknown>) => ({
    action: 'completed',
    workflow_run: { id: 500, name: 'CI', path: '.github/workflows/ci.yml', workflow_id: 77, head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/x/y/actions/runs/500', event: 'push', run_attempt: 1, ...over },
  });

  /** Every delivery shape the receiver routes to a fire, by event. */
  const FIXTURES: Record<string, Array<[string, Record<string, unknown>]>> = {
    issues: [
      ['ready label', { action: 'labeled', issue, label: { name: 'workflow: ready for development' }, sender: person }],
      ['label', { action: 'labeled', issue, label: { name: 'type: bug' }, sender: person }],
      ['unlabel', { action: 'unlabeled', issue, label: { name: 'type: bug' }, sender: person }],
      ['close', { action: 'closed', issue: { ...issue, state_reason: 'completed' }, sender: person }],
      ['reopen', { action: 'reopened', issue, sender: person }],
      ['opened mentioning', { action: 'opened', issue: { ...issue, body: '@claude fix this' }, sender: person }],
      ['assigned to claude', { action: 'assigned', issue, assignee: { login: 'claude' }, sender: person }],
    ],
    issue_comment: [
      ['mention', { action: 'created', issue, comment: mention() }],
      ['remark on a PR', { action: 'created', issue: prIssue, comment: mention({ body: 'A remark.' }) }],
    ],
    pull_request_review_comment: [
      ['remark', { action: 'created', pull_request: pr, comment: mention({ body: 'Inverted.', path: 'a.mjs', line: 1 }) }],
    ],
    pull_request_review: [
      ['review', { action: 'submitted', pull_request: pr, review: { id: 9, body: 'Changes.', state: 'changes_requested', html_url: 'x', user: person, author_association: 'OWNER' } }],
    ],
    pull_request: [
      ['opened', { action: 'opened', pull_request: pr, sender: person }],
      ['push', { action: 'synchronize', pull_request: pr, sender: person, before: 'b'.repeat(40), after: SHA }],
      ['merge', { action: 'closed', pull_request: { ...pr, merged: true, merge_commit_sha: SHA }, sender: person }],
      ['close', { action: 'closed', pull_request: { ...pr, merged: false }, sender: person }],
    ],
    workflow_run: [
      ['red on main', run({})],
      ['scheduled red', run({ event: 'schedule' })],
      ['branch run', run({ event: 'workflow_dispatch', head_branch: 'claude/x', conclusion: 'success' })],
    ],
    workflow_job: [
      ['shipping job', { action: 'completed', workflow_job: { id: 9001, run_id: 500, run_attempt: 1, head_sha: SHA, head_branch: 'main', name: 'dev / Publish (dev) · deployed: dev', workflow_name: 'Deliver', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/y/actions/runs/500/job/9001' } }],
    ],
  };

  const from = (repo: string, payload: Record<string, unknown>) => ({ ...payload, repository: { full_name: repo, html_url: `https://github.com/${repo}`, default_branch: 'main' } });

  test('every event the App subscribes to has a fixture', () => {
    assert.deepEqual(Object.keys(FIXTURES).sort(), [...HOOK_EVENTS].sort());
  });

  for (const [event, fixtures] of Object.entries(FIXTURES)) {
    for (const [what, payload] of fixtures) {
      test(`${event} ${what}: queues as the factory's, and nothing from an unlisted owner, at info`, async () => {
        const owners = ['acme', 't-d-d'];
        assert.ok(routeEvent({ event, payload: from(FACTORY, payload), owners }).fires.length > 0, `the fixture routes nowhere as the factory's: ${routeEvent({ event, payload: from(FACTORY, payload), owners }).reason}`);
        const queued: unknown[] = [];
        const logged: Array<Record<string, unknown>> = [];
        const raw = JSON.stringify(from('stranger/repo', payload));
        const response = await handle({
          headers: { 'x-github-event': event, 'x-github-delivery': 'd-1', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` },
          body: raw,
        }, {
          secret: async () => SECRET,
          hookSecret: async () => SECRET,
          owners,
          appId: 1,
          enqueue: async (message) => { queued.push(message); return 'm'; },
          log: (name, context = {}) => { logged.push({ event: name, ...context }); },
        });
        assert.ok(response.statusCode >= 200 && response.statusCode < 300, String(response.statusCode));
        assert.deepEqual(queued, []);
        assert.ok(logged.every((l) => l.level === 'info'), JSON.stringify(logged));
      });
    }
  }
});

/**
 * A served repo's file may replace the instruction in each message kind,
 * and the dispatcher keeps the facts. Each kind is built here
 * through the code that sends it, once with a sentinel prompt: the sentinel
 * is in, the facts are in, the default is out.
 */
const PROD = 'deployed: prod';
/** A red run of CI or Deliver, which the factory's file names its CI and its triage target's workflow. */
const red = (name: string) => ({ kind: 'workflow', name, path: `.github/workflows/${name === 'CI' ? 'ci' : 'deliver'}.yml`, branch: 'main', event: 'push', runId: 500, url: RUN_URL, conclusion: 'failure', headSha: SHA });
const shipped = { kind: 'job', name: 'Publish', workflow: 'Deliver', branch: 'main', runId: 500, jobId: 1, url: `${RUN_URL}/job/1`, headSha: SHA, label: 'deployed: dev', commit: SHA };
const plan = async (invocation: unknown, coverage: unknown, prompts: Record<string, string>) => planWorkflow({ invocation: invocation as never, coverage: coverage as never, prompts, workflows: FACTORY_WORKFLOWS });
const note = async (invocation: unknown, coverage: unknown, prompts: Record<string, string>) => (await plan(invocation, coverage, prompts)).notes[0]!.text;
const triage = async (invocation: unknown, coverage: unknown, prompts: Record<string, string>) => (await plan(invocation, coverage, prompts)).triage!.prompt;
const ticket = (number: number) => ({ number, title: `Ticket ${number}`, state: 'open', body: '', labels: [], pull: false });
const RUN_FACTS = [RUN_URL, 'backend'];

/** Every kind: the message built with `prompts`, and the facts it carries whatever the prompt. */
const KINDS: Record<string, { build: (prompts: Record<string, string>) => Promise<string> | string, facts: string[] }> = {
  pickup: { build: (p) => promptFor(7, 'Title', FACTORY, 'claimed', p), facts: ["Pickup #7 'Title'"] },
  signOff: { build: (p) => standingLine([], { repo: FACTORY, closing: true, prompts: p }), facts: ['No other open PR or issue in acme/factory names this session.'] },
  mergeHandoff: { build: (p) => String(handoffText([{ closed: 5, waiting: [ticket(6)], freed: [ticket(8)] }], FACTORY, p, JSON.parse(FACTORY_FILE).labels)), facts: ['#5 blocked:', '#6: Ticket 6', '#8: Ticket 8'] },
  mergeHandoffUnread: { build: (p) => unreadText('HTTP 502', p), facts: ['HTTP 502'] },
  redScheduledRun: { build: (p) => redRunPrompt('A scheduled run of Emulator on main ended failure.', p), facts: ['A scheduled run of Emulator on main ended failure.', UNATTENDED] },
  ciBreaker: { build: (p) => note(red('CI'), coverageOf([pull(1)]), p), facts: [...RUN_FACTS, 'PR #1: PR 1'] },
  ciTriage: { build: (p) => triage(red('CI'), coverageOf([pull(1), pull(2)]), p), facts: [...RUN_FACTS, 'PR #1: PR 1', 'PR #2: PR 2', UNATTENDED] },
  ciBumpTriage: { build: (p) => triage(red('CI'), coverageOf([pull(1, DEPENDABOT)]), p), facts: [...RUN_FACTS, 'PR #1: PR 1', UNATTENDED] },
  prodTriage: { build: (p) => triage(red('Deliver'), coverageOf([pull(1)], { label: PROD }), p), facts: [...RUN_FACTS, 'PR #1: PR 1', UNATTENDED] },
  deployGreen: { build: (p) => note(shipped, coverageOf([pull(1)], { label: 'deployed: dev' }), p), facts: ['PR #1: PR 1', 'Your change is on dev'] },
  deployGreenMany: { build: (p) => note(shipped, coverageOf([pull(1), pull(2)], { label: 'deployed: dev' }), p), facts: ['PR #1: PR 1', 'PR #2: PR 2', 'Your changes are on dev'] },
  deployRed: { build: (p) => note(red('Deliver'), coverageOf([pull(1)], { label: 'deployed: dev' }), p), facts: [...RUN_FACTS, 'PR #1: PR 1'] },
  deployRedMany: { build: (p) => note(red('Deliver'), coverageOf([pull(1), pull(2)], { label: 'deployed: dev' }), p), facts: [...RUN_FACTS, 'PR #1: PR 1', 'PR #2: PR 2'] },
  subscribed: { build: (p) => note(shipped, coverageOf([pull(1)], { label: 'deployed: dev', subscribed: true }), p), facts: ['PR #1: PR 1', 'which you subscribe to'] },
  conflicts: {
    build: (p) => { const m = conflictMessage({ pr: { number: 1, title: 'PR 1', html_url: 'u1' }, base: 'main', head: 'c'.repeat(40), merged: { pr: 2, sha: SHA } }, p); assert.ok(m.fallback.prompt.includes(m.text.split('\n\n')[1]!), 'the fallback carries the instruction'); return m.text; },
    facts: ['PR #1 (PR 1, u1)', 'c'.repeat(40), '#2 merged', SHA],
  },
};

describe('fitness: a prompt replaces only the instruction (dispatcher-repos.md)', () => {
  test('every message kind the schema names is built here', () => {
    assert.deepEqual(Object.keys(KINDS).sort(), Object.keys(PROMPTS).sort());
  });

  for (const [kind, { build, facts }] of Object.entries(KINDS)) {
    test(`${kind}: the prompt replaces the default, and the facts stay`, async () => {
      const fills = PROMPTS[kind]!.fills.map((f) => `{${f}}`).join(' ');
      const sentinel = `SENTINEL ${kind} ${fills}`.trim();
      const text = await build({ [kind]: sentinel });
      assert.ok(text.includes(`SENTINEL ${kind}`), text);
      assert.doesNotMatch(text, /\{[a-z]+\}/, 'every fact the prompt names is written in');
      for (const fact of facts) assert.ok(text.includes(fact), `${fact} missing from ${text}`);
      assert.ok(!text.includes(instruction({}, kind as never, {}).split('{')[0]!), `the default is still in: ${text}`);
      const byDefault = await build({});
      for (const fact of facts) assert.ok(byDefault.includes(fact), `${fact} missing from ${byDefault}`);
    });
  }
});

describe('fitness: every prompt key has a default, and the defaults are generic (dispatcher-repos.md)', () => {
  test('each default names no repo\'s skill, file or section', () => {
    for (const [kind, { text }] of Object.entries(PROMPTS)) {
      assert.ok(text.trim() !== '', kind);
      assert.doesNotMatch(text, /CLAUDE\.md|§|skill|docs\/|origin\/main|Verification table|gh-deps|workflow: /i, kind);
    }
  });
});

/**
 * A repo's prompts reach its messages word for word: each instruction, from
 * the factory's file, as the code writes it.
 */
const FACTORY_LOGS = "Read the failed jobs' logs (the ops-tooling skill says how) and find the cause.";
const FACTORY_TEXTS: Record<string, [Record<string, string | number>, string]> = {
  pickup: [{ issue: 7, repo: FACTORY, claim: 'workflow: under development' }, 'Implement GitHub issue #7 in acme/factory through to a reviewable PR.\nThe dispatcher claimed #7 for this session: it is `workflow: under development` for you, so proceed on it.\nUnattended session: push and raise the PR without asking, `Closes #7`.'],
  signOff: [{}, 'Sign this session off unless you know otherwise (work not on GitHub or in another repo, a check you still owe, or the operator is working with you in this session, which is theirs to end): make `Signing off.` the last line of your reply, and the dispatcher archives the session. Above it, write any `Lesson:` lines CLAUDE.md § Lessons calls for; usually there are none.'],
  mergeHandoff: [{}, "For each ticket waiting on you (CLAUDE.md § After your PR merges): rewrite what waited from the code that merged, drop the `Spec waits until` line and mark it `workflow: ready for development`. A decision only a person can make goes into its body as a question instead, and it stays unlabelled.\nFor each started or ready one: if the merge contradicts its spec, fix its body. If it is `workflow: under development`, message its session too (the dispatcher's marker comment on the ticket names it)."],
  mergeHandoffUnread: [{}, 'Read them yourself (`gh-deps list-blocking <n>`, the issue-dependencies skill) and follow CLAUDE.md § After your PR merges.'],
  redScheduledRun: [{}, `${FACTORY_LOGS} Read the docs/constraints/ files that name the workflow file before re-running it: some tiers limit how soon one run may follow another. First search the open issues and PRs for it: if one already covers this failure, comment this run on it and stop. If the fix is in the repo, push it on a new branch from origin/main with a new PR. If it is not (a lapsed credential, a third-party outage), raise an issue saying what failed and what it needs.`],
  ciBreaker: [{ pr: 9 }, `${FACTORY_LOGS} If the cause is in your change, push the fix on a new branch from origin/main with a new PR: PR #9 is merged and its branch is done. If it is not, comment on PR #9 with what you found instead.`],
  ciTriage: [{}, `${FACTORY_LOGS} Work out which merge caused it, and push the fix on a new branch from origin/main with a new PR naming that PR. Then comment on the culprit PR with what broke and a link to your fix.`],
  ciBumpTriage: [{ pr: 9 }, `${FACTORY_LOGS} If the bump caused it, push the fix on a new branch from origin/main with a new PR naming PR #9: the change the new version needs. Where none is in reach, revert the bump in that PR instead and raise an issue naming the bump and what broke, since Dependabot raises it again. Then comment on PR #9 with what broke and a link to your fix. If the bump did not cause it, comment on PR #9 with what you found instead.`],
  prodTriage: [{}, `${FACTORY_LOGS} If a merge caused it, push the fix on a new branch from origin/main with a new PR naming that PR, and comment on it with what broke and a link to your fix. If none did (a prod-only secret, store or quota), raise an issue saying what broke and what the operator must do.`],
  deployGreen: [{ pr: 9, target: 'dev' }, "Run what your PR's Verification table promised at `dev deploy`, if anything, and report the result on PR #9. If it promised nothing there, nothing is owed."],
  deployGreenMany: [{ pr: 9, target: 'dev' }, 'Run what their Verification tables promised at `dev deploy`, if anything, and report the results in one comment on PR #9, the newest. If none promised anything there, nothing is owed.'],
  deployRed: [{ pr: 9 }, `${FACTORY_LOGS} If your change caused it, push the fix on a new branch from origin/main with a new PR. If it did not, nothing is owed; say what you found on PR #9.`],
  deployRedMany: [{ pr: 9 }, `${FACTORY_LOGS} If one of your changes caused it, push the fix on a new branch from origin/main with a new PR. If none did, nothing is owed; say what you found in one comment on PR #9, the newest.`],
  subscribed: [{}, 'Act only on what is yours: a check you promised, a change of yours this bears on.'],
  conflicts: [{ base: 'main' }, 'Merge main into your branch, resolve the conflicts, run the checks and push.'],
};

/** The factory's file as a turn serves it: its prompt files read off the checkout, as off the default branch. */
const FACTORY_SERVED = await (async () => {
  const read = readConfig(FACTORY_FILE);
  assert.ok(read.ok, JSON.stringify(read));
  const resolved = await resolveFiles(read.config, async (path) => factoryFile(path));
  assert.ok(resolved.ok, JSON.stringify(resolved));
  return resolved;
})();

describe('fitness: a repo\'s prompts reach its messages word for word (dispatcher-repos.md)', () => {
  const read = FACTORY_SERVED;
  test('every kind is pinned', () => {
    assert.deepEqual(Object.keys(FACTORY_TEXTS).sort(), Object.keys(PROMPTS).sort());
  });
  for (const [kind, [fills, want]] of Object.entries(FACTORY_TEXTS)) {
    test(kind, () => assert.equal(instruction(read.config.prompts, kind as never, fills), want));
  }
});
