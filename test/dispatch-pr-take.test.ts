/**
 * A live PR owner's link written back (#615, under PRD #599). A
 * `pull_request` `edited` delivery, sent by no bot, whose old body names
 * session A and whose new body names B, where B is not A, moved the PR's
 * session link. With `prMessages` and `sessionRules` both on, the receiver
 * queues a `prEdit` fire:
 *
 * - A is sent a notice that its PR's body was edited and its link moved;
 * - where A refuses as archived, nothing is written, and B owns the PR by
 *   its link, as at a takeover;
 * - where A takes the notice, governor reads the body again and, where its
 *   link still names B, writes A's link back and tells B once.
 *
 * With either switch off, the receiver queues nothing for the edit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handle } from '../dispatch/webhook/route.mjs';
import { build, parseFire } from '../dispatch/webhook/fire.mjs';
import { droppedBy, switchesOf } from '../dispatch/webhook/switches.mjs';
import { relinkSession, sessionNamedIn } from '../dispatch/webhook/subscribe.mjs';
import { SWITCHES, readConfig, type RepoConfig } from '../dispatch/repo-config.mjs';
import { correctionText, planPrEdit, prEditText } from '../dispatch/take.mjs';
import { SESSION_RULES } from '../dispatch/session-rules.mjs';
import { exitCodeFor } from '../dispatch/cli.mjs';
import { factoryFile } from './helpers/factory.ts';

const SECRET = 'whsec_test';
const REPO = 'acme/factory';
const APP_ID = 5075844;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const CONFIG = (() => {
  const read = readConfig(factoryFile('.github/governor.json'));
  assert.ok(read.ok);
  return read.config as RepoConfig;
})();
const OWNER = 'https://claude.ai/code/session_01OWNER';
const EDITOR = 'https://claude.ai/code/session_01EDITOR';
const OTHER = 'https://claude.ai/code/session_01OTHER';
const member = { login: 't-d-d', type: 'User' };
const app = { login: 'governor-app[bot]', type: 'Bot' };
const at = { full_name: REPO, default_branch: 'main' };

const pr = (session: string, words = 'The work.') => `${words}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${session}`;
const OWNED = pr(OWNER);
/** The editor's body: the description changed, and the editor's link at its end. */
const TAKEN = pr(EDITOR, 'The work, described again.');

const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

const edited = ({ from = OWNED as string | null, body = TAKEN, sender = member as Record<string, unknown>, state = 'open' } = {}) => ({
  action: 'edited',
  number: 12,
  changes: from === null ? { title: { from: 'Old' } } : { body: { from } },
  pull_request: {
    number: 12,
    state,
    title: 'Build the ticket',
    html_url: `https://github.com/${REPO}/pull/12`,
    body,
    user: member,
    author_association: 'OWNER',
    head: { ref: 'claude/owner', sha: 'a'.repeat(40) },
    base: { ref: 'main' },
    merged: false,
  },
  repository: at,
  sender,
});

/** The hook-table item the task writes: every switch on but `off`. */
const item = (off: string[] = []) => async () => ({
  switches: new Map(SWITCHES.map((name) => [name, !off.includes(name)])),
  ready: ['mode: afk'],
  claim: CONFIG.labels.claim,
});

const handled = async (payload: unknown, repoItem: () => Promise<unknown> = item()) => {
  const queued: Array<Record<string, any>> = [];
  const deps = {
    secret: async () => SECRET,
    hookSecret: async () => 'hook-secret',
    listedHooks: async () => null,
    countFire: async () => 'counted' as const,
    repoItem,
    owners: ['acme'],
    appId: APP_ID,
    enqueue: async (message: Record<string, unknown>) => { queued.push(message); return `m-${queued.length}`; },
    log: () => {},
  };
  const body = JSON.stringify(payload);
  await handle({ headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body), 'x-github-delivery': 'd-1' }, body, isBase64Encoded: false } as never, deps as never);
  return queued.map((q) => q.fire as Record<string, any>).filter((f) => f.kind === 'prEdit');
};

describe('the receiver: a PR body edit that moves the session link', () => {
  test('queues a prEdit fire naming the PR, the old owner and the editor', async () => {
    const [fire, ...more] = await handled(edited());
    assert.deepEqual(more, []);
    assert.equal(fire?.pr, 12);
    assert.equal(fire?.from, OWNER);
    assert.equal(fire?.to, EDITOR);
    assert.equal(fire?.repo, REPO);
    assert.deepEqual(parseFire(fire), fire);
  });

  test('governor\'s own relink, or any bot\'s edit, queues nothing', async () => {
    assert.deepEqual(await handled(edited({ sender: app })), []);
    assert.deepEqual(await handled(edited({ from: TAKEN, body: OWNED, sender: app })), []);
  });

  test('an edit that leaves the link, removes it, or adds one to a body that named none queues nothing', async () => {
    assert.deepEqual(await handled(edited({ body: pr(OWNER, 'The work, again.') })), []);
    assert.deepEqual(await handled(edited({ body: 'The work, unsigned.' })), []);
    assert.deepEqual(await handled(edited({ from: 'The work, as a person wrote it.' })), []);
    assert.deepEqual(await handled(edited({ from: null })), []);
  });

  test('with sessionRules or prMessages off, nothing is queued for the edit', async () => {
    assert.deepEqual(await handled(edited(), item(['sessionRules'])), []);
    assert.deepEqual(await handled(edited(), item(['prMessages'])), []);
    assert.equal((await handled(edited(), item(['subscribeMessages']))).length, 1);
  });
});

describe('a prEdit fire', () => {
  const fire = { ...build.prEdit({ pr: 12, from: OWNER, to: EDITOR, authors: ['OWNER'] }), repo: REPO };

  test('round-trips, and is refused without a PR, an old owner or an editor', () => {
    assert.deepEqual(parseFire(JSON.parse(JSON.stringify(fire))), fire);
    assert.throws(() => parseFire({ ...fire, pr: 0 }), /pr/);
    assert.throws(() => parseFire({ ...fire, from: 'nobody' }), /from/);
    assert.throws(() => parseFire({ ...fire, to: undefined }), /to/);
  });

  test('needs prMessages and sessionRules both: either off drops it', () => {
    assert.deepEqual(switchesOf(fire), ['prMessages', 'sessionRules']);
    const off = (names: string[]) => new Map(SWITCHES.map((name) => [name, !names.includes(name)]));
    assert.deepEqual(droppedBy(fire, off(['sessionRules'])), ['sessionRules']);
    assert.deepEqual(droppedBy(fire, off(['prMessages'])), ['prMessages']);
    assert.equal(droppedBy(fire, off([])), null);
    assert.equal(droppedBy(fire, null), null);
  });

  test('other fires need the one switch they always did', () => {
    assert.deepEqual(switchesOf({ kind: 'offer', issue: 7, session: EDITOR }), ['sessionRules']);
    assert.deepEqual(switchesOf({ kind: 'unblocked', issue: 3, blocker: { repo: 'acme/tools', number: 4, title: 't' } } as never), []);
  });
});

describe('prEditText and the PR correction', () => {
  test('the notice tells the owner its PR\'s body was edited and its link moved', () => {
    const text = prEditText(12, EDITOR);
    assert.match(text, /PR #12/);
    assert.match(text, /edited/);
    assert.ok(text.includes(EDITOR));
    assert.doesNotMatch(text, /—/);
  });

  test('the correction says the editor does not own the PR, to comment next time, and carries the rules', () => {
    const text = correctionText(12, 'edit-pr', OWNER);
    assert.match(text, /PR #12/);
    assert.match(text, /do not own/);
    assert.ok(text.includes(OWNER));
    assert.match(text, /comment/);
    assert.ok(text.includes(SESSION_RULES));
    assert.doesNotMatch(text, /—/);
  });
});

type Sent = { session: string, text: string, opts: Record<string, unknown> };
type Delivery = { ok: boolean, answered: boolean | null, refused: boolean, capped?: boolean, sessionUrl: string | null, error: string | null, fallback: null, dropped: boolean | null, skipped: null, relinked: null };

/**
 * A `TurnContext` whose reader holds PR 12 with `body` (as it reads now);
 * `archived` the sessions that refuse, `capped` those the ceiling holds
 * back, `fails` those whose send faults.
 */
const context = ({
  body = TAKEN, archived = [] as string[], capped = [] as string[], fails = [] as string[],
  readFails = false, writeFails = false, told = new Set<string>(),
} = {}) => {
  const sent: Sent[] = [];
  const writes: Array<{ pr: number, body: string }> = [];
  const logged: Array<Record<string, unknown>> = [];
  const reader = {
    pull: async (n: number) => {
      if (readFails) throw new Error('GitHub answered 502');
      return { number: n, body, head: 'claude/owner', defaultBranch: 'main', open: true, author: 't-d-d', association: 'OWNER' };
    },
    updatePull: async (n: number, change: { body: string }) => {
      if (writeFails) throw new Error('GitHub answered 403');
      writes.push({ pr: n, body: change.body });
    },
  };
  const answer = (session: string): Delivery => {
    if (fails.includes(session)) return { ok: false, answered: false, refused: false, sessionUrl: null, error: 'the CLI printed nothing', fallback: null, dropped: null, skipped: null, relinked: null };
    if (capped.includes(session)) return { ok: false, answered: null, refused: false, capped: true, sessionUrl: null, error: 'held at the message ceiling', fallback: null, dropped: null, skipped: null, relinked: null };
    const gone = archived.includes(session);
    return { ok: !gone, answered: true, refused: gone, sessionUrl: session, error: gone ? `cloud session ${session} is archived and cannot accept new messages` : null, fallback: null, dropped: gone ? true : null, skipped: null, relinked: null };
  };
  const ctx = {
    readerFor: async () => reader,
    configOf: () => CONFIG,
    served: [],
    bare: false,
    prompts: CONFIG.prompts,
    delivery: () => ({
      deliver: async (to: { session?: string }, text: string, opts: Record<string, unknown>) => {
        assert.ok(to.session !== undefined, 'a PR edit\'s messages go to a named session, not by branch');
        sent.push({ session: to.session, text, opts });
        return answer(to.session);
      },
    }),
    storeLogin: async () => false,
    state: {
      recordTold: async (session: string, kind: string) => {
        const key = `${session.slice(session.lastIndexOf('/') + 1)}#${kind}`;
        if (told.has(key)) return false;
        told.add(key);
        return true;
      },
    },
    start: async () => { throw new Error('a PR body edit starts nothing'); },
    open: async () => true,
    claims: new Set<string>(),
    beats: [],
    now: () => NOW,
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    sleep: async () => {},
    cap: 2,
  };
  return { ctx: ctx as never, sent, writes, logged, told };
};

const fire = (over: Record<string, unknown> = {}) => ({ kind: 'prEdit', repo: REPO, pr: 12, from: OWNER, to: EDITOR, authors: ['OWNER'], ...over }) as never;
const to = (sent: Sent[]) => sent.map((s) => s.session);

describe('planPrEdit', () => {
  test('a live owner keeps its PR: it hears the edit, its link is written back, and the editor is told once', async () => {
    const { ctx, sent, writes, told } = context();
    const plan = await planPrEdit(fire(), ctx) as any;
    assert.deepEqual(to(sent), [OWNER, EDITOR]);
    assert.equal(sent[0]!.text, prEditText(12, EDITOR));
    assert.deepEqual(sent[0]!.opts.on, [12]);
    assert.deepEqual(writes, [{ pr: 12, body: relinkSession(TAKEN, OWNER) }]);
    assert.equal(sessionNamedIn(writes[0]!.body), OWNER);
    assert.match(writes[0]!.body, /described again/);
    assert.equal(sent[1]!.text, correctionText(12, 'edit-pr', OWNER));
    assert.deepEqual(sent[1]!.opts.on, [12]);
    assert.equal(plan.answer.kind, 'prEdit');
    assert.equal(exitCodeFor(plan.answer), 0);
    // A second such edit: the link is written back again, and the editor told nothing.
    const again = context({ told });
    await planPrEdit(fire(), again.ctx);
    assert.equal(again.writes.length, 1);
    assert.deepEqual(to(again.sent), [OWNER]);
  });

  test('an archived owner: nothing is written, and the editor owns the PR by its link and is told nothing', async () => {
    const { ctx, sent, writes, logged } = context({ archived: [OWNER] });
    const plan = await planPrEdit(fire(), ctx) as any;
    assert.deepEqual(writes, []);
    assert.deepEqual(to(sent), [OWNER]);
    assert.equal(exitCodeFor(plan.answer), 0);
    assert.ok(logged.some((l) => l.event === 'dispatch-take' && /owns the PR/.test(String(l.outcome))));
  });

  test('where the body no longer names the editor, or the read or the write fails, nothing is written and the editor is told nothing', async () => {
    const cases: Array<[string, Parameters<typeof context>[0]]> = [
      ['moved on', { body: pr(OTHER) }],
      ['read fails', { readFails: true }],
      ['write fails', { writeFails: true }],
    ];
    for (const [name, over] of cases) {
      const { ctx, sent, writes, logged } = context(over);
      const plan = await planPrEdit(fire(), ctx) as any;
      assert.deepEqual(writes, [], name);
      assert.deepEqual(to(sent), [OWNER], name);
      assert.equal(exitCodeFor(plan.answer), 0, name);
      if (name !== 'moved on') assert.ok(logged.some((l) => l.event === 'dispatch-relink' && l.level === 'error'), name);
    }
  });

  test('a notice the ceiling holds back changes nothing else; one that faults fails the turn and changes nothing else', async () => {
    const held = context({ capped: [OWNER] });
    const heldPlan = await planPrEdit(fire(), held.ctx) as any;
    assert.deepEqual([held.writes, to(held.sent)], [[], [OWNER]]);
    assert.equal(exitCodeFor(heldPlan.answer), 0);
    const faulted = context({ fails: [OWNER] });
    const plan = await planPrEdit(fire(), faulted.ctx) as any;
    assert.deepEqual([faulted.writes, to(faulted.sent)], [[], [OWNER]]);
    assert.equal(exitCodeFor(plan.answer), 1);
  });

  test('a correction that faults fails the turn', async () => {
    const { ctx } = context({ fails: [EDITOR] });
    const plan = await planPrEdit(fire(), ctx) as any;
    assert.equal(exitCodeFor(plan.answer), 1);
  });
});
