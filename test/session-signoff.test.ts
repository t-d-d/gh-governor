import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ARCHIVE_TIMEOUT_MS, SIGNOFF_PAGES, SIGNOFF_WINDOW_MS, awaitReplies, replyDecision, signsOff, sweepSignoffs } from '../scripts/lib/session-signoff.mjs';
import { BRIDGE_REPLY, CLOUD_REPLY, NOT_SIGNED, bridgeAfterRequest, bridgeNotSigned, bridgeSignedOff, cloudSignedOff, cloudSignedOffThenNot, event, pagedHistory, signedOffBehind, stateEvents } from './fixtures/session-events.ts';

describe('signsOff: the sign-off line, as a served repo\'s session writes it', () => {
  test('the reply\'s last non-empty line starts the sign-off, as a person writes it', () => {
    for (const reply of ['Done.\n\nSigning off.', 'Signing off.\n\n', '**Signing off.**', '_Signing off: #967 is closed._', 'Signing off!', 'Signing off', '  `Signing off.`  ']) {
      assert.equal(signsOff(reply), true, JSON.stringify(reply));
    }
  });

  test('anything else does not', () => {
    for (const reply of ['', 'Signing off.\nOne more thing.', 'I\'m not signing off yet.', 'Signing offline work now.', 'signing off.', 'Not Signing off.']) {
      assert.equal(signsOff(reply), false, JSON.stringify(reply));
    }
  });
});

describe('replyDecision: a session\'s sign-off from its own events', () => {
  test('a cloud session whose last result ends with the sign-off line reads as signed off', () => {
    assert.deepEqual(replyDecision(cloudSignedOff), { signedOff: true });
  });

  test('a Remote Control session whose empty result follows an assistant message ending with it reads as signed off', () => {
    assert.deepEqual(replyDecision(bridgeSignedOff), { signedOff: true });
  });

  test('the last reply decides: a newer one without the line, cloud or Remote Control, is not signed off', () => {
    assert.deepEqual(replyDecision(cloudSignedOffThenNot), { signedOff: false });
    assert.deepEqual(replyDecision(bridgeNotSigned), { signedOff: false });
  });

  // A prompt the worker has not started on yet: the row can still read idle,
  // and the sign-off before it is no longer the session's last word.
  test('a person\'s prompt newer than the signed-off result withdraws it; trailing hook and control events do not', () => {
    const prompted = { data: [event('user', '2026-10-17T19:35:00Z', { message: { content: 'One more thing, please.', role: 'user' } }), ...cloudSignedOff.data] };
    assert.deepEqual(replyDecision(prompted), { signedOff: false });
    assert.deepEqual(replyDecision(cloudSignedOff), { signedOff: true }, 'a Stop hook and an end_session request after the result');
  });

  test('an answer outside the schema is unreadable, and says where without quoting any text', () => {
    const cases: unknown[] = [
      null,
      'Signing off.',
      { events: [] },
      { data: [event('result', '2026-10-27T09:00:00Z', { result: 42 })] },
      { data: [{ type: 'result', result: 'Signing off.' }] },
      { data: [event('result', '2026-10-27T09:00:01Z', { result: '' }), event('assistant', '2026-10-27T09:00:00Z', { message: { content: 'Signing off.' } })] },
    ];
    for (const answer of cases) {
      const decided = replyDecision(answer);
      assert.ok('unreadable' in decided, JSON.stringify(answer));
      assert.doesNotMatch(decided.unreadable, /Signing off/, JSON.stringify(decided));
    }
  });

  // Newest first: the page is read from its start, whatever the timestamps.
  test('the page is read newest first, so events sharing a created_at keep their order', () => {
    const at = '2026-10-24T08:50:36Z';
    const decided = replyDecision({ data: [event('result', at, { result: '' }), event('assistant', at, { message: { content: [{ type: 'text', text: 'Signing off.' }] } }), event('assistant', at, { message: { content: [{ type: 'text', text: 'Working.' }] } })] });
    assert.deepEqual(decided, { signedOff: true });
  });

  test('an empty result reads its own turn only: an earlier turn\'s sign-off does not stand for a later turn with no text', () => {
    const turn = (minute: number, text: string | null) => [
      event('result', `2026-10-27T09:0${minute}:01Z`, { result: '' }),
      event('assistant', `2026-10-27T09:0${minute}:00Z`, { message: { content: text === null ? [{ type: 'tool_use', name: 'Bash' }] : [{ type: 'text', text }] } }),
    ];
    const decided = replyDecision({ data: [...turn(2, null), ...turn(1, 'Done.\n\nSigning off.')] });
    assert.ok('unreadable' in decided, JSON.stringify(decided));
  });

  test('a turn that ended with no result (interrupted) is not read into the next turn: the prompt that opened it bounds the reply', () => {
    const decided = replyDecision({
      data: [
        event('result', '2026-10-27T09:05:00Z', { result: '' }),
        event('assistant', '2026-10-27T09:04:00Z', { message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
        event('user', '2026-10-27T09:03:30Z', { message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], role: 'user' } }),
        event('user', '2026-10-27T09:03:00Z', { message: { content: 'Carry on, please.', role: 'user' } }),
        event('assistant', '2026-10-27T09:02:00Z', { message: { content: [{ type: 'text', text: 'Signing off.' }] } }),
      ],
    });
    assert.ok('unreadable' in decided, JSON.stringify(decided));
  });

  test('an error result, which carries no result text, reads the assistant text before it', () => {
    const decided = replyDecision({
      data: [
        event('result', '2026-10-27T09:05:00Z', { subtype: 'error_max_turns', is_error: true }),
        event('assistant', '2026-10-27T09:04:00Z', { message: { content: [{ type: 'text', text: 'Done.\n\nSigning off.' }] } }),
      ],
    });
    assert.deepEqual(decided, { signedOff: true });
  });

  // The deployed read found 100 events and no result: the reason
  // shows what the page holds, so a page of other kinds reads at a glance.
  test('a page with no result says what it holds: each event_type and payload type, and the created_at span, never text', () => {
    const decided = replyDecision({
      data: [
        event('assistant', '2026-10-27T09:00:06Z', { message: { content: [{ type: 'text', text: 'Signing off.' }] } }),
        event('assistant', '2026-10-27T09:00:05Z', { message: {} }),
        { event_id: 'e', event_type: 'client_event', payload: { type: 'user', message: { content: 'Signing off.' } }, created_at: '2026-10-27T09:00:04Z' },
        { created_at: '2026-10-27T09:00:00Z', other: true },
      ],
    });
    assert.ok('unreadable' in decided);
    assert.match(decided.unreadable, /4 events/);
    assert.match(decided.unreadable, /\(no event_type\)\/\? 1, assistant\/assistant 2, client_event\/user 1/);
    assert.match(decided.unreadable, /created_at 2026-10-27T09:00:06Z to 2026-10-27T09:00:00Z/);
    assert.doesNotMatch(decided.unreadable, /Signing off/);
  });

  test('a page with no result and no created_at says so rather than guessing', () => {
    const decided = replyDecision({ data: [{ event_type: 'system' }] });
    assert.ok('unreadable' in decided);
    assert.match(decided.unreadable, /1 events: system\/\? 1; created_at \? to \?/);
  });

  test('a page with no result, or an empty result with no assistant text before it, is unreadable', () => {
    assert.match((replyDecision({ data: [] }) as { unreadable: string }).unreadable, /no result/);
    const bare = { data: [event('result', '2026-10-27T09:00:01Z', { result: '' }), event('assistant', '2026-10-27T09:00:00Z', { message: { content: [{ type: 'tool_use', name: 'Bash' }] } })] };
    assert.match((replyDecision(bare) as { unreadable: string }).unreadable, /no assistant text/);
  });
});

const NOW = Date.parse('2026-10-27T16:00:00Z');
const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'sk-ant-ort01-r', expiresAt: NOW + 3_600_000, scopes: ['user:sessions:claude_code'] } });
const SERVED = 'acme/factory';

/**
 * A sessions-list row as the deployed list answers it (2026-10-27):
 * no `session_context`; the session names its repo under `config`, a cloud
 * one in `sources[].url`, a Remote Control one in `outcomes[].git_info`.
 */
const row = (id: string, { repo = SERVED, worker = 'idle', kind = 'anthropic_cloud', status = 'active' } = {}) => ({
  id,
  status,
  worker_status: worker,
  environment_kind: kind,
  config: kind === 'bridge'
    ? { model: 'claude-opus-5-5', outcomes: [{ type: 'git_repository', git_info: { repo, branches: ['claude/x'] } }] }
    : { model: 'claude-opus-5-5', sources: [{ type: 'git_repository', url: `https://github.com/${repo}`, revision: 'main' }] },
});

/** One sweep over `rows`, each session's events from `pages`, everything else injected. */
const sweepOver = async (rows: Array<Record<string, unknown>>, pages: Record<string, unknown>, over: Record<string, unknown> = {}) => {
  const logged: Array<Record<string, unknown>> = [];
  const archived: string[] = [];
  const read: string[] = [];
  const sweep = await sweepSignoffs({
    archive: async ({ session }: { session: string }) => {
      archived.push(session);
      return { status: 200, body: '{}' };
    },
    login: LOGIN,
    started: NOW,
    now: () => NOW,
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    repos: [SERVED],
    list: async () => rows,
    lookup: async (id: string) => ({ row: rows.find((r) => r.id === id) ?? null, from: 'list' as const }),
    events: async (id: string) => {
      read.push(id);
      const page = pages[id];
      if (page instanceof Error) throw page;
      return page;
    },
    ...over,
  } as never);
  return { sweep, logged, archived, read };
};

describe('fitness: a sign-off is read from the session (session-signoff.md)', () => {
  test('archives a cloud session whose newest result ends with the sign-off line', async () => {
    const { archived, logged } = await sweepOver([row('cse_01CLOUD')], { cse_01CLOUD: cloudSignedOff });
    assert.deepEqual(archived, ['session_01CLOUD']);
    assert.ok(logged.some((l) => l.event === 'dispatch-signoff' && l.session === 'session_01CLOUD' && l.archived === true), JSON.stringify(logged));
  });

  test('archives a Remote Control session whose empty result follows an assistant message ending with it', async () => {
    const { archived } = await sweepOver([row('cse_01BRIDGE', { kind: 'bridge' })], { cse_01BRIDGE: bridgeSignedOff });
    assert.deepEqual(archived, ['session_01BRIDGE']);
  });

  test('archives a turn the self-archive request continued, when the reply to it ends with the sign-off line', async () => {
    for (const reply of ['Archived this session.\n\nSigning off.', 'I do not have that tool.\n\nSigning off.']) {
      const { archived } = await sweepOver([row('cse_01BRIDGE', { kind: 'bridge' })], { cse_01BRIDGE: bridgeAfterRequest(reply) });
      assert.deepEqual(archived, ['session_01BRIDGE'], reply);
    }
  });

  test('archives none of: a reply to the request without the line, a running session, a newer reply without the line, a failed read, an answer outside the schema, a repo not served', async () => {
    const rows = [
      row('cse_01DECLINED', { kind: 'bridge' }),
      row('cse_01RUNNING', { worker: 'running' }),
      row('cse_01AGAIN'),
      row('cse_01BRIDGENOT', { kind: 'bridge' }),
      row('cse_01FAILED'),
      row('cse_01ODD'),
      row('cse_01ELSEWHERE', { repo: 't-d-d/askme-mcp' }),
      row('cse_01ELSEBRIDGE', { repo: 't-d-d/askme-mcp', kind: 'bridge' }),
      row('cse_01GONE', { status: 'archived' }),
    ];
    const { archived, read, sweep } = await sweepOver(rows, {
      cse_01DECLINED: bridgeAfterRequest('I do not have that tool.'),
      cse_01RUNNING: cloudSignedOff,
      cse_01AGAIN: cloudSignedOffThenNot,
      cse_01BRIDGENOT: bridgeNotSigned,
      cse_01FAILED: new Error('GET /v1/code/sessions/cse_01FAILED/events: 500'),
      cse_01ODD: { data: [{ type: 'result', result: 'Signing off.' }] },
      cse_01ELSEWHERE: cloudSignedOff,
      cse_01ELSEBRIDGE: bridgeSignedOff,
      cse_01GONE: cloudSignedOff,
    });
    assert.deepEqual(archived, []);
    assert.deepEqual(read.sort(), ['cse_01AGAIN', 'cse_01BRIDGENOT', 'cse_01DECLINED', 'cse_01FAILED', 'cse_01ODD'], 'a running, archived or unserved session is no candidate');
    assert.deepEqual(sweep.kept.map((k: { session: string }) => k.session).sort(), ['session_01FAILED', 'session_01ODD']);
  });

  // The candidate row is read before the events: a prompt that lands during
  // that read sets the session to work, and the archive reads it afresh.
  test('a session set to work while its events are read is not archived', async () => {
    let prompted = false;
    const rows = [row('cse_01CLOUD')];
    const { archived } = await sweepOver(rows, {}, {
      events: async () => { prompted = true; return cloudSignedOff; },
      lookup: async (id: string) => ({ row: { ...rows.find((r) => r.id === id), worker_status: prompted ? 'running' : 'idle' }, from: 'list' }),
    });
    assert.deepEqual(archived, []);
  });

  test('a session this turn messaged is left until its reply lands, then decided by it', async () => {
    const sent = Date.parse('2026-10-17T19:30:00Z');
    const early = await sweepOver([row('cse_01CLOUD')], { cse_01CLOUD: cloudSignedOff }, { woken: new Map([['session_01CLOUD', sent]]) });
    assert.deepEqual(early.archived, [], 'its newest result predates the message');
    assert.equal(early.sweep.deferred, 1);
    const late = await sweepOver([row('cse_01CLOUD')], { cse_01CLOUD: cloudSignedOff }, { woken: new Map([['session_01CLOUD', sent - 60 * 60 * 1000]]) });
    assert.deepEqual(late.archived, ['session_01CLOUD']);
  });

  test('a list it cannot read, or a login it cannot use, archives nothing and says why', async () => {
    const refused = await sweepOver([row('cse_01CLOUD')], { cse_01CLOUD: cloudSignedOff }, { list: async () => { throw new Error('GET /v1/code/sessions: 503'); } });
    assert.deepEqual(refused.archived, []);
    assert.match(String(refused.sweep.skipped), /503/);
    const expired = await sweepOver([row('cse_01CLOUD')], { cse_01CLOUD: cloudSignedOff }, { login: LOGIN.replace(String(NOW + 3_600_000), String(NOW - 1)) });
    assert.deepEqual(expired.archived, []);
    assert.match(String(expired.sweep.skipped), /expired/);
  });

  test('stops reading candidates once its window has passed, and counts the rest as deferred', async () => {
    let now = NOW;
    const rows = [row('cse_01A'), row('cse_01B'), row('cse_01C')];
    let reads = 0;
    const { archived, sweep } = await sweepOver(rows, {}, {
      now: () => now,
      events: async () => { reads += 1; now += SIGNOFF_WINDOW_MS + 1; return cloudSignedOff; },
    });
    assert.equal(reads, 1);
    assert.deepEqual(archived, ['session_01A']);
    assert.equal(sweep.deferred, 2);
  });

  // An idle session that never signs off stays a candidate until archived by
  // hand, while a sign-off is its session's last update: reading the most
  // recently updated first keeps a pile of old idle sessions from holding a
  // sign-off past the window on every turn.
  test('reads the most recently updated candidates first, so old idle ones past the window never hold back a sign-off', async () => {
    let now = NOW;
    const at = (iso: string) => ({ updated_at: iso });
    const rows = [
      { ...row('cse_01OLDA'), ...at('2026-10-01T09:00:00Z') },
      { ...row('cse_01OLDB'), ...at('2026-10-02T09:00:00Z') },
      { ...row('cse_01OLDC'), ...at('2026-10-03T09:00:00Z') },
      { ...row('cse_01SIGNED'), ...at('2026-10-27T15:00:00Z') },
    ];
    const read: string[] = [];
    const { archived, sweep } = await sweepOver(rows, {}, {
      now: () => now,
      events: async (id: string) => {
        read.push(id);
        now += SIGNOFF_WINDOW_MS / 2 + 1;
        return id === 'cse_01SIGNED' ? cloudSignedOff : cloudSignedOffThenNot;
      },
    });
    assert.deepEqual(archived, ['session_01SIGNED']);
    assert.equal(sweep.deferred, 2);
    assert.deepEqual(read, ['cse_01SIGNED', 'cse_01OLDC']);
  });

  // Summed over a day, these say whether the window defers anyone:
  // no other line carries a numeric `deferred` to count twice.
  test('logs one line per sweep with its counts, and no session', async () => {
    let now = NOW;
    const rows = [row('cse_01A'), row('cse_01B'), row('cse_01C'), row('cse_01D'), row('cse_01RUNNING', { worker: 'running' })];
    const pages: Record<string, unknown> = { cse_01A: cloudSignedOff, cse_01B: cloudSignedOffThenNot, cse_01C: new Error('500') };
    const { logged } = await sweepOver(rows, pages, {
      now: () => now,
      events: async (id: string) => {
        if (id === 'cse_01C') { now += SIGNOFF_WINDOW_MS + 1; throw pages[id]; }
        return pages[id];
      },
    });
    const counts = logged.filter((l) => l.event === 'dispatch-signoff' && 'candidates' in l).map(({ turnedAway: _t, ...rest }) => rest);
    assert.deepEqual(counts, [{ event: 'dispatch-signoff', listed: 5, candidates: 4, archived: 1, unsigned: 1, kept: 1, deferred: 1 }]);
    assert.equal(logged.filter((l) => typeof l.deferred === 'number').length, 1);
  });

  // Measured on the deployed list: a row names its repo under
  // `config`, not `session_context`, and the line counts what each test
  // turned away, with no sample of any row.
  test('the counting line says how many rows each test turned away, and carries no row', async () => {
    const rows: Array<Record<string, unknown>> = [
      row('cse_01OK'),
      { ...row('session_01LINKID'), title: 'secret title' },
      row('cse_01GONE', { status: 'archived' }),
      { ...row('cse_01BUSY', { worker: 'running' }), title: 'secret title' },
      { id: 'cse_01BARE', status: 'active', worker_status: 'idle', title: 'secret title', external_metadata: { current_branches: { '': 'claude/x' } } },
      row('cse_01ELSE', { repo: 't-d-d/askme-mcp' }),
    ];
    const { logged } = await sweepOver(rows, { cse_01OK: cloudSignedOffThenNot });
    const line = logged.find((l) => l.event === 'dispatch-signoff' && 'candidates' in l)!;
    assert.equal(line.listed, 6);
    assert.equal(line.candidates, 1);
    assert.deepEqual(line.turnedAway, { id: 1, archived: 1, busy: 1, unnamed: 1, unserved: 1 });
    assert.equal(line.samples, undefined);
    assert.doesNotMatch(JSON.stringify(line), /secret title|claude\/x|askme|cse_|session_/);
  });

  test('no line the sweep logs carries reply text', async () => {
    const rows = [row('cse_01CLOUD'), row('cse_01BRIDGE', { kind: 'bridge' }), row('cse_01AGAIN'), row('cse_01ODD')];
    const { logged } = await sweepOver(rows, {
      cse_01CLOUD: cloudSignedOff,
      cse_01BRIDGE: bridgeSignedOff,
      cse_01AGAIN: cloudSignedOffThenNot,
      cse_01ODD: { data: [event('result', '2026-10-27T09:00:00Z', { result: 42 })] },
    });
    assert.ok(logged.some((l) => l.event === 'dispatch-signoff' && l.session === 'session_01AGAIN' && l.decision === 'not signed off'), 'each candidate\'s line names its decision');
    const text = JSON.stringify(logged);
    for (const reply of [CLOUD_REPLY, BRIDGE_REPLY, NOT_SIGNED]) {
      for (const line of reply.split('\n').filter((l) => l.trim() !== '')) assert.ok(!text.includes(line), line);
    }
  });
});

describe('reading back: a reply behind a newest page of other events', () => {
  /** A sweep of one cloud candidate whose events `history` answers, a page per call. */
  const sweepPaged = async (history: (cursor?: string) => unknown) => {
    const cursors: Array<string | undefined> = [];
    const result = await sweepOver([row('cse_01BEHIND')], {}, {
      events: async (_id: string, _token: string, cursor?: string) => { cursors.push(cursor); return history(cursor); },
    });
    return { ...result, cursors };
  };

  test('archives a session whose newest page holds no result and whose page before holds a signed-off one', async () => {
    const { archived, cursors } = await sweepPaged(pagedHistory(signedOffBehind));
    assert.deepEqual(archived, ['session_01BEHIND']);
    assert.equal(cursors.length, 3, 'two pages of state events, then the page with the result');
    assert.equal(cursors[0], undefined, 'the first read is the newest page');
    const history = pagedHistory(signedOffBehind);
    assert.equal(cursors[1], history().next_cursor, 'each read follows the page before\'s next_cursor');
    assert.equal(cursors[2], history(cursors[1]).next_cursor);
  });

  test('a reply behind the newest page that did not sign off is not archived', async () => {
    const written = [...[...cloudSignedOffThenNot.data].reverse(), ...stateEvents(150)] as Array<{ event_id: string }>;
    const { archived, logged } = await sweepPaged(pagedHistory(written));
    assert.deepEqual(archived, []);
    assert.ok(logged.some((l) => l.session === 'session_01BEHIND' && l.decision === 'not signed off'), JSON.stringify(logged));
  });

  test('an empty result whose assistant text is on the page before is read across the pages', async () => {
    const written = [...[...bridgeSignedOff.data].reverse()].slice(0, -1) as Array<{ event_id: string }>;
    // The empty result opens the newest page; the reply is on the next.
    const { archived } = await sweepPaged(pagedHistory(written, 2));
    assert.deepEqual(archived, ['session_01BEHIND']);
  });

  test('stops reading back at SIGNOFF_PAGES pages, a bound that fits the sweep\'s window', async () => {
    const { archived, cursors, logged } = await sweepPaged(pagedHistory(stateEvents(100 * SIGNOFF_PAGES + 50)));
    assert.deepEqual(archived, []);
    assert.equal(cursors.length, SIGNOFF_PAGES);
    const line = logged.find((l) => l.session === 'session_01BEHIND');
    assert.equal(line?.decision, 'unreadable');
    assert.match(String(line?.reason), new RegExp(`no result in the newest ${SIGNOFF_PAGES} pages \\(${100 * SIGNOFF_PAGES} events`));
    assert.ok(SIGNOFF_PAGES * ARCHIVE_TIMEOUT_MS <= SIGNOFF_WINDOW_MS, 'one candidate\'s reads, each bounded by its timeout, fit the window');
  });

  test('the start of the session ends the read: no result in its whole history is unreadable', async () => {
    const { archived, cursors, logged } = await sweepPaged(pagedHistory(stateEvents(130)));
    assert.deepEqual(archived, []);
    assert.equal(cursors.length, 2, 'the second page carries no next_cursor');
    assert.match(String(logged.find((l) => l.session === 'session_01BEHIND')?.reason), /no result in the session's whole history \(130 events/);
  });

  test('an empty result whose turn runs back to the start of the session says its text is missing, not its result', async () => {
    // The init event, the empty result and a request after it: no assistant text in the turn.
    const written = [...[...bridgeSignedOff.data].reverse()].slice(3) as Array<{ event_id: string }>;
    const { archived, cursors, logged } = await sweepPaged(pagedHistory(written, 1));
    assert.deepEqual(archived, []);
    assert.equal(cursors.length, 3, 'three events a page at a time, the last with no next_cursor');
    const reason = String(logged.find((l) => l.session === 'session_01BEHIND')?.reason);
    assert.match(reason, /the last result is empty and no assistant text precedes it in its turn/);
    assert.doesNotMatch(reason, /no result/);
  });

  test('events that carry no event_id are not read as repeats of one another', async () => {
    const states = stateEvents(4).map((e, i) => (i % 2 === 0 ? { ...e, event_id: undefined } : e));
    const written = [...[...cloudSignedOff.data].reverse(), ...states] as Array<{ event_id: string }>;
    const { archived, logged } = await sweepPaged(pagedHistory(written, 3));
    assert.deepEqual(archived, ['session_01BEHIND'], JSON.stringify(logged));
  });

  test('a page with no next_cursor, an empty one or an empty page is the start of the session', async () => {
    const newest = pagedHistory(stateEvents(100))();
    for (const last of [{ data: newest.data }, { data: newest.data, next_cursor: '' }, { data: newest.data, next_cursor: null }]) {
      const { archived, cursors, logged } = await sweepPaged(() => last);
      assert.deepEqual(archived, []);
      assert.equal(cursors.length, 1, JSON.stringify(last.next_cursor));
      assert.match(String(logged.find((l) => l.session === 'session_01BEHIND')?.reason), /no result in the session's whole history \(100 events/);
    }
    const emptied = await sweepPaged((cursor) => (cursor === undefined ? { ...newest, next_cursor: 'c1.more' } : { data: [], next_cursor: 'c1.more' }));
    assert.equal(emptied.cursors.length, 2);
    assert.match(String(emptied.logged.find((l) => l.session === 'session_01BEHIND')?.reason), /no result in the session's whole history/);
  });

  // The deployed endpoint ignored before_id: an answer that is not
  // the page before reads unreadable and says what came back, never text.
  test('an answer that ignores the cursor, or reads newer events, is unreadable and says so', async () => {
    const newest = pagedHistory(stateEvents(150));
    const ignored = await sweepPaged(() => newest());
    assert.deepEqual(ignored.archived, []);
    assert.equal(ignored.cursors.length, 2);
    assert.match(String(ignored.logged.find((l) => l.session === 'session_01BEHIND')?.reason), /did not read back: 100 of its 100 events were already read/);
    const newer = [...stateEvents(1, '2026-10-30T00:00:00Z'), ...stateEvents(99, '2026-10-29T00:00:00Z')];
    const forward = await sweepPaged((cursor) => (cursor === undefined ? newest() : { data: newer }));
    assert.match(String(forward.logged.find((l) => l.session === 'session_01BEHIND')?.reason), /did not read back: .*newer than/);
  });
});

describe('awaitReplies: waiting on a quiet lane for the replies a turn asked for', () => {
  const sent = Date.parse('2026-10-17T19:28:00Z');
  const wait = async (pages: () => unknown, over: Record<string, unknown> = {}) => {
    let now = NOW;
    const logged: Array<Record<string, unknown>> = [];
    const slept: number[] = [];
    await awaitReplies({
      fires: { waiting: async () => 0 },
      woken: new Map([['session_01CLOUD', sent]]),
      login: LOGIN,
      started: NOW,
      now: () => now,
      sleep: async (ms: number) => { slept.push(ms); now += ms; },
      log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
      events: async () => pages(),
      ...over,
    } as never);
    return { logged, slept };
  };

  test('stops as soon as a result newer than the message is on the session\'s events', async () => {
    let looks = 0;
    const older = { data: cloudSignedOff.data.filter((e) => Date.parse((e as { created_at: string }).created_at) < sent) };
    const { logged, slept } = await wait(() => (++looks >= 3 ? cloudSignedOff : older));
    assert.equal(slept.length, 2);
    assert.ok(logged.some((l) => l.event === 'dispatch-signoff-wait' && l.ended === 'every session replied'), JSON.stringify(logged));
  });

  test('an events read that fails ends the wait and says why, never quoting the session', async () => {
    const { logged, slept } = await wait(() => { throw new Error('GET /v1/code/sessions/cse_01CLOUD/events: 500'); });
    assert.equal(slept.length, 0);
    assert.ok(logged.some((l) => l.event === 'dispatch-signoff-wait' && /500/.test(String(l.error))), JSON.stringify(logged));
  });
});
