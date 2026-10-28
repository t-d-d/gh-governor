/**
 * Finding a session by the branch it has checked out: the owner of a
 * PR whose body names no session. The sessions API is injected; its rows are
 * shaped as the CLI reads them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { branchFinder, MAX_PAGES, reposOf, sessionRecord } from '../scripts/lib/session-branch.mjs';

const BRANCH = 'claude/lessons-learned-signoff-ad8b07';
const REPO = 'acme/factory';
const at = (minutesAgo: number) => new Date(Date.parse('2026-09-27T16:00:00Z') - minutesAgo * 60_000).toISOString();

const api = (rows: unknown, details: Record<string, unknown> = {}) => {
  const asked: string[] = [];
  return {
    asked,
    sessions: {
      list: async () => { asked.push('list'); return rows; },
      get: async (id: string) => {
        asked.push(`get ${id}`);
        if (!(id in details)) return null;
        const detail = details[id];
        if (detail instanceof Error) throw detail;
        return detail;
      },
    },
  };
};

describe('branchFinder', () => {
  test('reads the branch off a list row where the row carries one, in either place', async () => {
    const { sessions, asked } = api({ data: [
      { id: 'cse_01AA', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'remote', updated_at: at(3), external_metadata: { current_branches: { 'acme/factory': 'other' } } },
      { id: 'cse_01BB', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'remote', updated_at: at(4), session_context: { outcomes: [{ git_repository: { git_info: { repo: 'acme/factory', branches: [BRANCH] } } }] } },
    ] });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), 'https://claude.ai/code/session_01BB');
    assert.deepEqual(asked, ['list'], 'no row needed fetching');
  });

  test('fetches a local row that carries no branch, and no cloud one', async () => {
    const { sessions, asked } = api({ data: [
      { id: 'cse_01CLOUD', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'remote', updated_at: at(1) },
      { id: 'cse_01LOCAL', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(2) },
    ] }, { cse_01LOCAL: { id: 'cse_01LOCAL', session_status: 'SESSION_STATUS_IDLE', external_metadata: { current_branches: { 'acme/factory': BRANCH } } } });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), 'https://claude.ai/code/session_01LOCAL');
    assert.deepEqual(asked, ['list', 'get cse_01LOCAL']);
  });

  test('takes the most recently updated of several on the branch', async () => {
    const { sessions } = api({ data: [
      { id: 'session_01OLD', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(30), external_metadata: { current_branches: { 'acme/factory': BRANCH } } },
      { id: 'session_01NEW', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(1), external_metadata: { current_branches: { 'acme/factory': BRANCH } } },
    ] });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), 'https://claude.ai/code/session_01NEW');
  });

  test('passes over an archived session, in its list row or its own record', async () => {
    const { sessions } = api({ data: [
      { id: 'cse_01GONE', session_status: 'SESSION_STATUS_ARCHIVED', environment_kind: 'bridge', updated_at: at(1), external_metadata: { current_branches: { 'acme/factory': BRANCH } } },
      { id: 'cse_01QUIT', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(2) },
    ] }, { cse_01QUIT: { id: 'cse_01QUIT', session_status: 'SESSION_STATUS_ARCHIVED', external_metadata: { current_branches: { 'acme/factory': BRANCH } } } });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), null);
  });

  test('bridgeOnly: a cloud session on the branch is not the one', async () => {
    const { sessions } = api({ data: [
      { id: 'cse_01CLOUD', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'remote', updated_at: at(1), external_metadata: { current_branches: { 'acme/factory': BRANCH } } },
      { id: 'cse_01LOCAL', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(2), external_metadata: { current_branches: { 'acme/factory': BRANCH } } },
    ] });
    const find = branchFinder(sessions, REPO);
    assert.equal(await find(BRANCH, { bridgeOnly: true }), 'https://claude.ai/code/session_01LOCAL');
    assert.equal(await find(BRANCH), 'https://claude.ai/code/session_01CLOUD');
  });

  test('a record the API does not have holds no branch; a row with an id it cannot read is passed over', async () => {
    const { sessions } = api({ data: [
      { id: '../x', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(1), external_metadata: { current_branches: { 'acme/factory': BRANCH } } },
      { id: 'cse_01MISSING', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(2) },
    ] });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), null);
  });

  test('a record read that fails is an error, not a session holding no branch', async () => {
    const { sessions } = api({ data: [
      { id: 'cse_01LOCAL', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(2) },
    ] }, { cse_01LOCAL: new Error('GET /v1/code/sessions/cse_01LOCAL: 503') });
    await assert.rejects(branchFinder(sessions, REPO)(BRANCH), /503/);
  });

  // The row the API listed for a local session on 2026-09-27,
  // cut to the fields the finder reads and the ones beside them.
  test('finds the local session in a row as the API lists it', async () => {
    const live = {
      id: 'session_01LOCALA',
      title: 'operators-macbook-pro-641-local-velvet-hummingbird',
      session_status: 'SESSION_STATUS_IDLE',
      created_at: '2026-09-27T18:08:58.680899Z',
      updated_at: '2026-09-27T18:10:08.403869Z',
      session_context: {
        sources: [{ git_repository: { url: 'https://github.com/acme/factory', revision: 'claude/test-4501-dispatcher-3b4a95' } }],
        outcomes: [{ git_repository: { git_info: { repo: 'acme/factory', branches: ['test/865-local-session'] } } }],
      },
      origin: 'claude_code_cli',
      connection_status: 'connected',
      external_metadata: { current_branches: { 'acme/factory': 'test/865-local-session' } },
      environment_kind: 'bridge',
      status_bucket: 'SESSION_STATUS_BUCKET_REVIEW_READY',
    };
    const cloud = {
      id: 'session_01LOCALB',
      session_status: 'SESSION_STATUS_IDLE',
      updated_at: '2026-09-27T18:34:05.553338Z',
      session_context: { outcomes: [{ git_repository: { git_info: { repo: 'acme/factory', branches: ['claude/dispatcher-session-archive-qa-qn2kqz'] } } }] },
      external_metadata: { current_branches: { '': 'claude/dispatcher-session-archive-qa-qn2kqz' } },
      environment_kind: 'anthropic_cloud',
    };
    const { sessions, asked } = api({ data: [cloud, live], has_more: true });
    const find = branchFinder(sessions, REPO);
    assert.equal(await find('test/865-local-session', { bridgeOnly: true }), 'https://claude.ai/code/session_01LOCALA');
    assert.equal(await find('claude/dispatcher-session-archive-qa-qn2kqz'), 'https://claude.ai/code/session_01LOCALB', 'a cloud row keys its branch by ""');
    assert.deepEqual(asked, ['list'], 'the branch is on the row');
  });

  test('a branch another repository\'s session holds is not this one\'s', async () => {
    const { sessions } = api({ data: [
      { id: 'cse_01ELSEWHERE', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(1), external_metadata: { current_branches: { 'someone/else': 'main' } }, session_context: { outcomes: [{ git_repository: { git_info: { repo: 'someone/else', branches: ['main'] } } }] } },
    ] });
    assert.equal(await branchFinder(sessions, REPO)('main'), null);
  });

  test('a local row holding only another repository\'s branch is not fetched', async () => {
    const { sessions, asked } = api({ data: [
      { id: 'cse_01ELSEWHERE', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(1), external_metadata: { current_branches: { 'someone/else': BRANCH } } },
    ] }, { cse_01ELSEWHERE: new Error('GET /v1/code/sessions/cse_01ELSEWHERE: 503') });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), null);
    assert.deepEqual(asked, ['list'], 'its branch is known, and is not this repository\'s');
  });

  test('a cloud row\'s "" branch is not this one\'s when its outcomes name another repository', async () => {
    const { sessions } = api({ data: [
      { id: 'cse_01CLOUD', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'anthropic_cloud', updated_at: at(1), external_metadata: { current_branches: { '': BRANCH } }, session_context: { outcomes: [{ git_repository: { git_info: { repo: 'someone/else', branches: [BRANCH] } } }] } },
    ] });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), null);
  });

  test('a status that merely ends in ARCHIVED is not archived', async () => {
    const { sessions } = api({ data: [
      { id: 'cse_01BACK', session_status: 'SESSION_STATUS_UNARCHIVED', environment_kind: 'bridge', updated_at: at(1), external_metadata: { current_branches: { 'acme/factory': BRANCH } } },
    ] });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), 'https://claude.ai/code/session_01BACK');
  });

  test('reads the list once, and each record once, however many branches are asked about', async () => {
    const { sessions, asked } = api({ data: [
      { id: 'cse_01LOCAL', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(2) },
    ] }, { cse_01LOCAL: { id: 'cse_01LOCAL', external_metadata: { current_branches: { 'acme/factory': BRANCH } } } });
    const find = branchFinder(sessions, REPO);
    assert.equal(await find('other'), null);
    assert.equal(await find(BRANCH), 'https://claude.ai/code/session_01LOCAL');
    assert.deepEqual(asked, ['list', 'get cse_01LOCAL']);
  });

  test('a list that is not a list of sessions is an error, not an empty answer', async () => {
    await assert.rejects(branchFinder(api({ error: { type: 'authentication_error' } }).sessions, REPO)(BRANCH), /sessions/);
    const { sessions } = api(async () => { throw new Error('401'); });
    sessions.list = async () => { throw new Error('GET /v1/code/sessions: 401'); };
    await assert.rejects(branchFinder(sessions, REPO)(BRANCH), /401/);
  });

  // The list pages as the CLI pages it: `has_more`, then `after_id` set to
  // the page's `last_id`.
  const paged = (pages: Array<Array<Record<string, unknown>>>) => {
    const asked: Array<string | undefined> = [];
    return {
      asked,
      sessions: {
        list: async (after?: string) => {
          asked.push(after);
          const i = after === undefined ? 0 : Number(after.replace('cse_page', ''));
          const data = pages[i] ?? [];
          return { data, has_more: i + 1 < pages.length, last_id: `cse_page${i + 1}` };
        },
        get: async () => null,
      },
    };
  };
  const row = (id: string, branch: string, over: Record<string, unknown> = {}) => ({
    id, session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(1), created_at: at(60),
    external_metadata: { current_branches: { 'acme/factory': branch } }, ...over,
  });

  test('reads every page of the list: a session pushed off the newest page is still found', async () => {
    const newest = Array.from({ length: 3 }, (_, i) => row(`cse_01CLOUD${i}`, `claude/other-${i}`, { environment_kind: 'anthropic_cloud' }));
    const { sessions, asked } = paged([newest, [row('cse_01LOCAL', BRANCH)]]);
    assert.equal(await branchFinder(sessions, REPO)(BRANCH, { bridgeOnly: true }), 'https://claude.ai/code/session_01LOCAL');
    assert.deepEqual(asked, [undefined, 'cse_page1']);
  });

  test('a list longer than the bound is read to the bound, and the log says it was cut', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => [row(`cse_01P${i}`, `claude/p-${i}`)]);
    const { sessions, asked } = paged(pages);
    const logged: Array<Record<string, unknown>> = [];
    const find = branchFinder(sessions, REPO, { log: (event, context) => logged.push({ event, ...context }) });
    assert.equal(await find('claude/p-29'), null);
    assert.equal(asked.length, MAX_PAGES);
    assert.ok(MAX_PAGES <= 5, 'each page may take the request timeout, inside a sweep that has minutes left');
    assert.ok(logged.some((l) => l.event === 'dispatch-sessions' && l.truncated === true), JSON.stringify(logged));
  });

  test('a cursor that does not move ends the read', async () => {
    const asked: Array<string | undefined> = [];
    const sessions = {
      list: async (after?: string) => { asked.push(after); return { data: [row('cse_01LOCAL', BRANCH)], has_more: true, last_id: 'cse_01LOCAL' }; },
      get: async () => null,
    };
    assert.equal(await branchFinder(sessions, REPO)(BRANCH, { bridgeOnly: true }), 'https://claude.ai/code/session_01LOCAL');
    assert.deepEqual(asked, [undefined, 'cse_01LOCAL']);
  });

  test('a session the list gives twice is read as the later page gives it', async () => {
    const { sessions } = paged([
      [row('cse_01LOCAL', BRANCH)],
      [row('cse_01LOCAL', BRANCH, { session_status: 'SESSION_STATUS_ARCHIVED', updated_at: at(1) })],
    ]);
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), null, 'archived between the two page reads');
  });

  test('a read that failed is asked again on the next question, not replayed for the rest of the turn', async () => {
    const one = { id: 'cse_01LOCAL', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(2) };
    let lists = 0;
    let gets = 0;
    const find = branchFinder({
      list: async () => { lists += 1; if (lists === 1) throw new Error('socket hang up'); return { data: [one] }; },
      get: async () => { gets += 1; if (gets === 1) throw new Error('socket hang up'); return { ...one, external_metadata: { current_branches: { 'acme/factory': BRANCH } } }; },
    }, REPO);
    await assert.rejects(find(BRANCH), /socket hang up/, 'the list read fails');
    await assert.rejects(find(BRANCH), /socket hang up/, 'the record read fails');
    assert.equal(await find(BRANCH), 'https://claude.ai/code/session_01LOCAL');
    assert.deepEqual({ lists, gets }, { lists: 2, gets: 2 });
  });
});

// The deployed sweep logged a record's `response_shape` as text beginning
// `{"client_presence":[],"config":{`: the log prints a string as is
// and an object as JSON, so either answer reads that way.
describe('reposOf', () => {
  // The fields the deployed list and record answer (2026-10-27): no
  // session_context; `config.sources[]` carries `type` and `url`,
  // `config.outcomes[]` `type` and `git_info`.
  test('names the repos a row\'s config sources and outcomes give, lower-cased, each once', () => {
    const row = {
      config: {
        sources: [{ type: 'git_repository', url: 'https://github.com/Acme/Factory', revision: 'main' }, { type: 'git_repository', url: 'https://gitlab.com/a/b' }],
        outcomes: [{ type: 'git_repository', git_info: { repo: 'acme/factory', branches: ['x'] } }, { type: 'git_repository', git_info: { repo: 't-d-d/askme-mcp' } }],
      },
    };
    assert.deepEqual(reposOf(row), ['acme/factory', 't-d-d/askme-mcp']);
    assert.deepEqual(reposOf({ config: { sources: [{ type: 'git_repository', url: 'https://github.com/t-d-d/tagalong.git' }] } }), ['t-d-d/tagalong']);
  });

  test('a row naming no repo names none', () => {
    for (const row of [null, {}, { config: {} }, { config: { sources: 'x', outcomes: [{ git_info: { repo: 'no-slash' } }] } }]) {
      assert.deepEqual(reposOf(row), [], JSON.stringify(row));
    }
  });
});

describe('branchFinder, on the measured row', () => {
  test('finds the session whose config outcomes name the branch, where current_branches does not', async () => {
    const listed = { id: 'cse_01LOCAL', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'bridge', updated_at: at(1), config: { outcomes: [{ type: 'git_repository', git_info: { repo: REPO, branches: [BRANCH] } }] }, external_metadata: {} };
    const { sessions, asked } = api({ data: [listed] });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), 'https://claude.ai/code/session_01LOCAL');
    assert.deepEqual(asked, ['list'], 'the row names a branch: no record read');
  });

  test('a cloud row\'s "" branch is not this one\'s when its config outcomes name another repository', async () => {
    const { sessions } = api({ data: [
      { id: 'cse_01CLOUD', session_status: 'SESSION_STATUS_IDLE', environment_kind: 'anthropic_cloud', updated_at: at(1), external_metadata: { current_branches: { '': BRANCH } }, config: { outcomes: [{ type: 'git_repository', git_info: { repo: 'someone/else', branches: [BRANCH] } }] } },
    ] });
    assert.equal(await branchFinder(sessions, REPO)(BRANCH), null);
  });
});

describe('sessionRecord', () => {
  const session = { id: 'cse_01X', worker_status: 'idle', environment_kind: 'anthropic_cloud' };

  test('unwraps a session sent under response_shape alone, as an object or as JSON text', () => {
    assert.deepEqual(sessionRecord({ response_shape: session }), session);
    assert.deepEqual(sessionRecord({ response_shape: JSON.stringify(session) }), session);
  });

  test('leaves any other answer as it came', () => {
    for (const answer of [
      null,
      undefined,
      session,
      { response_shape: 'secret prompt' },
      { response_shape: '[1,2]' },
      { response_shape: [session] },
      { response_shape: null },
      { response_shape: session, id: 'cse_01X' },
    ]) assert.deepEqual(sessionRecord(answer), answer, JSON.stringify(answer));
  });
});
