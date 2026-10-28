/**
 * Delivering a message to a session: `deliveries` in
 * dispatch/deliveries.mjs decides whom a message reaches and sends it. One
 * verb, `deliver`, to a session or to the owner of a PR, and a record of what
 * came of it: sent, refused, forwarded, a fallback launched, a subscriber
 * dropped, skipped, or an error.
 *
 * Its four adapters are recording fakes here: the GitHub reader, the send
 * into a session, the launcher, and the sessions finder. The turn's own
 * tests (test/dispatch-turn.test.ts) keep a few cases per kind proving it
 * plans, delivers and stores the login.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DELIVER_LAUNCHES, DISPATCHER_LABEL, deliveries, fromDispatcher, standingLine } from '../dispatch/deliveries.mjs';
import { subscribeLine, subscribersFor } from '../dispatch/webhook/subscribe.mjs';
import { dispatchMarker } from '../dispatch/webhook/fire.mjs';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { SIGN_OFF } from '../scripts/lib/session-signoff.mjs';
import { CONFIG_PATH } from '../dispatch/repo-config.mjs';
import { factoryFile } from './helpers/factory.ts';

/** The factory's own file's prompts, whose sign-off ask names its lessons. */
const FACTORY_PROMPTS = JSON.parse(factoryFile(CONFIG_PATH)).prompts;

const REPO = 'acme/factory';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const PR_BODY = '## Outcome\n\nThe grant.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01OLD';
const FRESH = 'https://claude.ai/code/session_01ABC';

type Message = { session: string; text: string };
type Launch = { prompt: string; sessionName: string; model: string };
type Answer = { status: number | null; output: string };
type Started = { outcome: 'dispatched' | 'unconfirmed' | 'failed'; sessionUrl: string | null };
type Find = (branch: string, options?: { bridgeOnly?: boolean }) => Promise<string | null>;
type Told = {
  ok: boolean;
  answered: boolean | null;
  refused: boolean;
  sessionUrl: string | null;
  error: string | null;
  fallback: { outcome: string; sessionUrl: string | null } | null;
  dropped: boolean | null;
  skipped: string | null;
};

const accepted = (session = 'session_01ABC'): Answer => ({ status: 0, output: JSON.stringify({ ok: true, session_id: session, url: `https://claude.ai/code/${session}` }) });
const archived = async ({ session }: Message): Promise<Answer> => ({ status: 1, output: JSON.stringify({ ok: false, session_id: session, error: `cloud session ${session} is archived and cannot accept new messages` }) });
/** An answer that is not the session being gone: the dispatcher's fault, not the session's refusal. */
const orgLookup = async ({ session }: Message): Promise<Answer> => ({ status: 1, output: JSON.stringify({ ok: false, session_id: session, error: 'Unable to get organization UUID' }) });

/**
 * The four adapters, recording what they saw, and the clock, the log and
 * the sleep. `reader` replaces the methods it names.
 */
const fakes = (over: {
  send?: (m: Message, until: number) => Promise<Answer>;
  launch?: (l: Launch, until: number) => Promise<Started>;
  reader?: Record<string, unknown>;
  sessions?: (asking: string) => Find;
  now?: () => number;
  launchTimeoutMs?: number;
  repo?: string;
} = {}) => {
  const sent: Message[] = [];
  const untils: number[] = [];
  const launches: Launch[] = [];
  const comments: Array<{ issue: number; body: string }> = [];
  const edits: Array<{ pr: number; body: string }> = [];
  const issueEdits: Array<{ issue: number; body: string }> = [];
  const searches: string[] = [];
  const asked: string[] = [];
  const logged: Array<{ event: string; [key: string]: unknown }> = [];
  const slept: number[] = [];
  let readers = 0;
  const reader = {
    comments: async () => [],
    comment: async (n: number, body: string) => { comments.push({ issue: n, body }); },
    pull: async (n: number) => ({ number: n, body: PR_BODY, head: '' }),
    updatePull: async (n: number, { body }: { body: string }) => { edits.push({ pr: n, body }); },
    issue: async (n: number) => ({ number: n, body: PR_BODY, pull: true }),
    updateIssue: async (n: number, { body }: { body: string }) => { issueEdits.push({ issue: n, body }); },
    openNaming: async (id: string) => { searches.push(id); return []; },
    openPulls: async () => [],
    commit: async (sha: string) => ({ sha, message: 'A commit a person wrote' }),
    ...over.reader,
  };
  const delivery = deliveries({
    prompts: FACTORY_PROMPTS,
    reader: async () => { readers += 1; return reader as never; },
    repo: over.repo ?? REPO,
    send: async (m: Message, until: number) => {
      sent.push(m);
      untils.push(until);
      return over.send ? over.send(m, until) : accepted();
    },
    launch: async (l: Launch, until: number) => {
      launches.push(l);
      untils.push(until);
      return over.launch ? over.launch(l, until) : { outcome: 'dispatched', sessionUrl: FRESH };
    },
    sessions: over.sessions ?? ((asking: string) => { asked.push(asking); return async () => null; }),
    now: over.now ?? (() => NOW),
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    sleep: async (ms: number) => { slept.push(ms); },
    ...(over.launchTimeoutMs === undefined ? {} : { launchTimeoutMs: over.launchTimeoutMs }),
  });
  const deliver = (to: { session: string } | { pr: number; poster?: string }, text: string, options: Record<string, unknown> = {}) =>
    delivery.deliver(to, text, options as never) as Promise<Told>;
  return { delivery, deliver, sent, untils, launches, comments, edits, issueEdits, searches, asked, logged, slept, readers: () => readers };
};

describe('deliver — a message into a session', () => {
  test('sends the text, labelled, with the session\'s standing under it, and reports the CLI\'s answer', async () => {
    const f = fakes();
    const told = await f.deliver({ session: 'session_01ABC' }, 'the reviewer asked for a test');
    assert.deepEqual(f.sent, [{ session: 'session_01ABC', text: fromDispatcher(`the reviewer asked for a test\n\n${standingLine([], { repo: REPO, closing: false, prompts: FACTORY_PROMPTS })}`) }]);
    assert.deepEqual(told, { ok: true, answered: true, refused: false, sessionUrl: FRESH, error: null, fallback: null, dropped: null, skipped: null });
    assert.deepEqual(f.launches, []);
    assert.deepEqual(f.comments, []);
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message' && l.ok === true && l.session === 'session_01ABC'));
  });

  test('a session the CLI answers archived is refused, with its reason', async () => {
    const f = fakes({ send: archived });
    const told = await f.deliver({ session: 'session_01OLD' }, 'hi');
    assert.equal(told.ok, false);
    assert.equal(told.refused, true);
    assert.match(String(told.error), /archived/);
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message' && l.ok === false));
  });

  test('any other answer, or one naming something else archived, is not a refusal', async () => {
    for (const error of ['401 Unauthorized: the login was revoked', 'repository acme/factory is archived and cannot be pushed to']) {
      const f = fakes({ send: async () => ({ status: 1, output: JSON.stringify({ ok: false, error }) }) });
      const told = await f.deliver({ session: 'session_01ABC' }, 'hi');
      assert.equal(told.ok, false, error);
      assert.equal(told.answered, true, error);
      assert.equal(told.refused, false, error);
    }
  });

  test('a CLI that printed no JSON is unanswered, its output the reason', async () => {
    const f = fakes({ send: async () => ({ status: 1, output: 'Error: --cloud requires a claude.ai login' }) });
    const told = await f.deliver({ session: 'session_01ABC' }, 'hi');
    assert.equal(told.ok, false);
    assert.equal(told.answered, false);
    assert.equal(told.refused, false);
    assert.match(String(told.error), /requires a claude.ai login/);
    const silent = fakes({ send: async () => ({ status: 7, output: '' }) });
    assert.match(String((await silent.deliver({ session: 'session_01ABC' }, 'hi')).error), /exited 7 and printed nothing/);
  });

  test('every text it sends opens with the dispatcher\'s label', () => {
    assert.ok(fromDispatcher('x').startsWith(`${DISPATCHER_LABEL}\n\n`));
  });

  test('the reader is not built until a delivery needs it', async () => {
    const f = fakes();
    assert.equal(f.readers(), 0);
    await f.deliver({ session: 'session_01ABC' }, 'one');
    assert.ok(f.readers() >= 1);
  });
});

describe('deliver — the resend', () => {
  const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';

  test('a send that fails once on a live session is sent again after five seconds, and a second yes is a delivery', async () => {
    // 2026-09-28 07:32: the CLI answered {"ok":false,"error":""} and the next send 46 s later went through.
    for (const first of [
      { status: 1, output: JSON.stringify({ ok: false, session_id: 'session_01REVIEWER', error: '' }) },
      { status: 1, output: 'Error: network' },
    ]) {
      const answers = [first];
      const f = fakes({ send: async () => answers.shift() ?? accepted('session_01REVIEWER') });
      const told = await f.deliver({ session: REVIEWER }, 'x', { on: [724], dropFrom: [724] });
      assert.equal(told.ok, true, first.output);
      assert.equal(f.sent.length, 2);
      assert.deepEqual(f.slept, [5_000]);
      assert.ok(f.logged.some((l) => l.event === 'dispatch-message-retry' && l.session === REVIEWER), JSON.stringify(f.logged));
    }
  });

  test('a refusal is not sent again', async () => {
    const f = fakes({ send: archived });
    await f.deliver({ session: REVIEWER }, 'x');
    assert.equal(f.sent.length, 1);
  });

  test('a send that fails twice is sent twice, no more, and once a resend has failed no later send is resent', async () => {
    const f = fakes({ send: orgLookup });
    const told = await f.deliver({ session: REVIEWER }, 'x');
    assert.equal(f.sent.length, 2);
    assert.equal(told.ok, false);
    assert.equal(told.refused, false);
    await f.deliver({ session: 'session_01OTHER' }, 'y');
    assert.equal(f.sent.length, 3, 'a fault that outlasts one resend is not a blip');
  });

  test('a failed send is not resent when what is left of the budget would not cover the wait and another send as slow', async () => {
    // Budget 2 × 60 s. The first send takes 100 s and fails: 20 s are left,
    // enough for the wait but not for a send like the one that just failed.
    let clock = NOW;
    const f = fakes({ now: () => clock, launchTimeoutMs: 60_000, send: async (m) => { clock += 100_000; return orgLookup(m); } });
    await f.deliver({ session: REVIEWER }, 'x');
    assert.equal(f.sent.length, 1);
    assert.ok(!f.logged.some((l) => l.event === 'dispatch-message-retry'), JSON.stringify(f.logged));
  });
});

describe('deliver — with a fallback', () => {
  const fallback = { prompt: 'A comment on a pull request mentioned @claude…', sessionName: '@claude #724 Grant the public InvokeFunction' };
  const onPr = { ...fallback, issue: 724 };
  const at = new Date(NOW - 5 * 60_000).toISOString();
  const markedBy = (sessionUrl: string | null) => ({ comments: async () => [{ id: 5, body: dispatchMarker({ at, sessionUrl }), created_at: at }] });

  test('a refusal launches the fallback, labelled, and reports both', async () => {
    const f = fakes({ send: archived });
    const told = await f.deliver({ session: 'session_01OLD' }, fallback.prompt, { fallback, takeover: true });
    assert.deepEqual(f.launches, [{ prompt: fromDispatcher(fallback.prompt), sessionName: fallback.sessionName, model: f.launches[0]!.model }]);
    assert.ok(f.launches[0]!.model);
    assert.deepEqual(f.comments, [], 'a mention has no ticket to mark');
    assert.equal(told.ok, false);
    assert.equal(told.refused, true);
    assert.deepEqual(told.fallback, { outcome: 'dispatched', sessionUrl: FRESH });
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message-fallback' && l.outcome === 'dispatched'), JSON.stringify(f.logged));
  });

  test('a fallback naming no session is launched as `dispatch`', async () => {
    const f = fakes({ send: archived });
    await f.deliver({ session: 'session_01OLD' }, 'hi', { fallback: { prompt: 'p' } });
    assert.equal(f.launches[0]!.sessionName, 'dispatch');
  });

  test('a fallback that started nothing is reported as failed, and leaves no marker', async () => {
    const f = fakes({ send: archived, launch: async () => ({ outcome: 'failed', sessionUrl: null }) });
    const told = await f.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.deepEqual(told.fallback, { outcome: 'failed', sessionUrl: null });
    assert.deepEqual(f.comments, []);
    assert.deepEqual(f.edits, []);
  });

  test('a send failing for any reason but an archived session starts nothing: the owner may be live', async () => {
    for (const send of [orgLookup, async () => ({ status: 1, output: 'Error: connect ECONNRESET api.anthropic.com' })]) {
      const f = fakes({ send });
      const told = await f.deliver({ session: 'session_01LIVE' }, 'hi', { fallback: onPr, takeover: true });
      assert.deepEqual(f.launches, []);
      assert.deepEqual(f.comments, []);
      assert.equal(told.ok, false);
      assert.equal(told.fallback, null);
    }
  });

  test('an accepted message launches nothing', async () => {
    const f = fakes();
    const told = await f.deliver({ session: 'session_01ABC' }, 'hi', { fallback, takeover: true });
    assert.deepEqual(f.launches, []);
    assert.equal(told.fallback, null);
  });

  /**
   * A fallback on a PR leaves the dispatch marker on it, and the next
   * refusal inside the window reads the marker as a forwarding address: a
   * review with six inline comments on a PR whose session is archived is
   * one fresh session and five forwards, not six sessions pushing to one
   * branch.
   */
  test('a fallback on a PR leaves the marker on it, naming the session it started', async () => {
    const f = fakes({ send: archived });
    const told = await f.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.equal(f.launches.length, 1);
    assert.deepEqual(f.comments, [{ issue: 724, body: dispatchMarker({ at: new Date(NOW).toISOString(), sessionUrl: FRESH }) }]);
    assert.deepEqual(told.fallback, { outcome: 'dispatched', sessionUrl: FRESH });
  });

  /**
   * The marker forwards for two hours; the PR body names the PR's session
   * for as long as the PR is open. So a takeover's fallback also rewrites
   * the body's session link: the next remark queues a message
   * straight to it.
   */
  test('a takeover points the PR body at the session it started, so the next remark is a message into it', async () => {
    const f = fakes({ send: archived });
    await f.deliver({ session: 'https://claude.ai/code/session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.deepEqual(f.edits, [{ pr: 724, body: PR_BODY.replace('session_01OLD', 'session_01ABC') }]);
    assert.equal(f.comments.length, 1, 'the marker stays, for a remark that raced the rewrite');
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message-fallback' && l.relinked === true), JSON.stringify(f.logged));

    const remark = {
      action: 'created',
      repository: { full_name: REPO },
      issue: { number: 724, title: 'Grant', html_url: 'https://github.com/acme/factory/pull/724', body: f.edits[0]?.body, pull_request: { url: 'https://api.github.com/repos/acme/factory/pulls/724' } },
      comment: { id: 78, body: 'One more thing.', html_url: 'https://github.com/acme/factory/pull/724#issuecomment-78', user: { login: 'tdickinson', type: 'User' }, author_association: 'OWNER' },
    };
    const { fires, reason } = routeEvent({ event: 'issue_comment', payload: remark, owners: ['acme'] });
    assert.deepEqual(fires.map((fire) => fire.fire.kind), ['message'], reason);
    assert.equal((fires[0]!.fire as { session: string }).session, FRESH);
  });

  test('a fallback that is not a takeover leaves the marker and keeps the PR body\'s author', async () => {
    const f = fakes({ send: archived });
    await f.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: false });
    assert.equal(f.comments.length, 1);
    assert.deepEqual(f.edits, []);
  });

  test('a launch that printed no session URL leaves the PR body as it is, and the marker forwards', async () => {
    const f = fakes({ send: archived, launch: async () => ({ outcome: 'unconfirmed', sessionUrl: null }) });
    const told = await f.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.deepEqual(told.fallback, { outcome: 'unconfirmed', sessionUrl: null });
    assert.deepEqual(f.edits, []);
    assert.deepEqual(f.comments, [{ issue: 724, body: dispatchMarker({ at: new Date(NOW).toISOString(), sessionUrl: null }) }]);
  });

  test('a rewrite GitHub refuses is logged, and the fallback it started is still reported, marker left', async () => {
    const f = fakes({ send: archived, reader: { updatePull: async () => { throw new Error('PATCH /repos/acme/factory/pulls/724 failed: 403 Forbidden: Resource not accessible by integration'); } } });
    const told = await f.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.deepEqual(told.fallback, { outcome: 'dispatched', sessionUrl: FRESH });
    assert.equal(f.comments.length, 1);
    assert.ok(f.logged.some((l) => l.event === 'dispatch-relink' && /403/.test(String(l.error))), JSON.stringify(f.logged));
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message-fallback' && l.relinked === false), JSON.stringify(f.logged));
  });

  test('a refusal on a PR marked inside the window forwards the text to the marked session instead of starting another', async () => {
    const seen: Array<{ issue: number; since: string }> = [];
    const f = fakes({
      send: async (m) => (m.session === 'session_01OLD' ? archived(m) : accepted('session_01NEW')),
      reader: { comments: async (issue: number, { since }: { since: string }) => { seen.push({ issue, since }); return markedBy('https://claude.ai/code/session_01NEW').comments(); } },
    });
    const told = await f.deliver({ session: 'session_01OLD' }, 'a second inline comment', { fallback: onPr, takeover: true });
    assert.deepEqual(f.launches, []);
    assert.deepEqual(f.comments, []);
    assert.deepEqual(f.sent.map((m) => m.session), ['session_01OLD', 'https://claude.ai/code/session_01NEW']);
    assert.equal(f.sent[1]?.text, fromDispatcher(`a second inline comment\n\n${standingLine([], { repo: REPO, closing: false, prompts: FACTORY_PROMPTS })}`));
    assert.deepEqual(told.fallback, { outcome: 'forwarded', sessionUrl: 'https://claude.ai/code/session_01NEW' });
    assert.deepEqual(seen, [{ issue: 724, since: new Date(NOW - 2 * 60 * 60_000).toISOString() }], 'the marker is read over the window');
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message-fallback' && l.outcome === 'forwarded'), JSON.stringify(f.logged));
  });

  test('a forward failing for any reason but an archived session starts nothing beside the marked session', async () => {
    for (const forwardAnswer of [
      { status: 1, output: JSON.stringify({ ok: false, session_id: 'session_01NEW', error: 'Unable to get organization UUID' }) },
      { status: 1, output: 'Error: network' },
    ]) {
      const f = fakes({ send: async (m) => (m.session === 'session_01OLD' ? archived(m) : forwardAnswer), reader: markedBy('https://claude.ai/code/session_01NEW') });
      const told = await f.deliver({ session: 'session_01OLD' }, 'a second inline comment', { fallback: onPr, takeover: true });
      assert.deepEqual(f.launches, [], forwardAnswer.output);
      assert.deepEqual(f.comments, []);
      assert.deepEqual(f.edits, [], 'the PR body keeps pointing at the marked session');
      assert.deepEqual(told.fallback, { outcome: 'failed', sessionUrl: null });
    }
  });

  test('a marked session that refuses too gets a fresh one; a marker naming no session skips', async () => {
    const both = fakes({ send: archived, reader: markedBy('https://claude.ai/code/session_01NEW') });
    const fresh = await both.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.equal(both.launches.length, 1);
    assert.deepEqual(fresh.fallback, { outcome: 'dispatched', sessionUrl: FRESH });
    const none = fakes({ send: archived, reader: markedBy(null) });
    const skipped = await none.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.deepEqual(none.launches, []);
    assert.deepEqual(skipped.fallback, { outcome: 'skipped', sessionUrl: null });
  });

  // After a handoff the PR body names the session the marker names. When that
  // session refuses, the marker is not a second address.
  test('a marker naming the session that just refused is not sent to again', async () => {
    for (const session of ['https://claude.ai/code/session_01NEW', 'session_01NEW']) {
      const f = fakes({ send: archived, reader: markedBy('https://claude.ai/code/session_01NEW') });
      const told = await f.deliver({ session }, 'hi', { fallback: onPr, takeover: true });
      assert.deepEqual(f.sent.map((m) => m.session), [session], session);
      assert.equal(f.launches.length, 1, session);
      assert.equal(told.fallback?.outcome, 'dispatched', session);
    }
  });

  /**
   * A send, a forward and a fallback launch share one budget: each
   * is handed the same end, DELIVER_LAUNCHES launch budgets from the
   * delivery's start, so a launch after two slow sends gets what they left.
   */
  test('a send, a forward and a fallback launch share one end', async () => {
    let clock = NOW;
    const f = fakes({ now: () => clock, launchTimeoutMs: 100, send: async (m) => { clock += 80; return archived(m); }, reader: markedBy('https://claude.ai/code/session_01NEW') });
    await f.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr, takeover: true });
    assert.deepEqual(f.untils, [NOW + DELIVER_LAUNCHES * 100, NOW + DELIVER_LAUNCHES * 100, NOW + DELIVER_LAUNCHES * 100]);
    const unbounded = fakes({ send: archived });
    await unbounded.deliver({ session: 'session_01OLD' }, 'hi', { fallback: onPr });
    assert.deepEqual(unbounded.untils, [Infinity, Infinity], 'no launch budget: no end');
  });
});

describe('deliver — a session\'s standing', () => {
  const OWNER = 'https://claude.ai/code/session_01OWNERAAA';
  const open = (number: number, pull = true) => ({ number, title: `Open ${number}`, html_url: `https://github.com/${REPO}/${pull ? 'pull' : 'issues'}/${number}`, pull });

  test('lists what else of the session\'s is open, searched by its id, leaving out what the message is about', async () => {
    const seen: string[] = [];
    const f = fakes({ reader: { openNaming: async (id: string) => { seen.push(id); return [open(724), open(730), open(717, false)]; } } });
    await f.deliver({ session: OWNER }, 'A comment on your pull request.', { on: [724], dropFrom: [724] });
    assert.deepEqual(seen, ['session_01OWNERAAA']);
    const text = f.sent[0]!.text;
    assert.match(text, /PR #730: Open 730/);
    assert.match(text, /Issue #717: Open 717/);
    assert.doesNotMatch(text, /#724: Open/, 'the PR the message is about is not "else"');
  });

  test('with nothing else open, it says so; a close asks it to sign off; something open asks nothing', async () => {
    const plain = fakes({ reader: { openNaming: async () => [open(724)] } });
    await plain.deliver({ session: OWNER }, 'A comment.', { on: [724] });
    assert.match(plain.sent[0]!.text, /no other open PR or issue in acme\/factory names this session/i);
    assert.ok(!plain.sent[0]!.text.includes(SIGN_OFF));

    const closed = fakes();
    await closed.deliver({ session: OWNER }, 'Your pull request was merged.', { on: [724], closing: true });
    assert.ok(closed.sent[0]!.text.endsWith(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS })));

    const busy = fakes({ reader: { openNaming: async () => [open(730)] } });
    await busy.deliver({ session: OWNER }, 'Your pull request was merged.', { on: [724], closing: true });
    assert.match(busy.sent[0]!.text, /PR #730/);
    assert.ok(!busy.sent[0]!.text.includes(SIGN_OFF));
  });

  test('the standing names the repo it searched: a message fired from another repo does not speak for the factory', async () => {
    const OTHER = 't-d-d/askme-mcp';
    const closed = fakes({ repo: OTHER });
    await closed.deliver({ session: OWNER }, 'Your pull request was merged.', { on: [448], closing: true });
    assert.match(closed.sent[0]!.text, /No other open PR or issue in t-d-d\/askme-mcp names this session\./);
    assert.ok(closed.sent[0]!.text.endsWith(standingLine([], { repo: OTHER, closing: true, prompts: FACTORY_PROMPTS })));

    const busy = fakes({ repo: OTHER, reader: { openNaming: async () => [open(449)] } });
    await busy.deliver({ session: OWNER }, 'A comment.', { on: [448] });
    assert.match(busy.sent[0]!.text, /Also open in t-d-d\/askme-mcp and naming this session:\n- PR #449/);

    const failed = fakes({ repo: OTHER, reader: { openNaming: async () => { throw new Error('502 Bad Gateway'); } } });
    await failed.deliver({ session: OWNER }, 'A comment.', { on: [448] });
    assert.match(failed.sent[0]!.text, /which other open PRs or issues in t-d-d\/askme-mcp name this session \(502 Bad Gateway\)/);
  });

  test('a search that fails still sends, saying the standing could not be read', async () => {
    const f = fakes({ reader: { openNaming: async () => { throw new Error('GET /search/issues failed: 403 Forbidden: rate limit'); } } });
    const told = await f.deliver({ session: OWNER }, 'A comment.', { on: [724] });
    assert.equal(told.ok, true);
    assert.match(f.sent[0]!.text, /could not read/i);
    assert.match(f.sent[0]!.text, /rate limit/);
    assert.ok(f.logged.some((l) => l.event === 'dispatch-standing' && l.session === OWNER), JSON.stringify(f.logged));
  });

  test('a session is searched once per deliveries, and a rate limit stops every later search', async () => {
    const searched: string[] = [];
    const f = fakes({ reader: { openNaming: async (id: string) => { searched.push(id); return []; } } });
    await f.deliver({ session: OWNER }, 'one');
    await f.deliver({ session: OWNER }, 'two');
    assert.deepEqual(searched, ['session_01OWNERAAA']);

    const limited: string[] = [];
    const refused = fakes({ reader: { openNaming: async (id: string) => { limited.push(id); throw Object.assign(new Error('GET /repos/acme/factory/issues failed: 429 Too Many Requests'), { status: 429, rateLimited: true }); } } });
    await refused.deliver({ session: OWNER }, 'one');
    await refused.deliver({ session: 'session_01OTHER' }, 'two');
    assert.equal(limited.length, 1);
    assert.match(refused.sent[1]!.text, /an earlier search this turn was refused: 429 Too Many Requests/);

    const flaky: string[] = [];
    const unmarked = fakes({ reader: { openNaming: async (id: string) => { flaky.push(id); if (flaky.length === 1) throw new Error('502 Bad Gateway'); return []; } } });
    await unmarked.deliver({ session: OWNER }, 'one');
    await unmarked.deliver({ session: OWNER }, 'two');
    assert.equal(flaky.length, 2, 'a failure that is not the rate limit leaves the next send to search');
  });

  test('standingLine: the list, nothing, or nothing and the sign-off', () => {
    assert.match(standingLine([open(1)], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /PR #1: Open 1 \(https:/);
    assert.doesNotMatch(standingLine([open(1)], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /sign.*off|archive/i);
    assert.doesNotMatch(standingLine([], { repo: REPO, closing: false, prompts: FACTORY_PROMPTS }), /sign.*off|archive/i);
    // The line itself, exactly, as the session's Stop hook reads it.
    assert.ok(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }).includes(`make \`${SIGN_OFF}\` the last line of your reply`));
    assert.match(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /the dispatcher archives/i);
    assert.doesNotMatch(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /archive_session/, 'the tool never reaches a session a dispatcher message woke');
    assert.match(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /unless you know otherwise/i);
    assert.match(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /\(work not on GitHub or in another repo,/, 'the search covers one repo (#985)');
    assert.match(standingLine([], { repo: REPO, closing: false, prompts: FACTORY_PROMPTS }), /^No other open PR or issue in acme\/factory names this session\.$/);
    assert.match(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /^No other open PR or issue in acme\/factory names this session\. Sign this session off unless you know otherwise/);
    assert.match(standingLine(null, { repo: REPO, closing: true, error: 'boom', prompts: FACTORY_PROMPTS }), /which other open PRs or issues in acme\/factory name this session \(boom\)/);
    assert.match(standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /the operator is working with you in this session, which is theirs to end/);
  });

  test('the factory\'s sign-off ask reminds the session to write its lessons', () => {
    const ask = standingLine([], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS });
    assert.ok(ask.includes('`Lesson:`'), ask);
    assert.match(ask, /CLAUDE\.md § Lessons/);
    // § Lessons is the one definition of what counts: the ask defines nothing.
    assert.doesNotMatch(ask, /\b(?:cost|lost|spent|saved?|time)\w*/i, ask);
    assert.doesNotMatch(standingLine([], { repo: REPO, closing: false, prompts: FACTORY_PROMPTS }), /lesson/i);
    assert.doesNotMatch(standingLine([open(1)], { repo: REPO, closing: true, prompts: FACTORY_PROMPTS }), /lesson/i);
  });

  test('the default sign-off ask names no lessons: another repo\'s CLAUDE.md may have no § Lessons', () => {
    const ask = standingLine([], { repo: REPO, closing: true, prompts: {} });
    assert.ok(ask.includes(`make \`${SIGN_OFF}\` the last line of your reply`), ask);
    assert.doesNotMatch(ask, /§ Lessons|lesson/i, ask);
  });
});

/**
 * A subscriber that refuses (archived) is gone: its line is dropped from the
 * body of what it subscribed to. Only the owner's fire has a fallback.
 */
describe('deliver — a subscriber that refuses', () => {
  const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';
  const FILER = 'https://claude.ai/code/session_01FILERBBB';
  const body = `The change.\n\n${subscribeLine(REVIEWER, ['comments'])}\n${subscribeLine('https://claude.ai/code/session_01OTHERONE')}${'\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01OLD'}`;
  const onPull = (text: string, pull = true) => ({ issue: async (n: number) => ({ number: n, body: text, pull }) });

  test('is dropped from the body and logged, with nothing launched', async () => {
    const f = fakes({ send: archived, reader: onPull(body) });
    const told = await f.deliver({ session: REVIEWER }, 'A comment on a pull request you subscribe to.', { on: [724], dropFrom: [724] });
    assert.deepEqual(f.launches, []);
    assert.equal(told.refused, true);
    assert.equal(told.dropped, true);
    assert.equal(f.issueEdits.length, 1);
    assert.equal(f.issueEdits[0]!.issue, 724);
    assert.doesNotMatch(f.issueEdits[0]!.body, /session_01REVIEWER/);
    assert.match(f.issueEdits[0]!.body, /session_01OTHERONE/);
    assert.match(f.issueEdits[0]!.body, /session_01OLD/);
    assert.ok(f.logged.some((l) => l.event === 'dispatch-unsubscribe' && l.dropped === true && l.on === 724), JSON.stringify(f.logged));
  });

  test('a refusal with nothing to drop from drops nothing, and says nothing was asked', async () => {
    const f = fakes({ send: archived });
    const told = await f.deliver({ session: 'https://claude.ai/code/session_01OLD' }, 'Your pull request was merged.', { on: [724] });
    assert.deepEqual(f.issueEdits, []);
    assert.equal(told.dropped, null);
  });

  test('an issue\'s filer that refuses is struck from its footer, so the next event on the issue messages nobody', async () => {
    const filed = `A bug.\n\n${subscribeLine(REVIEWER, ['comments'])}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${FILER}`;
    const f = fakes({ send: archived, reader: onPull(filed, false) });
    await f.deliver({ session: FILER }, 'Your issue was closed.', { on: [4415], dropFrom: [4415] });
    assert.deepEqual(f.launches, []);
    assert.equal(f.issueEdits.length, 1);
    const after = f.issueEdits[0]!.body;
    assert.deepEqual(subscribersFor(after, 'close'), [], 'the next close messages nobody');
    assert.deepEqual(subscribersFor(after, 'comments'), [{ session: REVIEWER, owner: false }], 'a subscriber\'s line stays');
    assert.doesNotMatch(after, /session_01FILERBBB/);
  });

  test('a PR\'s owner that refuses keeps its footer: a remark\'s fallback takes the PR over from it', async () => {
    const f = fakes({ send: archived, reader: onPull(body) });
    const told = await f.deliver({ session: 'https://claude.ai/code/session_01OLD' }, 'A push to your pull request.', { on: [724], dropFrom: [724] });
    assert.deepEqual(f.issueEdits, []);
    assert.equal(told.dropped, false);
  });

  test('a drop GitHub refuses is logged, and nothing is dropped', async () => {
    const f = fakes({ send: archived, reader: { ...onPull(body), updateIssue: async () => { throw new Error('PATCH failed: 403'); } } });
    const told = await f.deliver({ session: REVIEWER }, 'x', { on: [724], dropFrom: [724] });
    assert.equal(told.dropped, false);
    assert.ok(f.logged.some((l) => l.event === 'dispatch-unsubscribe' && /403/.test(String(l.error))), JSON.stringify(f.logged));
  });

  test('a send that fails for any other reason, or is never answered, drops nobody: the session may be live', async () => {
    for (const send of [orgLookup, async () => ({ status: 1, output: 'Error: network' })]) {
      for (const [who, text] of [[REVIEWER, body], [FILER, `A bug.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${FILER}`]] as const) {
        const f = fakes({ send, reader: onPull(text, who === REVIEWER) });
        const told = await f.deliver({ session: who }, 'x', { on: [724], dropFrom: [724] });
        assert.deepEqual(f.issueEdits, []);
        assert.deepEqual(f.launches, []);
        assert.equal(told.dropped, null);
      }
    }
  });

  test('a refusal with a fallback starts it, and drops nobody', async () => {
    const f = fakes({ send: archived, reader: onPull(body) });
    const told = await f.deliver({ session: REVIEWER }, 'x', { fallback: { prompt: 'p', sessionName: 's' }, on: [724], dropFrom: [724] });
    assert.equal(f.launches.length, 1);
    assert.deepEqual(f.issueEdits, []);
    assert.equal(told.dropped, null);
  });
});

/**
 * A push names its commit: a session whose own commit it is (its
 * `Claude-Session` trailer) is not told of its own push.
 */
describe('deliver — a push by the session itself', () => {
  const SHA = 'b'.repeat(40);
  const SESSION = 'https://claude.ai/code/session_01OWNERAAA';

  test('is not sent: the commit\'s trailer names the session', async () => {
    const f = fakes({ reader: { commit: async (sha: string) => ({ sha, message: `Fix the thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: ${SESSION}` }) } });
    const told = await f.deliver({ session: SESSION }, 'A push to your pull request.', { on: [724], commit: SHA });
    assert.deepEqual(f.sent, []);
    assert.deepEqual(told, { ok: false, answered: null, refused: false, sessionUrl: null, error: null, fallback: null, dropped: null, skipped: `its own push, ${SHA.slice(0, 12)}` });
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message' && /own push/.test(String(l.skipped))), JSON.stringify(f.logged));
  });

  test('a merge the session made to catch up, whose message has no trailer, is its own through its first parent', async () => {
    const OWN = 'c'.repeat(40);
    const MAIN = 'd'.repeat(40);
    const commits: Record<string, { sha: string; message: string; parents: string[] }> = {
      [SHA]: { sha: SHA, message: "Merge remote-tracking branch 'origin/main' into claude/x", parents: [OWN, MAIN] },
      [OWN]: { sha: OWN, message: `Fix the thing\n\nClaude-Session: ${SESSION}`, parents: ['e'.repeat(40)] },
      [MAIN]: { sha: MAIN, message: 'Another change on main\n\nClaude-Session: https://claude.ai/code/session_01SOMEONEELSE', parents: [] },
    };
    const own = fakes({ reader: { commit: async (sha: string) => commits[sha]! } });
    assert.match(String((await own.deliver({ session: SESSION }, 'A push.', { commit: SHA })).skipped), /own push/);
    assert.deepEqual(own.sent, []);

    const theirs = fakes({ reader: { commit: async (sha: string) => (sha === SHA ? { ...commits[SHA]!, parents: [MAIN, OWN] } : commits[sha]!) } });
    await theirs.deliver({ session: SESSION }, 'A push.', { commit: SHA });
    assert.equal(theirs.sent.length, 1, 'a merge whose first parent is someone else\'s is theirs');
  });

  test('another session\'s push, or a person\'s, is sent; a commit it cannot read is sent too', async () => {
    const other = fakes({ reader: { commit: async (sha: string) => ({ sha, message: 'Fix\n\nClaude-Session: https://claude.ai/code/session_01SOMEONEELSE' }) } });
    await other.deliver({ session: SESSION }, 'A push.', { commit: SHA });
    assert.equal(other.sent.length, 1);
    const unreadable = fakes({ reader: { commit: async () => { throw new Error('404'); } } });
    await unreadable.deliver({ session: SESSION }, 'A push.', { commit: SHA });
    assert.equal(unreadable.sent.length, 1);
    assert.ok(unreadable.logged.some((l) => l.event === 'dispatch-message' && /could not read the commit/.test(String(l.error))), JSON.stringify(unreadable.logged));
  });
});

/**
 * The owner of a PR whose body named no session when the fire was queued:
 * the session its body names now, else the live local session
 * holding its head branch.
 */
describe('deliver — to the owner of a PR', () => {
  const BRANCH = 'claude/lessons-learned-signoff-ad8b07';
  const UNNAMED = '## Outcome\n\nThe lessons.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  const LOCAL = 'https://claude.ai/code/session_01LOCAL';
  const PR = 4492;
  const unnamed = (over: Record<string, unknown> = {}) => ({
    pull: async (n: number) => ({ number: n, body: UNNAMED, head: BRANCH }),
    issue: async (n: number) => ({ number: n, body: UNNAMED, pull: true }),
    openPulls: async () => [{ number: PR, draft: false, base: 'main', head: BRANCH, title: 'Lessons', html_url: `https://github.com/${REPO}/pull/${PR}`, body: UNNAMED }],
    ...over,
  });
  /** A finder that knows which local session holds each branch, recording what it was asked. */
  const holding = (owners: Record<string, string>, asked: Array<{ branch: string; bridgeOnly?: boolean }> = []) => () => async (branch: string, options: { bridgeOnly?: boolean } = {}) => {
    asked.push({ branch, ...options });
    return owners[branch] ?? null;
  };

  test('reaches the live local session on its head branch', async () => {
    const asked: Array<{ branch: string; bridgeOnly?: boolean }> = [];
    const f = fakes({ reader: unnamed(), sessions: holding({ [BRANCH]: LOCAL }, asked) });
    const told = await f.deliver({ pr: PR }, 'Why the new section?', { on: [PR] });
    assert.deepEqual(f.sent.map((m) => m.session), [LOCAL]);
    assert.equal(told.ok, true);
    assert.deepEqual(asked[0], { branch: BRANCH, bridgeOnly: true }, 'only a local session owns a PR naming none (#871)');
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message' && l.on === PR && l.branch === BRANCH && l.session === LOCAL), JSON.stringify(f.logged));
  });

  test('with no live session on its head branch, nobody is messaged, nothing is taken over, and it says why', async () => {
    const f = fakes({ reader: unnamed(), sessions: holding({}) });
    const told = await f.deliver({ pr: PR }, 'Why?', { on: [PR], fallback: { prompt: 'p', sessionName: 's', issue: PR }, takeover: true });
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.launches, []);
    assert.equal(told.skipped, `no live session holds PR #${PR}'s head branch ${BRANCH}`);
    assert.equal(told.error, null);
    assert.ok(f.logged.some((l) => l.event === 'dispatch-message' && l.branch === BRANCH && l.session === null), JSON.stringify(f.logged));
  });

  test('a PR with no head branch has no owner to look for', async () => {
    const f = fakes({ reader: unnamed({ pull: async (n: number) => ({ number: n, body: UNNAMED, head: '' }) }), sessions: () => { throw new Error('not asked'); } });
    const told = await f.deliver({ pr: PR }, 'Why?');
    assert.equal(told.skipped, `no live session holds PR #${PR}'s head branch`);
  });

  test('a remark its branch\'s session answers archived starts the takeover, and the relink writes the fresh link into the body', async () => {
    const f = fakes({ send: archived, reader: unnamed(), sessions: holding({ [BRANCH]: LOCAL }) });
    await f.deliver({ pr: PR }, 'Why?', { on: [PR], fallback: { prompt: 'p', sessionName: 's', issue: PR }, takeover: true });
    assert.equal(f.launches.length, 1);
    assert.equal(f.edits.length, 1);
    assert.equal(subscribersFor(f.edits[0]!.body, 'comments')[0]?.session, FRESH);
    assert.ok(f.edits[0]!.body.startsWith(UNNAMED), 'the body keeps what it said');
  });

  test('a post by the session found on the branch is its own, and it is not told of it', async () => {
    const f = fakes({ reader: unnamed(), sessions: holding({ [BRANCH]: LOCAL }) });
    const told = await f.deliver({ pr: PR, poster: 'session_01LOCAL' }, 'Fixed.', { on: [PR] });
    assert.deepEqual(f.sent, []);
    assert.equal(told.skipped, `its own post, on the branch ${BRANCH}`);
    const other = fakes({ reader: unnamed(), sessions: holding({ [BRANCH]: LOCAL }) });
    await other.deliver({ pr: PR, poster: 'session_01SOMEONE' }, 'Fixed.', { on: [PR] });
    assert.equal(other.sent.length, 1);
  });

  test('a body that has named its session since the fire was queued: that session is told, and the finder is not asked', async () => {
    const f = fakes({ reader: unnamed({ pull: async (n: number) => ({ number: n, body: `${UNNAMED}\n\nhttps://claude.ai/code/session_01NAMED`, head: BRANCH }) }), sessions: () => { throw new Error('not asked'); } });
    await f.deliver({ pr: PR }, 'Why?', { on: [PR] });
    assert.deepEqual(f.sent.map((m) => m.session), ['https://claude.ai/code/session_01NAMED']);
  });

  test('a lookup that cannot run is an error, and nobody is messaged: a token it cannot use, a refused list, a PR it cannot read', async () => {
    const cases = [
      { sessions: () => { throw new Error('cannot ask which session holds x: the access token expired'); }, reader: unnamed(), error: /expired/ },
      { sessions: () => async () => { throw new Error('GET /v1/code/sessions: 401 unauthorized'); }, reader: unnamed(), error: /401/ },
      { sessions: holding({}), reader: unnamed({ pull: async () => { throw new Error('GET /pulls/4492 failed: 502'); } }), error: /502/ },
    ];
    for (const { error, ...over } of cases) {
      const f = fakes(over);
      const told = await f.deliver({ pr: PR }, 'Why?', { on: [PR], fallback: { prompt: 'p', sessionName: 's', issue: PR } });
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.launches, []);
      assert.match(String(told.error), error);
      assert.match(String(told.error), new RegExp(`could not find PR #${PR}'s session by its head branch`));
      assert.equal(told.ok, false);
      assert.ok(f.logged.some((l) => l.event === 'dispatch-message' && l.on === PR && error.test(String(l.error))), JSON.stringify(f.logged));
    }
  });

  test('a local owner\'s standing counts its other open PRs by head branch, and only those', async () => {
    const OTHER = 'claude/second-thing-9f1e2d';
    const reader = unnamed({
      openPulls: async () => [
        { number: 889, draft: false, base: 'main', head: OTHER, title: 'Second thing', html_url: `https://github.com/${REPO}/pull/889`, body: UNNAMED },
        { number: 895, draft: false, base: 'main', head: 'claude/someone-else', title: 'Not its', html_url: `https://github.com/${REPO}/pull/895`, body: UNNAMED },
        { number: 901, draft: false, base: 'main', head: OTHER, title: 'Named', html_url: `https://github.com/${REPO}/pull/901`, body: `${UNNAMED}\n\nhttps://claude.ai/code/session_01ELSE` },
      ],
    });
    const f = fakes({ reader, sessions: holding({ [BRANCH]: LOCAL, [OTHER]: LOCAL, 'claude/someone-else': 'https://claude.ai/code/session_01SOMEONE' }) });
    await f.deliver({ pr: PR }, 'Your pull request was closed.', { on: [PR], closing: true });
    assert.deepEqual(f.sent.map((m) => m.session), [LOCAL]);
    assert.match(f.sent[0]!.text, /PR #889: Second thing/);
    assert.doesNotMatch(f.sent[0]!.text, /#895|#901/);
    assert.ok(!f.sent[0]!.text.includes(SIGN_OFF));
  });

  test('a local owner\'s standing that the sessions API refuses says so, and is not taken for GitHub\'s rate limit', async () => {
    let finds = 0;
    const sessions = () => async (branch: string) => {
      finds += 1;
      if (finds > 1) throw Object.assign(new Error('GET /v1/code/sessions/cse_01OLDER: 429 rate limit exceeded'), { status: 429, rateLimited: true });
      return branch === BRANCH ? LOCAL : null;
    };
    const f = fakes({ reader: unnamed(), sessions });
    await f.deliver({ pr: PR }, 'one', { on: [PR] });
    assert.match(f.sent[0]!.text, /could not read/);
    assert.match(f.sent[0]!.text, /could not ask the sessions API which open PRs are/);
    await f.deliver({ session: 'session_01OTHER' }, 'two');
    assert.doesNotMatch(f.sent[1]!.text, /earlier search/);
  });

  test('onBranch, as a plan uses it, marks the session it finds as local for its standing', async () => {
    const OTHER = 'claude/second-thing-9f1e2d';
    const reader = unnamed({ openPulls: async () => [{ number: 889, draft: false, base: 'main', head: OTHER, title: 'Second thing', html_url: `https://github.com/${REPO}/pull/889`, body: UNNAMED }] });
    const f = fakes({ reader, sessions: holding({ [BRANCH]: LOCAL, [OTHER]: LOCAL }) });
    assert.equal(await f.delivery.onBranch(BRANCH), LOCAL);
    await f.deliver({ session: LOCAL }, 'Your change is on dev.');
    assert.match(f.sent[0]!.text, /PR #889: Second thing/);
    const cloud = fakes({ reader, sessions: holding({ [OTHER]: LOCAL }) });
    await cloud.deliver({ session: LOCAL }, 'Your change is on dev.');
    assert.doesNotMatch(cloud.sent[0]!.text, /#889/, 'a session not found by a branch is not searched by one');
  });
});
