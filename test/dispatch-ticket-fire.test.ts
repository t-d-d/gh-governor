/**
 * The task's half of a claimed ticket's events (#538, under PRD #535): a
 * ticket fire's comment, close or reopen goes to the ticket's spec owner
 * and, on a claimed ticket, to each builder the one lookup finds
 * (dispatch/builders.mjs). Each message names both roles and says which
 * the recipient holds. A session never hears its own signed post, and a
 * builder whose PR's merge closed the ticket hears the close through its PR
 * alone. On an unclaimed ticket the spec owner is sent what it was before,
 * with no read.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, type RepoConfig } from '../dispatch/repo-config.mjs';
import { planTicket } from '../dispatch/ticket-fire.mjs';
import { dispatchMarker } from '../dispatch/webhook/fire.mjs';
import { factoryFile } from './helpers/factory.ts';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const CONFIG = (() => {
  const read = readConfig(factoryFile('.github/governor.json'));
  assert.ok(read.ok);
  return read.config as RepoConfig;
})();
const CLAIM = CONFIG.labels.claim;
const SPEC = 'https://claude.ai/code/session_01SPECOWNER';
const BUILDER = 'https://claude.ai/code/session_01BUILDER';
const PR_OWNER = 'https://claude.ai/code/session_01PROWNER';
const MARKER = dispatchMarker({ at: new Date(NOW - 60_000).toISOString(), sessionUrl: BUILDER });
const TEXT = 'A comment on an issue.\n\n[#7 A ticket](https://github.com/acme/factory/issues/7)';
const SPEC_DUTY = 'You own its spec. If the comment calls for a change you agree with, edit the body. If you disagree, reply on the issue saying why.';

type Sent = { session: string, text: string, opts: Record<string, unknown> };

const fire = (over: Record<string, unknown> = {}) => ({ kind: 'ticket', repo: REPO, issue: 7, text: TEXT, event: 'comments', state: 'open', labels: [CLAIM], owner: SPEC, authors: ['MEMBER'], ...over }) as never;

/**
 * A `TurnContext` whose reader holds ticket 7: `comments` its thread,
 * `closing` the open PRs that close it, `merged` the PR whose merge closed
 * it, `owners` each PR's owner.
 */
const context = ({ comments = [{ body: MARKER }] as Array<{ body: string }>, closing = [] as number[], merged = null as number | null, owners = {} as Record<number, string>, archived = [] as string[], fails = null as string | null } = {}) => {
  const sent: Sent[] = [];
  const reads: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const stored: number[] = [];
  const failing = (name: string) => { if (fails === name) throw new Error('HTTP 502'); };
  const reader = {
    openClosing: async (n: number) => { reads.push(`open closing ${n}`); failing('openClosing'); return closing.map((number) => ({ number, title: `PR ${number}`, html_url: `u${number}` })); },
    closure: async (n: number) => { reads.push(`closure ${n}`); failing('closure'); return { pr: merged === null ? null : { number: merged } }; },
    allComments: async (n: number) => { reads.push(`thread ${n}`); failing('allComments'); return comments.map((c) => ({ ...c, ours: true })); },
  };
  const ctx = {
    readerFor: async () => { reads.push('reader'); return reader; },
    configOf: () => CONFIG,
    served: [],
    bare: false,
    prompts: CONFIG.prompts,
    delivery: () => ({
      ownerOf: async (pr: number) => ({ session: owners[pr] ?? null }),
      deliver: async ({ session }: { session: string }, text: string, opts: Record<string, unknown>) => {
        sent.push({ session, text, opts });
        const gone = archived.includes(session);
        return { ok: !gone, answered: true, refused: gone, sessionUrl: session, error: gone ? `cloud session ${session} is archived and cannot accept new messages` : null, fallback: null, dropped: null, skipped: null, relinked: null };
      },
    }),
    storeLogin: async () => { stored.push(1); return true; },
    state: {},
    start: async () => { throw new Error('a ticket fire starts nothing'); },
    open: async () => true,
    claims: new Set<string>(),
    beats: [],
    now: () => NOW,
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    sleep: async () => {},
    cap: 2,
  };
  return { ctx: ctx as never, sent, reads, logged, stored };
};

const to = (sent: Sent[]) => sent.map((s) => s.session);

describe('planTicket: a ticket fire reaches the spec owner and the builders', () => {
  test('an unclaimed ticket: the spec owner is sent the text with its role, and nothing is read from GitHub', async () => {
    const { ctx, sent, reads } = context();
    const plan = await planTicket(fire({ labels: ['mode: afk'] }), ctx) as any;
    assert.deepEqual(to(sent), [SPEC]);
    assert.equal(sent[0]!.text, `${TEXT}\n\nYou are its spec owner.\n${SPEC_DUTY}`);
    assert.deepEqual(sent[0]!.opts.on, [7]);
    assert.deepEqual(reads, []);
    assert.equal(plan.answer.kind, 'ticket');
    assert.equal(plan.answer.messaged.ok, true);
  });

  test('an unclaimed ticket whose body names no session: nobody is sent anything, and nothing is read', async () => {
    const { ctx, sent, reads } = context();
    await planTicket(fire({ labels: ['mode: afk'], owner: undefined }), ctx);
    assert.deepEqual([to(sent), reads], [[], []]);
  });

  test('a person\'s comment on a claimed ticket reaches its builder and its spec owner, each told its own role and linked to the other\'s session', async () => {
    const { ctx, sent, stored } = context();
    await planTicket(fire(), ctx);
    assert.deepEqual(to(sent), [SPEC, BUILDER]);
    for (const { text } of sent) assert.ok(text.startsWith(TEXT), text);
    assert.ok(sent[0]!.text.includes(`\n\nYou are its spec owner; [its builder](${BUILDER}) builds it.\n${SPEC_DUTY}`), sent[0]!.text);
    assert.doesNotMatch(sent[0]!.text, /As its builder/);
    assert.ok(sent[1]!.text.includes(`\n\nYou build it; [its spec owner](${SPEC}) writes its body.\nAs its builder you build it`), sent[1]!.text);
    assert.doesNotMatch(sent[1]!.text, /You own its spec/);
    assert.match(sent[1]!.text, /do not edit its body/);
    assert.equal(stored.length, 1);
  });

  test('the builder\'s own signed comment reaches the spec owner, and not the builder', async () => {
    const { ctx, sent } = context();
    await planTicket(fire({ poster: BUILDER }), ctx);
    assert.deepEqual(to(sent), [SPEC]);
    assert.ok(sent[0]!.text.includes(`You are its spec owner; [its builder](${BUILDER}) builds it.`), sent[0]!.text);
  });

  test('the spec owner\'s own signed comment reaches the builder, and not the spec owner', async () => {
    const { ctx, sent } = context();
    await planTicket(fire({ poster: SPEC }), ctx);
    assert.deepEqual(to(sent), [BUILDER]);
  });

  test('a claimed ticket a person wrote: the builder hears, told no session holds the spec', async () => {
    const { ctx, sent } = context();
    await planTicket(fire({ owner: undefined }), ctx);
    assert.deepEqual(to(sent), [BUILDER]);
    assert.match(sent[0]!.text, /\n\nYou build it; a person owns its body\./);
  });

  test('one session holding both roles, a spec session building its own ticket: one message, saying so', async () => {
    const { ctx, sent } = context({ comments: [] });
    await planTicket(fire(), ctx);
    assert.deepEqual(to(sent), [SPEC]);
    assert.match(sent[0]!.text, /\n\nYou are its spec owner and you build it\.\nYou own its spec\..*\nAs its builder you build it/);
  });

  test('a close or a reopen of a claimed ticket reaches both', async () => {
    for (const [state, closing] of [['closed', true], ['open', undefined]] as const) {
      const { ctx, sent } = context();
      await planTicket(fire({ event: 'close', state, ...(closing ? { closing } : {}) }), ctx);
      assert.deepEqual(to(sent), [SPEC, BUILDER], state);
      for (const s of sent) assert.equal(s.opts.closing, closing === true, state);
      for (const s of sent) assert.match(s.text, /\nNothing is asked of you\.$/, state);
      for (const s of sent) assert.doesNotMatch(s.text, /You own its spec|As its builder/, state);
    }
  });

  test('a close by the merge of the builder\'s own PR: the builder hears it through its PR, not again from the ticket', async () => {
    const { ctx, sent } = context({ merged: 60, owners: { 60: PR_OWNER } });
    await planTicket(fire({ event: 'close', state: 'closed', closing: true }), ctx);
    assert.deepEqual(to(sent), [SPEC]);
    assert.ok(sent[0]!.text.includes(`You are its spec owner; [its builder](${PR_OWNER}) built it.\nNothing is asked of you.`), sent[0]!.text);
  });

  test('a comment on a ticket an open PR closes reaches that PR\'s owner, who hands it on to its branch\'s session if archived', async () => {
    const { ctx, sent } = context({ closing: [60], owners: { 60: PR_OWNER } });
    await planTicket(fire(), ctx);
    assert.deepEqual(to(sent), [SPEC, PR_OWNER]);
    assert.deepEqual(sent[1]!.opts.owns, [60]);
  });

  // Governor's deploy comment on a closed ticket, as the receiver queues it
  // (dispatch/webhook/mention.mjs): the builder the merged PR names hears it
  // beside the spec owner, and each is asked to sign off where nothing else
  // is open, since its PR's own deploy message is not sent (#543).
  test('governor\'s deploy comment on a closed claimed ticket reaches the spec owner and the merged PR\'s owner, each closing', async () => {
    const { ctx, sent } = context({ merged: 60, owners: { 60: PR_OWNER } });
    await planTicket(fire({ state: 'closed', closing: true, text: 'Labelled `deployed: prod` by the Deliver workflow.' }), ctx);
    assert.deepEqual(to(sent), [SPEC, PR_OWNER]);
    assert.deepEqual(sent.map((m) => m.opts.closing), [true, true]);
    assert.ok(sent[1]!.text.includes(`You built it; [its spec owner](${SPEC}) writes its body.`), sent[1]!.text);
    assert.doesNotMatch(sent[1]!.text, /As its builder/);
    // A comment on a closed ticket calls on no duty, and says so.
    assert.match(sent[1]!.text, /Nothing is asked of you\./);
  });

  test('a claimed ticket with neither role found: nobody is sent anything', async () => {
    const { ctx, sent, logged } = context({ comments: [] });
    const plan = await planTicket(fire({ owner: undefined }), ctx) as any;
    assert.deepEqual(to(sent), []);
    assert.equal(plan.answer.messaged, null);
    assert.ok(logged.some((l) => l.event === 'dispatch-ticket'), JSON.stringify(logged));
  });

  test('a read the builder lookup needs that fails fails the turn, and nobody is sent anything', async () => {
    for (const fails of ['openClosing', 'allComments']) {
      const { ctx, sent } = context({ fails });
      await assert.rejects(planTicket(fire(), ctx), /HTTP 502/, fails);
      assert.deepEqual(to(sent), [], fails);
    }
  });

  test('an archived builder leaves the spec owner\'s message standing, and the turn answers with what was sent', async () => {
    const { ctx, sent } = context({ archived: [BUILDER] });
    const plan = await planTicket(fire(), ctx) as any;
    assert.deepEqual(to(sent), [SPEC, BUILDER]);
    assert.equal(plan.answer.messaged.ok, true);
  });

  // #562: a spec owner that also builds through its open PR is sent with
  // that PR, as the summons path sends it, so a refusal hands the message
  // to the live session on the PR's head branch.
  test('a spec owner that also builds through its open PR is sent with that PR', async () => {
    const { ctx, sent } = context({ closing: [60], owners: { 60: SPEC } });
    await planTicket(fire(), ctx);
    assert.deepEqual(to(sent), [SPEC]);
    assert.deepEqual(sent[0]!.opts.owns, [60]);
    assert.match(sent[0]!.text, /\n\nYou are its spec owner and you build it\.\nYou own its spec\..*\nAs its builder you build it/);
  });

  test('a body edit on a ticket a merged PR closed reaches that PR\'s builder, told its PR has merged', async () => {
    const { ctx, sent } = context({ merged: 60, owners: { 60: PR_OWNER } });
    await planTicket(fire({ event: 'edit', state: 'closed' }), ctx);
    assert.deepEqual(to(sent), [SPEC, PR_OWNER]);
    assert.match(sent[1]!.text, /Your PR, which closed #7, has merged: act on this message only where it calls for new work\./);
    assert.doesNotMatch(sent[0]!.text, /has merged/);
  });
});
