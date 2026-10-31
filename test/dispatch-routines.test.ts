/**
 * A periodic that names claude.ai connectors starts as a routine run
 * (dispatch/routines.mjs): governor keeps one routine per such periodic,
 * points it at the fire's prompt, environment, repo and connectors, fires
 * it, and finds the session the run started. The routines API and the
 * connector list are fakes here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NEVER_DUE, ROUTINE_ANSWER, ROUTINE_SESSION_TRIES, answerShape, connectionsFor, launchRoutine, observed, routineName } from '../dispatch/routines.mjs';

const REPO = 'acme/factory';
const FEED = { uuid: 'mcpsrv_01FEED', name: 'feed_prod', url: 'https://feed.example/mcp' };
const GMAIL = { uuid: 'mcpsrv_01GMAIL', name: 'claude.ai Gmail', url: 'https://gmail.example/mcp' };

/** A fake routines API that records every call. */
const fakeApi = (over: Record<string, unknown> = {}, earlier: unknown[] = []) => {
  const calls: Array<{ call: string; id?: string; body?: any }> = [];
  let fired = false;
  let readsAfter = 0;
  const api = {
    connectors: async () => ({ data: [FEED, GMAIL] }),
    triggers: async () => ({ data: [] as unknown[] }),
    create: async (body: unknown) => { calls.push({ call: 'create', body }); return { id: 'trig_01NEW' }; },
    update: async (id: string, body: unknown) => { calls.push({ call: 'update', id, body }); return { id }; },
    run: async (id: string) => { calls.push({ call: 'run', id }); fired = true; return {}; },
    // The run's session shows on the second read after the fire.
    sessions: async (id: string) => {
      calls.push({ call: 'sessions', id });
      if (fired) readsAfter += 1;
      return { data: readsAfter >= 2 ? [{ id: 'cse_01RUN', created_at: '2026-10-31T12:00:05Z' }, ...earlier] : earlier };
    },
    ...over,
  };
  return { api, calls };
};

const launch = (api: unknown, over: Record<string, unknown> = {}) => launchRoutine({
  api: api as never,
  repo: REPO,
  periodic: 'Weekly retro',
  prompt: 'Run a retro.\n\nThis periodic last fired at 2026-10-24T12:00:00.000Z.',
  environment: 'env_01FACTORY',
  model: 'claude-opus-5-5',
  connectors: ['feed_prod'],
  sleep: async () => {},
  uuid: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  ...over,
});

describe('a periodic\'s connectors', () => {
  test('each name becomes the connector\'s id, name and URL from the account\'s list, the app\'s prefix dropped and the name sanitised as the CLI does', () => {
    assert.deepEqual(connectionsFor(['feed_prod', 'Gmail'], { data: [FEED, GMAIL] }), {
      connections: [
        { connector_uuid: FEED.uuid, name: 'feed_prod', url: FEED.url },
        { connector_uuid: GMAIL.uuid, name: 'Gmail', url: GMAIL.url },
      ],
    });
  });

  test('a name the account has not connected is missing, and so is one only an additional install carries', () => {
    assert.deepEqual(connectionsFor(['feed_prod', 'slack'], { data: [FEED] }), { missing: ['slack'] });
    assert.deepEqual(connectionsFor(['feed_prod'], { data: [{ ...FEED, additional_install: true }] }), { missing: ['feed_prod'] });
  });

  test('a list in another shape throws, never read as no connectors', () => {
    for (const answer of [null, {}, { data: 'x' }, { data: [{ name: 'feed_prod' }] }]) {
      assert.throws(() => connectionsFor(['feed_prod'], answer), /connector list/, JSON.stringify(answer));
    }
  });
});

describe('a periodic\'s routine run', () => {
  test('with no routine yet, governor creates one named after the repo and the periodic, on a schedule that never comes due, then fires it and finds its session', async () => {
    const { api, calls } = fakeApi();
    const result = await launch(api);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /https:\/\/claude\.ai\/code\/session_01RUN\b/);
    assert.deepEqual(calls.map((c) => c.call), ['create', 'run', 'sessions', 'sessions']);
    const body = calls[0]!.body;
    assert.equal(body.name, routineName(REPO, 'Weekly retro'));
    assert.match(body.name, /acme\/factory/);
    assert.match(body.name, /Weekly retro/);
    assert.equal(body.cron_expression, NEVER_DUE);
    assert.equal(body.run_once_at, undefined);
    assert.equal(body.enabled, true);
    assert.deepEqual(body.mcp_connections, [{ connector_uuid: FEED.uuid, name: 'feed_prod', url: FEED.url }]);
    assert.equal(body.job_config.ccr.environment_id, 'env_01FACTORY');
    assert.deepEqual(body.job_config.ccr.session_context.sources, [{ git_repository: { url: 'https://github.com/acme/factory' } }]);
    assert.equal(body.job_config.ccr.session_context.model, 'claude-opus-5-5');
    assert.deepEqual(body.job_config.ccr.events, [{ data: {
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', session_id: '', type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: 'Run a retro.\n\nThis periodic last fired at 2026-10-24T12:00:00.000Z.' },
    } }]);
  });

  test('the schedule that never comes due names a day no month has', () => {
    const [minute, hour, day, month, weekday] = NEVER_DUE.split(' ');
    assert.deepEqual([minute, hour, weekday], ['0', '0', '*']);
    assert.ok(Number(month) === 2 && Number(day) >= 30, NEVER_DUE);
  });

  test('a routine already named for the periodic is reused: updated with this fire\'s prompt, environment, repo and connectors, and its schedule set back to never', async () => {
    const { api, calls } = fakeApi({ triggers: async () => ({ data: [{ id: 'trig_01OTHER', name: 'someone else' }, { id: 'trig_01OLD', name: routineName(REPO, 'Weekly retro'), cron_expression: '0 9 * * 1' }] }) }, [{ id: 'cse_01EARLIER' }]);
    const result = await launch(api, { connectors: ['feed_prod', 'Gmail'] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(calls.filter((c) => c.call !== 'sessions').map((c) => [c.call, c.id]), [['update', 'trig_01OLD'], ['run', 'trig_01OLD']]);
    const body = calls.find((c) => c.call === 'update')!.body;
    assert.equal(body.cron_expression, NEVER_DUE);
    assert.equal(body.mcp_connections.length, 2);
    assert.ok(calls.filter((c) => c.call === 'sessions').every((c) => c.id === 'trig_01OLD'));
    assert.equal(calls.findIndex((c) => c.call === 'sessions') < calls.findIndex((c) => c.call === 'run'), true, 'its earlier runs are read before the fire, so none is taken for this one');
  });

  test('a routine named for the periodic under the repo in another case is the same routine, never a second one', async () => {
    const { api, calls } = fakeApi({ triggers: async () => ({ data: [{ id: 'trig_01OLD', name: routineName(REPO, 'Weekly retro') }] }) });
    const result = await launch(api, { repo: 'Acme/Factory' });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(calls.filter((c) => c.call !== 'sessions').map((c) => [c.call, c.id]), [['update', 'trig_01OLD'], ['run', 'trig_01OLD']]);
  });

  test('a connector the account has not connected starts nothing and names it', async () => {
    const { api, calls } = fakeApi();
    const result = await launch(api, { connectors: ['feed_prod', 'slack'] });
    assert.deepEqual(result.missing, ['slack']);
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, 3);
    assert.deepEqual(calls, [], 'no routine created, updated or fired');
  });

  test('the session the fire answers with is taken without the list', async () => {
    const { api, calls } = fakeApi({ run: async () => ({ session_id: 'session_01FIRED' }) });
    const result = await launch(api);
    assert.equal(result.status, 0);
    assert.match(result.output, /session_01FIRED/);
    assert.ok(!calls.some((c) => c.call === 'sessions'), JSON.stringify(calls));
  });

  test('a fire whose session the list never shows is unconfirmed, after a bounded number of reads', async () => {
    let reads = 0;
    const { api } = fakeApi({ sessions: async () => { reads += 1; return { data: [] }; } });
    const result = await launch(api);
    assert.equal(result.status, 3, result.output);
    assert.equal(reads, ROUTINE_SESSION_TRIES, 'a new routine has no earlier runs to read first');
  });

  test('a list read that fails after the fire is unconfirmed too: the run may have started', async () => {
    let reads = 0;
    const { api } = fakeApi({ sessions: async () => { reads += 1; if (reads > 1) throw new Error('503'); return { data: [] }; } });
    assert.equal((await launch(api)).status, 3);
  });

  test('a refusal before the fire started nothing', async () => {
    for (const over of [
      { connectors: async () => { throw new Error('GET /v1/mcp_servers: 401'); } },
      { triggers: async () => { throw new Error('GET /v1/code/triggers: 500'); } },
      { create: async () => { throw new Error('POST /v1/code/triggers: 400 bad cron'); } },
      { run: async () => { throw new Error('POST run: 409'); } },
      { triggers: async () => ({ data: [{ id: 'trig_01OLD', name: routineName(REPO, 'Weekly retro') }] }), sessions: async () => { throw new Error('GET sessions: 500'); } },
      { create: async () => ({}) },
    ]) {
      const { api } = fakeApi(over);
      const result = await launch(api);
      assert.equal(result.status, 1, JSON.stringify(Object.keys(over)));
      assert.equal(result.missing, undefined);
    }
  });

  test('a routines list that runs past a page without the routine starts nothing, rather than create a second one', async () => {
    const { api, calls } = fakeApi({ triggers: async () => ({ data: [], has_more: true }) });
    const result = await launch(api);
    assert.equal(result.status, 1);
    assert.match(result.output, /page/);
    assert.ok(!calls.some((c) => c.call === 'create'));
  });
});

describe('what the routines API answered, logged by shape', () => {
  test('each call logs its keys and their types, any routine or session id, and for a list its count, has_more and first row\'s keys', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const prompt = 'Publish the week. A secret plan.';
    const api = observed({
      connectors: async () => ({ data: [FEED] }),
      triggers: async () => ({ data: [{ id: 'trig_01OLD', name: 'governor acme/factory: Weekly retro', job_config: { ccr: { events: [{ data: { message: { content: prompt } } }] } } }], has_more: false }),
      create: async () => ({ id: 'trig_01NEW', name: 'x' }),
      update: async (id: string) => ({ id }),
      run: async () => ({ type: 'run_started', session: { id: 'cse_01RUN', title: prompt }, last_run: null }),
      sessions: async () => ({ data: [{ id: 'cse_01RUN', title: prompt, created_at: '2026-10-31T12:00:05Z' }], has_more: true, last_id: 'cse_01RUN' }),
    }, (event, context) => logged.push({ event, ...context }));
    await api.connectors();
    await api.triggers();
    await api.run('trig_01OLD');
    await api.sessions('trig_01OLD');
    assert.ok(logged.every((l) => l.event === ROUTINE_ANSWER && l.level === 'info'));
    assert.deepEqual(logged.map((l) => [l.call, l.routine ?? null]), [['connectors', null], ['triggers', null], ['run', 'trig_01OLD'], ['sessions', 'trig_01OLD']]);
    assert.deepEqual(logged[2]!.answer, { keys: { type: 'string', session: 'object', last_run: 'null' }, ids: { 'session.id': 'cse_01RUN' } });
    assert.deepEqual(logged[3]!.answer, {
      keys: { data: 'array', has_more: 'boolean', last_id: 'string' },
      ids: { last_id: 'cse_01RUN' },
      rows: 1,
      hasMore: true,
      firstRow: { keys: { id: 'string', title: 'string', created_at: 'string' }, ids: { id: 'cse_01RUN' } },
    });
    assert.deepEqual((logged[1]!.answer as { firstRow: { keys: unknown } }).firstRow.keys, { id: 'string', name: 'string', job_config: 'object' });
    assert.ok(!JSON.stringify(logged).includes('secret plan'), 'no string the API answered with is logged but an id');
    assert.ok(!JSON.stringify(logged).includes('Weekly retro'));
  });

  test('a call that throws logs that it failed, and still throws', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const api = observed({ ...fakeApi().api, run: async () => { throw new Error('POST /v1/code/triggers/trig_01OLD/run: 409'); } }, (event, context) => logged.push({ event, ...context }));
    await assert.rejects(api.run('trig_01OLD'), /409/);
    assert.deepEqual(logged, [{ event: ROUTINE_ANSWER, level: 'info', call: 'run', routine: 'trig_01OLD', failed: true }]);
  });

  test('an answer that is not an object logs its type alone', () => {
    assert.deepEqual(answerShape('ok'), { type: 'string' });
    assert.deepEqual(answerShape([1, 2]), { type: 'array', rows: 2 });
    assert.deepEqual(answerShape({}), { keys: {}, ids: {} });
  });
});
