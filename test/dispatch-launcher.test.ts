/**
 * The launcher (dispatch/launcher.mjs), through `start`, with one fake
 * launch and one fake record write in place of a whole turn. The outcomes
 * the turn sees end to end stay pinned by the table in
 * test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_LATE, SESSION_UNRECORDED, launcher, routineLaunch, sessionUrlFrom } from '../dispatch/launcher.mjs';

const URL_A = 'https://claude.ai/code/session_01LAUNCHER';

type Line = { event: string, fields: Record<string, unknown> };
type Asked = { prompt: string, sessionName: string, model: string, repo: string, environment: string, connectors?: string[] };
type Result = { status: number | null, output: string, routine?: string, refused?: true };
type Budgeted = <T>(begin: () => Promise<T>, name: string, until?: number, onOver?: () => void) => Promise<T>;

/** A launcher over one fake launch and one fake record write, and what they saw. */
const harness = (opts: { output?: string, status?: number | null, routine?: string, record?: (url: string) => Promise<unknown>, cli?: () => Promise<Result>, budgeted?: Budgeted, fireRepo?: string } = {}) => {
  const lines: Line[] = [];
  const launched: Asked[] = [];
  const routined: Array<{ asked: Asked, connectors: string[] }> = [];
  const recorded: string[] = [];
  const pending = new Set<{ repo: string, sessionName: string, sessionUrl: string }>();
  const result = (): Result => ({ status: opts.status === undefined ? 0 : opts.status, output: opts.output ?? `created ${URL_A}\n`, ...(opts.routine === undefined ? {} : { routine: opts.routine }) });
  const { start, settle } = launcher({
    cli: async (asked: Asked) => { launched.push(asked); return opts.cli === undefined ? result() : opts.cli(); },
    routine: async (asked: Asked, connectors: string[]) => { routined.push({ asked, connectors }); return result(); },
    recordSession: async (url: string) => { recorded.push(url); if (opts.record !== undefined) await opts.record(url); },
    suffix: (repo: string) => `SIGNED ${repo}`,
    budgeted: opts.budgeted ?? (async (begin) => begin()),
    ...(opts.fireRepo === undefined ? {} : { fireRepo: opts.fireRepo }),
    environment: (repo: string) => `env of ${repo}`,
    pending,
    log: (event: string, fields: Record<string, unknown> = {}) => { lines.push({ event, fields }); },
  });
  return { start, settle, lines, launched, routined, recorded, pending };
};

const ASK: Asked = { prompt: 'Do the thing.', sessionName: 'Weekly retro', model: 'm', repo: 'acme/factory', environment: 'env' };

describe('launcher: start', () => {
  test('a CLI launch gets the repo\'s suffix on its prompt, and its printed session is recorded off the launch', async () => {
    const h = harness();
    const result = await h.start(ASK);
    assert.equal(result.status, 0);
    assert.deepEqual(h.launched.map((l) => l.prompt), ['Do the thing.\n\nSIGNED acme/factory']);
    assert.equal(h.pending.size, 1, 'the deadline can see the record while it is written');
    await h.settle();
    assert.deepEqual(h.recorded, [URL_A]);
    assert.equal(h.pending.size, 0);
    assert.deepEqual(h.lines, []);
  });

  test('a launch naming connectors goes to the routine, not the CLI', async () => {
    const h = harness();
    await h.start({ ...ASK, connectors: ['Slack'] });
    assert.equal(h.launched.length, 0);
    assert.deepEqual(h.routined.map((r) => r.connectors), [['Slack']]);
    await h.settle();
    assert.deepEqual(h.recorded, [URL_A]);
  });

  test('a record that fails is logged as unrecorded, naming the session, and the launch still returns', async () => {
    const h = harness({ record: async () => { throw new Error('table down'); } });
    const result = await h.start(ASK);
    assert.equal(result.status, 0);
    await h.settle();
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
    let printed: Promise<unknown> = Promise.resolve();
    const seen: Array<{ name: string, until: number | undefined }> = [];
    // A budget that starts the launch, then refuses it: it calls the page it
    // was handed and rejects, while the launcher runs on.
    const refusing: Budgeted = async (begin, name, until, onOver) => {
      seen.push({ name, until });
      printed = begin();
      onOver?.();
      throw new Error(`the launcher for ${name} ran past 5 ms`);
    };
    const h = harness({ cli: () => new Promise<Result>((resolve) => { print = resolve; }), budgeted: refusing });
    await assert.rejects(h.start(ASK, 99), /ran past 5 ms/);
    assert.deepEqual(seen, [{ name: 'Weekly retro', until: 99 }], 'the launch runs under the budget it shares');
    assert.deepEqual(h.lines.map((l) => [l.event, l.fields.sessionUrl]), [[SESSION_UNRECORDED, null]]);
    print({ status: 0, output: URL_A });
    await printed;
    await h.settle();
    assert.deepEqual(h.lines.map((l) => l.event), [SESSION_UNRECORDED, SESSION_LATE]);
    assert.match(String(h.lines[1]!.fields.reason), /the turn waits for its record/);
    assert.deepEqual(h.recorded, [URL_A]);
  });

  test('a launch the budget refused that never prints pages once, at the refusal', async () => {
    let print: (r: Result) => void = () => {};
    let printed: Promise<unknown> = Promise.resolve();
    const refusing: Budgeted = async (begin, name, _until, onOver) => {
      printed = begin();
      onOver?.();
      throw new Error(`the launcher for ${name} ran past 5 ms`);
    };
    const h = harness({ cli: () => new Promise<Result>((resolve) => { print = resolve; }), budgeted: refusing });
    await assert.rejects(h.start(ASK), /ran past/);
    print({ status: 3, output: 'nothing' });
    await printed;
    assert.deepEqual(h.lines.map((l) => l.event), [SESSION_UNRECORDED], 'the page at the refusal is the only one');
  });

  test('a budget with nothing left starts nothing and pages nothing', async () => {
    const spent: Budgeted = async (_begin, name) => { throw new Error(`no budget left to start ${name}`); };
    const h = harness({ budgeted: spent });
    await assert.rejects(h.start(ASK, 0), /no budget left/);
    assert.equal(h.launched.length, 0);
    assert.deepEqual(h.lines, []);
  });

  test('a launch naming no repo starts in the fire\'s repo and that repo\'s environment', async () => {
    const h = harness({ fireRepo: 'acme/fire' });
    const result = await h.start({ prompt: 'p', sessionName: 's', model: 'm' });
    assert.deepEqual(h.launched.map((l) => [l.repo, l.environment]), [['acme/fire', 'env of acme/fire']]);
    assert.equal(result.outcome, 'dispatched');
    assert.equal(result.sessionUrl, URL_A);
  });

  test('a launch naming no repo in a fire that names none is refused before it starts', async () => {
    const h = harness();
    await assert.rejects(h.start({ prompt: 'p', sessionName: 's', model: 'm' }), /names no repo/);
    assert.equal(h.launched.length, 0);
  });

  test('a failed launch names no session, and keeps what the routine said', async () => {
    const h = harness({ status: 1, output: `refused ${URL_A}` });
    const result = await h.start(ASK);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.sessionUrl, null);
    assert.equal(result.status, 1);
  });

  test('a session printed after the turn ended pages again, naming it, and its record is still tried', async () => {
    const h = harness();
    await h.settle();
    await h.start(ASK);
    // Read before the write lands: a record left to wait on would still be pending here.
    assert.equal(h.pending.size, 0, 'nothing waits for it');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.lines.map((l) => [l.event, l.fields.sessionUrl]), [[SESSION_UNRECORDED, URL_A]]);
    assert.deepEqual(h.recorded, [URL_A]);
  });
});

describe('launcher: settle', () => {
  test('settle waits for a record still being written, then the launcher is ended', async () => {
    let land: () => void = () => {};
    const h = harness({ record: () => new Promise<void>((resolve) => { land = resolve; }) });
    await h.start(ASK);
    let settled = false;
    const waiting = h.settle().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the record has not landed');
    assert.equal(h.pending.size, 1);
    land();
    await waiting;
    assert.equal(h.pending.size, 0);
    assert.deepEqual(h.lines, []);
  });

  test('settle waits for a record a late launcher adds while it waits', async () => {
    let print: (r: Result) => void = () => {};
    let printed: Promise<unknown> = Promise.resolve();
    let landFirst: () => void = () => {};
    let landLate: () => void = () => {};
    const writes: string[] = [];
    let calls = 0;
    const refusing: Budgeted = async (begin, name, _until, onOver) => {
      printed = begin();
      onOver?.();
      throw new Error(`the launcher for ${name} ran past 5 ms`);
    };
    // The first launch prints at once, and its record hangs until released.
    // The second runs past its budget and prints while settle waits, and its
    // record hangs past the first's, so settle ends only when it lands.
    let budget: Budgeted = async (begin) => begin();
    const h = harness({
      cli: () => (calls++ === 0 ? Promise.resolve({ status: 0, output: URL_A }) : new Promise<Result>((resolve) => { print = resolve; })),
      record: (url) => { writes.push(url); return new Promise<void>((resolve) => { if (url === URL_A) landFirst = resolve; else landLate = resolve; }); },
      budgeted: (begin, name, until, onOver) => budget(begin, name, until, onOver),
    });
    await h.start(ASK);
    budget = refusing;
    await assert.rejects(h.start({ ...ASK, sessionName: 'Late' }), /ran past/);
    let settled = false;
    const waiting = h.settle().then(() => { settled = true; });
    const URL_B = 'https://claude.ai/code/session_01LATELAUNCH';
    print({ status: 0, output: URL_B });
    await printed;
    landFirst();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the late record has not landed');
    assert.equal(h.pending.size, 1);
    landLate();
    await waiting;
    assert.equal(h.pending.size, 0);
    assert.deepEqual(writes, [URL_A, URL_B], 'the late record was waited for, not cut off');
    assert.equal(h.lines.filter((l) => l.event === SESSION_LATE).length, 1);
    assert.match(String(h.lines.find((l) => l.event === SESSION_LATE)!.fields.reason), /the turn waits for its record/);
    assert.equal(h.lines.filter((l) => l.event === SESSION_UNRECORDED && l.fields.sessionUrl !== null).length, 0, 'no page for a record that was waited for');
  });

  test('a record that fails does not stop settle', async () => {
    const h = harness({ record: async () => { throw new Error('write refused'); } });
    await h.start(ASK);
    await h.settle();
    assert.deepEqual(h.lines.map((l) => [l.event, l.fields.error]), [[SESSION_UNRECORDED, 'write refused']]);
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
