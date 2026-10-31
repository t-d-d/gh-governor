/**
 * The webhook receiver: a GitHub delivery in, at most one fire queued. What
 * is pinned: the signature check that keeps anyone else from queueing fires,
 * which events queue one and what each carries, who may summon a session by
 * mentioning @claude, and the answer GitHub sees for each.
 *
 * Every I/O is injected; the real ones (Secrets Manager, SQS) live in
 * dispatch/webhook/handler.mjs, which a merge-gate test never imports.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { HOOK_EVENTS, appIdOf, cachedSecret, handle, handleSchedule, routeEvent, verifySignature } from '../dispatch/webhook/route.mjs';
import { relinkSession, sessionNamedIn, subscribeLine } from '../dispatch/webhook/subscribe.mjs';
import { reviewMarker } from '../dispatch/pr-body.mjs';
import { OVERRIDE_CAP, SIGN_POSTS, UNATTENDED, containerOverride, dispatchMarker, parseFire } from '../dispatch/webhook/fire.mjs';
import { UNSIGNED } from '../dispatch/webhook/mention.mjs';

const SECRET = 'whsec_test';
const REPO = 'acme/factory';
/** The stack's owner list: the accounts whose installations the receiver routes for. */
const OWNERS = ['acme', 't-d-d'];
/** The stack's SelectLabels as the factory's deployment sets it: the labels whose addition queues a selection fire. */
const SELECT_LABELS = ['workflow: ready for development', 'mode: afk'];
/** The dispatcher's own App, whose comments alone carry the PR review's marker. */
const APP_ID = 5075844;

/**
 * The one fire a delivery queues, or none: most deliveries queue at most one,
 * and those that fan out to subscribers are read with `routeEvent` itself.
 */
const route = (args: Parameters<typeof routeEvent>[0]) => {
  const { fires, reason } = routeEvent(args);
  assert.ok(fires.length <= 1, `expected at most one fire, got ${fires.length}: ${reason}`);
  return { fire: fires[0]?.fire, reason: fires[0]?.reason ?? reason };
};

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const issuesEvent = (action: string, over: Record<string, unknown> = {}) => ({
  action,
  issue: { number: 717, title: 'An issue', labels: [{ name: 'type: bug' }], html_url: 'https://github.com/acme/factory/issues/717', body: 'Body.', user: { login: 't-d-d', type: 'User' }, author_association: 'OWNER', assignees: [] },
  repository: { full_name: REPO },
  ...over,
});

const member = { login: 't-d-d', type: 'User' };

/** A comment on issue or PR #717 from a repository member, mentioning @claude unless told otherwise. */
const commentEvent = (over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: { number: 717, title: 'An issue', html_url: 'https://github.com/acme/factory/issues/717' },
  comment: {
    id: 77,
    body: '@claude please look at the retry budget here',
    html_url: 'https://github.com/acme/factory/issues/717#issuecomment-77',
    user: member,
    author_association: 'MEMBER',
    ...comment,
  },
  repository: { full_name: REPO },
  ...over,
});

const pullRequest = { number: 724, title: 'Grant the public InvokeFunction', html_url: 'https://github.com/acme/factory/pull/724', head: { ref: 'claude/kind-galileo-xanzvu' } };

const reviewCommentEvent = (comment: Record<string, unknown> = {}) => ({
  action: 'created',
  pull_request: pullRequest,
  comment: {
    id: 88,
    body: '@claude this condition reads inverted',
    html_url: 'https://github.com/acme/factory/pull/724#discussion_r88',
    path: 'infra/governor.cfn.yml',
    line: 458,
    user: member,
    author_association: 'OWNER',
    ...comment,
  },
  repository: { full_name: REPO },
});

const reviewEvent = (review: Record<string, unknown> = {}) => ({
  action: 'submitted',
  pull_request: pullRequest,
  review: {
    id: 99,
    body: '@claude address the nits and re-request me',
    state: 'changes_requested',
    html_url: 'https://github.com/acme/factory/pull/724#pullrequestreview-99',
    user: member,
    author_association: 'OWNER',
    ...review,
  },
  repository: { full_name: REPO },
});

const harness = (over: Record<string, unknown> = {}) => {
  const queued: Array<{ message: Record<string, unknown>, dedupId?: string }> = [];
  const logged: Array<Record<string, unknown>> = [];
  const deps = {
    secret: async () => SECRET,
    hookSecret: async () => 'hook-secret-test',
    listedHooks: async () => null,
    countFire: async () => true,
    owners: OWNERS,
    selectLabels: SELECT_LABELS,
    appId: APP_ID,
    enqueue: async (message: Record<string, unknown>, dedupId?: string) => {
      queued.push({ message, ...(dedupId === undefined ? {} : { dedupId }) });
      return `m-${queued.length}`;
    },
    log: (event: string, context: Record<string, unknown> = {}) => {
      logged.push({ event, ...context });
    },
    ...over,
  };
  return { deps, queued, logged };
};

const delivery = (event: string, payload: unknown, over: Record<string, unknown> = {}) => {
  const body = JSON.stringify(payload);
  return {
    headers: { 'x-github-event': event, 'x-hub-signature-256': sign(body), 'x-github-delivery': 'd-1' },
    body,
    isBase64Encoded: false,
    ...over,
  };
};

describe('appIdOf', () => {
  test('reads a positive integer App ID from configuration, and nothing else', () => {
    assert.equal(appIdOf('5075844'), 5075844);
    assert.equal(appIdOf(' 5075844\n'), 5075844);
    for (const bad of [undefined, '', ' ', '0', '-1', '1.5', '5.0', '0x10', '0b11', '1e3', '+5', 'abc', '9007199254740993']) assert.equal(appIdOf(bad), undefined, String(bad));
  });
});

describe('verifySignature', () => {
  test('accepts GitHub\'s sha256 HMAC of the raw body, and nothing else', () => {
    const body = '{"a":1}';
    assert.equal(verifySignature(SECRET, body, sign(body)), true);
    assert.equal(verifySignature(SECRET, body, sign(body, 'other')), false);
    assert.equal(verifySignature(SECRET, body + ' ', sign(body)), false);
    assert.equal(verifySignature(SECRET, body, undefined), false);
    assert.equal(verifySignature(SECRET, body, 'sha1=abc'), false);
    assert.equal(verifySignature(SECRET, body, 'sha256=not-hex'), false);
  });
});

describe('routeEvent — the selection', () => {
  test('an issue labelled ready for development is a schedule fire for that issue alone, naming the label', () => {
    const decision = route({ event: 'issues', payload: issuesEvent('labeled', { label: { name: 'workflow: ready for development' } }), owners: OWNERS, selectLabels: SELECT_LABELS });
    assert.deepEqual(decision.fire, { kind: 'schedule', issue: 717, label: 'workflow: ready for development', repo: REPO });
    assert.match(decision.reason, /#717 labelled workflow: ready for development/);
  });

  // A close names the closed issue, and the task queues an `unblocked`
  // fire for each open ticket that issue blocked (dispatch/unblocked.mjs).
  // A fire that ran the whole selection on every close cascaded, every
  // session that finished starting two more.
  test('an issue closed is a schedule fire naming it as freed, and nothing wider', () => {
    const decision = route({ event: 'issues', payload: issuesEvent('closed'), owners: OWNERS });
    assert.deepEqual(decision.fire, { kind: 'schedule', freed: 717, counted: 'issuesClosed', repo: REPO });
    assert.match(decision.reason, /#717 closed/);
    const numberless = route({ event: 'issues', payload: issuesEvent('closed', { issue: { title: 'No number' } }), owners: OWNERS });
    assert.equal(numberless.fire, undefined, 'a close naming no issue must not fall back to the whole selection');
  });

  test('any other label, action or event starts nothing', () => {
    for (const [event, payload] of [
      ['issues', issuesEvent('labeled', { label: { name: 'type: bug' } })],
      ['issues', issuesEvent('reopened')],
      ['issue_comment', commentEvent({}, { body: 'no mention here' })],
      ['push', { ref: 'refs/heads/main', repository: { full_name: REPO } }],
      ['ping', { zen: 'x', repository: { full_name: REPO } }],
    ] as const) {
      const decision = route({ event, payload, owners: OWNERS, selectLabels: SELECT_LABELS });
      assert.equal(decision.fire, undefined, `${event} ${JSON.stringify(payload).slice(0, 60)}`);
    }
  });

  test('a delivery for another repository starts nothing, whatever it says', () => {
    const payload = issuesEvent('labeled', { label: { name: 'workflow: ready for development' }, repository: { full_name: 'someone/else' } });
    const decision = route({ event: 'issues', payload, owners: OWNERS });
    assert.equal(decision.fire, undefined);
    assert.match(decision.reason, /someone\/else/);
  });
});

/**
 * The events a periodic counts (dispatch/periodics.mjs): a merge into the
 * default branch, an issue opened, an issue closed. The receiver reads no
 * config file, so it marks the event on a fire for any listed repo, and
 * the turn checks the repo's periodics. Where the event already queues a
 * turn, the mark rides it; only an event that queues none gets a fire of
 * its own.
 */
describe('routeEvent — what a periodic counts', () => {
  const SHA = '3333333333333333333333333333333333333333';
  const counted = (event: string, payload: unknown) => routeEvent({ event, payload, owners: OWNERS, selectLabels: SELECT_LABELS }).fires
    .filter((f) => (f.fire as { counted?: string }).counted !== undefined)
    .map((f) => [f.fire.kind, (f.fire as { counted?: string }).counted, f.key]);
  const mergedPr = (over: Record<string, unknown> = {}) => ({
    action: 'closed',
    pull_request: { ...pullRequest, body: 'No session named.', merged: true, merge_commit_sha: SHA, base: { ref: 'main' }, ...over },
    sender: member,
    repository: { full_name: REPO, default_branch: 'main' },
  });

  test('a merge into the default branch rides its conflicts fire, and one with no merge commit named gets a fire of its own', () => {
    assert.deepEqual(counted('pull_request', mergedPr()), [['conflicts', 'merges', 'conflicts']]);
    assert.deepEqual(counted('pull_request', mergedPr({ merge_commit_sha: null })), [['periodics', 'merges', 'periodics']]);
  });

  test('a merge into another branch, or a close unmerged, counts nothing', () => {
    assert.deepEqual(counted('pull_request', mergedPr({ base: { ref: 'claude/stacked' } })), []);
    assert.deepEqual(counted('pull_request', mergedPr({ merged: false })), []);
  });

  test('an issue closed rides the fire that frees what it blocked', () => {
    assert.deepEqual(counted('issues', issuesEvent('closed')), [['schedule', 'issuesClosed', undefined]]);
  });

  test('an issue opened, which queues nothing today, gets a fire of its own', () => {
    const { fires } = routeEvent({ event: 'issues', payload: issuesEvent('opened'), owners: OWNERS });
    assert.deepEqual(fires.map((f) => [f.fire, f.key]), [[{ kind: 'periodics', counted: 'issuesOpened', repo: REPO }, 'periodics']]);
  });

  test('an issue opened summoning a session rides the summons', () => {
    const payload = issuesEvent('opened', { issue: { ...issuesEvent('opened').issue, body: '@claude what does the retry budget do?' } });
    const { fires } = routeEvent({ event: 'issues', payload, owners: OWNERS });
    assert.deepEqual(fires.map((f) => [f.fire.kind, (f.fire as { counted?: string }).counted]), [['dispatch', 'issuesOpened']]);
  });

  test('a PR opened, an issue reopened or labelled counts nothing', () => {
    assert.deepEqual(counted('pull_request', { action: 'opened', pull_request: { ...pullRequest, body: 'x', head: { ...pullRequest.head, sha: SHA } }, sender: member, repository: { full_name: REPO, default_branch: 'main' } }), []);
    assert.deepEqual(counted('issues', issuesEvent('reopened')), []);
    assert.deepEqual(counted('issues', issuesEvent('labeled', { label: { name: 'workflow: ready for development' } })), []);
  });

  test('a delivery for an unlisted owner counts nothing', () => {
    assert.deepEqual(counted('issues', issuesEvent('opened', { repository: { full_name: 'someone/else' } })), []);
  });
});

/**
 * A mention by someone with a say in the repository summons one session
 * with a prompt of its own, carrying where the mention is and what it said.
 * The session reads the rest itself, so the prompt names the URL and quotes
 * the body rather than embedding the PR or the issue.
 */
describe('routeEvent — a mention', () => {
  const dispatchOf = (event: string, payload: unknown) => {
    const decision = route({ event, payload, owners: OWNERS });
    assert.equal(decision.fire?.kind, 'dispatch', decision.reason);
    return decision.fire as { kind: 'dispatch', prompt: string, sessionName: string };
  };

  test('a comment on an issue mentioning @claude summons a session told to answer on that issue', () => {
    const fire = dispatchOf('issue_comment', commentEvent());
    assert.match(fire.prompt, /issue #717/i);
    assert.match(fire.prompt, /issues\/717#issuecomment-77/);
    assert.match(fire.prompt, /please look at the retry budget/);
    assert.match(fire.prompt, /t-d-d/);
    assert.match(fire.prompt, /open a PR/i);
    assert.match(fire.sessionName, /#717/);
  });

  test('a comment on a pull request summons a session told to work on its head branch and not open another', () => {
    const fire = dispatchOf('issue_comment', commentEvent({ issue: { number: 724, title: 'Grant the public InvokeFunction', html_url: 'https://github.com/acme/factory/pull/724', pull_request: { url: 'https://api.github.com/repos/acme/factory/pulls/724' } } }));
    assert.match(fire.prompt, /PR #724/);
    assert.match(fire.prompt, /head branch/i);
    assert.match(fire.prompt, /do not open a new branch or PR/i);
    assert.match(fire.sessionName, /#724/);
  });

  /**
   * A PR a session wrote carries that session's link in its footer, and a
   * message wakes the session whether its container is warm or gone.
   * So a remark on such a PR goes to the session that has the
   * context, as a message fire, and only a refusal (an archived session)
   * starts a fresh one: the fallback the fire carries.
   */
  const SESSION_LINK = 'https://claude.ai/code/session_01PRSESSIONXYZ';
  const footer = `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${SESSION_LINK}`;
  const prIssue = (body: string) => ({ number: 724, title: 'Grant the public InvokeFunction', html_url: 'https://github.com/acme/factory/pull/724', body, pull_request: { url: 'https://api.github.com/repos/acme/factory/pulls/724' } });
  const messageOf = (event: string, payload: unknown) => {
    const decision = route({ event, payload, owners: OWNERS });
    assert.equal(decision.fire?.kind, 'message', decision.reason);
    return { fire: decision.fire as { kind: 'message', session: string, text: string, fallback?: { prompt: string, sessionName: string, issue: number } }, reason: decision.reason };
  };

  test('a comment on a PR a session wrote is a message into that session, carrying the prompt and a fallback', () => {
    const { fire, reason } = messageOf('issue_comment', commentEvent({ issue: prIssue(`## Outcome\n\nThe grant.${footer}`) }));
    assert.equal(fire.session, SESSION_LINK);
    assert.match(fire.text, /PR #724/);
    assert.match(fire.text, /issuecomment-77/);
    assert.ok(fire.fallback?.prompt.startsWith(fire.text), 'the fresh session, if it comes to that, gets the same prompt');
    assert.match(String(fire.fallback?.prompt), /session that wrote this PR is gone/, 'and is told to take the PR over, footer included');
    assert.match(String(fire.fallback?.sessionName), /#724/);
    assert.equal(fire.fallback?.issue, 724, 'the PR number, so the turn can mark it and find the mark');
    assert.doesNotThrow(() => parseFire(fire), 'what the receiver queues, the task accepts');
    assert.match(reason, /session_01PRSESSIONXYZ/);
  });

  test('a review comment and a review on such a PR are messages into its session too', () => {
    const pr = { ...pullRequest, body: `The PR.${footer}` };
    assert.equal(messageOf('pull_request_review_comment', { ...reviewCommentEvent(), pull_request: pr }).fire.session, SESSION_LINK);
    assert.equal(messageOf('pull_request_review', { ...reviewEvent(), pull_request: pr }).fire.session, SESSION_LINK);
  });

  test('the last session link in the body is the one: the footer comes last', () => {
    const { fire } = messageOf('issue_comment', commentEvent({ issue: prIssue(`Supersedes https://claude.ai/code/session_01OLDERONE.${footer}`) }));
    assert.equal(fire.session, SESSION_LINK);
  });

  /**
   * The session's PR is the session's to keep: a remark on it needs no
   * mention, and a review bot's findings are what the session is waiting
   * for. The review loop is the point (a comment, a considered change, a
   * re-review), and it ends when the session reads a comment and pushes
   * nothing. What still messages nothing: the session's own posts, which
   * carry the footer; a stranger; and a review with neither text nor a
   * verdict, whose comments arrive as events of their own.
   */
  test('on a PR a session wrote, every comment is a message, @claude mentioned or not, and the prompt says whose PR it is', () => {
    const { fire, reason } = messageOf('issue_comment', commentEvent({ issue: prIssue(`The PR.${footer}`) }, { body: 'The retry budget reads inverted here.' }));
    assert.equal(fire.session, SESSION_LINK);
    assert.match(fire.text, /your pull request/i);
    assert.doesNotMatch(fire.text, /mentioned @claude/);
    assert.match(fire.text, /reads inverted/);
    assert.match(fire.text, /issuecomment-77/);
    assert.match(reason, /session_01PRSESSIONXYZ/);
  });

  test('a bot\'s comment or review on such a PR is a message too', () => {
    const bot = { user: { login: 'claude-code-review[bot]', type: 'Bot' }, author_association: 'NONE', body: 'Two findings.' };
    assert.equal(messageOf('issue_comment', commentEvent({ issue: prIssue(`The PR.${footer}`) }, bot)).fire.session, SESSION_LINK);
    assert.equal(messageOf('pull_request_review', { ...reviewEvent({ ...bot, state: 'commented' }), pull_request: { ...pullRequest, body: `The PR.${footer}` } }).fire.session, SESSION_LINK);
    assert.equal(messageOf('pull_request_review_comment', { ...reviewCommentEvent(bot), pull_request: { ...pullRequest, body: `The PR.${footer}` } }).fire.session, SESSION_LINK);
  });

  test('the session\'s own comment on its PR, and a stranger\'s, message nothing', () => {
    const own = commentEvent({ issue: prIssue(`The PR.${footer}`) }, { body: `Fixed in the next push.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n\n${SESSION_LINK}` });
    const ownDecision = route({ event: 'issue_comment', payload: own, owners: OWNERS });
    assert.equal(ownDecision.fire, undefined);
    assert.match(ownDecision.reason, /own/);
    const stranger = commentEvent({ issue: prIssue(`The PR.${footer}`) }, { user: { login: 'passer-by', type: 'User' }, author_association: 'NONE', body: 'Nice.' });
    assert.equal(route({ event: 'issue_comment', payload: stranger, owners: OWNERS }).fire, undefined);
  });

  test('a review with no text is a message only when it carries a verdict', () => {
    const pr = { ...pullRequest, body: `The PR.${footer}` };
    assert.equal(messageOf('pull_request_review', { ...reviewEvent({ body: '', state: 'approved' }), pull_request: pr }).fire.session, SESSION_LINK);
    assert.equal(messageOf('pull_request_review', { ...reviewEvent({ body: null, state: 'changes_requested' }), pull_request: pr }).fire.session, SESSION_LINK);
    const wrapper = route({ event: 'pull_request_review', payload: { ...reviewEvent({ body: null, state: 'commented' }), pull_request: pr }, owners: OWNERS });
    assert.equal(wrapper.fire, undefined);
    assert.match(wrapper.reason, /own events/);
  });

  test('a PR naming no session still needs the mention to summon: a comment without one only asks for the session on its head branch', () => {
    const decision = route({ event: 'issue_comment', payload: commentEvent({ issue: prIssue('A PR a person opened.') }, { body: 'Looks fine.' }), owners: OWNERS });
    assert.equal(decision.fire?.kind, 'message');
    assert.equal((decision.fire as { byBranch?: true }).byBranch, true);
  });

  test('a message fire fits the task\'s container override, the prompt twice over, whatever the remark holds', () => {
    // ECS caps a RunTask's overrides at 8192 characters; the fire rides one
    // as JSON inside JSON, so a quote costs four characters, a CJK character
    // three bytes, and the prompt appears twice. The remark is quoted shorter
    // until the fire fits; the URL carries the rest.
    for (const fill of ['x', '"', '字']) {
      const { fire } = messageOf('issue_comment', commentEvent({ issue: prIssue(`The PR.${footer}`) }, { body: `@claude ${fill.repeat(10_000)}` }));
      const override = JSON.stringify(containerOverride('dispatch', fire));
      assert.ok(Buffer.byteLength(override) < OVERRIDE_CAP, `${fill}: ${Buffer.byteLength(override)} bytes`);
      assert.match(fire.text, /issuecomment-77/);
      assert.match(fire.text, /more characters at the URL above/);
    }
  });

  test('a link the task would refuse, or one glued to more id characters, names no session', () => {
    for (const link of ['https://claude.ai/code/session_01', `https://claude.ai/code/session_${'A'.repeat(200)}`, `${SESSION_LINK}-older`]) {
      const decision = route({ event: 'issue_comment', payload: commentEvent({ issue: prIssue(`Footer.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${link}\n`) }), owners: OWNERS });
      assert.equal(decision.fire?.kind, 'dispatch', link);
    }
  });

  /**
   * A fallback's handoff: the turn rewrites the PR body so the link
   * this arm reads is the fresh session's, and the next remark reaches it.
   */
  test('relinkSession puts a session in the body where sessionNamedIn reads it, and changes nothing else', () => {
    const FRESH = 'https://claude.ai/code/session_01FRESHONE';
    const cited = `Supersedes https://claude.ai/code/session_01OLDERONE.${footer}`;
    assert.equal(relinkSession(cited, FRESH), cited.replace(SESSION_LINK, FRESH), 'the last link under the footer is replaced; a citation above it stays');
    assert.equal(relinkSession(`${cited}\n`, FRESH), `${cited.replace(SESSION_LINK, FRESH)}\n`);
    assert.equal(sessionNamedIn(relinkSession(cited, FRESH)), FRESH);
    // A body naming no session gets the footer appended.
    for (const body of ['A body with no footer.', `Investigated in ${SESSION_LINK}.`, `Footer.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`, '', null]) {
      const relinked = relinkSession(body, FRESH);
      assert.equal(sessionNamedIn(relinked), FRESH, String(body));
      assert.ok(relinked.startsWith(String(body ?? '').trimEnd()), `keeps what was there: ${String(body)}`);
      assert.equal(messageOf('issue_comment', commentEvent({ issue: prIssue(relinked) })).fire.session, FRESH, String(body));
      assert.ok(relinked.split('[Claude Code]').length <= 2, `one footer, not a second: ${relinked}`);
    }
  });

  test('a PR a person opened that cites a session link is not that session\'s: the link counts only under the Claude Code footer', () => {
    const decision = route({ event: 'issue_comment', payload: commentEvent({ issue: prIssue(`Investigated in ${SESSION_LINK}; see the transcript.`) }), owners: OWNERS });
    assert.equal(decision.fire?.kind, 'dispatch');
  });

  test('a payload naming no PR number still queues a fire the task accepts, with no issue to mark', () => {
    const { number: _number, ...noNumber } = prIssue(`The PR.${footer}`);
    const { fire } = messageOf('issue_comment', commentEvent({ issue: noNumber }));
    assert.equal(fire.fallback?.issue, undefined);
    assert.doesNotThrow(() => parseFire(fire));
  });

  test('the dispatcher\'s own marker on the PR, left by a fallback, messages nothing', () => {
    const marker = commentEvent({ issue: prIssue(`The PR.${footer}`) }, { user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', body: dispatchMarker({ at: '2026-09-26T08:00:00.000Z', sessionUrl: 'https://claude.ai/code/session_01NEW' }) });
    const decision = route({ event: 'issue_comment', payload: marker, owners: OWNERS });
    assert.equal(decision.fire, undefined);
    assert.match(decision.reason, /marker/);
  });

  test('a PR with no session link, and an issue whose body names one, summon a fresh session', () => {
    assert.equal(dispatchOf('issue_comment', commentEvent({ issue: prIssue('A PR a person opened.') })).kind, 'dispatch');
    const issueWithLink = { ...commentEvent().issue, body: `See ${SESSION_LINK} for the run.` };
    assert.equal(dispatchOf('issue_comment', commentEvent({ issue: issueWithLink })).kind, 'dispatch');
  });

  test('a review comment summons a session pointed at the file, the line and the branch', () => {
    const fire = dispatchOf('pull_request_review_comment', reviewCommentEvent());
    assert.match(fire.prompt, /PR #724/);
    assert.match(fire.prompt, /infra\/governor\.cfn\.yml/);
    assert.match(fire.prompt, /line 458/i);
    assert.match(fire.prompt, /claude\/kind-galileo-xanzvu/);
    assert.match(fire.prompt, /discussion_r88/);
  });

  test('a review summons a session told the review\'s state and branch', () => {
    const fire = dispatchOf('pull_request_review', reviewEvent());
    assert.match(fire.prompt, /PR #724/);
    assert.match(fire.prompt, /changes_requested/);
    assert.match(fire.prompt, /claude\/kind-galileo-xanzvu/);
    assert.match(fire.prompt, /pullrequestreview-99/);
  });

  test('an issue opened with @claude in its body, or assigned to claude, summons a session', () => {
    const opened = dispatchOf('issues', issuesEvent('opened', { issue: { ...issuesEvent('opened').issue, body: '@claude what does the retry budget do?' } }));
    assert.match(opened.prompt, /issue #717/i);
    assert.match(opened.prompt, /what does the retry budget do/);
    const assigned = dispatchOf('issues', issuesEvent('assigned', { assignee: { login: 'claude' }, issue: { ...issuesEvent('assigned').issue, assignees: [{ login: 'claude' }] } }));
    assert.match(assigned.prompt, /issue #717/i);
  });

  // `mcp__github__issue_write` strips a session's footer from an issue body
  // and leaves its link on the last line: the issue is the session's own,
  // and naming @claude in it (a ticket about the mention router) summons
  // nobody, as a footer would have said.
  test('an issue a session opened, its footer stripped to its link on the last line, summons nothing by naming @claude', () => {
    const body = 'A comment mentioning @claude on a PR a session owns should message the owner.\nhttps://claude.ai/code/session_01FILERBBB';
    const { fires, reason } = routeEvent({ event: 'issues', payload: issuesEvent('opened', { issue: { ...issuesEvent('opened').issue, body } }), owners: OWNERS });
    assert.deepEqual(fires.map((f) => f.fire.kind), ['periodics'], 'counted, and no summons');
    assert.match(reason, /a session cannot summon another/);
    const comment = route({ event: 'issue_comment', payload: commentEvent({}, { body: '@claude this one stalled:\nhttps://claude.ai/code/session_01FILERBBB' }), owners: OWNERS });
    assert.equal(comment.fire?.kind, 'dispatch', 'a person\'s comment ending in a session link is still a summons');
  });

  test('an issue opened already assigned to claude summons once: GitHub also sends the assignment', () => {
    const issue = { ...issuesEvent('opened').issue, body: '@claude what does the retry budget do?', assignees: [{ login: 'claude' }] };
    const fires = [
      route({ event: 'issues', payload: issuesEvent('opened', { issue }), owners: OWNERS }),
      route({ event: 'issues', payload: issuesEvent('assigned', { issue, assignee: { login: 'claude' } }), owners: OWNERS }),
    ].filter((d) => d.fire?.kind === 'dispatch');
    assert.equal(fires.length, 1);
  });

  test('"@claude" inside another handle or an address is not a mention', () => {
    for (const body of ['ask @claude-bot about it', 'cc @claudette', 'mail support@claude.ai', 'see @claudeai',
      // A domain, a team or a package scope, and code: GitHub links none of them.
      'open @claude.ai to try it', 'ping @claude/reviewers', 'bump @claude/sdk',
      'the `@claude` trigger', '```\n@claude look\n```', '~~~\nsay @claude\n~~~']) {
      const decision = route({ event: 'issue_comment', payload: commentEvent({}, { body }), owners: OWNERS });
      assert.equal(decision.fire, undefined, body);
    }
    for (const body of ['@claude look', 'thanks, @claude.', '(@claude) please', 'cc:@claude', '@Claude look', '_@claude please_', 'it\'s `odd @claude look', '`x` then @claude',
      // A blank line ends a paragraph, and no code span crosses one: in the
      // CRLF a comment typed on github.com carries too, and straight after
      // the opening backtick.
      'don`t stall\n\n@claude look\n\nit won`t', 'don`t stall\r\n\r\n@claude look\r\n\r\nit won`t',
      'a stray `\n\n@claude look at the `foo` call']) {
      assert.equal(route({ event: 'issue_comment', payload: commentEvent({}, { body }), owners: OWNERS }).fire?.kind, 'dispatch', body);
    }
  });

  test('assigning someone else to an issue claude already holds summons nothing: the assignee is the one just assigned, not the list', () => {
    const payload = issuesEvent('assigned', { assignee: { login: 't-d-d' }, issue: { ...issuesEvent('assigned').issue, assignees: [{ login: 'claude' }, { login: 't-d-d' }] } });
    assert.equal(route({ event: 'issues', payload, owners: OWNERS }).fire, undefined);
  });

  test('the prompt quotes a long body only so far, and names the URL for the rest: the task takes the prompt through an override with a size cap', () => {
    const fire = dispatchOf('issue_comment', commentEvent({}, { body: `@claude ${'x'.repeat(10_000)}` }));
    assert.ok(fire.prompt.length < 4_000, `${fire.prompt.length} chars`);
    assert.match(fire.prompt, /issuecomment-77/);
  });

  test('a session cannot summon another: nothing quotes the session footer', () => {
    // A dispatched session's comments carry the attribution footer; one that
    // quotes "@claude" back would otherwise start a session that starts one.
    const decision = route({ event: 'issue_comment', payload: commentEvent({}, { body: 'You asked @claude to look.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_' }), owners: OWNERS });
    assert.equal(decision.fire, undefined);
    assert.match(decision.reason, /session/);
  });

  test('a bot, a stranger and a first-time contributor summon nothing', () => {
    for (const [what, comment] of [
      ['a bot', { user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE' }],
      ['a stranger', { user: { login: 'passer-by', type: 'User' }, author_association: 'NONE' }],
      ['a contributor', { user: { login: 'once', type: 'User' }, author_association: 'CONTRIBUTOR' }],
    ] as const) {
      const decision = route({ event: 'issue_comment', payload: commentEvent({}, comment), owners: OWNERS });
      assert.equal(decision.fire, undefined, what);
    }
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      assert.equal(route({ event: 'issue_comment', payload: commentEvent({}, { author_association: association }), owners: OWNERS }).fire?.kind, 'dispatch', association);
    }
  });

  test('an edited or deleted comment, and a review merely dismissed, summon nothing', () => {
    assert.equal(route({ event: 'issue_comment', payload: commentEvent({ action: 'edited' }), owners: OWNERS }).fire, undefined);
    assert.equal(route({ event: 'issue_comment', payload: commentEvent({ action: 'deleted' }), owners: OWNERS }).fire, undefined);
    assert.equal(route({ event: 'pull_request_review', payload: { ...reviewEvent(), action: 'dismissed' }, owners: OWNERS }).fire, undefined);
  });
});

/**
 * Subscribers: any session that leaves a `governor:subscribe` line
 * in a PR or issue body hears of the events it names, one message fire
 * each; the PR's footer is its owner, subscribed to everything, and only
 * the owner's fire carries a fallback. Nobody hears of their own post.
 */
describe('routeEvent — subscribers', () => {
  const OWNER = 'https://claude.ai/code/session_01OWNERAAA';
  const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';
  const FILER = 'https://claude.ai/code/session_01FILERBBB';
  const footer = `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${OWNER}`;
  const sessionPost = (text: string, session?: string) => `${text}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_${session ? `\n\n${session}` : ''}`;
  const prBody = (lines: string[] = [subscribeLine(REVIEWER)]) => `The change.\n\n${lines.join('\n')}${footer}`;
  const prIssue = (body = prBody()) => ({ number: 724, title: 'Grant the public InvokeFunction', html_url: 'https://github.com/acme/factory/pull/724', body, pull_request: { url: 'https://api.github.com/repos/acme/factory/pulls/724' } });
  const issue = (body = `Filed.\n\n${subscribeLine(FILER)}`) => ({ number: 717, title: 'An issue', html_url: 'https://github.com/acme/factory/issues/717', body, labels: [], user: member, author_association: 'OWNER', assignees: [] });

  type Message = { kind: 'message', session: string, text: string, on?: number, event?: string, commit?: string, closing?: true, merged?: true, fallback?: { prompt: string } };
  const messages = (event: string, payload: unknown) => {
    const { fires, reason } = routeEvent({ event, payload, owners: OWNERS, appId: APP_ID, selectLabels: SELECT_LABELS });
    for (const { fire } of fires) assert.doesNotThrow(() => parseFire(fire), `the task accepts ${JSON.stringify(fire).slice(0, 80)}`);
    return { all: fires, sent: fires.filter((f) => f.fire.kind === 'message').map((f) => ({ ...(f.fire as Message), key: f.key })), reason };
  };

  test('a comment on a PR reaches its owner and every subscriber, one fire each; only the owner\'s carries a fallback', () => {
    const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: 'The retry budget reads inverted here.' }));
    assert.deepEqual(sent.map((m) => m.session), [OWNER, REVIEWER]);
    assert.deepEqual(sent.map((m) => m.key), ['session_01OWNERAAA', 'session_01REVIEWER'], 'each its own dedup key');
    const [owner, reviewer] = sent;
    assert.ok(owner!.fallback, 'the owner is answered either way');
    assert.equal(reviewer!.fallback, undefined, 'a subscriber that refuses is dropped, not replaced');
    assert.match(owner!.text, /your pull request/i);
    assert.match(reviewer!.text, /you subscribe to/i);
    assert.doesNotMatch(reviewer!.text, /your pull request/i);
    assert.match(reviewer!.text, /reads inverted/);
    for (const m of sent) {
      assert.equal(m.on, 724);
      assert.equal(m.event, 'comments');
    }
  });

  test('a subscriber hears only the events its line names', () => {
    const body = prBody([subscribeLine(REVIEWER, ['reviews'])]);
    assert.deepEqual(messages('issue_comment', commentEvent({ issue: prIssue(body) }, { body: 'A remark.' })).sent.map((m) => m.session), [OWNER]);
    const review = messages('pull_request_review', { ...reviewEvent({ body: 'Looks right.' }), pull_request: { ...pullRequest, body } });
    assert.deepEqual(review.sent.map((m) => [m.session, m.event]), [[OWNER, 'reviews'], [REVIEWER, 'reviews']]);
    const reviewComment = messages('pull_request_review_comment', { ...reviewCommentEvent({ body: 'Inverted.' }), pull_request: { ...pullRequest, body } });
    assert.deepEqual(reviewComment.sent.map((m) => [m.session, m.event]), [[OWNER, 'comments']]);
  });

  test('nobody hears of their own post: the URL under the footer says whose it is', () => {
    const byReviewer = messages('pull_request_review', { ...reviewEvent({ body: sessionPost('Two findings.', REVIEWER), state: 'commented' }), pull_request: { ...pullRequest, body: prBody() } });
    assert.deepEqual(byReviewer.sent.map((m) => m.session), [OWNER]);
    const byOwner = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: sessionPost('Fixed in abc123.', OWNER) }));
    assert.deepEqual(byOwner.sent.map((m) => m.session), [REVIEWER]);
    assert.match(byOwner.reason, /own/);
  });

  // The posting tool strips a footer it finds and appends its own, so the
  // URL a session wrote under the footer arrives above it (a session's
  // comment once came back to its own author this way).
  test('a session\'s own post is its own when the posting tool moved the footer below its URL', () => {
    const moved = `Dev deploy: nothing is owed.\n\n${OWNER}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`;
    const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: moved }));
    assert.deepEqual(sent.map((m) => m.session), [REVIEWER]);
  });

  test('a person\'s reply quoting a session\'s post reaches that session', () => {
    const quoted = `> Dev deploy: nothing is owed.\n>\n> ${OWNER}\n>\n> ---\n> _Generated by [Claude Code](https://claude.ai/code)_\n\nIt is: the stack drifted.`;
    const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: quoted }));
    assert.deepEqual(sent.map((m) => m.session), [OWNER, REVIEWER]);
  });

  test('a session\'s post naming no session reaches every subscriber, the owner included', () => {
    const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: sessionPost('Fixed.') }));
    assert.deepEqual(sent.map((m) => m.session), [OWNER, REVIEWER]);
  });

  // Claude Code ends a session's comment in the bare footer, so who wrote it
  // is a guess. Skipping the owner would lose a reviewer session's remark
  // and leave the PR idle; delivering costs the author one turn, and the
  // message teaches it to sign its posts so the next one is skipped.
  test('a session\'s post naming no session tells each recipient it may be its own, and how to sign its posts', () => {
    const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: sessionPost('Fixed.') }));
    for (const m of sent) {
      assert.ok(m.text.includes(UNSIGNED), `${m.session} is told the post may be its own`);
      assert.ok(m.text.includes(SIGN_POSTS), `${m.session} is told to put its link above the footer`);
    }
    const owner = sent.find((m) => m.session === OWNER)!;
    assert.ok(owner.fallback, 'a gone owner is still taken over from');
    assert.ok(!owner.fallback.prompt.includes(UNSIGNED), 'a fresh session taking the PR over wrote nothing');
    assert.doesNotMatch(owner.text, /session_01[A-Z]/, 'no literal link: a refused message is forwarded to another session as it is');
  });

  test('a session\'s post naming no session on an issue tells its filer the same', () => {
    const filed = `Filed.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${FILER}`;
    const { sent } = messages('issue_comment', commentEvent({ issue: issue(filed) }, { body: sessionPost('Raised the PR.') }));
    assert.deepEqual(sent.map((m) => m.session), [FILER]);
    assert.ok(sent[0]!.text.includes(UNSIGNED));
  });

  test('a person\'s remark, and a session\'s post naming its session, say nothing of an unsigned post', () => {
    const person = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: 'A remark.' }));
    const signed = messages('pull_request_review', { ...reviewEvent({ body: sessionPost('Two findings.', REVIEWER), state: 'commented' }), pull_request: { ...pullRequest, body: prBody() } });
    assert.deepEqual([...person.sent, ...signed.sent].map((m) => m.session), [OWNER, REVIEWER, OWNER]);
    for (const m of [...person.sent, ...signed.sent]) assert.ok(!m.text.includes(UNSIGNED), `${m.session} is told nothing of signing`);
  });

  test('a session that signs its post as told does not hear of it', () => {
    const signed = `Fixed in abc123.\n\n${REVIEWER}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`;
    const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: signed }));
    assert.deepEqual(sent.map((m) => m.session), [OWNER]);
    assert.ok(!sent[0]!.text.includes(UNSIGNED));
  });

  test('a PR a person opened, with a subscriber: the subscriber hears every remark, and a mention still summons a fresh session', () => {
    const body = `A person's PR.\n\n${subscribeLine(REVIEWER)}`;
    const plain = messages('issue_comment', commentEvent({ issue: prIssue(body) }, { body: 'A remark.' }));
    assert.deepEqual(plain.sent.map((m) => m.session), [undefined, REVIEWER], 'the session on its head branch, and the subscriber');
    assert.equal(plain.sent.find((m) => m.session === REVIEWER)!.fallback, undefined);
    const mention = messages('issue_comment', commentEvent({ issue: prIssue(body) }));
    assert.deepEqual(mention.all.map((f) => f.fire.kind).sort(), ['dispatch', 'message']);
  });

  // A PR raised from a local session names none: the session cannot learn
  // its own link. Its owner is whichever live session holds its
  // head branch, which only the task can ask the sessions API.
  describe('a PR whose body names no session', () => {
    type ByBranch = Message & { byBranch?: true; poster?: string };
    const unnamed = 'A local session\'s PR.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
    const branchFires = (event: string, payload: unknown) => messages(event, payload).sent.filter((m) => (m as ByBranch).byBranch === true) as Array<ByBranch & { key?: string }>;

    test('a remark queues one fire for the session on its head branch, as the owner, with the takeover fallback', () => {
      const [fire, ...rest] = branchFires('issue_comment', commentEvent({ issue: prIssue(unnamed) }, { body: 'A remark.' }));
      assert.deepEqual(rest, []);
      assert.equal(fire!.session, undefined, 'the task finds the session');
      assert.equal(fire!.on, 724);
      assert.equal(fire!.event, 'comments');
      assert.match(fire!.text, /your pull request/i);
      assert.ok(fire!.fallback, 'a gone owner is taken over from');
      assert.ok(fire!.key, 'its own dedup key');
      const review = branchFires('pull_request_review', { ...reviewEvent({ body: 'Looks right.' }), pull_request: { ...pullRequest, body: unnamed } });
      assert.deepEqual(review.map((m) => m.event), ['reviews']);
      const inline = branchFires('pull_request_review_comment', { ...reviewCommentEvent({ body: 'Inverted.' }), pull_request: { ...pullRequest, body: unnamed } });
      assert.deepEqual(inline.map((m) => m.event), ['comments']);
    });

    test('a close or a merge reaches it; a push does not, since the session on the branch is the one pushing', () => {
      const pr = { ...pullRequest, body: unnamed };
      const merged = branchFires('pull_request', { action: 'closed', pull_request: { ...pr, merged: true }, sender: member, repository: { full_name: REPO } });
      assert.deepEqual(merged.map((m) => [m.event, m.closing]), [['close', undefined]]);
      const closed = branchFires('pull_request', { action: 'closed', pull_request: { ...pr, merged: false }, sender: member, repository: { full_name: REPO } });
      assert.deepEqual(closed.map((m) => [m.event, m.closing]), [['close', true]]);
      const pushed = branchFires('pull_request', { action: 'synchronize', after: 'a'.repeat(40), pull_request: pr, sender: member, repository: { full_name: REPO } });
      assert.deepEqual(pushed, []);
    });

    test('a mention on it still summons a fresh session, and queues no lookup beside it', () => {
      const { all } = messages('issue_comment', commentEvent({ issue: prIssue(unnamed) }));
      assert.deepEqual(all.map((f) => f.fire.kind), ['dispatch']);
    });

    test('a mention that summons nothing (a bot\'s) still reaches the session on its head branch', () => {
      const bot = { user: { login: 'reviewer-bot[bot]', type: 'Bot' }, author_association: 'NONE', body: '@claude two findings: the guard is inverted.' };
      const { all } = messages('issue_comment', commentEvent({ issue: prIssue(unnamed) }, bot));
      assert.deepEqual(all.map((f) => [f.fire.kind, (f.fire as ByBranch).byBranch]), [['message', true]]);
    });

    test('a session\'s post naming no session is taken for the local session\'s own, and one naming a session tells the task whose it is', () => {
      assert.deepEqual(branchFires('issue_comment', commentEvent({ issue: prIssue(unnamed) }, { body: sessionPost('Fixed.') })), []);
      const [named] = branchFires('issue_comment', commentEvent({ issue: prIssue(unnamed) }, { body: sessionPost('Two findings.', REVIEWER) }));
      assert.equal(named!.poster, REVIEWER);
    });

    test('a PR whose body names its session queues no lookup', () => {
      assert.deepEqual(branchFires('issue_comment', commentEvent({ issue: prIssue() }, { body: 'A remark.' })), []);
      assert.deepEqual(branchFires('pull_request', { action: 'closed', pull_request: { ...pullRequest, body: prBody(), merged: true }, sender: member, repository: { full_name: REPO } }), []);
    });

    test('the task takes a lookup only for a PR, and never beside a session it names', () => {
      const fire = { kind: 'message', byBranch: true, on: 724, text: 'A remark.', repo: REPO };
      assert.deepEqual(parseFire(fire), fire);
      assert.throws(() => parseFire({ ...fire, on: undefined }), /on/);
      assert.throws(() => parseFire({ ...fire, session: OWNER }), /session or/);
      assert.throws(() => parseFire({ ...fire, poster: 'someone' }), /poster/);
      assert.throws(() => parseFire({ kind: 'message', on: 724, text: 'A remark.', repo: REPO }), /session/);
    });

    test('an issue whose body names no session queues no lookup: an issue has no branch', () => {
      assert.deepEqual(branchFires('issue_comment', commentEvent({ issue: issue('Filed by a person.') }, { body: 'A remark.' })), []);
    });
  });

  test('a stranger, the dispatcher\'s marker, and an edited comment reach no subscriber', () => {
    const stranger = messages('issue_comment', commentEvent({ issue: prIssue() }, { user: { login: 'passer-by', type: 'User' }, author_association: 'NONE', body: 'Nice.' }));
    assert.deepEqual(stranger.all, []);
    const marker = messages('issue_comment', commentEvent({ issue: prIssue() }, { user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', body: dispatchMarker({ at: '2026-09-26T08:00:00.000Z', sessionUrl: 'https://claude.ai/code/session_01NEW' }) }));
    assert.deepEqual(marker.all, []);
    assert.deepEqual(messages('issue_comment', commentEvent({ issue: prIssue(), action: 'edited' }, { body: 'A remark.' })).all, []);
  });

  /**
   * The PR review's comment is the record. The owner hears only what
   * it can act on, a fail an edit meets and a conflict, as its own message
   * fire with the fallback any comment carries; a subscriber reads
   * the comment, and a pass or a fail no edit meets reaches no one.
   */
  test('the PR review\'s comment reaches the owner alone, and only when it can act on it', () => {
    const bot = { user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', performed_via_github_app: { id: APP_ID } };
    const marker = reviewMarker('a'.repeat(40), 'b'.repeat(64));
    for (const text of [
      'Passes the PR review: closes #717 as written.',
      'Waits for a person: the change adds an IAM grant (test 7). No edit to the description makes it pass. A person merges it.',
    ]) {
      const review = messages('issue_comment', commentEvent({ issue: prIssue() }, { ...bot, body: `${text}\n\n${marker}` }));
      assert.deepEqual(review.all, [], text);
      assert.match(review.reason, /review/);
    }
    for (const text of [
      'Waits for a description edit: name the criterion (test 2). An edit to the description meets it, and the review runs again on the edit.',
      'Passes the PR review, but conflicts with its base: merging the base branch in is the author session\'s to push, and the review runs again on the push. Closes #717.',
      `Conflicts with its base since main moved to ${'c'.repeat(40)} (after #793 merged): merging the base branch in is the author session's to push, and the review runs again on the push.`,
    ]) {
      const review = messages('issue_comment', commentEvent({ issue: prIssue() }, { ...bot, body: `${text}\n\n${marker}` }));
      assert.deepEqual(review.sent.map((m) => [m.session, m.on, m.event]), [[OWNER, 724, 'comments']], text);
      assert.ok(review.sent[0]!.fallback, 'the owner is answered either way');
      assert.ok(review.sent[0]!.text.includes(text));
      assert.doesNotMatch(review.sent[0]!.text, /governor:pr-review/, 'the marker is the receiver\'s, not the session\'s to quote');
      assert.doesNotMatch(review.sent[0]!.fallback!.prompt, /governor:pr-review/);
    }
  });

  // The marker is the review's only on the dispatcher's own App's
  // comment. Another App's, or a workflow's, is any bot's remark.
  test('another bot\'s comment carrying the review\'s marker reaches every subscriber as an ordinary comment', () => {
    const text = `Waits for a description edit: name the criterion (test 2). An edit to the description meets it, and the review runs again on the edit.\n\n${reviewMarker('a'.repeat(40), 'b'.repeat(64))}`;
    for (const [who, app] of [
      ['github-actions[bot]', { id: 15368 }],
      ['other-app[bot]', { id: APP_ID + 1 }],
      ['governor-app[bot]', null],
    ] as const) {
      const comment = { user: { login: who, type: 'Bot' }, author_association: 'NONE', performed_via_github_app: app, body: text };
      const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, comment));
      assert.deepEqual(sent.map((m) => m.session), [OWNER, REVIEWER], who);
      assert.match(sent[0]!.text, /^A comment on your pull request\./, 'the owner hears a comment, as from any bot');
      assert.match(sent[1]!.text, /you subscribe to/i);
    }
    const passing = { user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', performed_via_github_app: { id: 15368 }, body: `Passes the PR review: closes #717 as written.\n\n${reviewMarker('a'.repeat(40), 'b'.repeat(64))}` };
    assert.deepEqual(messages('issue_comment', commentEvent({ issue: prIssue() }, passing)).sent.map((m) => m.session), [OWNER, REVIEWER], 'a pass it forged is not dropped as the review\'s record');
    const unconfigured = routeEvent({ event: 'issue_comment', payload: commentEvent({ issue: prIssue() }, { user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', performed_via_github_app: { id: APP_ID }, body: text }), owners: OWNERS });
    assert.equal(unconfigured.fires.length, 2, 'a receiver that knows no App ID takes no comment for the review\'s');
  });

  test('a review comment an edit meets, but written by a person or edited in place, reaches no one', () => {
    const text = `Waits for a description edit: name the criterion (test 2). An edit to the description meets it, and the review runs again on the edit.\n\n${reviewMarker('a'.repeat(40), 'b'.repeat(64))}`;
    assert.deepEqual(messages('issue_comment', commentEvent({ issue: prIssue() }, { body: text })).all, [], 'a person quoting it');
    assert.deepEqual(messages('issue_comment', commentEvent({ issue: prIssue(), action: 'edited' }, { user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', body: text })).all, [], 'edited in place');
  });

  const pullRequestEvent = (action: string, over: Record<string, unknown> = {}) => ({
    action,
    number: 724,
    before: '1111111111111111111111111111111111111111',
    after: '2222222222222222222222222222222222222222',
    pull_request: { ...pullRequest, body: prBody(), merged: false, head: { ...pullRequest.head, sha: '2222222222222222222222222222222222222222' } },
    sender: member,
    repository: { full_name: REPO, html_url: 'https://github.com/acme/factory', default_branch: 'main' },
    ...over,
  });

  test('a push to a PR reaches its subscribers to pushes, naming the commit so the task can skip the session that pushed it', () => {
    const body = prBody([subscribeLine(REVIEWER, ['pushes']), subscribeLine(FILER, ['comments'])]);
    const { sent } = messages('pull_request', pullRequestEvent('synchronize', { pull_request: { ...pullRequestEvent('synchronize').pull_request, body } }));
    assert.deepEqual(sent.map((m) => m.session), [OWNER, REVIEWER]);
    for (const m of sent) {
      assert.equal(m.event, 'pushes');
      assert.equal(m.commit, '2222222222222222222222222222222222222222');
      assert.equal(m.fallback, undefined, 'a push is nothing a fresh session is started for');
      assert.match(m.text, /PR #724/);
      assert.match(m.text, /compare\/1{40}\.\.\.2{40}/);
    }
    assert.match(sent[0]!.text, /your pull request/i);
    assert.match(sent[1]!.text, /you subscribe to/i);
  });

  // A merge is not the end of a PR's work: CI on main and the dev deploy are
  // still to come, so only a deploy's message says to archive.
  test('a PR closed, merged or not, reaches its subscribers to close, and says which; only one closed unmerged is the last word', () => {
    const merged = messages('pull_request', pullRequestEvent('closed', { pull_request: { ...pullRequestEvent('closed').pull_request, merged: true } }));
    assert.deepEqual(merged.sent.map((m) => [m.session, m.event, m.closing]), [[OWNER, 'close', undefined], [REVIEWER, 'close', undefined]]);
    assert.match(merged.sent[0]!.text, /merged/);
    assert.ok(merged.sent.every((m) => m.fallback === undefined));
    const abandoned = messages('pull_request', pullRequestEvent('closed'));
    assert.match(abandoned.sent[0]!.text, /closed without merging/);
    assert.ok(abandoned.sent.every((m) => m.closing === true));
  });

  // The owner's message of a merge into main is marked merged.
  test('a PR merged into main marks its owner\'s message merged, and no subscriber\'s; a merge elsewhere or a close marks none', () => {
    const closedWith = (over: Record<string, unknown>) => pullRequestEvent('closed', { pull_request: { ...pullRequestEvent('closed').pull_request, ...over } });
    const merged = messages('pull_request', closedWith({ merged: true, base: { ref: 'main' } }));
    assert.deepEqual(merged.sent.map((m) => [m.session, m.merged]), [[OWNER, true], [REVIEWER, undefined]]);
    for (const payload of [closedWith({ merged: true, base: { ref: 'claude/stacked' } }), closedWith({ merged: false, base: { ref: 'main' } })]) {
      assert.ok(messages('pull_request', payload).sent.every((m) => m.merged === undefined), JSON.stringify(payload.pull_request));
    }
    const local = messages('pull_request', closedWith({ merged: true, base: { ref: 'main' }, body: 'No session named.' }));
    assert.deepEqual(local.all.filter((f) => f.fire.kind === 'message').map((f) => [(f.fire as { byBranch?: true }).byBranch, (f.fire as { merged?: true }).merged]), [[true, true]], 'a local owner by branch is the owner');
  });

  // GitHub has no event for a PR a merge left conflicted, so the
  // merge's own close queues the check of every open PR.
  test('a PR merged into main queues one conflicts fire naming it and its merge commit, keyed apart from the subscribers\' fires', () => {
    const mergedInto = (base: string, over: Record<string, unknown> = {}) => pullRequestEvent('closed', {
      pull_request: { ...pullRequestEvent('closed').pull_request, merged: true, merge_commit_sha: '3333333333333333333333333333333333333333', base: { ref: base }, ...over },
    });
    const { all } = messages('pull_request', mergedInto('main'));
    const checks = all.filter((f) => f.fire.kind === 'conflicts');
    assert.deepEqual(checks.map((f) => [f.fire, f.key]), [[{ kind: 'conflicts', pr: 724, sha: '3333333333333333333333333333333333333333', base: 'main', counted: 'merges', repo: REPO }, 'conflicts']]);
    for (const payload of [
      mergedInto('claude/stacked'),
      mergedInto('main', { merge_commit_sha: null }),
      pullRequestEvent('closed', { pull_request: { ...pullRequestEvent('closed').pull_request, base: { ref: 'main' } } }),
      pullRequestEvent('synchronize'),
    ]) {
      assert.deepEqual(messages('pull_request', payload).all.filter((f) => f.fire.kind === 'conflicts'), [], JSON.stringify(payload.pull_request));
    }
  });

  // The PR review runs in the task, which reads the PR; the fire
  // names the PR and the head it was queued for.
  const REVIEW = { kind: 'review', pr: 724, headSha: '2222222222222222222222222222222222222222', repo: REPO };
  const reviews = (all: ReturnType<typeof messages>['all']) => all.filter((f) => f.fire.kind === 'review');

  test('a PR opened, readied, pushed to, its body edited or its base retargeted queues one review fire naming the PR and its head', () => {
    for (const payload of [
      pullRequestEvent('opened'),
      pullRequestEvent('ready_for_review'),
      pullRequestEvent('synchronize'),
      pullRequestEvent('edited', { changes: { body: { from: 'The old body.' } } }),
      pullRequestEvent('edited', { changes: { title: { from: 'Old' }, body: { from: 'The old body.' } } }),
      // A stacked PR the review skipped, retargeted to main once the PR below merged.
      pullRequestEvent('edited', { changes: { base: { ref: { from: 'claude/the-pr-below' }, sha: { from: 'x' } } } }),
    ]) {
      const { all, reason } = messages('pull_request', payload);
      const found = reviews(all);
      assert.deepEqual(found.map((f) => f.fire), [REVIEW], `${payload.action}: ${reason}`);
      assert.equal(found[0]!.key, 'review', 'keyed apart from the subscribers\' fires on the same delivery');
    }
  });

  test('a PR Dependabot opened or rebased queues its review like any: the review, not the receiver, decides a bot\'s PR', () => {
    const dependabot = { login: 'dependabot[bot]', type: 'Bot' };
    for (const action of ['opened', 'synchronize']) {
      const event = pullRequestEvent(action);
      const payload = { ...event, sender: dependabot, pull_request: { ...event.pull_request, user: dependabot, author_association: 'NONE' } };
      assert.deepEqual(reviews(messages('pull_request', payload).all).map((f) => f.fire), [REVIEW], action);
    }
  });

  test('a push queues the review beside the subscribers\' messages', () => {
    const { all } = messages('pull_request', pullRequestEvent('synchronize'));
    assert.deepEqual(all.map((f) => f.fire.kind).sort(), ['message', 'message', 'review']);
  });

  test('a title-only edit, and every other pull_request action, queues no review', () => {
    for (const payload of [
      pullRequestEvent('edited', { changes: { title: { from: 'Old' } } }),
      pullRequestEvent('edited'),
      ...['labeled', 'reopened', 'review_requested', 'converted_to_draft', 'assigned'].map((action) => pullRequestEvent(action)),
    ]) {
      const { all, reason } = messages('pull_request', payload);
      assert.deepEqual(all, [], `${payload.action} ${JSON.stringify((payload as { changes?: unknown }).changes)}`);
      assert.ok(reason.length > 0);
    }
  });

  test('a review fire with no usable head still names the PR, and the task reads the head itself', () => {
    const payload = pullRequestEvent('opened', { pull_request: { ...pullRequestEvent('opened').pull_request, head: { ref: 'x' } } });
    assert.deepEqual(reviews(messages('pull_request', payload).all).map((f) => f.fire), [{ kind: 'review', pr: 724, repo: REPO }]);
  });

  test('an issue\'s lines subscribe to its comments, labels and close', () => {
    const comment = messages('issue_comment', commentEvent({ issue: issue() }, { body: 'Is this still wanted?' }));
    assert.deepEqual(comment.sent.map((m) => [m.session, m.event, m.on]), [[FILER, 'comments', 717]]);
    assert.equal(comment.sent[0]!.fallback, undefined);
    assert.match(comment.sent[0]!.text, /Issue #717/);
    assert.match(comment.sent[0]!.text, /still wanted/);

    const labelled = messages('issues', { action: 'labeled', label: { name: 'type: bug' }, issue: issue(), sender: member, repository: { full_name: REPO } });
    assert.deepEqual(labelled.sent.map((m) => [m.session, m.event]), [[FILER, 'labels']]);
    assert.match(labelled.sent[0]!.text, /type: bug/);
    const unlabelled = messages('issues', { action: 'unlabeled', label: { name: 'type: bug' }, issue: issue(), sender: member, repository: { full_name: REPO } });
    assert.deepEqual(unlabelled.sent.map((m) => m.event), ['labels']);

    const reopened = messages('issues', { action: 'reopened', issue: issue(), sender: member, repository: { full_name: REPO } });
    assert.deepEqual(reopened.sent.map((m) => [m.session, m.event, m.closing]), [[FILER, 'close', undefined]], 'a reopen closes nothing');
    assert.match(reopened.sent[0]!.text, /reopened/);
  });

  test('an issue\'s footer subscribes its filer to every event but labels with no line: its close queues one message fire', () => {
    const filed = issue(`Filed.${footer}`);
    const closed = messages('issues', { action: 'closed', issue: { ...filed, state_reason: 'completed' }, sender: member, repository: { full_name: REPO } });
    assert.deepEqual(closed.sent.map((m) => [m.session, m.event, m.on, m.closing]), [[OWNER, 'close', 717, true]]);
    assert.match(closed.sent[0]!.text, /closed/);

    const comment = messages('issue_comment', commentEvent({ issue: issue(`Filed.\n\n${subscribeLine(FILER)}${footer}`) }, { body: 'Is this still wanted?' }));
    assert.deepEqual(comment.sent.map((m) => m.session), [OWNER, FILER], 'the filer first, then each line');
    assert.equal(comment.sent[0]!.fallback, undefined, 'no takeover: a fallback takes a PR over, and an issue has nothing to take');
    assert.doesNotMatch(comment.sent[0]!.text, /pull request/i);

    const own = messages('issue_comment', commentEvent({ issue: filed }, { body: sessionPost('Still wanted.', OWNER) }));
    assert.deepEqual(own.sent, [], 'nor does the filer hear of its own comment');
  });

  test('a label reaches an issue\'s filer only through a line: a label carries no session to skip, so the filer\'s own would echo back', () => {
    const labelled = (body: string, action = 'labeled') => messages('issues', { action, label: { name: 'type: adr' }, issue: issue(body), sender: member, repository: { full_name: REPO } });
    assert.deepEqual(labelled(`Filed.${footer}`).sent, []);
    assert.deepEqual(labelled(`Filed.${footer}`, 'unlabeled').sent, []);
    assert.deepEqual(labelled(`Filed.\n\n${subscribeLine(FILER)}${footer}`).sent.map((m) => [m.session, m.event]), [[FILER, 'labels']], 'another subscriber still hears');
    assert.deepEqual(labelled(`Filed.\n\n${subscribeLine(OWNER, ['labels'])}${footer}`).sent.map((m) => [m.session, m.event]), [[OWNER, 'labels']], 'a filer that asks for labels hears them');

    const ready = messages('issues', { action: 'labeled', label: { name: 'workflow: ready for development' }, issue: issue(`Filed.${footer}`), sender: member, repository: { full_name: REPO } });
    assert.deepEqual(ready.all.map((f) => f.fire), [{ kind: 'schedule', issue: 717, label: 'workflow: ready for development', repo: REPO }], 'the ready label still schedules');
  });

  test('a deployed: label added is a deploys event: it reaches deploys lines and lines naming no events, not labels lines, and the filer only through a line', () => {
    const deployed = (body: string, action = 'labeled', name = 'deployed: prod', state = 'closed') =>
      messages('issues', { action, label: { name }, issue: { ...issue(body), state }, sender: { login: 'governor-app[bot]', type: 'Bot' }, repository: { full_name: REPO } });
    const lines = [subscribeLine(FILER, ['deploys']), subscribeLine(REVIEWER, ['labels'])].join('\n');
    const sent = deployed(`Filed.\n\n${lines}${footer}`).sent;
    assert.deepEqual(sent.map((m) => [m.session, m.event, m.on, m.closing]), [[FILER, 'deploys', 717, true]], 'no labels subscriber, no filer by default; asks for sign-off as a close does');
    assert.match(sent[0]!.text, /Issue #717/);
    assert.match(sent[0]!.text, /\bprod\b/);
    assert.match(sent[0]!.text.split('\n')[0]!, /reached prod\.$/, 'a deploy, not a label');

    assert.deepEqual(deployed(`Filed.\n\n${subscribeLine(FILER)}`).sent.map((m) => [m.session, m.event]), [[FILER, 'deploys']], 'a line naming no events hears it');
    assert.deepEqual(deployed(`Filed.${footer}`).sent, [], 'the filer does not hear by default');
    assert.deepEqual(deployed(`Filed.\n\n${subscribeLine(OWNER, ['deploys'])}${footer}`).sent.map((m) => [m.session, m.event]), [[OWNER, 'deploys']], 'a filer that asks hears');
    assert.match(deployed(`Filed.\n\n${subscribeLine(FILER)}`, 'labeled', 'deployed: play track').sent[0]!.text, /play track/);
    assert.deepEqual(deployed(`Filed.\n\n${subscribeLine(FILER)}`, 'labeled', 'deployed: dev', 'open').sent.map((m) => [m.event, m.closing]), [['deploys', undefined]], 'a reopened issue is not finished with, so no sign-off ask');

    const removed = deployed(`Filed.\n\n${lines}${footer}`, 'unlabeled');
    assert.deepEqual(removed.sent.map((m) => [m.session, m.event]), [[REVIEWER, 'labels']], 'a removal is a person\'s edit, so a labels event');
    assert.deepEqual(deployed(`Filed.\n\n${lines}${footer}`, 'labeled', 'deployment: prod').sent.map((m) => m.event), ['labels'], 'only the deployed: family');
  });

  test('the ready label keeps its schedule fire beside the subscriber\'s message, and so does a close', () => {
    const ready = messages('issues', { action: 'labeled', label: { name: 'workflow: ready for development' }, issue: issue(), sender: member, repository: { full_name: REPO } });
    assert.deepEqual(ready.all.map((f) => f.fire), [{ kind: 'schedule', issue: 717, label: 'workflow: ready for development', repo: REPO }, ...ready.sent.map(({ key: _key, ...fire }) => fire)]);
    assert.equal(ready.all[0]!.key, undefined, 'the schedule fire keys on the delivery alone, as before');
    assert.deepEqual(ready.sent.map((m) => m.event), ['labels']);
    const closed = messages('issues', { action: 'closed', issue: { ...issue(), state_reason: 'completed' }, sender: member, repository: { full_name: REPO } });
    assert.deepEqual(closed.all[0]!.fire, { kind: 'schedule', freed: 717, counted: 'issuesClosed', repo: REPO });
    assert.deepEqual(closed.sent.map((m) => [m.session, m.event, m.closing]), [[FILER, 'close', true]]);
    assert.match(closed.sent[0]!.text, /closed/);
  });

  // The dispatcher puts the ready label back when a launch it claimed for
  // fails. A fire for that label would claim and launch the same
  // ticket again inside the turn's lane, so a ready label a bot added queues
  // no selection: the payload names no App behind a bot sender, and the
  // dispatcher's is the only bot that adds the label. Its subscribers still hear it.
  test('a ready label the dispatcher\'s App added queues no selection, and still reaches subscribers', () => {
    const app = { login: 'governor-app[bot]', type: 'Bot' };
    const ready = messages('issues', { action: 'labeled', label: { name: 'workflow: ready for development' }, issue: issue(), sender: app, repository: { full_name: REPO } });
    assert.deepEqual(ready.all.filter((f) => f.fire.kind === 'schedule'), [], 'no selection fire');
    assert.deepEqual(ready.sent.map((m) => [m.session, m.event]), [[FILER, 'labels']], 'the subscriber hears it');
    const bare = route({ event: 'issues', payload: issuesEvent('labeled', { label: { name: 'workflow: ready for development' }, sender: app }), owners: OWNERS });
    assert.equal(bare.fire, undefined);
  });

  test('a subscriber\'s fire fits the container override too, whatever the remark holds', () => {
    for (const fill of ['x', '"', '字']) {
      const { sent } = messages('issue_comment', commentEvent({ issue: prIssue() }, { body: fill.repeat(10_000) }));
      for (const { key: _key, ...fire } of sent) {
        const override = JSON.stringify(containerOverride('dispatch', fire));
        assert.ok(Buffer.byteLength(override) < OVERRIDE_CAP, `${fill} ${fire.session}: ${Buffer.byteLength(override)} bytes`);
      }
    }
  });
});

/**
 * A completed job: the one that earns a `deployed: ` label says
 * so in its name, so the receiver fires on `workflow_job` from the payload
 * alone, and the task labels and tells from the run that job is of. It
 * reads nothing: a job's name, run, commit and page are all in the payload.
 */
describe('routeEvent — a workflow job', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const BUILT = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2';
  const NAME = `dev / Publish (dev) at ${BUILT} · deployed: dev`;
  const workflowJob = (over: Record<string, unknown> = {}, action = 'completed') => ({
    action,
    workflow_job: {
      id: 9001, run_id: 500, run_attempt: 1, head_sha: SHA, head_branch: 'main', name: NAME, workflow_name: 'Deliver', status: 'completed', conclusion: 'success',
      html_url: `https://github.com/${REPO}/actions/runs/500/job/9001`, steps: [], ...over,
    },
    repository: { full_name: REPO, default_branch: 'main' },
  });

  test('a marked job that succeeded on main queues a job fire naming the job, its run, its label and the commit its name carries', () => {
    const { fire, reason } = route({ event: 'workflow_job', payload: workflowJob(), owners: OWNERS });
    assert.deepEqual(fire, { kind: 'job', name: NAME, workflow: 'Deliver', branch: 'main', runId: 500, jobId: 9001, url: `https://github.com/${REPO}/actions/runs/500/job/9001`, headSha: SHA, label: 'deployed: dev', commit: BUILT, runAttempt: 1, repo: REPO }, reason);
    assert.doesNotThrow(() => parseFire(fire), 'what the receiver queues, the task accepts');
    assert.match(reason, /deployed: dev/);
  });

  test('a marked job naming no commit built the run\'s head; a re-run attempt fires too, and the cursor keeps it from telling twice', () => {
    const prod = route({ event: 'workflow_job', payload: workflowJob({ name: 'prod / Publish (prod) · deployed: prod', run_attempt: 2 }), owners: OWNERS });
    assert.deepEqual(prod.fire, { kind: 'job', name: 'prod / Publish (prod) · deployed: prod', workflow: 'Deliver', branch: 'main', runId: 500, jobId: 9001, url: `https://github.com/${REPO}/actions/runs/500/job/9001`, headSha: SHA, label: 'deployed: prod', commit: SHA, runAttempt: 2, repo: REPO });
    const unattempted = route({ event: 'workflow_job', payload: workflowJob({ run_attempt: undefined }), owners: OWNERS });
    assert.equal((unattempted.fire as { runAttempt?: number }).runAttempt, undefined);
  });

  test('every other job is acknowledged with nothing queued, saying why', () => {
    for (const [payload, why] of [
      [workflowJob({}, 'queued'), /completed/],
      [workflowJob({}, 'in_progress'), /completed/],
      [workflowJob({ conclusion: 'failure' }), /success/],
      [workflowJob({ conclusion: 'skipped' }), /success/],
      [workflowJob({ conclusion: 'cancelled' }), /success/],
      [workflowJob({ head_branch: 'claude/a-branch' }), /main/],
      [workflowJob({ head_branch: null }), /main/],
      [workflowJob({ name: 'dev / Deploy stack (dev)' }), /marker|shipping/],
      [workflowJob({ name: `Publish (dev) at ${BUILT}` }), /marker|shipping/],
      [workflowJob({ name: 'Dry run: Publish (dev) · deployed: ' }), /marker|shipping/],
      [workflowJob({ head_sha: 'main' }), /commit|head_sha/],
      // The task takes a whole commit id only (parseFire): a short one the
      // marker reads is refused here, not queued to fail in the task.
      [workflowJob({ name: 'dev / Publish (dev) at 0123abc · deployed: dev' }), /commit/],
      [workflowJob({ html_url: 'job 9001' }), /url|link/],
    ] as const) {
      const decision = route({ event: 'workflow_job', payload, owners: OWNERS });
      assert.equal(decision.fire, undefined, JSON.stringify(payload));
      assert.match(decision.reason, why, JSON.stringify(payload));
    }
  });

  test('a delivery of one is queued from the payload alone, keyed by the delivery', async () => {
    const { deps, queued, logged } = harness();
    const response = await handle(delivery('workflow_job', workflowJob()), deps);
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.dedupId, 'd-1');
    assert.equal((queued[0]!.message.fire as { kind: string }).kind, 'job');
    assert.equal(queued[0]!.message.github, 'workflow_job');
    assert.ok(logged.some((l) => l.event === 'webhook-queued' && l.kind === 'job'), JSON.stringify(logged));
    assert.deepEqual(Object.keys(deps).sort(), ['appId', 'countFire', 'enqueue', 'hookSecret', 'listedHooks', 'log', 'owners', 'secret', 'selectLabels'], 'the receiver holds no GitHub reader');
  });
});

/**
 * A completed run. The receiver holds no GitHub
 * token, so it only names the run and its file; the task reads the rest. A
 * red run on main is a workflow fire, a CI run only from a push; a green
 * run queues nothing, since each of its shipping jobs fired on its own
 * (`routeEvent — a workflow job`); a red scheduled run starts a session of
 * its own; a run dispatched on a branch is a branch-run fire.
 */
describe('routeEvent — a workflow run', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const workflowRun = (over: Record<string, unknown> = {}, action = 'completed') => ({
    action,
    workflow_run: { id: 500, name: 'CI', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'failure', html_url: `https://github.com/${REPO}/actions/runs/500`, event: 'push', run_attempt: 1, ...over },
    repository: { full_name: REPO, default_branch: 'main' },
  });

  test('a red CI run on main, and a red run of a deploy workflow, queue a workflow fire naming the run', () => {
    for (const [name, event] of [['CI', 'push'], ['Deliver', 'workflow_run'], ['Deliver', 'workflow_dispatch'], ['Dispatch stack', 'push']] as const) {
      const { fires, reason } = routeEvent({ event: 'workflow_run', payload: workflowRun({ name, event, conclusion: 'failure' }), owners: OWNERS });
      const workflow = fires.filter((f) => f.fire.kind === 'workflow');
      assert.deepEqual(workflow.map((f) => f.fire), [{ kind: 'workflow', name, branch: 'main', event, runId: 500, url: `https://github.com/${REPO}/actions/runs/500`, conclusion: 'failure', headSha: SHA, runAttempt: 1, repo: REPO }], reason);
      for (const { fire } of fires) assert.doesNotThrow(() => parseFire(fire), 'what the receiver queues, the task accepts');
    }
  });

  // A green run's shipping jobs each fire on their own, with the
  // label each earns; the run as a whole says nothing a job did not.
  test('a green run of any workflow on main queues nothing: its shipping jobs fired', () => {
    for (const [name, path, event] of [
      ['CI', '.github/workflows/ci.yml', 'push'],
      ['Deliver', '.github/workflows/deliver.yml', 'workflow_run'],
      ['Deliver', '.github/workflows/deliver.yml', 'workflow_dispatch'],
      ['Dispatch stack', '.github/workflows/deploy.yml', 'push'],
      ['Android release', '.github/workflows/android-release.yml', 'workflow_dispatch'],
    ] as const) {
      const decision = route({ event: 'workflow_run', payload: workflowRun({ name, path, event, conclusion: 'success' }), owners: OWNERS });
      assert.equal(decision.fire, undefined, `${name} ${event}: ${decision.reason}`);
      assert.match(decision.reason, /shipping job/);
    }
  });

  // An earlier review held every merge while a Deploy Prod run was
  // unfinished; nothing holds one now, so no run's end reviews anything.
  test('no run\'s end queues a review of the open PRs, whatever it concluded', () => {
    for (const name of ['Deploy Prod', 'Deliver', 'Deploy']) {
      for (const conclusion of ['success', 'failure', 'cancelled']) {
        const { fires } = routeEvent({ event: 'workflow_run', payload: workflowRun({ name, event: 'workflow_dispatch', conclusion }), owners: OWNERS });
        assert.deepEqual(fires.filter((f) => f.fire.kind === 'review'), [], `${name} ${conclusion}`);
      }
    }
  });

  // The task reads the workflow's file at the run's commit for the
  // target it declares, so the receiver queues every workflow's red run and
  // names the file; it reads none itself.
  test('a red run of any workflow on main queues a workflow fire naming its file', () => {
    for (const [name, path, event] of [
      ['CI', '.github/workflows/ci.yml', 'push'],
      ['Android release', '.github/workflows/android-release.yml', 'workflow_dispatch'],
      ['Dispatch stack', '.github/workflows/deploy.yml', 'push'],
      ['Publish to MCP Registry', '.github/workflows/publish-mcp.yml', 'workflow_dispatch'],
    ] as const) {
      const { fires, reason } = routeEvent({ event: 'workflow_run', payload: workflowRun({ name, path, event, conclusion: 'failure' }), owners: OWNERS });
      const workflow = fires.filter((f) => f.fire.kind === 'workflow');
      assert.deepEqual(workflow.map((f) => f.fire), [{ kind: 'workflow', name, path, branch: 'main', event, runId: 500, url: `https://github.com/${REPO}/actions/runs/500`, conclusion: 'failure', headSha: SHA, runAttempt: 1, repo: REPO }], reason);
      assert.doesNotThrow(() => parseFire(workflow[0]!.fire), 'what the receiver queues, the task accepts');
    }
  });

  test('a path outside .github/workflows is left off the fire, which still names the run', () => {
    for (const path of ['dynamic/pages/pages-build-deployment', '../ci.yml', 7, undefined]) {
      const { fire } = route({ event: 'workflow_run', payload: workflowRun({ name: 'Deliver', event: 'workflow_run', conclusion: 'failure', path }), owners: OWNERS });
      assert.equal(fire?.kind, 'workflow');
      assert.equal((fire as { path?: string }).path, undefined, String(path));
    }
  });

  // Whether a run is CI is the task's, from the repo's `workflows.ci`: the receiver matches no workflow by name, and names the event,
  // so the task can refuse a CI dispatched by hand that tested no merge.
  test('a red CI dispatched by hand on main is queued with its event: the task decides', () => {
    const { fire, reason } = route({ event: 'workflow_run', payload: workflowRun({ event: 'workflow_dispatch' }), owners: OWNERS });
    assert.equal(fire?.kind, 'workflow', reason);
    assert.equal((fire as { event?: string }).event, 'workflow_dispatch');
  });

  test('a run on main that timed out is told as a failure', () => {
    for (const name of ['Deliver', 'Dispatch stack', 'Android release']) {
      const { fires, reason } = routeEvent({ event: 'workflow_run', payload: workflowRun({ name, event: 'workflow_dispatch', conclusion: 'timed_out' }), owners: OWNERS });
      const workflow = fires.filter((f) => f.fire.kind === 'workflow').map((f) => f.fire);
      assert.equal(workflow.length, 1, reason);
      assert.equal((workflow[0] as { conclusion?: string }).conclusion, 'failure', name);
      assert.doesNotThrow(() => parseFire(workflow[0]!), 'what the receiver queues, the task accepts');
    }
  });

  test('every other run is acknowledged with nothing queued', () => {
    for (const payload of [
      workflowRun({}, 'requested'),
      workflowRun({}, 'in_progress'),
      workflowRun({ conclusion: 'cancelled' }),
      workflowRun({ conclusion: 'success' }),
      workflowRun({ name: 'Deliver', conclusion: 'skipped' }),
      workflowRun({ name: 'Deliver', conclusion: 'cancelled' }),
      workflowRun({ head_branch: 'claude/a-branch' }),
    ]) {
      const decision = route({ event: 'workflow_run', payload, owners: OWNERS });
      assert.equal(decision.fire, undefined, JSON.stringify(payload.workflow_run));
      assert.ok(decision.reason.length > 0);
    }
  });

  // A run dispatched on a branch is one a session waits on before it raises
  // or readies its PR (the pre-push skill): the task tells the session that
  // wrote the commit it tested, whatever it concluded.
  describe('a run dispatched on a branch', () => {
    const BRANCH = 'claude/emulator-share-x1';
    const dispatched = (over: Record<string, unknown> = {}, action = 'completed') =>
      workflowRun({ name: 'Emulator', head_branch: BRANCH, event: 'workflow_dispatch', conclusion: 'success', ...over }, action);

    test('finished, whatever the workflow and whatever it concluded, queues a branch-run fire naming the run and its branch', () => {
      for (const [name, conclusion] of [['Emulator', 'success'], ['Device', 'failure'], ['Apple E2E', 'timed_out'], ['CI', 'cancelled'], ['E2E', 'startup_failure']] as const) {
        const { fires, reason } = routeEvent({ event: 'workflow_run', payload: dispatched({ name, conclusion }), owners: OWNERS });
        assert.deepEqual(fires.map((f) => f.fire), [{ kind: 'branch-run', name, runId: 500, url: `https://github.com/${REPO}/actions/runs/500`, conclusion, headSha: SHA, branch: BRANCH, runAttempt: 1, repo: REPO }], reason);
        assert.doesNotThrow(() => parseFire(fires[0]!.fire), 'what the receiver queues, the task accepts');
      }
    });

    test('a re-run is told too: the session that re-ran it waits on it', () => {
      const { fire, reason } = route({ event: 'workflow_run', payload: dispatched({ run_attempt: 2 }), owners: OWNERS });
      assert.deepEqual(fire, { kind: 'branch-run', name: 'Emulator', runId: 500, url: `https://github.com/${REPO}/actions/runs/500`, conclusion: 'success', headSha: SHA, branch: BRANCH, runAttempt: 2, repo: REPO }, reason);
    });

    // On main, the head commit is the last merge's, not the dispatcher's: a
    // red run there is a workflow fire; a green one's shipping jobs fired.
    test('on main, a dispatched run is a workflow fire when red, and no branch run either way', () => {
      const red = route({ event: 'workflow_run', payload: dispatched({ head_branch: 'main', conclusion: 'failure' }), owners: OWNERS });
      assert.equal(red.fire?.kind, 'workflow', red.reason);
      const green = route({ event: 'workflow_run', payload: dispatched({ head_branch: 'main' }), owners: OWNERS });
      assert.equal(green.fire, undefined, green.reason);
      assert.match(green.reason, /shipping job/);
    });

    test('unfinished, not dispatched, or naming no branch or commit, queues nothing', () => {
      for (const payload of [
        dispatched({}, 'in_progress'),
        dispatched({}, 'requested'),
        dispatched({ event: 'push' }),
        dispatched({ event: 'workflow_run' }),
        dispatched({ head_branch: '' }),
        dispatched({ head_branch: null }),
        dispatched({ head_sha: 'main' }),
        dispatched({ id: 0 }),
        dispatched({ name: ' ' }),
        // What the task would refuse, the receiver does not queue.
        dispatched({ html_url: undefined }),
        dispatched({ html_url: 'http://github.com/x' }),
        dispatched({ conclusion: null }),
      ]) {
        const decision = route({ event: 'workflow_run', payload, owners: OWNERS });
        assert.equal(decision.fire, undefined, JSON.stringify(payload.workflow_run));
        assert.ok(decision.reason.length > 0);
      }
    });

    test('a red deploy dispatched on main is a workflow fire alone, not a branch run and no review sweep', () => {
      const { fires, reason } = routeEvent({ event: 'workflow_run', payload: dispatched({ name: 'Deliver', head_branch: 'main', conclusion: 'failure' }), owners: OWNERS });
      assert.deepEqual(fires.map((f) => f.fire.kind), ['workflow'], reason);
    });

    test('its fire fits the container override, whatever the branch and workflow are called', () => {
      const { fire } = route({ event: 'workflow_run', payload: dispatched({ name: 'W'.repeat(1000), head_branch: `claude/${'b'.repeat(250)}` }), owners: OWNERS });
      const override = JSON.stringify(containerOverride('dispatch', fire));
      assert.ok(Buffer.byteLength(override) < OVERRIDE_CAP, `${Buffer.byteLength(override)} bytes`);
      assert.doesNotThrow(() => parseFire(fire));
    });
  });

  // A scheduled run has no PR and no session behind it: nobody dispatched
  // it, so nobody is watching it. A run a session dispatched is that
  // session's to watch.
  describe('a scheduled run', () => {
    const scheduled = (over: Record<string, unknown> = {}, action = 'completed') =>
      workflowRun({ name: 'Emulator', path: '.github/workflows/emulator.yml', workflow_id: 77, event: 'schedule', ...over }, action);

    test('red on main, whatever the workflow, starts one fresh session on it', () => {
      for (const [name, conclusion] of [['Emulator', 'failure'], ['E2E', 'failure'], ['Conformance', 'timed_out'], ['Housekeeping', 'startup_failure'], ['CI', 'failure']] as const) {
        const { fire, reason } = route({ event: 'workflow_run', payload: scheduled({ name, conclusion }), owners: OWNERS });
        assert.equal(fire?.kind, 'dispatch', reason);
        assert.doesNotThrow(() => parseFire(fire), 'what the receiver queues, the task accepts');
        const { prompt, sessionName } = fire as { prompt: string, sessionName: string };
        assert.ok(prompt.includes(name), prompt);
        assert.ok(prompt.includes(conclusion), prompt);
        assert.ok(prompt.includes(`https://github.com/${REPO}/actions/runs/500`), prompt);
        assert.ok(prompt.includes(SHA.slice(0, 12)), prompt);
        // The facts alone: the task adds the repo's instruction and the
        // Unattended line (dispatch/workflow.mjs `redRunPrompt`).
        assert.ok(!prompt.includes(UNATTENDED), prompt);
        assert.doesNotMatch(prompt, /ops-tooling|docs\/constraints/, prompt);
        assert.ok(sessionName.includes(name) && sessionName.length <= 100, sessionName);
      }
    });

    // A workflow that stays red goes red on every scheduled run. The
    // receiver holds no token to read the run before, so the fire names the
    // workflow and the run, and the task launches nothing when the run
    // before was red too: that one's session is already on it.
    test('names its workflow and run, so the task can tell a red that follows a red', () => {
      const { fire, reason } = route({ event: 'workflow_run', payload: scheduled({ conclusion: 'failure' }), owners: OWNERS });
      assert.deepEqual((fire as { scheduled?: unknown }).scheduled, { workflowId: 77, runId: 500, branch: 'main' }, reason);
      assert.deepEqual(parseFire(fire), { ...fire, kind: 'dispatch' }, 'the task keeps what the receiver named');
      // The task tells a red run's fire by its `scheduled`, and adds its
      // instruction: a run it cannot name queues nothing.
      for (const bad of [{ workflow_id: undefined }, { workflow_id: 0 }, { id: -1 }]) {
        const odd = route({ event: 'workflow_run', payload: scheduled({ conclusion: 'failure', ...bad }), owners: OWNERS });
        assert.equal(odd.fire, undefined, JSON.stringify(bad));
      }
    });

    test('green, cancelled, off main, unfinished, or a re-run queues nothing', () => {
      for (const payload of [
        scheduled({ conclusion: 'success' }),
        scheduled({ conclusion: 'cancelled' }),
        scheduled({ conclusion: 'skipped' }),
        scheduled({ head_branch: 'claude/a-branch' }),
        scheduled({}, 'in_progress'),
        // A re-run is someone already looking: the first attempt started a session.
        scheduled({ run_attempt: 2 }),
      ]) {
        const decision = route({ event: 'workflow_run', payload, owners: OWNERS });
        assert.equal(decision.fire, undefined, JSON.stringify(payload.workflow_run));
        assert.ok(decision.reason.length > 0);
      }
    });

    test('the same workflow dispatched by hand or by a push starts no session: whoever started it watches it', () => {
      for (const event of ['workflow_dispatch', 'push', 'workflow_run']) {
        const decision = route({ event: 'workflow_run', payload: scheduled({ event }), owners: OWNERS });
        // A workflow fire, for the ticket label the file declares.
        assert.equal(decision.fire?.kind, 'workflow', `${event}: ${decision.reason}`);
      }
    });
  });
});

describe('handle', () => {
  test('a signed ready-label delivery queues one schedule fire, keyed by the delivery so a redelivery is not a second fire', async () => {
    const { deps, queued, logged } = harness();
    const response = await handle(delivery('issues', issuesEvent('labeled', { label: { name: 'workflow: ready for development' } })), deps);
    assert.equal(response.statusCode, 202);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]!.message.fire, { kind: 'schedule', issue: 717, label: 'workflow: ready for development', repo: REPO });
    assert.equal(queued[0]!.message.github, 'issues');
    assert.equal(queued[0]!.dedupId, 'd-1');
    assert.ok(logged.some((l) => l.event === 'webhook-queued' && l.delivery === 'd-1'), JSON.stringify(logged));
  });

  test('a signed close queues one freed fire on the lane, keyed by the delivery', async () => {
    const { deps, queued } = harness();
    const response = await handle(delivery('issues', issuesEvent('closed')), deps);
    assert.equal(response.statusCode, 202);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]!.message.fire, { kind: 'schedule', freed: 717, counted: 'issuesClosed', repo: REPO });
    assert.equal(queued[0]!.dedupId, 'd-1');
  });

  test('the PR review\'s comment is told apart by the App ID the receiver is configured with', async () => {
    const OWNER = 'https://claude.ai/code/session_01OWNERAAA';
    const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';
    const payload = commentEvent({
      issue: { number: 724, title: 'Grant', html_url: 'https://github.com/acme/factory/pull/724', body: `The change.\n\n${subscribeLine(REVIEWER)}\n\n${OWNER}`, pull_request: { url: 'p' } },
    }, {
      user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', performed_via_github_app: { id: APP_ID },
      body: `Waits for a description edit: name the criterion (test 2). An edit to the description meets it, and the review runs again on the edit.\n\n${reviewMarker('a'.repeat(40), 'b'.repeat(64))}`,
    });
    const sessions = async (appId: number | undefined) => {
      const { deps, queued } = harness({ appId });
      await handle(delivery('issue_comment', payload), deps);
      return queued.map((q) => (q.message.fire as { session: string }).session);
    };
    assert.deepEqual(await sessions(APP_ID), [OWNER]);
    assert.deepEqual(await sessions(APP_ID + 1), [OWNER, REVIEWER]);
  });

  test('a scheduled run on main that failed queues one fresh session on it, keyed by the delivery', async () => {
    const { deps, queued } = harness();
    const payload = {
      action: 'completed',
      workflow_run: { id: 36546147235, workflow_id: 77, name: 'Emulator', path: '.github/workflows/emulator.yml', head_branch: 'main', head_sha: '9a6e2d2312fbf5378156ae22336f234c0f723fee', status: 'completed', conclusion: 'failure', html_url: `https://github.com/${REPO}/actions/runs/36546147235`, event: 'schedule', run_attempt: 1 },
      repository: { full_name: REPO, default_branch: 'main' },
    };
    const response = await handle(delivery('workflow_run', payload), deps);
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.dedupId, 'd-1');
    const fire = queued[0]!.message.fire as { kind: string, prompt: string, sessionName: string };
    assert.doesNotThrow(() => parseFire(fire), 'what the receiver queues, the task accepts');
    assert.equal(fire.kind, 'dispatch');
    assert.ok(fire.prompt.includes(`https://github.com/${REPO}/actions/runs/36546147235`), fire.prompt);
    assert.ok(fire.prompt.includes('.github/workflows/emulator.yml'), fire.prompt);
    assert.match(fire.sessionName, /Emulator/);
  });

  test('a signed mention queues one dispatch fire carrying its prompt', async () => {
    const { deps, queued } = harness();
    const response = await handle(delivery('issue_comment', commentEvent()), deps);
    assert.equal(response.statusCode, 202);
    const fire = queued[0]?.message.fire as { kind: string, prompt: string };
    assert.equal(fire.kind, 'dispatch');
    assert.match(fire.prompt, /issuecomment-77/);
  });

  test('a delivery with several subscribers queues a fire each, keyed by the delivery and the session, so a redelivery is still one each', async () => {
    const { deps, queued } = harness();
    const owner = 'https://claude.ai/code/session_01OWNERAAA';
    const body = `The PR.\n\n<!-- governor:subscribe https://claude.ai/code/session_01REVIEWER -->\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${owner}`;
    const payload = commentEvent({ issue: { number: 724, title: 'A PR', html_url: 'https://github.com/acme/factory/pull/724', body, pull_request: { url: 'x' } } }, { body: 'A remark.' });
    const response = await handle(delivery('issue_comment', payload), deps);
    assert.equal(response.statusCode, 202);
    assert.deepEqual(queued.map((q) => q.dedupId), ['d-1:session_01OWNERAAA', 'd-1:session_01REVIEWER']);
    assert.deepEqual(queued.map((q) => (q.message.fire as { session: string }).session), [owner, 'https://claude.ai/code/session_01REVIEWER']);
  });

  test('an unsigned or wrongly signed delivery is refused before anything is read, and queues nothing', async () => {
    for (const headers of [
      { 'x-github-event': 'issues' },
      { 'x-github-event': 'issues', 'x-hub-signature-256': sign('{}', 'other') },
    ]) {
      const { deps, queued } = harness();
      const payload = issuesEvent('labeled', { label: { name: 'workflow: ready for development' } });
      const response = await handle({ ...delivery('issues', payload), headers }, deps);
      assert.equal(response.statusCode, 401);
      assert.deepEqual(queued, []);
    }
  });

  test('a base64 body is verified as the bytes GitHub signed', async () => {
    const { deps, queued } = harness();
    const payload = issuesEvent('labeled', { label: { name: 'workflow: ready for development' } });
    const raw = JSON.stringify(payload);
    const response = await handle({
      headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sign(raw) },
      body: Buffer.from(raw).toString('base64'),
      isBase64Encoded: true,
    }, deps);
    assert.equal(response.statusCode, 202);
    assert.equal(queued.length, 1);
  });

  test('an event that routes nowhere is acknowledged and queues nothing', async () => {
    const { deps, queued } = harness();
    const response = await handle(delivery('issues', issuesEvent('reopened')), deps);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(queued, []);
  });

  test('a body that is not JSON is a bad request, after the signature check', async () => {
    const { deps, queued } = harness();
    const body = 'not json';
    const response = await handle({ headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sign(body) }, body, isBase64Encoded: false }, deps);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(queued, []);
  });

  // The stack's tripwire reads the Lambda Errors metric, which a returned
  // status never reaches: a queue that refused the fire has to leave the
  // handler as a throw, or nobody hears of a delivery that is now lost.
  test('a queue that refuses the fire is logged and rethrown, so the errors alarm sees it', async () => {
    const { deps, logged } = harness({ enqueue: async () => { throw new Error('AccessDenied'); } });
    await assert.rejects(handle(delivery('issues', issuesEvent('labeled', { label: { name: 'workflow: ready for development' } })), deps), /AccessDenied/);
    assert.ok(logged.some((l) => l.event === 'webhook-failed' && /AccessDenied/.test(String(l.error))));
  });
});

describe('cachedSecret', () => {
  test('reads the secret once per warm environment', async () => {
    let reads = 0;
    const secret = cachedSecret(async () => { reads += 1; return 'k'; });
    assert.equal(await secret(), 'k');
    assert.equal(await secret(), 'k');
    assert.equal(reads, 1);
  });

  test('a read that failed is not what every later delivery gets', async () => {
    let reads = 0;
    const secret = cachedSecret(async () => {
      reads += 1;
      if (reads === 1) throw new Error('ThrottlingException');
      return 'k';
    });
    await assert.rejects(secret(), /Throttling/);
    assert.equal(await secret(), 'k');
    assert.equal(reads, 2);
  });
});

/**
 * The schedule fire comes through the same receiver and the same queue, so
 * the schedule and every delivery wait in one lane: the starter runs one
 * task at a time, and two turns never refresh one login.
 */
describe('handleSchedule', () => {
  test('queues one schedule fire', async () => {
    const { deps, queued, logged } = harness();
    const result = await handleSchedule(deps);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]!.message.fire, { kind: 'schedule' });
    assert.equal(queued[0]!.message.reason, 'schedule fire');
    assert.equal(result.queued, true);
    assert.ok(logged.some((l) => l.event === 'webhook-queued' && l.reason === 'schedule fire'));
  });

  test('a queue that refuses the fire is logged and rethrown, so the tripwire sees it', async () => {
    const { deps, logged } = harness({ enqueue: async () => { throw new Error('AccessDenied'); } });
    await assert.rejects(handleSchedule(deps), /AccessDenied/);
    assert.ok(logged.some((l) => l.event === 'webhook-failed'));
  });

  test('reads no secret: nothing signed it', async () => {
    const { deps } = harness({ secret: async () => { throw new Error('should not be read'); } });
    await handleSchedule(deps);
  });
});

/**
 * The Unattended line: a prompt that starts a session carries it,
 * since the dispatcher started that session and nobody is at it; a message
 * into a session that exists does not, since the dispatcher cannot know
 * whether its operator is at it (a local or Remote Control session, or a
 * cloud session the operator started).
 */
describe('routeEvent — the Unattended line', () => {
  const OWNER = 'https://claude.ai/code/session_01OWNSIT';
  const WATCHER = 'https://claude.ai/code/session_01WATCHES';
  const footer = `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${OWNER}`;
  const watched = `The change.\n\n${subscribeLine(WATCHER, ['comments', 'reviews', 'pushes', 'close', 'labels'])}${footer}`;
  const pr = { ...pullRequest, body: watched, head: { ref: pullRequest.head.ref, sha: 'b'.repeat(40) } };
  const prIssue = { number: pr.number, title: pr.title, html_url: pr.html_url, body: watched, pull_request: { url: 'x' } };
  const issue = { ...issuesEvent('opened').issue, body: watched, assignees: [] };
  const plain = { body: 'The retry budget reads short here.' };
  type Fire = { kind: string; text?: string; prompt?: string; session?: string; byBranch?: true; fallback?: { prompt: string } };
  const firesOf = (event: string, payload: unknown) => routeEvent({ event, payload, owners: OWNERS, appId: APP_ID }).fires.map(({ fire }) => {
    assert.doesNotThrow(() => parseFire(fire), `the task accepts ${JSON.stringify(fire).slice(0, 80)}`);
    return fire as Fire;
  });

  const relays: Array<[string, string, unknown, string[]?]> = [
    ['a PR comment', 'issue_comment', commentEvent({ issue: prIssue }, plain)],
    ['an issue comment', 'issue_comment', commentEvent({ issue }, plain)],
    ['a review comment', 'pull_request_review_comment', { ...reviewCommentEvent(plain), pull_request: pr }],
    ['a review', 'pull_request_review', { ...reviewEvent(plain), pull_request: pr }],
    ['a push', 'pull_request', { action: 'synchronize', pull_request: pr, sender: member, before: 'a'.repeat(40), after: 'b'.repeat(40), repository: { full_name: REPO, html_url: `https://github.com/${REPO}` } }],
    ['a merge', 'pull_request', { action: 'closed', pull_request: { ...pr, merged: true }, sender: member, repository: { full_name: REPO } }],
    ['a label', 'issues', { ...issuesEvent('labeled'), issue, label: { name: 'type: bug' }, sender: member }, [WATCHER]],
    ['a close', 'issues', { ...issuesEvent('closed'), issue: { ...issue, state_reason: 'completed' }, sender: member }],
  ];
  for (const [what, event, payload, hear = [OWNER, WATCHER]] of relays) {
    test(`${what} reaches its subscribers with no Unattended line`, () => {
      const messages = firesOf(event, payload).filter((f) => f.kind === 'message');
      assert.deepEqual(messages.map((m) => m.session).sort(), [...hear].sort(), what);
      for (const m of messages) assert.ok(!String(m.text).includes(UNATTENDED), `${what} to ${m.session}: ${m.text}`);
    });
  }

  test('a remark on a PR naming no session reaches the session on its branch with no Unattended line', () => {
    const [fire] = firesOf('issue_comment', commentEvent({ issue: { ...prIssue, body: 'A local session\'s change.' } }, plain));
    assert.equal(fire?.byBranch, true);
    assert.ok(!String(fire?.text).includes(UNATTENDED), String(fire?.text));
    assert.ok(fire?.fallback?.prompt.includes(UNATTENDED), 'the fresh session it falls back to is told it is unattended');
  });

  test('the fresh session an owner\'s remark falls back to is told it is unattended', () => {
    for (const [what, event, payload] of relays.slice(0, 4)) {
      const owner = firesOf(event, payload).find((f) => f.session === OWNER);
      if (what === 'an issue comment') assert.equal(owner?.fallback, undefined, 'an issue has nothing to take over');
      else assert.ok(owner?.fallback?.prompt.includes(UNATTENDED), `${what}: ${owner?.fallback?.prompt}`);
    }
  });

  const launches: Array<[string, string, unknown]> = [
    ['a mention in an issue comment', 'issue_comment', commentEvent()],
    ['a mention in a comment on a PR no session owns', 'issue_comment', commentEvent({ issue: { ...prIssue, body: 'A person\'s change.' } })],
    ['a mention in a review comment', 'pull_request_review_comment', reviewCommentEvent()],
    ['a mention in a review', 'pull_request_review', reviewEvent()],
    ['an issue opened mentioning @claude', 'issues', issuesEvent('opened', { issue: { ...issuesEvent('opened').issue, body: '@claude fix this' } })],
    ['an issue assigned to claude', 'issues', issuesEvent('assigned', { assignee: { login: 'claude' }, sender: member })],
  ];
  for (const [what, event, payload] of launches) {
    test(`${what} starts a session told it is unattended`, () => {
      const dispatch = firesOf(event, payload).find((f) => f.kind === 'dispatch');
      assert.ok(dispatch?.prompt?.includes(UNATTENDED), `${what}: ${dispatch?.prompt}`);
    });
  }
});

/**
 * Every served repo's deliveries reach the receiver through the App's one
 * webhook. The receiver routes from the payload and holds
 * no token: a delivery from an owner off the list queues nothing; another
 * listed repo's fires name it, and a label there is a schedule fire the task
 * checks against that repo's ready labels. The PR review, workflow runs,
 * branch runs, the conflicts check and shipping jobs route in any listed
 * repo by its payload's default branch, and the task applies the repo's
 * switches.
 */
describe('routeEvent — every served repo', () => {
  const ASKME = 't-d-d/askme-mcp';
  const OWNER = 'https://claude.ai/code/session_01OWNERAAA';
  const WATCHER = 'https://claude.ai/code/session_01WATCHES';
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const footer = `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${OWNER}`;
  const body = `The change.\n\n${subscribeLine(WATCHER)}${footer}`;
  const at = (repo: string) => ({ full_name: repo, html_url: `https://github.com/${repo}` });
  const pr = { number: 12, title: 'A change', html_url: `https://github.com/${ASKME}/pull/12`, body, head: { ref: 'claude/x', sha: SHA }, base: { ref: 'main' } };
  const prIssue = { number: 12, title: 'A change', html_url: `https://github.com/${ASKME}/pull/12`, body, pull_request: { url: 'x' } };
  const firesOf = (event: string, payload: Record<string, unknown>, repo = ASKME, defaultBranch?: string) =>
    routeEvent({ event, payload: { ...payload, repository: { ...at(repo), ...(defaultBranch === undefined ? {} : { default_branch: defaultBranch }) } }, owners: OWNERS, appId: APP_ID });

  test('a delivery from an owner off the list queues nothing, and says why', () => {
    const decision = firesOf('issue_comment', commentEvent(), 'stranger/repo');
    assert.deepEqual(decision.fires, []);
    assert.match(decision.reason, /stranger.*not on the owner list/);
  });

  test('an owner is matched in any case, as GitHub matches logins', () => {
    const shouted = routeEvent({ event: 'issue_comment', payload: { ...commentEvent(), repository: at(ASKME) }, owners: OWNERS.map((o) => o.toUpperCase()), appId: APP_ID });
    assert.deepEqual(shouted.fires.map((f) => f.fire.repo), [ASKME]);
  });

  test('a delivery naming no repository queues nothing', () => {
    assert.deepEqual(routeEvent({ event: 'issue_comment', payload: { ...commentEvent(), repository: undefined }, owners: OWNERS, appId: APP_ID }).fires, []);
  });

  test('every fire a listed repo\'s delivery queues names that repo, and the task accepts it', () => {
    const { fires } = firesOf('issue_comment', commentEvent({ issue: prIssue }, { body: 'A remark.' }));
    assert.deepEqual(fires.map((f) => [f.fire.kind, f.fire.repo]), [['message', ASKME], ['message', ASKME]]);
    for (const { fire } of fires) assert.equal(parseFire(fire).repo, ASKME);
    const summons = firesOf('issue_comment', commentEvent());
    assert.deepEqual(summons.fires.map((f) => [f.fire.kind, f.fire.repo]), [['dispatch', ASKME]]);
    const own = firesOf('issue_comment', commentEvent({ issue: prIssue }, { body: 'A remark.' }), REPO);
    assert.ok(own.fires.every((f) => f.fire.repo === REPO));
  });

  test('a PR\'s owner hears as the PR\'s, a subscriber as a subscriber: the task reads the switch each needs', () => {
    const { fires } = firesOf('issue_comment', commentEvent({ issue: prIssue }, { body: 'A remark.' }));
    const by = Object.fromEntries(fires.map((f) => [(f.fire as { session: string }).session, (f.fire as { subscribed?: true }).subscribed]));
    assert.deepEqual(by, { [OWNER]: undefined, [WATCHER]: true });
    const filed = firesOf('issue_comment', commentEvent({ issue: { number: 3, title: 'Filed', html_url: 'x', body: `Filed.${footer}` } }, { body: 'A remark.' }));
    assert.deepEqual(filed.fires.map((f) => (f.fire as { subscribed?: true }).subscribed), [true], 'an issue\'s filer hears by subscription: an issue is no PR');
  });

  test('any label a person adds is a schedule fire naming the issue and the label: the task checks the repo\'s ready labels', () => {
    const decision = firesOf('issues', issuesEvent('labeled', { label: { name: 'mode: afk' }, sender: member }));
    assert.deepEqual(decision.fires.filter((f) => f.fire.kind === 'schedule').map((f) => f.fire), [{ kind: 'schedule', issue: 717, label: 'mode: afk', repo: ASKME }]);
  });

  test('a label a bot added queues no selection there: the dispatcher\'s own claim or release', () => {
    for (const name of ['mode: afk', 'claimed']) {
      const decision = firesOf('issues', issuesEvent('labeled', { label: { name }, sender: { login: 'governor-app[bot]', type: 'Bot' } }));
      assert.deepEqual(decision.fires.filter((f) => f.fire.kind === 'schedule'), [], name);
    }
  });

  // The stack's SelectLabels: the receiver holds no token, so it
  // reads no repo's ready labels; the list names the labels worth a turn.
  test('a label on SelectLabels queues a selection fire; one off it queues none and still reaches subscribers; an empty list selects on every label', () => {
    const subscribed = { ...issuesEvent('labeled').issue, body };
    const labelled = (name: string, selectLabels: string[], repo = REPO) =>
      routeEvent({ event: 'issues', payload: { ...issuesEvent('labeled', { issue: subscribed, label: { name }, sender: member }), repository: at(repo) }, owners: OWNERS, appId: APP_ID, selectLabels });
    const selections = (decision: ReturnType<typeof routeEvent>) => decision.fires.filter((f) => f.fire.kind === 'schedule').map((f) => f.fire);
    for (const name of SELECT_LABELS) {
      assert.deepEqual(selections(labelled(name, SELECT_LABELS)), [{ kind: 'schedule', issue: 717, label: name, repo: REPO }], name);
      assert.deepEqual(selections(labelled(name, SELECT_LABELS, ASKME)), [{ kind: 'schedule', issue: 717, label: name, repo: ASKME }], `${name}, in any repo`);
    }
    const unlisted = labelled('type: bug', SELECT_LABELS);
    assert.deepEqual(selections(unlisted), [], 'a label off the list queues no selection');
    assert.deepEqual(unlisted.fires.filter((f) => f.fire.kind === 'message').map((f) => (f.fire as { session: string }).session), [WATCHER], 'its subscriber still hears it');
    assert.deepEqual(selections(labelled('type: bug', [])), [{ kind: 'schedule', issue: 717, label: 'type: bug', repo: REPO }], 'an empty list selects on every label');
    assert.deepEqual(selections(routeEvent({ event: 'issues', payload: { ...issuesEvent('labeled', { label: { name: 'type: bug' }, sender: member }), repository: at(REPO) }, owners: OWNERS, appId: APP_ID })), [{ kind: 'schedule', issue: 717, label: 'type: bug', repo: REPO }], 'no list is the empty list');
  });

  test('a listed label a bot added queues no selection in any repo', () => {
    for (const repo of [REPO, ASKME]) {
      const decision = routeEvent({ event: 'issues', payload: { ...issuesEvent('labeled', { label: { name: SELECT_LABELS[0] }, sender: { login: 'governor-app[bot]', type: 'Bot' } }), repository: at(repo) }, owners: OWNERS, appId: APP_ID, selectLabels: SELECT_LABELS });
      assert.deepEqual(decision.fires.filter((f) => f.fire.kind === 'schedule'), [], repo);
    }
  });

  test('a close frees what the issue blocked, in its own repo', () => {
    const decision = firesOf('issues', issuesEvent('closed'));
    assert.deepEqual(decision.fires.map((f) => f.fire), [{ kind: 'schedule', freed: 717, counted: 'issuesClosed', repo: ASKME }]);
  });

  const run = (over: Record<string, unknown>) => ({
    action: 'completed',
    workflow_run: { id: 500, name: 'CI', path: '.github/workflows/ci.yml', workflow_id: 77, head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'failure', html_url: `https://github.com/${ASKME}/actions/runs/500`, event: 'push', run_attempt: 1, ...over },
  });
  const job = {
    action: 'completed',
    workflow_job: { id: 9001, run_id: 500, run_attempt: 1, head_sha: SHA, head_branch: 'main', name: 'dev / Publish (dev) · deployed: dev', workflow_name: 'Deliver', status: 'completed', conclusion: 'success', html_url: `https://github.com/${ASKME}/actions/runs/500/job/9001` },
  };
  const trunk = (payload: Record<string, unknown>) => JSON.parse(JSON.stringify(payload).replaceAll('"main"', '"trunk"'));
  // The task refuses it where the repo's file leaves prReview off.
  test('a PR opened, readied, pushed to or its body edited queues a review fire in any served repo', () => {
    for (const payload of [
      { action: 'opened', pull_request: pr, sender: member },
      { action: 'ready_for_review', pull_request: pr, sender: member },
      { action: 'synchronize', pull_request: pr, sender: member },
      { action: 'edited', changes: { body: { from: 'old' } }, pull_request: pr, sender: member },
    ]) {
      for (const repo of [REPO, ASKME]) {
        const fires = firesOf('pull_request', payload, repo).fires.filter((f) => f.fire.kind === 'review');
        assert.equal(fires.length, 1, `${repo} ${payload.action}`);
        assert.equal((fires[0]!.fire as { repo?: string }).repo, repo);
        assert.doesNotThrow(() => parseFire(fires[0]!.fire), 'what the receiver queues, the task accepts');
      }
    }
  });

  // A required check pending at the push is read again when its run ends.
  test('a finished run on a PR\'s head queues a review fire for each PR it lists, at the head it ran on', () => {
    const head = 'c'.repeat(40);
    const prs = [{ number: 12, head: { ref: 'claude/x', sha: head }, base: { ref: 'trunk' } }, { number: 13, head: { ref: 'claude/x', sha: head }, base: { ref: 'trunk' } }];
    for (const conclusion of ['success', 'failure']) {
      const decision = firesOf('workflow_run', run({ head_branch: 'claude/x', head_sha: head, event: 'pull_request', conclusion, pull_requests: prs }), ASKME, 'trunk');
      const reviews = decision.fires.filter((f) => f.fire.kind === 'review');
      assert.deepEqual(reviews.map((f) => f.fire), [{ kind: 'review', pr: 12, headSha: head, repo: ASKME }, { kind: 'review', pr: 13, headSha: head, repo: ASKME }], conclusion);
      assert.equal(new Set(reviews.map((f) => f.key)).size, 2, 'each PR its own fire on the one delivery');
      for (const f of reviews) assert.doesNotThrow(() => parseFire(f.fire));
    }
    const unfinished = firesOf('workflow_run', { ...run({ head_branch: 'claude/x', event: 'pull_request', pull_requests: prs }), action: 'in_progress' }, ASKME, 'trunk');
    assert.deepEqual(unfinished.fires.filter((f) => f.fire.kind === 'review'), []);
    const onDefault = firesOf('workflow_run', run({ head_branch: 'trunk', pull_requests: prs }), ASKME, 'trunk');
    assert.deepEqual(onDefault.fires.filter((f) => f.fire.kind === 'review'), [], 'a run on the default branch reviews nothing');
  });

  // The receiver forwards workflow and merge events from every
  // served repo, routed by the default branch the payload names.
  const generic: Array<[string, string, Record<string, unknown>, string]> = [
    ['a red run on the default branch', 'workflow_run', run({}), 'workflow'],
    ['a branch run', 'workflow_run', run({ event: 'workflow_dispatch', head_branch: 'claude/x', conclusion: 'success' }), 'branch-run'],
    ['the conflicts check', 'pull_request', { action: 'closed', pull_request: { ...pr, merged: true, merge_commit_sha: SHA }, sender: member }, 'conflicts'],
    ['a shipping job', 'workflow_job', job, 'job'],
  ];
  for (const [what, event, payload, kind] of generic) {
    test(`${what} queues a ${kind} fire in any served repo, by the default branch its payload names`, () => {
      assert.ok(firesOf(event, payload, REPO, 'main').fires.some((f) => f.fire.kind === kind), `factory: ${what}`);
      const fires = firesOf(event, trunk(payload), ASKME, 'trunk').fires.filter((f) => f.fire.kind === kind);
      assert.equal(fires.length, 1, what);
      assert.doesNotThrow(() => parseFire(fires[0]!.fire), 'what the receiver queues, the task accepts');
      if (kind !== 'branch-run') {
        assert.deepEqual(firesOf(event, payload, ASKME, 'trunk').fires.filter((f) => f.fire.kind === kind), [], `${what}: main is not trunk's default branch`);
        assert.deepEqual(firesOf(event, payload, ASKME).fires.filter((f) => f.fire.kind === kind), [], `${what}: a payload naming no default branch routes nothing`);
      }
    });
  }

  test('a default branch named trunk routes by trunk: the fires carry it', () => {
    const red = firesOf('workflow_run', trunk(run({})), ASKME, 'trunk').fires[0]!.fire as { branch?: string };
    assert.equal(red.branch, 'trunk');
    const shipped = firesOf('workflow_job', trunk(job), ASKME, 'trunk').fires[0]!.fire as { branch?: string };
    assert.equal(shipped.branch, 'trunk');
    const merged = firesOf('pull_request', trunk({ action: 'closed', pull_request: { ...pr, merged: true, merge_commit_sha: SHA }, sender: member }), ASKME, 'trunk')
      .fires.find((f) => f.fire.kind === 'conflicts')?.fire as { base?: string };
    assert.equal(merged.base, 'trunk');
    const onMain = firesOf('workflow_run', run({ event: 'workflow_dispatch', head_branch: 'main' }), ASKME, 'trunk').fires;
    assert.deepEqual(onMain.map((f) => f.fire.kind), ['branch-run'], 'main is a branch like any other in a repo whose default is trunk');
  });

  test('a merge in another repo still tells the PR\'s sessions', () => {
    const { fires } = firesOf('pull_request', { action: 'closed', pull_request: { ...pr, merged: true, merge_commit_sha: SHA }, sender: member });
    assert.deepEqual(fires.map((f) => (f.fire as { session: string }).session).sort(), [OWNER, WATCHER].sort());
  });

  // The red scheduled run is a generic switch:
  // the receiver queues them in any served repo, on its default
  // branch, and the turn applies the repo's file.
  test('a red scheduled run on another repo\'s default branch queues a dispatch fire naming it', () => {
    const { fires } = firesOf('workflow_run', run({ event: 'schedule', head_branch: 'trunk' }), ASKME, 'trunk');
    assert.equal(fires.length, 1);
    assert.equal(fires[0]!.fire.kind, 'dispatch');
    assert.deepEqual((fires[0]!.fire as { scheduled?: unknown }).scheduled, { workflowId: 77, runId: 500, branch: 'trunk' });
    assert.match((fires[0]!.fire as { prompt: string }).prompt, /^A scheduled run of CI on trunk ended failure\./);
    assert.deepEqual(firesOf('workflow_run', run({ event: 'schedule', head_branch: 'main' }), ASKME, 'trunk').fires, [], 'off the default branch');
  });

  test('a merge into another repo\'s default branch marks its owner\'s message merged', () => {
    const merged = (base: string) => firesOf('pull_request', { action: 'closed', pull_request: { ...pr, merged: true, merge_commit_sha: SHA, base: { ref: base } }, sender: member }, ASKME, 'trunk')
      .fires.find((f) => (f.fire as { session?: string }).session === OWNER)?.fire as { merged?: boolean } | undefined;
    assert.equal(merged('trunk')?.merged, true);
    assert.equal(merged('feature')?.merged, undefined);
  });

  test('the events the receiver routes are the ones the App\'s webhook subscribes to', () => {
    assert.deepEqual([...HOOK_EVENTS].sort(), ['issue_comment', 'issues', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'workflow_job', 'workflow_run']);
  });
});

describe('handle — every served repo', () => {
  test('an owner off the list gets a 2xx, queues nothing, and is logged at info', async () => {
    const { deps, queued, logged } = harness();
    const response = await handle(delivery('issue_comment', { ...commentEvent(), repository: { full_name: 'stranger/repo' } }), deps);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(queued, []);
    const ignored = logged.find((l) => l.event === 'webhook-ignored');
    assert.equal(ignored?.level, 'info');
    assert.match(String(ignored?.reason), /not on the owner list/);
  });
});
