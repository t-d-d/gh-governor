/**
 * The launcher (dispatch/launcher.mjs), through `start`, with one fake
 * launch and one fake record write in place of a whole turn. The outcomes
 * the turn sees end to end stay pinned by the table in
 * test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_LATE, SESSION_UNRECORDED, launcher, overBudget, routineLaunch, sessionUrlFrom } from '../dispatch/launcher.mjs';

const URL_A = 'https://claude.ai/code/session_01LAUNCHER';

type Line = { event: string, fields: Record<string, unknown> };
type Asked = { prompt: string, sessionName: string, model: string, repo: string, environment: string, connectors?: string[] };
type Result = { status: number | null, output: string, routine?: string, refused?: true };

/** A launcher over one fake launch and one fake record write, and what they saw. */
const harness = (opts: { output?: string, status?: number | null, routine?: string, record?: (url: string) => Promise<unknown>, cli?: () => Promise<Result> } = {}) => {
  const lines: Line[] = [];
  const launched: Asked[] = [];
  const routined: Array<{ asked: Asked, connectors: string[] }> = [];
  const recorded: string[] = [];
  const records = { writes: [] as Promise<void>[], ended: false };
  const pending = new Set<{ repo: string, sessionName: string, sessionUrl: string }>();
  const result = (): Result => ({ status: opts.status === undefined ? 0 : opts.status, output: opts.output ?? `created ${URL_A}\n`, ...(opts.routine === undefined ? {} : { routine: opts.routine }) });
  const { start } = launcher({
    cli: async (asked: Asked) => { launched.push(asked); return opts.cli === undefined ? result() : opts.cli(); },
    routine: async (asked: Asked, connectors: string[]) => { routined.push({ asked, connectors }); return result(); },
    recordSession: async (url: string) => { recorded.push(url); if (opts.record !== undefined) await opts.record(url); },
    suffix: (repo: string) => `SIGNED ${repo}`,
    records,
    pending,
    log: (event: string, fields: Record<string, unknown> = {}) => { lines.push({ event, fields }); },
  });
  return { start, lines, launched, routined, recorded, records, pending };
};

const ASK: Asked = { prompt: 'Do the thing.', sessionName: 'Weekly retro', model: 'm', repo: 'acme/factory', environment: 'env' };

const settle = async (records: { writes: Promise<void>[] }) => { for (let i = 0; i < records.writes.length; i += 1) await records.writes[i]; };

describe('launcher: start', () => {
  test('a CLI launch gets the repo\'s suffix on its prompt, and its printed session is recorded off the launch', async () => {
    const h = harness();
    const result = await h.start(ASK);
    assert.equal(result.status, 0);
    assert.deepEqual(h.launched.map((l) => l.prompt), ['Do the thing.\n\nSIGNED acme/factory']);
    assert.equal(h.records.writes.length, 1, 'the record is left for the turn to wait on');
    assert.equal(h.pending.size, 1, 'the deadline can see the record while it is written');
    await settle(h.records);
    assert.deepEqual(h.recorded, [URL_A]);
    assert.equal(h.pending.size, 0);
    assert.deepEqual(h.lines, []);
  });

  test('a launch naming connectors goes to the routine, not the CLI', async () => {
    const h = harness();
    await h.start({ ...ASK, connectors: ['Slack'] });
    assert.equal(h.launched.length, 0);
    assert.deepEqual(h.routined.map((r) => r.connectors), [['Slack']]);
    await settle(h.records);
    assert.deepEqual(h.recorded, [URL_A]);
  });

  test('a record that fails is logged as unrecorded, naming the session, and the launch still returns', async () => {
    const h = harness({ record: async () => { throw new Error('table down'); } });
    const result = await h.start(ASK);
    assert.equal(result.status, 0);
    await settle(h.records);
    assert.deepEqual(h.lines.map((l) => l.event), [SESSION_UNRECORDED]);
    assert.equal(h.lines[0]!.fields.sessionUrl, URL_A);
    assert.equal(h.lines[0]!.fields.error, 'table down');
    assert.equal(h.pending.size, 0);
  });

  test('a launch that may have started a session but printed none pages, naming it', async () => {
    const h = harness({ output: 'nothing', status: 3 });
    await h.start(ASK);
    assert.deepEqual(h.recorded, []);
    assert.deepEqual(h.lines.map((l) => [l.event, l.fields.sessionName, l.fields.sessionUrl]), [[SESSION_UNRECORDED, 'Weekly retro', null]]);
  });

  test('a launch that failed outright pages nothing', async () => {
    const h = harness({ output: 'nothing', status: 1 });
    await h.start(ASK);
    assert.deepEqual(h.lines, []);
  });

  test('a routine whose run session went unnamed pages naming the routine', async () => {
    const h = harness({ output: 'fired', status: 0, routine: 'trig_x' });
    await h.start({ ...ASK, connectors: ['Slack'] });
    assert.equal(h.lines.length, 1);
    assert.equal(h.lines[0]!.fields.routine, 'trig_x');
    assert.equal(h.lines[0]!.fields.routineName, 'governor acme/factory: Weekly retro');
  });

  test('a launch its budget refused pages once, and the session it prints later is tied to that page and recorded', async () => {
    let print: (r: Result) => void = () => {};
    const h = harness({ cli: () => new Promise<Result>((resolve) => { print = resolve; }) });
    const launching = h.start(ASK);
    const onOver = overBudget.get(launching);
    assert.ok(onOver, 'the budget finds the page by the launch\'s promise');
    onOver();
    assert.deepEqual(h.lines.map((l) => [l.event, l.fields.sessionUrl]), [[SESSION_UNRECORDED, null]]);
    print({ status: 0, output: URL_A });
    await launching;
    await settle(h.records);
    assert.deepEqual(h.lines.map((l) => l.event), [SESSION_UNRECORDED, SESSION_LATE]);
    assert.match(String(h.lines[1]!.fields.reason), /the turn waits for its record/);
    assert.deepEqual(h.recorded, [URL_A]);
  });

  test('a session printed after the turn ended pages again, naming it, and its record is still tried', async () => {
    const h = harness();
    h.records.ended = true;
    await h.start(ASK);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.records.writes.length, 0, 'nothing waits for it');
    assert.deepEqual(h.lines.map((l) => [l.event, l.fields.sessionUrl]), [[SESSION_UNRECORDED, URL_A]]);
    assert.deepEqual(h.recorded, [URL_A]);
  });
});

describe('launcher: routineLaunch', () => {
  test('a login the turn cannot read started nothing, and is not a refusal', async () => {
    const launch = routineLaunch({
      secret: { get: async () => { throw new Error('no login'); } },
      token: async () => 'token',
      routines: () => { throw new Error('not reached'); },
      log: () => {},
      sleep: async () => {},
      uuid: () => 'u',
    });
    assert.deepEqual(await launch(ASK, ['Slack']), { status: 1, output: 'no login' });
  });

  /** A routine launch over a fake routines API that answers `connectors` and refuses everything else. */
  const over = (connectors: () => Promise<unknown>) => routineLaunch({
    secret: { get: async () => '{}' },
    token: async () => 'token',
    routines: () => {
      const refuse = async () => { throw new Error('refused'); };
      return { connectors, triggers: async () => ({ data: [] }), create: refuse, update: refuse, run: refuse, sessions: refuse };
    },
    log: () => {},
    sleep: async () => {},
    uuid: () => 'u',
  });

  test('a routine the routines API refused started nothing, and is marked a refusal, not the CLI\'s fault', async () => {
    const result = await over(async () => { throw new Error('refused'); })(ASK, ['Slack']);
    assert.equal(result.status, 1);
    assert.equal(result.refused, true);
  });

  test('a connector the account has not connected is not a refusal', async () => {
    const result = await over(async () => ({ data: [] }))(ASK, ['Slack']);
    assert.deepEqual(result.missing, ['Slack']);
    assert.equal(result.refused, undefined);
  });
});

describe('launcher: sessionUrlFrom', () => {
  test('reads the session URL the CLI prints, or builds it from the id', () => {
    assert.equal(sessionUrlFrom('Created cloud session: https://claude.ai/code/session_01ABC\nResume with: claude --teleport session_01ABC\n'), 'https://claude.ai/code/session_01ABC');
    assert.equal(sessionUrlFrom('Resume with: claude --teleport session_01XYZ\n'), 'https://claude.ai/code/session_01XYZ');
    assert.equal(sessionUrlFrom('nothing here'), null);
  });
});
