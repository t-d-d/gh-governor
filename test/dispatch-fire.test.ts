/**
 * The fire: what the receiver queues and the task, the starter and the
 * retrier read (dispatch/webhook/fire.mjs). One module packaged into
 * the Lambda and the image owns its shape: the builders the receiver calls,
 * the parser the task and the retrier call, the check the starter calls,
 * and the vocabulary they share.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_WINDOW_MS,
  dispatchMarker,
  lastDispatch,
  parseFire as parseNamed,
  recentlyDispatched,
  shippingJob,
  build,
} from '../dispatch/webhook/fire.mjs';

const NOW = Date.parse('2026-09-25T12:00:00Z');

/**
 * `parseNamed` for a fire whose shape is under test: one naming no repo is
 * read as the factory's, and handed back without it. What a fire's repo must be
 * is `parseFire — the repo a fire is for`, which calls `parseNamed` itself.
 */
const parseFire = (event: unknown) => {
  const e = event as Record<string, unknown> | null;
  if (e === null || typeof e !== 'object' || 'repo' in e || e.source === 'aws.events') return parseNamed(event);
  const { repo: _repo, ...fire } = parseNamed({ ...e, repo: 'acme/factory' }) as Record<string, unknown>;
  return fire as ReturnType<typeof parseNamed>;
};

describe('parseFire', () => {
  test('an EventBridge scheduled event is a schedule fire', () => {
    const event = { source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} };
    assert.deepEqual(parseFire(event), { kind: 'schedule' });
  });

  test('a direct invocation names its kind', () => {
    assert.deepEqual(parseFire({ kind: 'probe' }), { kind: 'probe' });
    assert.deepEqual(
      parseFire({ kind: 'dispatch', prompt: 'hello', sessionName: 'TEST' }),
      { kind: 'dispatch', prompt: 'hello', sessionName: 'TEST' },
    );
  });

  test('anything else is refused, not dispatched', () => {
    assert.throws(() => parseFire({}), /kind/);
    assert.throws(() => parseFire({ kind: 'dispatch' }), /prompt/);
    assert.throws(() => parseFire(null), /kind/);
  });
});

describe('dispatch marker', () => {
  test('carries the time and the session URL, and is found again by the time', () => {
    const at = new Date(NOW).toISOString();
    const body = dispatchMarker({ at, sessionUrl: 'https://claude.ai/code/session_abc' });
    assert.match(body, /<!-- governor:dispatched 2026-09-25T12:00:00\.000Z -->/);
    assert.match(body, /https:\/\/claude\.ai\/code\/session_abc/);
    assert.equal(recentlyDispatched([{ id: 1, body, created_at: at }], NOW + 60_000), true);
  });

  test('without a URL it still records the dispatch', () => {
    const body = dispatchMarker({ at: new Date(NOW).toISOString(), sessionUrl: null });
    assert.match(body, /<!-- governor:dispatched/);
    assert.doesNotMatch(body, /undefined|null/);
  });

  test('a marker older than the window no longer counts', () => {
    const at = new Date(NOW - DISPATCH_WINDOW_MS - 1).toISOString();
    const body = dispatchMarker({ at, sessionUrl: null });
    assert.equal(recentlyDispatched([{ id: 1, body, created_at: at }], NOW), false);
  });

  test('an ordinary comment is not a dispatch', () => {
    assert.equal(recentlyDispatched([{ id: 1, body: 'dispatched yesterday', created_at: '2026-09-25T11:59:00Z' }], NOW), false);
  });

  // The marker is the forwarding address: a message the PR's session refuses
  // goes to the session the newest marker inside the window names.
  test('the newest marker inside the window says where the last dispatch went', () => {
    const earlier = new Date(NOW - 3_600_000).toISOString();
    const later = new Date(NOW - 60_000).toISOString();
    const comments = [
      { id: 1, body: dispatchMarker({ at: earlier, sessionUrl: 'https://claude.ai/code/session_01EARLIER' }), created_at: earlier },
      { id: 2, body: 'a remark', created_at: later },
      { id: 3, body: dispatchMarker({ at: later, sessionUrl: 'https://claude.ai/code/session_01LATER' }), created_at: later },
    ];
    assert.deepEqual(lastDispatch(comments, NOW), { at: later, sessionUrl: 'https://claude.ai/code/session_01LATER' });
    assert.deepEqual(lastDispatch([comments[0]!], NOW), { at: earlier, sessionUrl: 'https://claude.ai/code/session_01EARLIER' });
    assert.deepEqual(lastDispatch([{ id: 4, body: dispatchMarker({ at: later, sessionUrl: null }), created_at: later }], NOW), { at: later, sessionUrl: null });
    assert.equal(lastDispatch(comments, NOW + DISPATCH_WINDOW_MS + 1), null);
    assert.equal(lastDispatch([comments[1]!], NOW), null);
  });

  // The marker reads a session link the way every other reader does: an id
  // too long for the grammar is no address, not a prefix of one.
  test('a marker whose session id is outside the grammar names no session', () => {
    const at = new Date(NOW - 60_000).toISOString();
    const long = `https://claude.ai/code/session_${'A'.repeat(200)}`;
    assert.deepEqual(lastDispatch([{ id: 1, body: dispatchMarker({ at, sessionUrl: long }), created_at: at }], NOW), { at, sessionUrl: null });
  });
});

describe('a targeted schedule fire', () => {
  test('parseFire keeps the issue a schedule fire names, and refuses one that is not a number', () => {
    assert.deepEqual(parseFire({ kind: 'schedule', issue: 4251 }), { kind: 'schedule', issue: 4251 });
    assert.deepEqual(parseFire({ kind: 'schedule' }), { kind: 'schedule' });
    assert.throws(() => parseFire({ kind: 'schedule', issue: 'x' }), /issue/);
    assert.throws(() => parseFire({ kind: 'schedule', issue: 0 }), /issue/);
  });
});

/**
 * A close names the closed issue: its turn queues an `unblocked` fire for
 * each open ticket the issue directly blocked (dispatch/unblocked.mjs).
 */
describe('a freed schedule fire', () => {
  test('parseFire keeps the closed issue a schedule fire names as freed, and refuses a bad one', () => {
    assert.deepEqual(parseFire({ kind: 'schedule', freed: 4334 }), { kind: 'schedule', freed: 4334 });
    assert.throws(() => parseFire({ kind: 'schedule', freed: 'x' }), /freed/);
    assert.throws(() => parseFire({ kind: 'schedule', freed: -1 }), /freed/);
    assert.throws(() => parseFire({ kind: 'schedule', freed: 1, issue: 2 }), /both/);
  });
});

/**
 * A blocker closed: the closing turn queues one `unblocked` fire for each
 * open ticket it blocked, in the ticket's own repo, carrying the blocker and
 * the PR that closed it, and no body.
 */
describe('an unblocked fire', () => {
  const blocker = { repo: 'acme/tools', number: 41, title: 'The parser', reason: 'completed' };
  const pr = { number: 52, title: 'Parse it', url: 'https://github.com/acme/tools/pull/52' };

  test('parseFire reads back the ticket, the blocker and the PR', () => {
    assert.deepEqual(parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker, pr }), { kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker, pr });
    assert.deepEqual(parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker: { ...blocker, reason: undefined } }), { kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker: { repo: 'acme/tools', number: 41, title: 'The parser' } });
  });

  test('parseFire refuses one with no repo, ticket or blocker, or a malformed one', () => {
    assert.throws(() => parseNamed({ kind: 'unblocked', issue: 7, blocker }), /repo/);
    assert.throws(() => parseNamed({ kind: 'unblocked', repo: 'acme/factory', blocker }), /issue/);
    assert.throws(() => parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7 }), /blocker/);
    assert.throws(() => parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker: { ...blocker, repo: 'nope' } }), /blocker/);
    assert.throws(() => parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker: { ...blocker, number: 0 } }), /blocker/);
    assert.throws(() => parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker: { ...blocker, reason: 'not planned\n' } }), /reason/);
    assert.throws(() => parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker, pr: { ...pr, url: 'http://evil' } }), /pr/);
    assert.throws(() => parseNamed({ kind: 'unblocked', repo: 'acme/factory', issue: 7, blocker, pr: { ...pr, number: -1 } }), /pr/);
  });

  test('the builder puts a title on one line and cuts it short, so a fire stays small', () => {
    const long = build.unblocked({ issue: 7, blocker: { ...blocker, title: `A\nB ${'x'.repeat(1000)}` }, pr: { ...pr, title: 'y'.repeat(1000) } });
    assert.ok(long.blocker.title.length <= 200 && !long.blocker.title.includes('\n'), long.blocker.title);
    assert.ok((long.pr?.title.length ?? 0) <= 200);
    assert.deepEqual(parseNamed({ ...long, repo: 'acme/factory' }), { ...long, repo: 'acme/factory' });
  });
});

/**
 * A message into a cloud session that already exists: the receiver's fire
 * for a comment on a PR a session wrote. The CLI takes the session as an id
 * or its claude.ai/code URL; the turn hands it over as given.
 */
describe('a message invocation', () => {
  test('parseFire keeps the session and the text, and refuses either missing or a session that is not one', () => {
    assert.deepEqual(parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi' }), { kind: 'message', session: 'session_01ABC', text: 'hi' });
    assert.deepEqual(parseFire({ kind: 'message', session: 'https://claude.ai/code/session_01ABC', text: 'hi' }), { kind: 'message', session: 'https://claude.ai/code/session_01ABC', text: 'hi' });
    assert.throws(() => parseFire({ kind: 'message', session: 'session_01ABC' }), /text/);
    assert.throws(() => parseFire({ kind: 'message', session: 'session_01ABC', text: '  ' }), /text/);
    assert.throws(() => parseFire({ kind: 'message', text: 'hi' }), /session/);
    assert.throws(() => parseFire({ kind: 'message', session: 'not a session', text: 'hi' }), /session/);
    assert.throws(() => parseFire({ kind: 'message', session: 'https://example.com/session_01ABC', text: 'hi' }), /session/);
  });

  // The receiver builds a fire's session and poster from a link in a body
  // (subscribe.mjs): a fire it could not have built is refused, not sent
  // to a session nothing named.
  test('takes a session the receiver reads, and refuses one it would not', async () => {
    const { postedBy } = await import('../dispatch/webhook/subscribe.mjs');
    const link = 'https://claude.ai/code/session_01ABC';
    assert.equal(postedBy(`Done.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n\n${link}`), link);
    assert.deepEqual(parseFire({ kind: 'message', session: link, text: 'hi' }), { kind: 'message', session: link, text: 'hi' });
    assert.deepEqual(parseFire({ kind: 'message', byBranch: true, on: 724, poster: link, text: 'hi' }), { kind: 'message', byBranch: true, on: 724, poster: link, text: 'hi' });
    for (const session of ['cse_01ABC', 'https://claude.ai/code/cse_01ABC', 'session_01A-BC', 'https://claude.ai/code/session_01A_BC']) {
      assert.throws(() => parseFire({ kind: 'message', session, text: 'hi' }), /session/, session);
      assert.throws(() => parseFire({ kind: 'message', byBranch: true, on: 724, poster: session, text: 'hi' }), /poster/, session);
    }
  });
});

describe('a message invocation with a fallback', () => {
  test('keeps a fallback that names a prompt, and refuses one that does not', () => {
    const fallback = { prompt: 'A comment on a pull request mentioned @claude…', sessionName: '@claude #724' };
    assert.deepEqual(parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', fallback }), { kind: 'message', session: 'session_01ABC', text: 'hi', fallback });
    assert.deepEqual(parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', fallback: { prompt: 'p' } }), { kind: 'message', session: 'session_01ABC', text: 'hi', fallback: { prompt: 'p' } });
    assert.throws(() => parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', fallback: { sessionName: 'x' } }), /fallback/);
    assert.throws(() => parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', fallback: 'p' }), /fallback/);
  });

  test('keeps the PR number the fallback names, and refuses one that is not a number', () => {
    const fallback = { prompt: 'p', sessionName: '@claude #724', issue: 724 };
    assert.deepEqual(parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', fallback }), { kind: 'message', session: 'session_01ABC', text: 'hi', fallback });
    assert.throws(() => parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', fallback: { prompt: 'p', issue: '724' } }), /fallback/);
    assert.throws(() => parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', fallback: { prompt: 'p', issue: 0 } }), /fallback/);
  });
});

/**
 * A subscriber's message says what it is about, so the task can
 * leave that out of the standing, drop a subscriber that refuses, tell a
 * close apart, and skip a session's own push.
 */
describe('a subscriber\'s message invocation', () => {
  const base = { kind: 'message', session: 'session_01ABC', text: 'hi' };

  test('keeps what it is on, the event and a push\'s commit', () => {
    const fire = { ...base, on: 724, event: 'pushes', commit: 'b'.repeat(40) };
    assert.deepEqual(parseFire(fire), fire);
    assert.deepEqual(parseFire({ ...base, on: 717, event: 'labels' }), { ...base, on: 717, event: 'labels' });
    assert.deepEqual(parseFire({ ...base, on: 717, event: 'close', closing: true }), { ...base, on: 717, event: 'close', closing: true });
  });

  test('refuses a closing that is not true', () => {
    assert.throws(() => parseFire({ ...base, event: 'close', closing: 'yes' }), /closing/);
  });

  // A fire queued before the merged mark was dropped still parses, and loses the mark.
  test('accepts a merged mark left on a queued message, and drops it', () => {
    assert.deepEqual(parseFire({ ...base, on: 724, event: 'close', merged: true }), { ...base, on: 724, event: 'close' });
    assert.deepEqual(parseFire({ ...base, event: 'close', merged: 'yes' }), { ...base, event: 'close' });
  });

  test('refuses an event outside the vocabulary, an on that is not a number, and a commit that is not one', () => {
    assert.throws(() => parseFire({ ...base, event: 'everything' }), /event/);
    assert.throws(() => parseFire({ ...base, on: '724' }), /on/);
    assert.throws(() => parseFire({ ...base, on: 0 }), /on/);
    assert.throws(() => parseFire({ ...base, commit: 'HEAD' }), /commit/);
  });
});

describe('a workflow invocation', () => {
  const fire = { kind: 'workflow', name: 'CI', branch: 'main', event: 'push', runId: 500, url: 'https://github.com/acme/factory/actions/runs/500', conclusion: 'failure', headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' };

  test('parseFire keeps the run a workflow fire names, and its attempt where it names one', () => {
    assert.deepEqual(parseFire(fire), fire);
    assert.deepEqual(parseFire({ ...fire, runAttempt: 2 }), { ...fire, runAttempt: 2 });
    assert.throws(() => parseFire({ ...fire, runAttempt: 0 }), /runAttempt/);
  });

  // Any workflow's run on main may declare a ticket label in its file.
  test('keeps any workflow, and the file it names', () => {
    const release = { ...fire, name: 'Android release', path: '.github/workflows/android-release.yml', conclusion: 'success' };
    assert.deepEqual(parseFire(release), release);
    assert.throws(() => parseFire({ ...release, path: '../x.yml' }), /path/);
    assert.throws(() => parseFire({ ...release, path: 7 }), /path/);
  });

  test('refuses a run missing its workflow, branch, id, URL, conclusion or commit', () => {
    assert.throws(() => parseFire({ ...fire, name: ' ' }), /workflow/);
    assert.throws(() => parseFire({ ...fire, branch: undefined }), /branch/);
    assert.throws(() => parseFire({ ...fire, branch: '' }), /branch/);
    assert.throws(() => parseFire({ ...fire, event: '' }), /event/);
    assert.throws(() => parseFire({ ...fire, name: undefined }), /workflow/);
    assert.throws(() => parseFire({ ...fire, runId: '500' }), /runId/);
    assert.throws(() => parseFire({ ...fire, url: undefined }), /url/);
    assert.throws(() => parseFire({ ...fire, conclusion: '' }), /conclusion/);
    assert.throws(() => parseFire({ ...fire, headSha: 'main' }), /headSha/);
  });
});

/**
 * The job that earns a label says so in its name, ` · deployed:
 * <target>` at its end, with the commit it built ` at <sha>` before it. A
 * reusable workflow's job is named `<caller> / <inner>`, so the marker is
 * read from the end.
 */
describe('shippingJob', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  test('reads the label, the target and the commit off a marked job name, with or without a reusable-workflow prefix', () => {
    assert.deepEqual(shippingJob(`Publish (dev) at ${SHA} · deployed: dev`), { label: 'deployed: dev', target: 'dev', commit: SHA });
    assert.deepEqual(shippingJob(`dev / Publish (dev) at ${SHA} · deployed: dev`), { label: 'deployed: dev', target: 'dev', commit: SHA });
    assert.deepEqual(shippingJob('prod / Publish (prod) at 0123abc · deployed: prod'), { label: 'deployed: prod', target: 'prod', commit: '0123abc' });
    assert.deepEqual(shippingJob(`Build the image, apply the stack, probe the task at ${SHA} · deployed: the dispatcher`), { label: 'deployed: the dispatcher', target: 'the dispatcher', commit: SHA });
  });

  test('the commit is optional to the parser; the marker is not', () => {
    assert.deepEqual(shippingJob('Publish to Play testing track · deployed: play track'), { label: 'deployed: play track', target: 'play track' });
    assert.deepEqual(shippingJob(`Publish (dev) at ${SHA}`), null, 'no marker');
    assert.deepEqual(shippingJob(`Publish (dev) at ${SHA} · deployed: dev · then more`), null, 'the marker ends the name');
    assert.deepEqual(shippingJob('Publish (dev) ·deployed: dev'), null, 'one space each side of the dot');
    assert.deepEqual(shippingJob('Publish (dev) - deployed: dev'), null, 'the middle dot, not a hyphen');
    assert.deepEqual(shippingJob('Publish (dev) · deployed: '), null, 'a label naming no target');
    assert.deepEqual(shippingJob('Dry run: Publish (dev) at xyz · deployed: dev'), { label: 'deployed: dev', target: 'dev' }, 'a sha that is not one names no commit');
    assert.equal(shippingJob(undefined), null);
  });
});

describe('a job invocation', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const fire = { kind: 'job', name: `dev / Publish (dev) at ${SHA} · deployed: dev`, workflow: 'Deliver', branch: 'main', runId: 500, jobId: 9001, url: 'https://github.com/acme/factory/actions/runs/500/job/9001', headSha: SHA, label: 'deployed: dev', commit: SHA };

  test('parseFire keeps the job a job fire names, and its attempt where it names one', () => {
    assert.deepEqual(parseFire(fire), fire);
    assert.deepEqual(parseFire({ ...fire, runAttempt: 2 }), { ...fire, runAttempt: 2 });
    assert.throws(() => parseFire({ ...fire, runAttempt: 0 }), /runAttempt/);
  });

  test('refuses a job missing its name, workflow, run, job id, URL, commit or label, or whose name carries no marker for its label', () => {
    assert.throws(() => parseFire({ ...fire, name: ' ' }), /name/);
    assert.throws(() => parseFire({ ...fire, workflow: '' }), /workflow/);
    assert.throws(() => parseFire({ ...fire, branch: undefined }), /branch/);
    assert.throws(() => parseFire({ ...fire, runId: '500' }), /runId/);
    assert.throws(() => parseFire({ ...fire, jobId: 0 }), /jobId/);
    assert.throws(() => parseFire({ ...fire, url: 'http://x' }), /url/);
    assert.throws(() => parseFire({ ...fire, headSha: 'main' }), /headSha/);
    assert.throws(() => parseFire({ ...fire, commit: 'main' }), /commit/);
    assert.throws(() => parseFire({ ...fire, label: 'deployed: prod' }), /label/);
    assert.throws(() => parseFire({ ...fire, label: 'shipped' }), /label/);
  });
});

describe('a branch-run invocation', () => {
  const fire = { kind: 'branch-run', name: 'Emulator', runId: 600, url: 'https://github.com/acme/factory/actions/runs/600', conclusion: 'success', headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', branch: 'claude/emulator-share-x1' };

  test('parseFire keeps the run, its branch, and its attempt where it names one, whatever the workflow', () => {
    assert.deepEqual(parseFire(fire), fire);
    assert.deepEqual(parseFire({ ...fire, runAttempt: 2 }), { ...fire, runAttempt: 2 });
    assert.deepEqual(parseFire({ ...fire, name: 'Apple E2E' }), { ...fire, name: 'Apple E2E' });
  });

  // The receiver keeps the default branch out: `main` is a
  // branch like another in a repo whose default branch is `trunk`.
  test('refuses a run missing its workflow, id, URL, conclusion, commit or branch', () => {
    assert.throws(() => parseFire({ ...fire, name: '' }), /a branch-run invocation's name/);
    assert.throws(() => parseFire({ ...fire, runId: '600' }), /a branch-run invocation's runId/);
    assert.throws(() => parseFire({ ...fire, url: 'http://x' }), /a branch-run invocation's url/);
    assert.throws(() => parseFire({ ...fire, conclusion: '' }), /a branch-run invocation's conclusion/);
    assert.throws(() => parseFire({ ...fire, headSha: 'main' }), /a branch-run invocation's headSha/);
    assert.throws(() => parseFire({ ...fire, branch: '' }), /a branch-run invocation's branch/);
    assert.deepEqual(parseFire({ ...fire, branch: 'main' }), { ...fire, branch: 'main' });
    assert.throws(() => parseFire({ ...fire, runAttempt: 0 }), /a branch-run invocation's runAttempt/);
  });
});

describe('a review invocation', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  test('parseFire keeps the PR and the head it was queued for; with no PR it is every open PR', () => {
    assert.deepEqual(parseFire({ kind: 'review', pr: 724, headSha: SHA }), { kind: 'review', pr: 724, headSha: SHA });
    assert.deepEqual(parseFire({ kind: 'review', pr: 724 }), { kind: 'review', pr: 724 });
    assert.deepEqual(parseFire({ kind: 'review' }), { kind: 'review' });
  });

  test('refuses a PR that is not a number, a head that is not a commit, and a head with no PR', () => {
    assert.throws(() => parseFire({ kind: 'review', pr: '724' }), /pr/);
    assert.throws(() => parseFire({ kind: 'review', pr: 0 }), /pr/);
    assert.throws(() => parseFire({ kind: 'review', pr: 724, headSha: 'main' }), /headSha/);
    assert.throws(() => parseFire({ kind: 'review', headSha: SHA }), /headSha/);
  });
});

describe('a conflicts invocation', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  test('parseFire keeps the merged PR and the commit its merge made', () => {
    assert.deepEqual(parseFire({ kind: 'conflicts', pr: 793, sha: SHA, base: 'trunk' }), { kind: 'conflicts', pr: 793, sha: SHA, base: 'trunk' });
  });

  test('refuses a PR that is not a number, a commit that is not an id, and no base', () => {
    assert.throws(() => parseFire({ kind: 'conflicts', pr: '793', sha: SHA, base: 'main' }), /pr/);
    assert.throws(() => parseFire({ kind: 'conflicts', sha: SHA, base: 'main' }), /pr/);
    assert.throws(() => parseFire({ kind: 'conflicts', pr: 793, sha: 'main', base: 'main' }), /sha/);
    assert.throws(() => parseFire({ kind: 'conflicts', pr: 793, base: 'main' }), /sha/);
    assert.throws(() => parseFire({ kind: 'conflicts', pr: 793, sha: SHA }), /base/);
  });
});

describe('a message invocation\'s event', () => {
  test('is one of the vocabulary\'s', async () => {
    const { SUBSCRIPTION_EVENTS } = await import('../dispatch/webhook/fire.mjs');
    for (const event of SUBSCRIPTION_EVENTS) {
      assert.deepEqual(parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', event }), { kind: 'message', session: 'session_01ABC', text: 'hi', event });
    }
    assert.throws(() => parseFire({ kind: 'message', session: 'session_01ABC', text: 'hi', event: 'stars' }), /event/);
  });
});

/**
 * The receiver builds every fire with these, so the parser reads back
 * exactly what a builder made: the test adapter between the two packages.
 */
describe('the builders', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  test('build each kind of fire the parser reads back unchanged, with no absent field spelled undefined', async () => {
    const { build } = await import('../dispatch/webhook/fire.mjs');
    const built = [
      build.schedule({}),
      build.schedule({ issue: 4251 }),
      build.schedule({ freed: 4334 }),
      build.dispatch({ prompt: 'p', sessionName: 'n' }),
      build.dispatch({ prompt: 'p', sessionName: 'n', scheduled: { workflowId: 7, runId: 8, branch: 'trunk' } }),
      build.message({ session: 'session_01ABC', text: 'hi' }),
      build.message({ session: 'https://claude.ai/code/session_01ABC', text: 'hi', on: 724, event: 'pushes', commit: SHA }),
      build.message({ session: 'session_01ABC', text: 'hi', on: 724, event: 'close', closing: true }),
      build.message({ byBranch: true, poster: 'https://claude.ai/code/session_01ABC', text: 'hi', on: 724, event: 'comments', fallback: { prompt: 'p', sessionName: 'n', issue: 724 } }),
      build.workflow({ name: 'CI', branch: 'main', event: 'push', runId: 500, url: 'https://github.com/x/y/actions/runs/500', conclusion: 'failure', headSha: SHA }),
      build.workflow({ name: 'Deploy', path: '.github/workflows/deploy.yml', branch: 'trunk', runId: 500, url: 'https://github.com/x/y/actions/runs/500', conclusion: 'success', headSha: SHA, runAttempt: 2 }),
      build.branchRun({ name: 'Emulator', runId: 600, url: 'https://github.com/x/y/actions/runs/600', conclusion: 'success', headSha: SHA, branch: 'claude/x' }),
      build.job({ name: `dev / Publish (dev) at ${SHA} · deployed: dev`, workflow: 'Deliver', branch: 'main', runId: 500, jobId: 9001, url: 'https://github.com/x/y/actions/runs/500/job/9001', headSha: SHA, label: 'deployed: dev', commit: SHA }),
      build.job({ name: 'Publish to Play testing track · deployed: play track', workflow: 'Android release', branch: 'main', runId: 501, jobId: 9002, url: 'https://github.com/x/y/actions/runs/501/job/9002', headSha: SHA, label: 'deployed: play track', commit: SHA, runAttempt: 2 }),
      build.review({}),
      build.review({ pr: 724, headSha: SHA }),
      build.conflicts({ pr: 793, sha: SHA, base: 'main' }),
      build.unblocked({ issue: 7, blocker: { repo: 'acme/tools', number: 41, title: 'The parser', reason: 'not_planned' } }),
      build.unblocked({ issue: 7, blocker: { repo: 'acme/tools', number: 41, title: 'The parser', reason: undefined }, pr: { number: 52, title: 'Parse it', url: 'https://github.com/acme/tools/pull/52' } }),
    ];
    for (const fire of built) {
      assert.equal(JSON.stringify(fire).includes('undefined'), false);
      assert.deepEqual(Object.values(fire).filter((v) => v === undefined), [], JSON.stringify(fire));
      assert.deepEqual(parseFire(fire), fire, JSON.stringify(fire));
    }
    assert.deepEqual(build.schedule({ issue: undefined }), { kind: 'schedule' });
    assert.deepEqual(build.review({ pr: 724, headSha: undefined }), { kind: 'review', pr: 724 });
  });

  test('a message names its session, or byBranch and what it is on', async () => {
    const { build } = await import('../dispatch/webhook/fire.mjs');
    assert.deepEqual(build.message({ session: 'session_01ABC', text: 'hi' }), { kind: 'message', session: 'session_01ABC', text: 'hi' });
    assert.deepEqual(build.message({ byBranch: true, text: 'hi', on: 724 }), { kind: 'message', byBranch: true, text: 'hi', on: 724 });
  });
});

/**
 * The starter refuses a fire with nothing to start before it spends a task
 * on it; the task's parser refuses the rest.
 */
describe('startable', () => {
  test('passes any fire with a kind, and refuses a dispatch with no prompt or a message with no session or text', async () => {
    const { startable } = await import('../dispatch/webhook/fire.mjs');
    for (const fire of [{ kind: 'schedule' }, { kind: 'dispatch', prompt: 'p' }, { kind: 'message', session: 'session_01ABC', text: 'hi' }, { kind: 'message', byBranch: true, text: 'hi' }, { kind: 'review' }]) {
      assert.doesNotThrow(() => startable(fire), JSON.stringify(fire));
    }
    assert.throws(() => startable(undefined), /no fire/);
    assert.throws(() => startable({}), /no fire/);
    assert.throws(() => startable({ kind: 'dispatch', prompt: ' ' }), /prompt/);
    assert.throws(() => startable({ kind: 'message', text: 'hi' }), /session, or byBranch/);
    assert.throws(() => startable({ kind: 'message', session: 'session_01ABC', text: '' }), /text/);
  });
});

/**
 * The fire's vocabulary has one spelling, here; the modules either side of
 * the packaging seam import it rather than spell it again.
 */
describe('the vocabulary', () => {
  test('lives in the fire module alone', async () => {
    const fire = await import('../dispatch/webhook/fire.mjs');
    const others = {
      route: await import('../dispatch/webhook/route.mjs'),
      mention: await import('../dispatch/webhook/mention.mjs'),
      subscribe: await import('../dispatch/webhook/subscribe.mjs'),
      router: await import('../scripts/lib/dispatch-router.mjs'),
      coverage: await import('../dispatch/coverage.mjs'),
    };
    const vocabulary = ['SUBSCRIPTION_EVENTS', 'RED', 'FAILED', 'WORKFLOW_PATH', 'MESSAGE_SESSION', 'SESSION_LINK', 'LABEL_PREFIX', 'deployedTarget', 'UNATTENDED', 'SUMMONERS', 'DISPATCH_MARKER', 'dispatchMarker', 'lastDispatch', 'recentlyDispatched', 'DISPATCH_WINDOW_MS', 'parseFire', 'parseInvocation'];
    for (const name of vocabulary.filter((n) => n !== 'parseInvocation')) assert.ok(name in fire, `fire.mjs exports ${name}`);
    for (const [module, exports] of Object.entries(others)) {
      for (const name of vocabulary) assert.equal(name in exports, false, `${module} spells ${name} again`);
    }
  });

  test('a session link is the grammar every reader shares', async () => {
    const { MESSAGE_SESSION, SESSION_LINK } = await import('../dispatch/webhook/fire.mjs');
    assert.match('https://claude.ai/code/session_01ABC', SESSION_LINK);
    assert.doesNotMatch('https://claude.ai/code/cse_01ABC', SESSION_LINK);
    assert.match('session_01ABC', MESSAGE_SESSION);
    assert.doesNotMatch('session_01A-BC', MESSAGE_SESSION);
  });
});

/**
 * The fire rides to the task as one environment variable on the RunTask
 * container override, which ECS caps at 8192 characters: the starter
 * builds the override, the retrier reads the fire back off a stopped task's.
 */
describe('the container override', () => {
  test('carries the fire the retrier reads back', async () => {
    const { containerOverride, fireOfOverride } = await import('../dispatch/webhook/fire.mjs');
    const fire = { kind: 'review', pr: 724 };
    const overrides = containerOverride('dispatch', fire);
    assert.deepEqual(overrides, { containerOverrides: [{ name: 'dispatch', environment: [{ name: 'DISPATCH_EVENT', value: JSON.stringify(fire) }] }] });
    assert.deepEqual(fireOfOverride(overrides), fire);
  });

  test('refuses an override with no fire object, and hands back any other as carried', async () => {
    const { containerOverride, fireOfOverride } = await import('../dispatch/webhook/fire.mjs');
    assert.throws(() => fireOfOverride(undefined), /DISPATCH_EVENT/);
    assert.throws(() => fireOfOverride({ containerOverrides: [] }), /DISPATCH_EVENT/);
    assert.throws(() => fireOfOverride({ containerOverrides: [{ environment: [{ name: 'DISPATCH_EVENT', value: 'not json' }] }] }), /DISPATCH_EVENT/);
    assert.deepEqual(fireOfOverride(containerOverride('dispatch', { kind: 'stars' })), { kind: 'stars' }, 'as carried: the retrier parses it');
  });

  test('a fire within the budget fits under the cap, framing included', async () => {
    const { OVERRIDE_BUDGET, OVERRIDE_CAP, containerOverride, overrideWeight } = await import('../dispatch/webhook/fire.mjs');
    const fire = { kind: 'dispatch', prompt: '"'.repeat(OVERRIDE_BUDGET) };
    let trimmed = fire;
    while (overrideWeight(trimmed) > OVERRIDE_BUDGET) trimmed = { ...trimmed, prompt: trimmed.prompt.slice(1) };
    assert.ok(OVERRIDE_BUDGET < OVERRIDE_CAP);
    assert.ok(Buffer.byteLength(JSON.stringify(containerOverride('dispatch', trimmed))) < OVERRIDE_CAP);
  });
});

describe('parseFire — the repo a fire is for', () => {
  test('carries the repo it names, refuses one that is not an owner/name, and leaves the bare schedule fire bare', () => {
    assert.deepEqual(parseNamed({ kind: 'schedule', repo: 't-d-d/askme-mcp' }), { kind: 'schedule', repo: 't-d-d/askme-mcp' });
    assert.deepEqual(parseNamed({ kind: 'message', session: 'session_01ABC', text: 'hi', repo: 'acme/factory' }), { kind: 'message', session: 'session_01ABC', text: 'hi', repo: 'acme/factory' });
    assert.deepEqual(parseNamed({ kind: 'schedule' }), { kind: 'schedule' });
    assert.deepEqual(parseNamed({ source: 'aws.events' }), { kind: 'schedule' });
    assert.deepEqual(parseNamed({ kind: 'probe', repo: 'acme/factory' }), { kind: 'probe' });
    assert.throws(() => parseNamed({ kind: 'schedule', repo: '../etc' }), /owner\/name/);
    assert.throws(() => parseNamed({ kind: 'schedule', repo: 7 }), /owner\/name/);
  });

  // A fire with no repo was once read as the stack's own repo's. Nothing
  // falls back to a default repo, and the retrier sends
  // such a fire to the dead-letter queue (retry.mjs).
  test('refuses every other fire that names no repo', () => {
    const unnamed = [
      { kind: 'schedule', issue: 9 },
      { kind: 'schedule', freed: 9 },
      { kind: 'dispatch', prompt: 'hi' },
      { kind: 'message', session: 'session_01ABC', text: 'hi' },
      { kind: 'review', pr: 4 },
      { kind: 'conflicts', pr: 4, sha: 'a'.repeat(40), base: 'main' },
    ];
    for (const fire of unnamed) assert.throws(() => parseNamed(fire), /names its repo/, JSON.stringify(fire));
  });
});

/**
 * A label added in a repo whose ready labels the receiver does not know: the
 * schedule fire names it beside the issue, and the turn checks it.
 */
describe('a schedule fire naming the label just added', () => {
  test('keeps the label beside its issue, and refuses one with no issue or that is not text', () => {
    const fire = { kind: 'schedule', issue: 12, label: 'mode: afk', repo: 't-d-d/askme-mcp' };
    assert.deepEqual(parseNamed(fire), fire);
    assert.throws(() => parseNamed({ kind: 'schedule', label: 'mode: afk', repo: 't-d-d/askme-mcp' }), /label/);
    assert.throws(() => parseNamed({ ...fire, label: '' }), /label/);
    assert.throws(() => parseNamed({ ...fire, label: 7 }), /label/);
  });
});

/**
 * A message heard by subscription says so: the turn reads the repo's
 * subscribe-messages switch for it, and the PR-messages switch for the PR's
 * owner's.
 */
describe('a subscribed message invocation', () => {
  test('keeps subscribed: true, and refuses anything else', () => {
    const fire = { kind: 'message', session: 'session_01ABC', text: 'hi', subscribed: true, repo: 'acme/factory' };
    assert.deepEqual(parseNamed(fire), fire);
    assert.throws(() => parseNamed({ ...fire, subscribed: 'yes' }), /subscribed/);
  });
});

describe('a fire that counts for the periodics', () => {
  test('any fire naming its repo may carry the event it counts', () => {
    for (const fire of [
      { kind: 'schedule', freed: 717, counted: 'issuesClosed' },
      { kind: 'conflicts', pr: 724, sha: 'c'.repeat(40), base: 'main', counted: 'merges' },
      { kind: 'dispatch', prompt: 'Look.', counted: 'issuesOpened' },
      { kind: 'periodics', counted: 'issuesOpened' },
    ]) {
      assert.deepEqual(parseNamed({ ...fire, repo: 'acme/factory' }), { ...fire, repo: 'acme/factory' });
    }
  });

  test('an event no periodic counts is refused, and so is a periodics fire counting none', () => {
    assert.throws(() => parseNamed({ kind: 'schedule', freed: 717, counted: 'pushes', repo: 'acme/factory' }), /counted/);
    assert.throws(() => parseNamed({ kind: 'periodics', repo: 'acme/factory' }), /counted/);
  });

  test('a fire naming no repo counts nothing', () => {
    assert.throws(() => parseNamed({ kind: 'periodics', counted: 'merges' }), /names its repo/);
    assert.throws(() => parseNamed({ kind: 'schedule', counted: 'merges' }), /repo/);
  });

  test('the builder spells it', () => {
    assert.deepEqual(build.periodics({ counted: 'merges' }), { kind: 'periodics', counted: 'merges' });
  });
});
