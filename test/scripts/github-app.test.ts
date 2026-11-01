/**
 * The dispatcher's GitHub identity: an installation token minted from the
 * GitHub App the repository already carries (APP_ID, APP_PRIVATE_KEY), and a
 * small REST reader over `fetch`.
 *
 * The dispatcher's image has no `gh` and no `gh-deps`, so the ready issues
 * and an issue's blockers are read here over fetch. The
 * endpoints and the row shapes are pinned to what `gh api` and the shim
 * produce, so `scripts/lib/ready-work.mjs` sees the rows it was written for.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  appJwt,
  githubApi,
  githubReader,
  RUNS_PER_PAGE,
  appInstallations,
  installationToken,
} from '../../scripts/lib/github-app.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const b64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

describe('appJwt', () => {
  test('is an RS256 JWT for the app, issued a minute early and good for nine', () => {
    const now = 1_790_000_000_000;
    const jwt = appJwt({ appId: '12345', privateKeyPem: PEM, now });
    const [header = '', payload = '', signature = ''] = jwt.split('.');
    assert.deepEqual(JSON.parse(b64url(header)), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(b64url(payload)), {
      iat: 1_790_000_000 - 60,
      exp: 1_790_000_000 + 540,
      iss: '12345',
    });
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    assert.equal(ok, true, 'signature does not verify against the app key');
  });

  test('a key in PKCS#8 form signs the same as PKCS#1', () => {
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const a = appJwt({ appId: '1', privateKeyPem: PEM, now: 0 });
    const b = appJwt({ appId: '1', privateKeyPem: pkcs8, now: 0 });
    assert.equal(a, b);
  });
});

type Recorded = { url: string; init: RequestInit | undefined };

/** A fetch that answers by URL and records every call. */
type Answer = unknown | ((init: RequestInit | undefined, url: string) => unknown);

const fakeFetch = (answers: Record<string, Answer>) => {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(answers).find((k) => url === k || url.startsWith(`${k}?`));
    if (key === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const answer = answers[key];
    const body = typeof answer === 'function' ? (answer as (i: RequestInit | undefined, u: string) => unknown)(init, url) : answer;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
};

describe('installationToken', () => {
  test('finds the installation for the repository with the app JWT, then mints a token with it', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/installation': { id: 777 },
      'https://api.github.com/app/installations/777/access_tokens': { token: 'ghs_abc', expires_at: '2026-09-25T12:00:00Z' },
    });
    const token = await installationToken({ appId: '12345', privateKeyPem: PEM, repo: 'acme/factory', fetch });
    assert.equal(token, 'ghs_abc');
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const auth = new Headers(call.init?.headers).get('authorization') ?? '';
      assert.match(auth, /^Bearer eyJ/, 'both calls carry the app JWT, not a token');
    }
    assert.equal(calls[1]?.init?.method, 'POST');
  });

  test('names the failing call when GitHub refuses', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/installation': new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    });
    await assert.rejects(
      installationToken({ appId: '1', privateKeyPem: PEM, repo: 'acme/factory', fetch }),
      /installation.*401/,
    );
  });
});

describe('githubReader', () => {
  const issueRow = (number: number, labels: string[], over: Record<string, unknown> = {}) => ({
    number,
    title: `Issue ${number}`,
    state: 'open',
    created_at: '2026-09-01T00:00:00Z',
    labels: labels.map((name) => ({ name })),
    ...over,
  });

  test('readyIssues pages through the ready label, drops pull requests, flattens labels', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues': (_init: RequestInit | undefined, url: string) => {
        const page = new URL(url).searchParams.get('page');
        return page === '2' ? [] : [
          issueRow(10, ['workflow: ready for development', 'mode: afk']),
          issueRow(11, ['workflow: ready for development'], { pull_request: { url: 'x' } }),
        ];
      },
    });
    const reader = githubReader({ token: 'ghs_abc', repo: 'acme/factory', fetch });
    const issues = await reader.readyIssues(['workflow: ready for development']);
    assert.deepEqual(issues, [
      {
        number: 10,
        title: 'Issue 10',
        state: 'open',
        created_at: '2026-09-01T00:00:00Z',
        labels: ['workflow: ready for development', 'mode: afk'],
      },
    ]);
    const first = new URL(calls[0]!.url);
    assert.equal(first.searchParams.get('labels'), 'workflow: ready for development');
    assert.equal(first.searchParams.get('state'), 'open');
    assert.equal(first.searchParams.get('per_page'), '100');
    assert.equal(new Headers(calls[0]!.init?.headers).get('authorization'), 'Bearer ghs_abc');
  });

  test('readyIssues carries each issue\'s open blocker count from its dependency summary, where it has one', async () => {
    // The summary counts a blocker the caller cannot see; `blocked_by` is
    // the open ones, `total_blocked_by` all of them.
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues': (_init: RequestInit | undefined, url: string) => (new URL(url).searchParams.get('page') === '2' ? [] : [
        issueRow(10, ['mode: afk'], { issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1, blocking: 0, total_blocking: 0 } }),
        issueRow(11, ['mode: afk'], { issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 2, blocking: 0, total_blocking: 0 } }),
        issueRow(12, ['mode: afk']),
      ]),
    });
    const issues = await githubReader({ token: 't', repo: 'acme/factory', fetch }).readyIssues(['mode: afk']);
    assert.deepEqual(issues.map((i) => [i.number, i.openBlockers]), [[10, 1], [11, 0], [12, undefined]]);
    assert.ok(!('openBlockers' in issues[2]!), 'a row with no summary carries no count');
  });

  test('blockers reads the native blocked_by relationship, in gh-deps row shape', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/dependencies/blocked_by': [
        { number: 3, state: 'open', title: 'Blocker' },
        { number: 4, state: 'closed', title: 'Done' },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.blockers(10), [
      { number: 3, state: 'open', title: 'Blocker' },
      { number: 4, state: 'closed', title: 'Done' },
    ]);
  });

  test('blocking reads the native blocking relationship, the reverse of blockers', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/dependencies/blocking': [
        { number: 11, state: 'open', title: 'Waits on 10', body: 'x' },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.blocking(10), [{ number: 11, state: 'open', title: 'Waits on 10', repo: 'acme/factory' }]);
    assert.equal(new URL(calls[0]!.url).searchParams.get('per_page'), '100');
  });

  // A dependency can cross repositories: each row names its repo, so
  // another repo's #12 is never read as this repo's #12.
  test('blocking keeps an issue in another repository, naming its repo', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/dependencies/blocking': [
        { number: 11, state: 'open', title: 'Here', repository_url: 'https://api.github.com/repos/Acme/Factory' },
        { number: 12, state: 'open', title: 'Elsewhere', repository_url: 'https://api.github.com/repos/acme/other' },
        { number: 13, state: 'open', title: 'Unsaid' },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.blocking(10), [
      { number: 11, state: 'open', title: 'Here', repo: 'Acme/Factory' },
      { number: 12, state: 'open', title: 'Elsewhere', repo: 'acme/other' },
      { number: 13, state: 'open', title: 'Unsaid', repo: 'acme/factory' },
    ]);
  });

  test('closure reads how an issue closed: its reason, and the PR whose merge closed it', async () => {
    const SHA = 'a'.repeat(40);
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/events': [
        { event: 'labeled' },
        { event: 'closed', created_at: '2026-09-01T00:00:00Z', commit_id: 'b'.repeat(40), commit_url: 'https://api.github.com/repos/acme/factory/commits/' + 'b'.repeat(40) },
        { event: 'reopened' },
        { event: 'closed', created_at: '2026-10-01T00:00:02Z', commit_id: SHA, commit_url: `https://api.github.com/repos/acme/factory/commits/${SHA}` },
      ],
      'https://api.github.com/repos/acme/factory/issues/10': { number: 10, title: 'The parser', state: 'closed', state_reason: 'completed' },
      [`https://api.github.com/repos/acme/factory/commits/${SHA}/pulls`]: [
        { number: 50, title: 'Open one', html_url: 'https://github.com/acme/factory/pull/50', merged_at: null, merge_commit_sha: 'c'.repeat(40) },
        { number: 52, title: 'Parse it', html_url: 'https://github.com/acme/factory/pull/52', merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: SHA },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.closure(10), { title: 'The parser', reason: 'completed', pr: { number: 52, title: 'Parse it', url: 'https://github.com/acme/factory/pull/52' } });
    assert.ok(calls.every((c) => c.url.startsWith('https://api.github.com/repos/acme/factory/')), calls.map((c) => c.url).join('; '));
  });

  // GitHub closes an issue from a commit message that names it, and its
  // `closed` event then names that commit: one on the PR's branch, which
  // reaches the default branch when the PR merges, not the merge commit.
  test('closure names the PR holding the closing commit when that PR merged just before the close', async () => {
    const SHA = 'a'.repeat(40);
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/events': [{ event: 'closed', created_at: '2026-10-01T00:04:00Z', commit_id: SHA, commit_url: `https://api.github.com/repos/acme/factory/commits/${SHA}` }],
      'https://api.github.com/repos/acme/factory/issues/10': { number: 10, title: 'The parser', state: 'closed', state_reason: 'completed' },
      [`https://api.github.com/repos/acme/factory/commits/${SHA}/pulls`]: [
        { number: 52, title: 'Parse it', html_url: 'https://github.com/acme/factory/pull/52', merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: 'c'.repeat(40) },
      ],
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 'acme/factory', fetch }).closure(10), { title: 'The parser', reason: 'completed', pr: { number: 52, title: 'Parse it', url: 'https://github.com/acme/factory/pull/52' } });
  });

  // A PR whose body says `Closes #10` closes the issue when it merges, and
  // the `closed` event names no commit. The PR is the one in the issue's
  // timeline that closes it from its body and merged just before the close.
  test('closure names the PR that closes the issue from its body and merged just before a close naming no commit', async () => {
    const pull = (number: number, body: string, merged_at: string | null, repo = 'acme/factory') => ({
      event: 'cross-referenced',
      source: { type: 'issue', issue: { number, title: `PR ${number}`, body, html_url: `https://github.com/${repo}/pull/${number}`, repository_url: `https://api.github.com/repos/${repo}`, pull_request: { merged_at } } },
    });
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/events': [{ event: 'closed', created_at: '2026-10-01T12:00:02Z', commit_id: null, commit_url: null }],
      'https://api.github.com/repos/acme/factory/issues/10': { number: 10, title: 'The parser', state: 'closed', state_reason: 'completed' },
      'https://api.github.com/repos/acme/factory/issues/10/timeline': [
        { event: 'labeled' },
        { event: 'cross-referenced', source: { type: 'issue', issue: { number: 11, title: 'A ticket', body: 'Closes #10', html_url: 'https://github.com/acme/factory/issues/11', repository_url: 'https://api.github.com/repos/acme/factory' } } },
        pull(40, 'Closes #10', '2026-10-01T11:50:00Z'),
        pull(41, 'Closes #10', '2026-10-01T11:56:00Z'),
        pull(42, 'Mentions #10 and closes nothing', '2026-10-01T12:00:01Z'),
        pull(43, 'Closes acme/factory#10', '2026-10-01T12:00:01Z', 'acme/other'),
        pull(44, 'Closes #10', null),
        pull(45, 'Closes #10', '2026-10-01T12:00:05Z'),
        pull(52, 'Closes #10', '2026-10-01T12:00:00Z', 'Acme/Factory'),
        { event: 'closed', commit_id: null },
      ],
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 'acme/factory', fetch }).closure(10), { title: 'The parser', reason: 'completed', pr: { number: 52, title: 'PR 52', url: 'https://github.com/Acme/Factory/pull/52' } });
    assert.ok(calls.every((c) => c.url.startsWith('https://api.github.com/repos/acme/factory/')), calls.map((c) => c.url).join('; '));
  });

  // The PR closed the issue, someone reopened it, and a hand closed it
  // again: the last close is the hand's, however soon it came.
  test('closure names no PR when the issue was reopened after the PR merged', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/events': [
        { event: 'closed', created_at: '2026-10-01T12:00:02Z', commit_id: null },
        { event: 'reopened', created_at: '2026-10-01T12:01:00Z' },
        { event: 'closed', created_at: '2026-10-01T12:02:00Z', commit_id: null },
      ],
      'https://api.github.com/repos/acme/factory/issues/10': { number: 10, title: 'The parser', state: 'closed', state_reason: 'completed' },
      'https://api.github.com/repos/acme/factory/issues/10/timeline': [
        { event: 'cross-referenced', source: { type: 'issue', issue: { number: 52, title: 'Parse it', body: 'Closes #10', html_url: 'https://github.com/acme/factory/pull/52', repository_url: 'https://api.github.com/repos/acme/factory', pull_request: { merged_at: '2026-10-01T12:00:00Z' } } } },
      ],
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 'acme/factory', fetch }).closure(10), { title: 'The parser', reason: 'completed', pr: null });
  });

  // A commit pushed to the default branch can also sit in an older merged
  // PR: only a PR that merged just before the close made it.
  test('closure names no PR when the PR holding the closing commit merged long before the close', async () => {
    const SHA = 'a'.repeat(40);
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/events': [{ event: 'closed', created_at: '2026-10-01T00:00:00Z', commit_id: SHA, commit_url: `https://api.github.com/repos/acme/factory/commits/${SHA}` }],
      'https://api.github.com/repos/acme/factory/issues/10': { number: 10, title: 'The parser', state: 'closed', state_reason: 'completed' },
      [`https://api.github.com/repos/acme/factory/commits/${SHA}/pulls`]: [{ number: 40, title: 'Back-merge', html_url: 'https://github.com/acme/factory/pull/40', merged_at: '2026-09-01T00:00:00Z', merge_commit_sha: 'd'.repeat(40) }],
      'https://api.github.com/repos/acme/factory/issues/10/timeline': [],
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 'acme/factory', fetch }).closure(10), { title: 'The parser', reason: 'completed', pr: null });
  });

  test('closure names no PR for a close by hand, or by a commit in another repository', async () => {
    const SHA = 'a'.repeat(40);
    for (const events of [
      [{ event: 'closed', created_at: '2026-10-01T00:00:00Z', commit_id: null }],
      [{ event: 'closed', created_at: '2026-10-01T00:00:00Z', commit_id: SHA, commit_url: `https://api.github.com/repos/acme/other/commits/${SHA}` }],
      [],
    ]) {
      const { fetch, calls } = fakeFetch({
        'https://api.github.com/repos/acme/factory/issues/10/events': events,
        'https://api.github.com/repos/acme/factory/issues/10': { number: 10, title: 'The parser', state: 'closed', state_reason: 'not_planned' },
        'https://api.github.com/repos/acme/factory/issues/10/timeline': [
          { event: 'cross-referenced', source: { type: 'issue', issue: { number: 44, title: 'Still open', body: 'Closes #10', html_url: 'https://github.com/acme/factory/pull/44', repository_url: 'https://api.github.com/repos/acme/factory', pull_request: { merged_at: null } } } },
        ],
      });
      const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
      assert.deepEqual(await reader.closure(10), { title: 'The parser', reason: 'not_planned', pr: null }, JSON.stringify(events));
      assert.ok(!calls.some((c) => c.url.includes('/commits/')), JSON.stringify(events));
    }
  });

  test('closure reads a missing reason as none', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/events': [],
      'https://api.github.com/repos/acme/factory/issues/10': { number: 10, title: 'Old', state: 'closed', state_reason: null },
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 'acme/factory', fetch }).closure(10), { title: 'Old', reason: null, pr: null });
  });

  test('comment posts to the issue and returns nothing the caller must handle', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/comments': (init: RequestInit | undefined) => {
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), { body: 'hello' });
        return { id: 1 };
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await reader.comment(10, 'hello');
    assert.equal(calls.length, 1);
  });

  test('comments lists an issue\'s comments, newest last', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/comments': [
        { id: 1, body: 'a', created_at: '2026-09-01T00:00:00Z' },
        { id: 2, body: 'b', created_at: '2026-09-02T00:00:00Z' },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.comments(10), [
      { id: 1, body: 'a', created_at: '2026-09-01T00:00:00Z' },
      { id: 2, body: 'b', created_at: '2026-09-02T00:00:00Z' },
    ]);
  });

  /**
   * The endpoint lists oldest first, a hundred to a page, and the dispatch
   * marker is the newest comment: on a long thread it would sit past the
   * page. `since` asks for the window's comments and nothing older.
   */
  test('comments takes a `since`, so a long thread still shows the newest marker', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/comments': [],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await reader.comments(10, { since: '2026-09-25T10:00:00.000Z' });
    assert.equal(new URL(calls[0]!.url).searchParams.get('since'), '2026-09-25T10:00:00.000Z');
  });

  // A fallback's handoff: the PR body's session link, read and rewritten.
  // Its head branch finds the session of a PR whose body names none.
  // A fork's branch is not this repository's: a session holding a branch of
  // the same name elsewhere is not its owner, so a fork's head reads as none.
  test('pull reads a pull request\'s number, body and head branch, a null body as empty, a fork\'s head as none', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls/10': { number: 10, title: 'T', body: 'B', state: 'open', head: { ref: 'claude/x', sha: 'abc', repo: { full_name: 'acme/factory' } } },
      'https://api.github.com/repos/acme/factory/pulls/11': { number: 11, title: 'U', body: null, state: 'open' },
      'https://api.github.com/repos/acme/factory/pulls/12': { number: 12, title: 'F', body: 'B', state: 'open', head: { ref: 'main', sha: 'def', repo: { full_name: 'someone/factory' } } },
      'https://api.github.com/repos/acme/factory/pulls/13': { number: 13, title: 'G', body: 'B', state: 'closed', head: { ref: 'main', sha: 'fed', repo: null } },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.pull(10), { number: 10, body: 'B', head: 'claude/x', open: true });
    assert.deepEqual(await reader.pull(11), { number: 11, body: '', head: '', open: true });
    assert.deepEqual(await reader.pull(12), { number: 12, body: 'B', head: '', open: true }, 'a fork\'s branch');
    assert.deepEqual(await reader.pull(13), { number: 13, body: 'B', head: '', open: false }, 'a deleted fork\'s branch, on a closed PR');
  });

  test('updatePull patches the pull request\'s body and nothing else', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls/10': (init: RequestInit | undefined) => {
        assert.equal(init?.method, 'PATCH');
        assert.deepEqual(JSON.parse(String(init?.body)), { body: 'new body' });
        return { number: 10 };
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await reader.updatePull(10, { body: 'new body' });
    assert.equal(calls.length, 1);
  });

  test('a non-2xx answer throws with the path and status', async () => {
    const { fetch } = fakeFetch({});
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await assert.rejects(reader.blockers(99), /issues\/99\/dependencies\/blocked_by.*404/);
  });

  // The workflow turn's reads.
  test('pullsForCommit lists the pull requests a commit belongs to, with the body, the merge commit, the head branch and the author', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/commits/abc/pulls': [
        { number: 7, title: 'T', html_url: 'u', body: 'B', merged_at: '2026-09-25T00:00:00Z', merge_commit_sha: 'abc', state: 'closed', head: { ref: 'claude/x', repo: { full_name: 'acme/factory' } }, user: { login: 'dependabot[bot]' } },
        { number: 8, title: 'O', html_url: 'v', body: null, merged_at: null, merge_commit_sha: 'zzz', state: 'open' },
        { number: 9, title: 'F', html_url: 'w', body: 'B', merged_at: '2026-09-25T00:00:00Z', merge_commit_sha: 'abc', state: 'closed', head: { ref: 'main', repo: { full_name: 'someone/factory' } }, user: { login: 'someone' } },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.pullsForCommit('abc'), [
      { number: 7, title: 'T', html_url: 'u', body: 'B', merged_at: '2026-09-25T00:00:00Z', merge_commit_sha: 'abc', head: 'claude/x', author: 'dependabot[bot]' },
      { number: 8, title: 'O', html_url: 'v', body: '', merged_at: null, merge_commit_sha: 'zzz', head: '', author: '' },
      { number: 9, title: 'F', html_url: 'w', body: 'B', merged_at: '2026-09-25T00:00:00Z', merge_commit_sha: 'abc', head: '', author: 'someone' },
    ]);
  });

  test('runJobs lists a run\'s latest attempt\'s jobs', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/actions/runs/500/jobs': { total_count: 2, jobs: [
        { id: 1, name: 'backend', conclusion: 'failure', html_url: 'j', steps: [{ name: 'Publish to Play testing track (fastlane supply)', status: 'completed', conclusion: 'skipped', number: 9 }] },
        { id: 2, name: 'web', conclusion: 'success', html_url: 'k' },
      ] },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.runJobs(500), [
      { name: 'backend', conclusion: 'failure', html_url: 'j' },
      { name: 'web', conclusion: 'success', html_url: 'k' },
    ]);
    assert.equal(new URL(calls[0]!.url).searchParams.get('filter'), 'latest');
  });

  // A job fire names its run by id, and the turn reads the run
  // for the workflow file the job is of.
  test('run reads one run by id: its workflow file, head, event, state and attempt', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/actions/runs/500': {
        id: 500, name: 'Deliver', path: '.github/workflows/deliver.yml', head_sha: 'c'.repeat(40), head_branch: 'main', event: 'workflow_run', status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/acme/factory/actions/runs/500', created_at: '2026-10-05T10:00:00Z', run_attempt: 2, workflow_id: 77, jobs_url: 'j',
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.run(500), {
      id: 500, path: '.github/workflows/deliver.yml', head_sha: 'c'.repeat(40), head_branch: 'main', event: 'workflow_run', status: 'completed', conclusion: 'success',
      html_url: 'https://github.com/acme/factory/actions/runs/500', created_at: '2026-10-05T10:00:00Z', run_attempt: 2,
    });
  });

  test('addLabels adds labels to an issue', async () => {
    const { fetch, calls } = fakeFetch({ 'https://api.github.com/repos/acme/factory/issues/804/labels': [{ name: 'deployed: dev' }] });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await reader.addLabels(804, ['deployed: dev']);
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { labels: ['deployed: dev'] });
  });

  test('removeLabel removes one label, its name escaped into the path', async () => {
    const { fetch, calls } = fakeFetch({ 'https://api.github.com/repos/acme/factory/issues/804/labels/workflow%3A%20ready%20for%20development': [] });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await reader.removeLabel(804, 'workflow: ready for development');
    assert.equal(calls[0]?.init?.method, 'DELETE');
  });

  // The label already gone is what removing it asked for.
  test('removeLabel takes a label the issue lacks as removed', async () => {
    const { fetch } = fakeFetch({});
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await reader.removeLabel(804, 'workflow: under development');
  });

  test('workflowRuns lists every branch\'s runs of a workflow unfiltered, newest first, each with its branch', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/actions/workflows/ci.yml/runs': { total_count: 1, workflow_runs: [{ id: 5, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', head_sha: 's', html_url: 'h', created_at: '2026-09-27T11:57:47Z', name: 'CI' }] },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.workflowRuns('ci.yml', {}), [{ id: 5, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', head_sha: 's', html_url: 'h', created_at: '2026-09-27T11:57:47Z' }]);
    assert.deepEqual([...new URL(calls[0]!.url).searchParams.keys()].sort(), ['page', 'per_page']);
    assert.equal(new URL(calls[0]!.url).searchParams.get('per_page'), String(RUNS_PER_PAGE));
    assert.equal(new URL(calls[0]!.url).searchParams.get('page'), '1');
    await reader.workflowRuns('ci.yml', { page: 3 });
    assert.equal(new URL(calls[1]!.url).searchParams.get('page'), '3');
  });

  test('compareCommits pages through the commits between two, with their messages', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/compare/aaa...bbb': (_init: RequestInit | undefined, url: string) => {
        const page = Number(new URL(url).searchParams.get('page'));
        const n = page === 1 ? 100 : 1;
        return { commits: Array.from({ length: n }, (_, i) => ({ sha: `c${page}-${i}`, commit: { message: `m${page}-${i}` } })) };
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    const commits = await reader.compareCommits('aaa', 'bbb');
    assert.equal(commits.length, 101);
    assert.deepEqual(commits[100], { sha: 'c2-0', message: 'm2-0' });
  });

  test('mergeBase is the commit the compare of two names as their merge base, and one it does not name throws', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/compare/main...bbb': { merge_base_commit: { sha: 'm0' }, commits: [] },
      'https://api.github.com/repos/acme/factory/compare/main...ccc': { commits: [] },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.equal(await reader.mergeBase('main', 'bbb'), 'm0');
    assert.equal(calls.length, 1);
    await assert.rejects(reader.mergeBase('main', 'ccc'), /merge base/);
  });

  test('fileAt is a file\'s text at a commit; a missing path, a directory or an undecoded body throws', async () => {
    const text = '# Billing\n\n- A rule, with “quotes”.\n';
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/contents/docs/notes/billing.md': { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n') },
      'https://api.github.com/repos/acme/factory/contents/docs/notes': [{ type: 'file', name: 'billing.md' }],
      'https://api.github.com/repos/acme/factory/contents/docs/notes/big.md': { type: 'file', encoding: 'none', content: '' },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.equal(await reader.fileAt('docs/notes/billing.md', 'm0'), text);
    assert.equal(new URL(calls[0]!.url).searchParams.get('ref'), 'm0');
    await assert.rejects(reader.fileAt('docs/notes/gone.md', 'm0'), /404/);
    await assert.rejects(reader.fileAt('docs/notes', 'm0'), /no file/);
    await assert.rejects(reader.fileAt('docs/notes/big.md', 'm0'), /no file/);
  });

  // The subscriptions' reads and write.
  // The search API allows an installation about thirty calls a minute, and
  // other callers of the App spend it too; the issues list is on the core
  // limit. One read of every open issue and PR serves the whole turn.
  test('openNaming lists open issues and PRs whose body names the term, reading the list once per reader and never searching', async () => {
    const row = (number: number, body: string | null, pull = false) => ({ number, title: `T${number}`, html_url: `u${number}`, body, ...(pull ? { pull_request: { url: 'x' } } : {}) });
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues': (_init: RequestInit | undefined, url: string) => {
        const params = new URL(url).searchParams;
        assert.equal(params.get('state'), 'open');
        return Number(params.get('page')) === 1
          ? [row(7, 'Footer https://claude.ai/code/session_01ABC', true), ...Array.from({ length: 99 }, (_, i) => row(100 + i, 'nobody'))]
          : [row(8, '<!-- governor:subscribe https://claude.ai/code/session_01ABC -->'), row(9, null), row(10, 'session_01OTHER'), row(11, 'https://claude.ai/code/session_01ABCDEF, a longer id')];
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.openNaming('session_01ABC'), [
      { number: 7, title: 'T7', html_url: 'u7', pull: true },
      { number: 8, title: 'T8', html_url: 'u8', pull: false },
    ]);
    assert.deepEqual(await reader.openNaming('session_01OTHER'), [{ number: 10, title: 'T10', html_url: 'u10', pull: false }]);
    assert.equal(calls.length, 2, 'two pages, read once for both sessions');
    assert.ok(calls.every((c) => !c.url.includes('/search/')), 'no search call');
  });

  test('openNaming reads the list again after a read that failed', async () => {
    let answered = 0;
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues': () => (answered++ === 0
        ? new Response('boom', { status: 502, statusText: 'Bad Gateway' })
        : [{ number: 7, title: 'T7', html_url: 'u7', body: 'session_01ABC' }]),
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await assert.rejects(reader.openNaming('session_01ABC'), /502/);
    assert.deepEqual(await reader.openNaming('session_01ABC'), [{ number: 7, title: 'T7', html_url: 'u7', pull: false }]);
    assert.equal(calls.length, 2);
  });

  test('commit reads a commit\'s message and its parents', async () => {
    const { fetch } = fakeFetch({ 'https://api.github.com/repos/acme/factory/commits/abc': { sha: 'abc', commit: { message: 'M\n\nClaude-Session: s' }, parents: [{ sha: 'p1' }, { sha: 'p2' }] } });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.commit('abc'), { sha: 'abc', message: 'M\n\nClaude-Session: s', parents: ['p1', 'p2'] });
  });

  test('issue reads an issue\'s or a PR\'s body and which it is, and updateIssue patches it and nothing else', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/12': (init: RequestInit | undefined) => {
        if (init?.method === 'PATCH') {
          assert.deepEqual(JSON.parse(String(init?.body)), { body: 'new body' });
          return { number: 12 };
        }
        return { number: 12, title: 'T', body: null };
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.issue(12), { number: 12, body: '', pull: false });
    await reader.updateIssue(12, { body: 'new body' });
    assert.deepEqual(calls.map((c) => c.init?.method ?? 'GET'), ['GET', 'PATCH']);
    const pr = githubReader({ token: 't', repo: 'acme/factory', fetch: fakeFetch({ 'https://api.github.com/repos/acme/factory/issues/13': { number: 13, body: 'b', pull_request: { url: 'u' } } }).fetch });
    assert.deepEqual(await pr.issue(13), { number: 13, body: 'b', pull: true });
  });

  // The PR review's reads and writes.
  test('pullRequest reads what the review needs: title, body, state, draft, base, head and mergeable', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls/10': { number: 10, title: 'T', body: null, state: 'open', draft: true, base: { ref: 'main' }, head: { sha: 'h', ref: 'b' }, mergeable: null, html_url: 'u', author_association: 'MEMBER', user: { login: 'dependabot[bot]', type: 'Bot' } },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.pullRequest(10), { number: 10, title: 'T', body: '', state: 'open', draft: true, base: 'main', headSha: 'h', mergeable: null, html_url: 'u', association: 'MEMBER', author: 'dependabot[bot]' });
  });

  test('pullCommits pages through a PR\'s commits, each with its author\'s and committer\'s logins, null for none, and whether GitHub verified it', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls/10/commits': (_init: RequestInit | undefined, url: string) => {
        const page = Number(new URL(url).searchParams.get('page'));
        return page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ sha: `s${i}`, author: { login: 'dependabot[bot]' }, committer: { login: 'web-flow' }, commit: { verification: { verified: true, reason: 'valid' } } }))
          : [{ sha: 'pushed', author: null, committer: null, commit: { verification: { verified: false, reason: 'unsigned' } } }, { sha: 'bare', commit: {} }];
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    const commits = await reader.pullCommits(10);
    assert.equal(commits.length, 102);
    assert.deepEqual(commits[0], { sha: 's0', author: 'dependabot[bot]', committer: 'web-flow', verified: true });
    assert.deepEqual(commits.slice(-2), [{ sha: 'pushed', author: null, committer: null, verified: false }, { sha: 'bare', author: null, committer: null, verified: false }]);
    assert.equal(calls.length, 2);
  });

  test('pullFiles pages through a PR\'s changed files', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls/10/files': (_init: RequestInit | undefined, url: string) => {
        const page = Number(new URL(url).searchParams.get('page'));
        return page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: 'modified', additions: 1 }))
          : [{ filename: 'moved', status: 'renamed', previous_filename: 'src/billing/entitlements.ts' }, { filename: 'last', status: 'added' }];
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    const files = await reader.pullFiles(10);
    assert.equal(files.length, 102);
    assert.deepEqual(files.at(-1), { filename: 'last', status: 'added' });
    // A rename keeps the path it left: moving a file out of a guarded path changes that path.
    assert.deepEqual(files.at(-2), { filename: 'moved', status: 'renamed', previous: 'src/billing/entitlements.ts' });
    assert.equal(calls.length, 2);
  });

  test('openPulls pages through the open PRs, each with whether it is a draft, its base, its head, its title, its link and its body', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls': [
        { number: 7, draft: false, title: 'x', html_url: 'https://github.com/acme/factory/pull/7', body: 'Closes #1', base: { ref: 'main' }, head: { ref: 'claude/a', repo: { full_name: 'acme/factory' } } },
        { number: 8, draft: true, base: { ref: 'claude/a' }, head: { ref: 'claude/b', repo: { full_name: 'someone/fork' } } },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.openPulls(), [
      { number: 7, draft: false, base: 'main', head: 'claude/a', title: 'x', html_url: 'https://github.com/acme/factory/pull/7', body: 'Closes #1' },
      { number: 8, draft: true, base: 'claude/a', head: '', title: '', html_url: '', body: '' },
    ], 'a fork\'s head is not this repository\'s branch');
    assert.equal(new URL(calls[0]!.url).searchParams.get('state'), 'open');
  });

  // A periodic's windows (dispatch/periodics.mjs): counted by when each
  // thing happened, never by comparing commits, which stops at 250.
  const SINCE = '2026-10-20T00:00:00Z';
  const page = (url: string) => Number(new URL(url).searchParams.get('page'));

  test('mergedSince lists the PRs merged into a base after a time, oldest first, reading closed PRs newest updated first until they predate it', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ number: 300 + i, title: `PR ${i}`, merged_at: i % 2 === 0 ? `2026-10-2${1 + (i % 5)}T00:00:00Z` : null, updated_at: '2026-10-26T00:00:00Z' }));
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls': (_init: RequestInit | undefined, url: string) => (page(url) === 1 ? full : [
        { number: 12, title: 'Merged just after', merged_at: '2026-10-20T00:00:01Z', updated_at: '2026-10-20T00:00:02Z' },
        { number: 11, title: 'Merged before', merged_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T23:00:00Z' },
        { number: 10, title: 'Updated after, merged before', merged_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' },
      ]),
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    const merged = await reader.mergedSince('trunk', SINCE);
    assert.equal(merged.length, 51);
    assert.deepEqual(merged[0], { number: 12, title: 'Merged just after', at: '2026-10-20T00:00:01Z' });
    assert.ok(merged.every((m, i) => i === 0 || merged[i - 1]!.at <= m.at), 'oldest first');
    assert.equal(calls.length, 2, 'a page whose last PR predates the window ends the read');
    const query = new URL(calls[0]!.url).searchParams;
    assert.deepEqual([query.get('state'), query.get('base'), query.get('sort'), query.get('direction')], ['closed', 'trunk', 'updated', 'desc']);
  });

  test('issuesOpenedSince lists the issues opened after a time, PRs dropped, oldest first, reading newest created first until they predate it', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues': [
        { number: 9, title: 'Newest', created_at: '2026-10-22T00:00:00Z' },
        { number: 8, title: 'A PR', created_at: '2026-10-21T00:00:00Z', pull_request: {} },
        { number: 7, title: 'Older', created_at: '2026-10-21T00:00:00Z' },
        { number: 6, title: 'Before', created_at: '2026-10-19T00:00:00Z' },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.issuesOpenedSince(SINCE), [
      { number: 7, title: 'Older', at: '2026-10-21T00:00:00Z' },
      { number: 9, title: 'Newest', at: '2026-10-22T00:00:00Z' },
    ]);
    const query = new URL(calls[0]!.url).searchParams;
    assert.deepEqual([query.get('state'), query.get('sort'), query.get('direction')], ['all', 'created', 'desc']);
  });

  test('issuesClosedSince lists the issues closed after a time, PRs and earlier closes dropped, oldest first', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues': [
        { number: 9, title: 'Closed late', closed_at: '2026-10-23T00:00:00Z' },
        { number: 8, title: 'A PR', closed_at: '2026-10-22T00:00:00Z', pull_request: {} },
        { number: 7, title: 'Closed before, commented after', closed_at: '2026-10-10T00:00:00Z' },
        { number: 6, title: 'Closed early', closed_at: '2026-10-21T00:00:00Z' },
      ],
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.issuesClosedSince(SINCE), [
      { number: 6, title: 'Closed early', at: '2026-10-21T00:00:00Z' },
      { number: 9, title: 'Closed late', at: '2026-10-23T00:00:00Z' },
    ]);
    const query = new URL(calls[0]!.url).searchParams;
    assert.deepEqual([query.get('state'), query.get('since')], ['closed', SINCE]);
  });

  test('branchHead reads the commit a branch is at', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/git/ref/heads/main': { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40), type: 'commit' } },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.equal(await reader.branchHead('main'), 'a'.repeat(40));
  });

  test('branchHead refuses a ref that names no commit, rather than answer an empty id', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/git/ref/heads/main': { ref: 'refs/heads/main', object: {} },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    await assert.rejects(reader.branchHead('main'), /main/);
  });

  test('ticket reads an issue\'s title, body, state and label names', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/12': { number: 12, title: 'T', body: null, state: 'open', labels: [{ name: 'mode: afk' }, 'type: nfr'] },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.deepEqual(await reader.ticket(12), { number: 12, title: 'T', body: '', state: 'open', labels: ['mode: afk', 'type: nfr'], pull: false });
  });

  // A fire naming issues reads each on its own and orders them oldest first.
  test('ticket carries its creation time, where the issue has one', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/12': { number: 12, title: 'T', body: '', state: 'open', labels: [], created_at: '2026-09-12T00:00:00Z' },
    });
    assert.equal((await githubReader({ token: 't', repo: 'acme/factory', fetch }).ticket(12)).created_at, '2026-09-12T00:00:00Z');
  });

  test('ticket carries its open blocker count from its dependency summary, where it has one', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/12': { number: 12, title: 'T', body: '', state: 'open', labels: [], issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 2 } },
    });
    assert.equal((await githubReader({ token: 't', repo: 'acme/factory', fetch }).ticket(12)).openBlockers, 1);
  });

  test('allComments pages through a whole thread, each marked with whether the reader\'s own App posted it', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/10/comments': (_init: RequestInit | undefined, url: string) => {
        const page = Number(new URL(url).searchParams.get('page'));
        return page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'b', created_at: 'c', user: { type: 'User', login: 'p' }, performed_via_github_app: null }))
          : [
            { id: 998, body: 'other', created_at: 'd', user: { type: 'Bot', login: 'github-actions[bot]' }, performed_via_github_app: { id: 15368 } },
            // A person acting through the App with a user access token: still a person's comment.
            { id: 997, body: 'person', created_at: 'd', user: { type: 'User', login: 'p' }, performed_via_github_app: { id: 5075844 } },
            { id: 999, body: 'last', created_at: 'd', user: { type: 'Bot', login: 'governor-app[bot]' }, performed_via_github_app: { id: 5075844 } },
          ];
      },
    });
    const reader = githubReader({ token: 't', repo: 'acme/factory', appId: 5075844, fetch });
    const rows = await reader.allComments(10);
    assert.equal(rows.length, 103);
    assert.deepEqual(rows.at(-1), { id: 999, body: 'last', created_at: 'd', ours: true });
    assert.deepEqual(rows.map((r) => r.ours).filter(Boolean).length, 1);
    assert.equal(calls.length, 2);
    // A reader that does not know its App trusts no comment.
    const blind = githubReader({ token: 't', repo: 'acme/factory', fetch });
    assert.equal((await blind.allComments(10)).some((r) => r.ours), false);
  });

  test('updateComment patches a comment\'s body by its id', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/issues/comments/55': (init: RequestInit | undefined) => {
        assert.equal(init?.method, 'PATCH');
        assert.deepEqual(JSON.parse(String(init?.body)), { body: 'new' });
        return { id: 55 };
      },
    });
    await githubReader({ token: 't', repo: 'acme/factory', fetch }).updateComment(55, 'new');
    assert.equal(calls.length, 1);
  });

  test('merge puts a merge commit, pinned to the head the review read', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls/10/merge': (init: RequestInit | undefined) => {
        assert.equal(init?.method, 'PUT');
        assert.deepEqual(JSON.parse(String(init?.body)), { merge_method: 'merge', sha: 'h' });
        return { merged: true, sha: 'm' };
      },
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 'acme/factory', fetch }).merge(10, { sha: 'h' }), { merged: true, sha: 'm' });
    assert.equal(calls.length, 1);
  });

  test('a merge the App may not make is refused out loud, with GitHub\'s reason', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/pulls/10/merge': new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403, statusText: 'Forbidden' }),
    });
    await assert.rejects(githubReader({ token: 't', repo: 'acme/factory', fetch }).merge(10, { sha: 'h' }), /403.*not accessible/);
  });

  test('workflowRuns takes a workflow id', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/actions/workflows/77/runs': { total_count: 0, workflow_runs: [] },
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 'acme/factory', fetch }).workflowRuns('77', {}), []);
    assert.equal(calls.length, 1);
  });
});

describe('githubApi', () => {
  test('calls the path under the API host as the token, and parses the answer', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/acme/factory/hooks': (init: RequestInit | undefined) =>
        init?.method === 'POST' ? { id: 9, ...JSON.parse(String(init.body)) } : [{ id: 1 }],
    });
    const api = githubApi({ token: 'ghs_t', fetch });
    assert.deepEqual(await api('GET', '/repos/acme/factory/hooks'), [{ id: 1 }]);
    assert.deepEqual(await api('POST', '/repos/acme/factory/hooks', { name: 'web' }), { id: 9, name: 'web' });
    assert.equal(new Headers(calls[0]!.init?.headers).get('authorization'), 'Bearer ghs_t');
    assert.equal(calls[1]?.init?.method, 'POST');
  });

  // A 403 from an App without the Webhooks permission says so only in the
  // body; the status alone reads as any other refusal.
  test('a refusal carries the API\'s message beside the status', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/acme/factory/hooks': new Response(
        '{"message":"Resource not accessible by integration"}',
        { status: 403, statusText: 'Forbidden' },
      ),
    });
    const api = githubApi({ token: 't', fetch });
    await assert.rejects(api('POST', '/repos/acme/factory/hooks', {}), /403.*Resource not accessible by integration/);
  });
  // A dropped connection throws `TypeError: fetch failed` before any answer:
  // one under the review's promotion read failed a dispatcher turn in dev.
  // A GET is safe to send again; a write may have landed, so it is not.
  test('a GET whose connection drops is sent again, after a pause, until one answers', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return new Response('[{"id":1}]', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const waits: number[] = [];
    const api = githubApi({ token: 't', fetch, sleep: async (ms: number) => { waits.push(ms); } });
    assert.deepEqual(await api('GET', '/repos/acme/factory/hooks'), [{ id: 1 }]);
    assert.equal(calls, 3);
    assert.equal(waits.length, 2);
    assert.ok(waits[0]! > 0 && waits[1]! > waits[0]!, `each pause is longer than the last: ${waits}`);
  });

  // fetch resolves on the headers: a connection that drops mid-body throws
  // from the read (`TypeError: terminated`), after the answer began.
  test('a GET whose connection drops while its body is read is sent again', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream({ start: (c) => { c.error(new TypeError('terminated')); } }), { status: 200 });
      }
      return new Response('[{"id":1}]', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = githubApi({ token: 't', fetch, sleep: async () => {} });
    assert.deepEqual(await api('GET', '/repos/acme/factory/hooks'), [{ id: 1 }]);
    assert.equal(calls, 2);
  });

  test('a GET named in lower case is a GET: a dropped one is sent again', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls < 2) throw new TypeError('fetch failed');
      return new Response('[]', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = githubApi({ token: 't', fetch, sleep: async () => {} });
    assert.deepEqual(await api('get', '/repos/acme/factory/hooks'), []);
    assert.equal(calls, 2);
  });

  test('a GET whose connection keeps dropping gives up with the transport error', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const api = githubApi({ token: 't', fetch, sleep: async () => {} });
    await assert.rejects(api('GET', '/repos/acme/factory/hooks'), /fetch failed/);
    assert.equal(calls, 3);
  });

  test('a write whose connection drops is not sent again', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const api = githubApi({ token: 't', fetch, sleep: async () => {} });
    await assert.rejects(api('POST', '/repos/acme/factory/hooks', {}), /fetch failed/);
    assert.equal(calls, 1);
  });

  // GitHub words a rate limit several ways ("API rate limit exceeded",
  // "secondary rate limit", none at all on a 429); the status and headers
  // say it, and a secondary limit's body where they do not.
  test('a refusal says whether it is a rate limit, so a caller never reads the text', async () => {
    const refusal = async (response: Response) => {
      const api = githubApi({ token: 't', fetch: (async () => response) as unknown as typeof globalThis.fetch });
      return api('GET', '/repos/acme/factory/hooks').then(() => assert.fail('no refusal'), (e: { rateLimited?: unknown }) => e.rateLimited);
    };
    const forbidden = (headers: Record<string, string>) => new Response('{"message":"Access restricted"}', { status: 403, statusText: 'Forbidden', headers });
    assert.equal(await refusal(new Response('', { status: 429, statusText: 'Too Many Requests' })), true, 'a 429');
    assert.equal(await refusal(forbidden({ 'x-ratelimit-remaining': '0' })), true, 'a 403 with the primary limit spent');
    assert.equal(await refusal(forbidden({ 'retry-after': '60' })), true, 'a 403 with a secondary limit\'s retry-after');
    // GitHub sends a secondary limit with neither header at times: its body says so.
    const secondary = new Response('{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}', { status: 403, statusText: 'Forbidden', headers: { 'x-ratelimit-remaining': '4999' } });
    assert.equal(await refusal(secondary), true, 'a 403 whose body names a secondary limit, with no retry-after');
    assert.equal(await refusal(forbidden({ 'x-ratelimit-remaining': '4999' })), false, 'a 403 with calls to spare');
    assert.equal(await refusal(new Response('{"message":"API rate limit exceeded"}', { status: 502, statusText: 'Bad Gateway' })), false, 'a 502, whatever it says');
  });

  // A private repo on GitHub's free plan lacks some features (rulesets); the
  // 403's body is the one place GitHub says so.
  test('a refusal says whether the repo\'s plan lacks the feature, so a caller never reads the text', async () => {
    const refusal = async (response: Response) => {
      const api = githubApi({ token: 't', fetch: (async () => response) as unknown as typeof globalThis.fetch });
      return api('GET', '/repos/acme/factory/rules/branches/main').then(() => assert.fail('no refusal'), (e: { planLimited?: unknown }) => e.planLimited);
    };
    const answer = (status: number, message: string) => new Response(JSON.stringify({ message }), { status, statusText: 'Refused' });
    assert.equal(await refusal(answer(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.')), true, 'a 403 naming the plan');
    assert.equal(await refusal(answer(403, 'Upgrade to GitHub Team to enable this feature.')), true, 'a 403 naming another plan');
    assert.equal(await refusal(answer(403, 'Resource not accessible by integration')), false, 'a 403 for a permission the App lacks');
    assert.equal(await refusal(answer(404, 'Upgrade to GitHub Pro or make this repository public to enable this feature.')), false, 'a 404, whatever it says');
  });

  test('a refusal is an answer, not a dropped connection: it is not sent again', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response('{}', { status: 502, statusText: 'Bad Gateway' });
    }) as unknown as typeof globalThis.fetch;
    const api = githubApi({ token: 't', fetch, sleep: async () => {} });
    await assert.rejects(api('GET', '/repos/acme/factory/hooks'), /502/);
    assert.equal(calls, 1);
  });

  test('the reader and the token mint resend a dropped call', async () => {
    const { fetch: answer } = fakeFetch({
      'https://api.github.com/repos/acme/factory/actions/workflows/deliver.yml/runs': { workflow_runs: [] },
      'https://api.github.com/repos/acme/factory/installation': { id: 7 },
      'https://api.github.com/app/installations/7/access_tokens': { token: 'ghs_x' },
    });
    // Each call's first send drops, the mint's POST included: a second
    // token minted is harmless, so the mint is resent like a read.
    const dropped = new Set<string>();
    const fetch = (async (url: string, init?: RequestInit) => {
      if (!dropped.has(url)) {
        dropped.add(url);
        throw new TypeError('fetch failed');
      }
      return answer(url, init);
    }) as unknown as typeof globalThis.fetch;
    const sleep = async () => {};
    const reader = githubReader({ token: 't', repo: 'acme/factory', fetch, sleep });
    assert.deepEqual(await reader.workflowRuns('deliver.yml', {}), []);
    assert.equal(await installationToken({ appId: '1', privateKeyPem: PEM, repo: 'acme/factory', fetch, sleep }), 'ghs_x');
  });
});

describe('a served repo\'s reads', () => {
  test('readyIssues asks for every ready label the repo names', async () => {
    const { fetch, calls } = fakeFetch({ 'https://api.github.com/repos/t-d-d/askme-mcp/issues': [] });
    await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).readyIssues(['mode: afk', 'ready']);
    assert.equal(new URL(calls[0]!.url).searchParams.get('labels'), 'mode: afk,ready');
  });

  test('configFile reads the file off the default branch; GitHub\'s 404 is no file, any other refusal throws', async () => {
    const path = 'https://api.github.com/repos/t-d-d/askme-mcp/contents/.github/dispatch.json';
    const text = '{"environment":"env_1"}';
    const { fetch, calls } = fakeFetch({ [path]: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } });
    assert.equal(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).configFile(), text);
    assert.equal(calls[0]!.url, path, 'no ref: the default branch, never a PR head');
    const none = fakeFetch({});
    assert.equal(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch: none.fetch }).configFile(), null);
    const broken = fakeFetch({ [path]: new Response('{"message":"boom"}', { status: 502, statusText: 'Bad Gateway' }) });
    await assert.rejects(githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch: broken.fetch, sleep: async () => {} }).configFile(), /502/);
  });

  test('configFile reads a prompt file beside the config file, off the default branch too', async () => {
    const path = 'https://api.github.com/repos/t-d-d/askme-mcp/contents/docs/my%20review.md';
    const { fetch, calls } = fakeFetch({ [path]: { type: 'file', encoding: 'base64', content: Buffer.from('# Review').toString('base64') } });
    assert.equal(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).configFile('docs/my review.md'), '# Review');
    assert.equal(calls[0]!.url, path);
    assert.equal(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch: fakeFetch({}).fetch }).configFile('docs/none.md'), null);
  });

  test('defaultBranch reads the repo\'s; one naming none throws', async () => {
    const { fetch } = fakeFetch({ 'https://api.github.com/repos/t-d-d/askme-mcp': { default_branch: 'trunk' } });
    assert.equal(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).defaultBranch(), 'trunk');
    const none = fakeFetch({ 'https://api.github.com/repos/t-d-d/askme-mcp': {} });
    await assert.rejects(githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch: none.fetch }).defaultBranch(), /default branch/);
  });

  test('requiredChecks reads the branch protection\'s and the rulesets\' required checks, once each', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/t-d-d/askme-mcp/branches/trunk': { protection: { required_status_checks: { contexts: ['gate', 'lint'], checks: [{ context: 'gate' }] } } },
      'https://api.github.com/repos/t-d-d/askme-mcp/rules/branches/trunk': [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'e2e' }, { context: 'lint' }] } }],
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).requiredChecks('trunk'), ['gate', 'lint', 'e2e']);
    const bare = fakeFetch({ 'https://api.github.com/repos/t-d-d/askme-mcp/branches/trunk': { protected: false }, 'https://api.github.com/repos/t-d-d/askme-mcp/rules/branches/trunk': [] });
    assert.deepEqual(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch: bare.fetch }).requiredChecks('trunk'), []);
  });

  test('requiredChecks reads a plan without rulesets as no ruleset checks; any other refusal still throws', async () => {
    const refused = (message: string) => new Response(JSON.stringify({ message }), { status: 403, statusText: 'Forbidden' });
    const unplanned = fakeFetch({
      'https://api.github.com/repos/t-d-d/askme-mcp/branches/trunk': { protected: false },
      'https://api.github.com/repos/t-d-d/askme-mcp/rules/branches/trunk': () => refused('Upgrade to GitHub Pro or make this repository public to enable this feature.'),
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch: unplanned.fetch }).requiredChecks('trunk'), []);
    const denied = fakeFetch({
      'https://api.github.com/repos/t-d-d/askme-mcp/branches/trunk': { protected: false },
      'https://api.github.com/repos/t-d-d/askme-mcp/rules/branches/trunk': () => refused('Resource not accessible by integration'),
    });
    await assert.rejects(githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch: denied.fetch }).requiredChecks('trunk'), /403/);
  });

  test('requiredChecks reads every page of the rulesets\' rules: a required check past the first page still counts', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/t-d-d/askme-mcp/branches/trunk': { protected: false },
      'https://api.github.com/repos/t-d-d/askme-mcp/rules/branches/trunk': (_init: RequestInit | undefined, url: string) => {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        const size = Number(new URL(url).searchParams.get('per_page') ?? '30');
        const rules = [...Array.from({ length: 120 }, () => ({ type: 'pull_request' })), { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'gate' }] } }];
        return rules.slice((page - 1) * size, page * size);
      },
    });
    assert.deepEqual(await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).requiredChecks('trunk'), ['gate']);
  });

  test('checksAt reads each latest check run and status at the commit, red where it ended in a way that blocks a merge', async () => {
    const sha = 'a'.repeat(40);
    const { fetch, calls } = fakeFetch({
      [`https://api.github.com/repos/t-d-d/askme-mcp/commits/${sha}/check-runs`]: { check_runs: [
        { name: 'gate', conclusion: 'failure' }, { name: 'lint', conclusion: 'success' }, { name: 'slow', conclusion: null }, { name: 'timed', conclusion: 'timed_out' }, { name: 'skip', conclusion: 'skipped' },
      ] },
      [`https://api.github.com/repos/t-d-d/askme-mcp/commits/${sha}/status`]: { statuses: [{ context: 'ci/legacy', state: 'error' }, { context: 'ci/ok', state: 'success' }, { context: 'ci/wait', state: 'pending' }] },
    });
    const checks = await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).checksAt(sha);
    assert.deepEqual(checks.filter((c) => c.state === 'red').map((c) => c.name), ['gate', 'timed', 'ci/legacy']);
    assert.deepEqual(checks.filter((c) => c.state === 'pending').map((c) => c.name), ['slow', 'ci/wait']);
    assert.equal(new URL(calls[0]!.url).searchParams.get('filter'), 'latest');
  });

  test('pullReviews lists each review with whether a bot wrote it; dismissReview dismisses one with a message', async () => {
    const dismissed: unknown[] = [];
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/t-d-d/askme-mcp/pulls/7/reviews': [{ id: 1, state: 'APPROVED', body: 'ok', user: { type: 'Bot' } }, { id: 2, state: 'COMMENTED', body: null, user: { type: 'User' } }],
      'https://api.github.com/repos/t-d-d/askme-mcp/pulls/7/reviews/1/dismissals': (init: RequestInit | undefined) => { dismissed.push({ method: init?.method, body: JSON.parse(String(init?.body)) }); return {}; },
    });
    const reader = githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch });
    assert.deepEqual(await reader.pullReviews(7), [{ id: 1, state: 'APPROVED', body: 'ok', bot: true }, { id: 2, state: 'COMMENTED', body: '', bot: false }]);
    await reader.dismissReview(7, 1, 'A later head fails.');
    assert.deepEqual(dismissed, [{ method: 'PUT', body: { message: 'A later head fails.', event: 'DISMISS' } }]);
  });

  test('approve posts an approving review pinned to the head reviewed', async () => {
    const posted: unknown[] = [];
    const { fetch } = fakeFetch({ 'https://api.github.com/repos/t-d-d/askme-mcp/pulls/7/reviews': (init: RequestInit | undefined) => { posted.push({ method: init?.method, body: JSON.parse(String(init?.body)) }); return { id: 1 }; } });
    await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).approve(7, { sha: 'b'.repeat(40), body: 'Passes.' });
    assert.deepEqual(posted, [{ method: 'POST', body: { commit_id: 'b'.repeat(40), event: 'APPROVE', body: 'Passes.' } }]);
  });

  test('ensureLabel creates a label the repo lacks, and leaves one it has', async () => {
    const created: unknown[] = [];
    const { fetch } = fakeFetch({
      'https://api.github.com/repos/t-d-d/askme-mcp/labels/claimed': new Response('{}', { status: 404, statusText: 'Not Found' }),
      'https://api.github.com/repos/t-d-d/askme-mcp/labels': (init: RequestInit | undefined) => { created.push(JSON.parse(String(init?.body))); return { name: 'claimed' }; },
      'https://api.github.com/repos/acme/factory/labels/workflow%3A%20under%20development': { name: 'workflow: under development' },
    });
    await githubReader({ token: 't', repo: 't-d-d/askme-mcp', fetch }).ensureLabel('claimed');
    assert.equal((created[0] as { name: string }).name, 'claimed');
    created.length = 0;
    await githubReader({ token: 't', repo: 'acme/factory', fetch }).ensureLabel('workflow: under development');
    assert.deepEqual(created, []);
  });
});

describe('appInstallations', () => {
  test('lists each installation\'s account and the repos it was granted', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/app/installations': [{ id: 1, account: { login: 'acme' } }, { id: 2, account: { login: 't-d-d' } }],
      'https://api.github.com/app/installations/1/access_tokens': { token: 'ghs_1' },
      'https://api.github.com/app/installations/2/access_tokens': { token: 'ghs_2' },
      'https://api.github.com/installation/repositories': (init: RequestInit | undefined) => ({
        repositories: (init?.headers as Record<string, string>).authorization === 'Bearer ghs_1'
          ? [{ full_name: 'acme/factory' }]
          : [{ full_name: 't-d-d/askme-mcp' }, { full_name: 't-d-d/tagalong' }],
      }),
    });
    const listed = await appInstallations({ appId: '1', privateKeyPem: PEM, fetch, owners: ['acme', 't-d-d'] });
    assert.deepEqual(listed, [
      { account: 'acme', repos: ['acme/factory'] },
      { account: 't-d-d', repos: ['t-d-d/askme-mcp', 't-d-d/tagalong'] },
    ]);
    assert.ok(calls.some((c) => c.url.startsWith('https://api.github.com/app/installations?')));
  });

  test('an unlisted owner\'s installation gets no token and no repo read', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/app/installations': [{ id: 3, account: { login: 'stranger' } }],
    });
    assert.deepEqual(await appInstallations({ appId: '1', privateKeyPem: PEM, fetch, owners: ['acme'] }), [{ account: 'stranger', repos: [] }]);
    assert.ok(!calls.some((c) => c.url.includes('access_tokens') || c.url.includes('/installation/repositories')));
  });

  test('a suspended installation on a listed owner is listed with no repos and mints no token', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/app/installations': [
        { id: 1, account: { login: 'acme' } },
        { id: 2, account: { login: 't-d-d' }, suspended_at: '2026-10-01T00:00:00Z' },
      ],
      'https://api.github.com/app/installations/1/access_tokens': { token: 'ghs_1' },
      'https://api.github.com/app/installations/2/access_tokens': new Response('{}', { status: 403, statusText: 'Forbidden' }),
      'https://api.github.com/installation/repositories': { repositories: [{ full_name: 'acme/factory' }] },
    });
    assert.deepEqual(await appInstallations({ appId: '1', privateKeyPem: PEM, fetch, owners: ['acme', 't-d-d'] }), [
      { account: 'acme', repos: ['acme/factory'] },
      { account: 't-d-d', repos: [] },
    ]);
    assert.ok(!calls.some((c) => c.url.includes('/installations/2/')));
  });

  test('a listing GitHub refuses throws', async () => {
    const { fetch } = fakeFetch({ 'https://api.github.com/app/installations': new Response('{}', { status: 401, statusText: 'Unauthorized' }) });
    await assert.rejects(appInstallations({ appId: '1', privateKeyPem: PEM, fetch, owners: ['acme'] }), /401/);
  });
});
