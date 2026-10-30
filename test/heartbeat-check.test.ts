/**
 * The heartbeat checker (checker/heartbeat-check.mjs): the reusable workflow
 * a served repo calls, pinned to a commit of this repo, to read its
 * heartbeat issue against its config file and keep an issue open for each
 * pickup sweep or periodic that has stopped. It runs in the served repo, on
 * that repo's own token, never in governor.
 *
 * The workflow carries the checker's source in its one step, so a caller
 * pinned to a commit runs that commit's checker with no checkout. The tests
 * run the copy the workflow carries, and check it is the file's.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { HEARTBEAT_END, HEARTBEAT_MARKER, readHeartbeat, stampHeartbeat } from '../dispatch/heartbeat.mjs';
import { readConfig as governorReadConfig } from '../dispatch/repo-config.mjs';

const WORKFLOW_PATH = new URL('../.github/workflows/heartbeat-check.yml', import.meta.url);
const SOURCE_PATH = new URL('../checker/heartbeat-check.mjs', import.meta.url);

type Step = { name?: string, run?: string, uses?: string, shell?: string, env?: Record<string, string> };
type Job = { 'runs-on': string, permissions: Record<string, string>, concurrency: { group: string, 'cancel-in-progress': boolean }, steps: Step[] };
type Workflow = { on: { workflow_call: { inputs: Record<string, { type: string, default?: unknown, required?: boolean }>, secrets?: unknown } }, permissions?: unknown, jobs: Record<string, Job> };

const workflowText = () => readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = () => yaml.load(workflowText()) as Workflow;
const step = () => {
  const jobs = Object.values(workflow().jobs);
  assert.equal(jobs.length, 1, 'one job');
  const steps = (jobs[0] as Job).steps;
  assert.equal(steps.length, 1, 'one step');
  return steps[0] as Step;
};

/** The checker as the workflow's step writes it out before running it. */
const carried = () => {
  const run = String(step().run);
  const m = /<<'CHECKER'\n([\s\S]*?)\nCHECKER\n/.exec(run);
  assert.ok(m !== null, `the step writes the checker from a quoted heredoc:\n${run}`);
  return `${m[1]}\n`;
};

type Checker = typeof import('../checker/heartbeat-check.mjs');
let checker: Checker;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-check-'));
  const file = join(dir, 'heartbeat-check.mjs');
  writeFileSync(file, carried());
  checker = await import(pathToFileURL(file).href) as Checker;
});

const AT = '2026-10-29T20:00:00.000Z';
const NOW = Date.parse('2026-10-29T21:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const SESSION = 'https://claude.ai/code/session_01RUN';
const OTHER = 'https://claude.ai/code/session_01OTHER';
const BODY = `Governor records its fires here.\n\n${HEARTBEAT_MARKER}\n\nKeep this issue open.\n`;
const REPO = 'acme/factory';

/** The fixture repo's full config file, in the heartbeat's `{ issue }` shape. */
const factory = () => {
  const file = JSON.parse(readFileSync(new URL('./fixtures/factory/.github/dispatch.json', import.meta.url), 'utf8'));
  return { ...file, heartbeat: { issue: 412 } };
};

describe('the workflow a served repo calls', () => {
  test('is called with workflow_call and takes the tolerance and the labels', () => {
    const { on } = workflow();
    assert.deepEqual(Object.keys(on), ['workflow_call']);
    const inputs = on.workflow_call.inputs;
    assert.equal(inputs['tolerance-hours']?.type, 'number');
    assert.equal(inputs.labels?.type, 'string');
  });

  test('runs on the caller\'s own token, with issues: write and contents: read, and takes no secret', () => {
    const wf = workflow();
    assert.equal(wf.on.workflow_call.secrets, undefined);
    assert.deepEqual(wf.permissions, {});
    const job = Object.values(wf.jobs)[0] as Job;
    assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });
    assert.equal(step().env?.GITHUB_TOKEN, '${{ github.token }}');
    assert.doesNotMatch(workflowText(), /secrets\./);
  });

  test('queues runs rather than overlapping them', () => {
    const job = Object.values(workflow().jobs)[0] as Job;
    assert.ok(job.concurrency.group.length > 0);
    assert.equal(job.concurrency['cancel-in-progress'], false);
  });

  test('every action it uses is pinned by commit', () => {
    for (const s of Object.values(workflow().jobs).flatMap((j) => j.steps)) {
      if (s.uses !== undefined) assert.match(s.uses, /@[0-9a-f]{40}$/, s.uses);
    }
  });

  test('carries checker/heartbeat-check.mjs exactly, and no expression GitHub would rewrite inside it', () => {
    assert.equal(carried(), readFileSync(SOURCE_PATH, 'utf8'), 'paste checker/heartbeat-check.mjs into the step\'s heredoc');
    assert.doesNotMatch(carried(), /\$\{\{/);
  });
});

describe('the checker reads exactly what governor writes', () => {
  const periodics = [
    { name: 'Code review', at: AT, by: { count: 'merges', number: 20 }, session: SESSION, state: 'open' },
    { name: 'One merge', at: AT, by: { count: 'merges', number: 1 }, session: SESSION, state: 'open' },
    { name: 'Ticket "triage" \\ odd', at: AT, by: { count: 'issuesOpened', number: 5 }, session: SESSION, state: 'signed off' },
    { name: 'Closed', at: AT, by: { count: 'issuesClosed', number: 1 }, session: OTHER, state: 'held' },
    { name: 'Opened once', at: AT, by: { count: 'issuesOpened', number: 1 }, session: OTHER, state: 'held' },
    { name: 'Closed many', at: AT, by: { count: 'issuesClosed', number: 3 }, session: OTHER, state: 'signed off' },
    { name: 'Weekly retro', at: AT, by: { days: 7 }, session: null, state: 'nothing to do' },
    { name: 'Daily', at: AT, by: { days: 1 }, session: SESSION, state: 'open' },
    { name: 'Held, no limit', at: AT, session: OTHER, state: 'held' },
    { name: 'Rétro: été', at: AT, by: { days: 2 }, session: SESSION, state: 'signed off' },
    { name: 'Not fired yet', at: AT, session: null, state: 'not fired' },
  ];

  test('every kind of line governor writes reads back the same', () => {
    for (const started of [0, 1, 4]) {
      const body = stampHeartbeat(BODY, { pickup: { at: AT, started }, periodics: periodics as never });
      assert.deepEqual(checker.readHeartbeat(body), readHeartbeat(body));
      assert.equal(checker.readHeartbeat(body).periodics.length, periodics.length);
    }
  });

  test('a block after governor\'s own updates and sign-offs reads back the same', () => {
    let body = stampHeartbeat(BODY, { periodics: periodics as never });
    body = stampHeartbeat(body, { periodics: [{ name: 'Code review', state: 'held' }], signedOff: ['session_01OTHER'] });
    body = stampHeartbeat(body, { pickup: { at: iso(NOW), started: 2 } });
    assert.deepEqual(checker.readHeartbeat(body), readHeartbeat(body));
  });

  test('a body with only the marker reads as nothing recorded, and one without it is refused', () => {
    assert.deepEqual(checker.readHeartbeat(BODY), readHeartbeat(BODY));
    assert.throws(() => checker.readHeartbeat('someone\'s ticket'), /governor:heartbeat/);
  });

  test('a line pairing first read with a fire\'s state, or last fire with not fired yet, is not governor\'s, as governor reads it', () => {
    const body = BODY.replace(HEARTBEAT_MARKER, `${HEARTBEAT_MARKER}\n- periodic "A": first read ${AT}, session ${SESSION}, open\n- periodic "B": last fire ${AT}, session none, not fired yet\n${HEARTBEAT_END}`);
    assert.deepEqual(checker.readHeartbeat(body).periodics, []);
    assert.deepEqual(checker.readHeartbeat(body), readHeartbeat(body));
  });

  test('it uses governor\'s markers', () => {
    assert.equal(checker.HEARTBEAT_MARKER, HEARTBEAT_MARKER);
    assert.equal(checker.HEARTBEAT_END, HEARTBEAT_END);
  });
});

describe('reading the config file', () => {
  test('reads the fixture repo\'s full file: the heartbeat issue, pickup\'s interval and each periodic\'s day limit', () => {
    const read = checker.readConfig(JSON.stringify(factory()));
    assert.deepEqual(read, {
      ok: true,
      config: {
        issue: 412,
        pickupHours: 2,
        periodics: [{ name: 'Weekly retro', days: 7 }, { name: 'Ticket review', days: 3 }, { name: 'Code review', days: 7 }],
      },
    });
  });

  test('pickup\'s interval is two hours when the file sets none, and nothing is checked for a feature left off', () => {
    const file = factory();
    delete file.pickup;
    file.features = { ...file.features, periodics: false };
    assert.deepEqual(checker.readConfig(JSON.stringify(file)), { ok: true, config: { issue: 412, pickupHours: 2, periodics: [] } });
    file.features = { ...file.features, pickup: false, periodics: true };
    assert.equal((checker.readConfig(JSON.stringify(file)) as { config: { pickupHours: unknown } }).config.pickupHours, null);
  });

  // A file with a key added after the caller's pinned commit still reads:
  // the checker reads only the keys it needs, without governor's schema.
  test('a key the checker does not know, which governor\'s schema refuses, still reads', () => {
    const file = { ...factory(), aKeyFromLater: { anything: true }, pickup: { sweepHours: 4, later: 1 } };
    assert.equal(governorReadConfig(JSON.stringify(file)).ok, false);
    const read = checker.readConfig(JSON.stringify(file));
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.config.pickupHours, 4);
  });

  test('a file it cannot use is a fault, never silence', () => {
    const faults: Array<[string, RegExp]> = [
      ['{ not json', /parse/i],
      ['[]', /object/],
      [JSON.stringify({ ...factory(), features: { pickup: true } }), /heartbeat/],
      [JSON.stringify({ ...factory(), heartbeat: undefined }), /heartbeat/],
      [JSON.stringify({ ...factory(), heartbeat: { issue: 'x' } }), /heartbeat\.issue/],
      [JSON.stringify({ ...factory(), heartbeat: { issue: 412, marker: '<!-- factory:hb -->' } }), /older shape/],
      [JSON.stringify({ ...factory(), pickup: { sweepHours: 'two' } }), /sweepHours/],
      [JSON.stringify({ ...factory(), periodics: 'none' }), /periodics/],
      [JSON.stringify({ ...factory(), periodics: [{ name: 'A' }] }), /days/],
      [JSON.stringify({ ...factory(), periodics: [{ days: 3 }] }), /name/],
    ];
    for (const [text, why] of faults) {
      const read = checker.readConfig(text);
      assert.equal(read.ok, false, text);
      assert.match((read as { fault: string }).fault, why, text);
    }
  });
});

/** A fake of the REST calls the checker makes, over one repo in memory. */
const github = (over: { config?: unknown, configStatus?: number, heartbeat?: unknown, heartbeatStatus?: number, configChanged?: string, issues?: Array<Record<string, unknown>>, failList?: boolean } = {}) => {
  const issues: Array<Record<string, unknown>> = over.issues ?? [];
  const calls: Array<{ method: string, path: string, body?: unknown }> = [];
  let next = 900;
  const fail = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const url = new URL(path, 'https://api.invalid');
    const p = url.pathname;
    if (method === 'GET' && p === `/repos/${REPO}/contents/.github/dispatch.json`) {
      assert.equal(url.searchParams.get('ref'), null, 'the default branch');
      if (over.configStatus !== undefined) throw fail(over.configStatus);
      const text = typeof over.config === 'string' ? over.config : JSON.stringify(over.config ?? factory());
      return { encoding: 'base64', content: Buffer.from(text).toString('base64') };
    }
    if (method === 'GET' && p === `/repos/${REPO}/commits`) {
      assert.equal(url.searchParams.get('path'), '.github/dispatch.json');
      return [{ commit: { committer: { date: over.configChanged ?? iso(NOW - 30 * DAY) } } }];
    }
    if (method === 'GET' && p === `/repos/${REPO}/issues/412`) {
      if (over.heartbeatStatus !== undefined) throw fail(over.heartbeatStatus);
      return { number: 412, body: over.heartbeat ?? BODY };
    }
    if (method === 'GET' && p === `/repos/${REPO}/issues`) {
      if (over.failList === true) throw fail(502);
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = Number(url.searchParams.get('per_page') ?? '30');
      return issues.filter((i) => i.state === 'open').slice((page - 1) * per, page * per);
    }
    if (method === 'POST' && p === `/repos/${REPO}/issues`) {
      const made = { number: next++, state: 'open', ...(body as object) };
      issues.push(made);
      return made;
    }
    const one = /^\/repos\/acme\/factory\/issues\/(\d+)(\/comments)?$/.exec(p);
    if (one !== null) {
      const issue = issues.find((i) => i.number === Number(one[1]));
      assert.ok(issue !== undefined, path);
      if (method === 'PATCH') Object.assign(issue, body);
      if (method === 'POST' && one[2] !== undefined) {
        const comments = (issue.comments ?? []) as unknown[];
        issue.comments = [...comments, (body as { body: string }).body];
      }
      return issue;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, issues, calls, open: () => issues.filter((i) => i.state === 'open') };
};

const fresh = () => stampHeartbeat(BODY, {
  pickup: { at: iso(NOW - HOUR), started: 0 },
  periodics: [
    { name: 'Weekly retro', at: iso(NOW - 6 * DAY), by: { days: 7 }, session: SESSION, state: 'signed off' },
    { name: 'Ticket review', at: iso(NOW - 2 * DAY), by: { days: 3 }, session: null, state: 'nothing to do' },
    { name: 'Code review', at: iso(NOW - DAY), by: { count: 'merges', number: 20 }, session: SESSION, state: 'open' },
  ],
});

const run = (gh: ReturnType<typeof github>, over: Record<string, unknown> = {}) =>
  checker.check({ api: gh.api, repo: REPO, now: NOW, toleranceHours: 3, labels: ['heartbeat', 'ops: alert'], log: () => {}, ...over });

describe('checking the heartbeat', () => {
  test('every line fresh: no issue opened', async () => {
    const gh = github({ heartbeat: fresh() });
    await run(gh);
    assert.deepEqual(gh.open(), []);
  });

  test('pickup older than its interval plus the tolerance gets one issue, carrying the caller\'s labels', async () => {
    const body = stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 6 * HOUR), started: 1 } });
    const gh = github({ heartbeat: body });
    await run(gh);
    const [issue, ...rest] = gh.open();
    assert.deepEqual(rest, []);
    assert.ok(issue !== undefined);
    assert.deepEqual(issue.labels, ['heartbeat', 'ops: alert']);
    assert.match(String(issue.title), /pickup/i);
    assert.match(String(issue.body), new RegExp(iso(NOW - 6 * HOUR).replaceAll('.', '\\.')));
    assert.match(String(issue.body), /2 hours/);
    assert.match(String(issue.body), /#412/);
    // A sweep five hours ago is inside two hours and the tolerance of three.
    const inside = github({ heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 5 * HOUR), started: 1 } }) });
    await run(inside);
    assert.deepEqual(inside.open(), []);
  });

  test('pickup\'s limit is the interval the file sets', async () => {
    const file = { ...factory(), pickup: { sweepHours: 12 } };
    const gh = github({ config: file, heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 14 * HOUR), started: 1 } }) });
    await run(gh);
    assert.deepEqual(gh.open(), []);
    await run(gh, { now: NOW + 2 * HOUR });
    assert.equal(gh.open().length, 1);
  });

  test('a periodic held for an open session gets an issue naming it, its last fire, its state and the session governor holds it for', async () => {
    const at = iso(NOW - 8 * DAY);
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { periodics: [{ name: 'Weekly retro', at, session: OTHER, state: 'held' }] }) });
    await run(gh);
    const [issue, ...rest] = gh.open();
    assert.deepEqual(rest, []);
    assert.ok(issue !== undefined);
    assert.match(String(issue.title), /"Weekly retro"/);
    const text = String(issue.body);
    assert.match(text, new RegExp(at.replaceAll('.', '\\.')));
    assert.match(text, /held/);
    assert.match(text, /session_01OTHER/);
    assert.match(text, /Governor is holding it/);
  });

  test('an overdue periodic governor is not holding says so', async () => {
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { periodics: [{ name: 'Ticket review', at: iso(NOW - 4 * DAY), by: { days: 3 }, session: SESSION, state: 'signed off' }] }) });
    await run(gh);
    const [issue] = gh.open();
    assert.match(String(issue?.title), /"Ticket review"/);
    assert.match(String(issue?.body), /signed off/);
    assert.match(String(issue?.body), /not holding it/);
  });

  test('an open run\'s line says governor will hold the next fire for it', async () => {
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { periodics: [{ name: 'Code review', at: iso(NOW - 8 * DAY), session: SESSION, state: 'open' }] }) });
    await run(gh);
    const [issue] = gh.open();
    assert.match(String(issue?.body), /session_01RUN/);
    assert.match(String(issue?.body), /has not signed off/);
  });

  test('a periodic governor has read but never fired is measured from its first read, and its issue says it has never fired', async () => {
    const at = iso(NOW - 8 * DAY);
    const unfired = (when: string) => stampHeartbeat(BODY, { ...readHeartbeat(fresh()), periodics: [...readHeartbeat(fresh()).periodics.filter((p) => p.name !== 'Weekly retro'), { name: 'Weekly retro', at: when, session: null, state: 'not fired' }] } as never);
    const gh = github({ heartbeat: unfired(at) });
    await run(gh);
    const [issue, ...rest] = gh.open();
    assert.deepEqual(rest, []);
    assert.match(String(issue?.title), /"Weekly retro"/);
    const text = String(issue?.body);
    assert.match(text, new RegExp(`first read .*${at.replaceAll('.', '\\.')}`));
    assert.match(text, /never fired/);
    assert.doesNotMatch(text, /last fired/);
    const read = github({ heartbeat: unfired(iso(NOW - 2 * DAY)) });
    await run(read);
    assert.deepEqual(read.open(), [], 'inside its day limit since the first read');
  });

  test('keeps one issue per line: a second run updates it, never opens another', async () => {
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 6 * HOUR), started: 1 } }) });
    await run(gh);
    await run(gh, { now: NOW + HOUR });
    assert.equal(gh.open().length, 1);
    assert.equal(gh.calls.filter((c) => c.method === 'POST' && c.path === `/repos/${REPO}/issues`).length, 1);
    assert.match(String(gh.open()[0]?.body), /7 hours ago|older than/);
  });

  test('closes the issue once the line is fresh again, and leaves other open issues alone', async () => {
    const someone = { number: 5, state: 'open', title: 'A ticket', body: 'Someone\'s ticket.' };
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 6 * HOUR), started: 1 } }), issues: [someone] });
    await run(gh);
    assert.equal(gh.open().length, 2);
    const later = github({ heartbeat: fresh(), issues: gh.issues });
    await run(later);
    assert.deepEqual(later.open().map((i) => i.number), [5]);
    const closed = later.issues.find((i) => i.number !== 5);
    assert.equal(closed?.state, 'closed');
    assert.equal((closed?.comments as unknown[]).length, 1);
  });

  test('finds its issues past the first page of open issues', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, state: 'open', title: `T${i}`, body: 'x' }));
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 6 * HOUR), started: 1 } }), issues: many });
    await run(gh);
    await run(gh);
    assert.equal(gh.open().length, 151);
  });

  test('a periodic or pickup with no line is overdue once the config file is older than its limit plus the tolerance', async () => {
    const body = stampHeartbeat(BODY, { pickup: { at: iso(NOW - HOUR), started: 0 } });
    const recent = github({ heartbeat: body, configChanged: iso(NOW - DAY) });
    await run(recent);
    assert.deepEqual(recent.open().map((i) => i.title), [], 'one day since the file changed: inside every day limit');
    const old = github({ heartbeat: body, configChanged: iso(NOW - 8 * DAY) });
    await run(old);
    assert.equal(old.open().length, 3);
    assert.ok(old.open().every((i) => /no line/.test(String(i.body))), JSON.stringify(old.open()));
  });

  test('a periodic name with spaces around it is matched trimmed, as governor stores it', async () => {
    const file = factory();
    file.periodics = file.periodics.map((p: { name: string }) => (p.name === 'Ticket review' ? { ...p, name: ' Ticket review ' } : p));
    const gh = github({ config: file, heartbeat: fresh() });
    await run(gh);
    assert.deepEqual(gh.open(), []);
  });

  test('closes its issue for a line the file no longer lists', async () => {
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 6 * HOUR), started: 1 } }) });
    await run(gh);
    assert.equal(gh.open().length, 1);
    const file = factory();
    file.features = { ...file.features, pickup: false };
    const off = github({ config: file, heartbeat: fresh(), issues: gh.issues });
    await run(off);
    assert.deepEqual(off.open(), []);
  });

  test('leaves alone an issue that only quotes its marker', async () => {
    const quoting = { number: 5, state: 'open', title: 'How the check works', body: 'Its issues start with `<!-- governor:heartbeat-check pickup -->`.' };
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 6 * HOUR), started: 1 } }), issues: [quoting] });
    await run(gh);
    assert.equal(gh.open().length, 2);
    assert.equal(quoting.title, 'How the check works');
  });

  test('a periodic the file lists twice gets one issue', async () => {
    const file = factory();
    file.periodics = [...file.periodics, file.periodics[0]];
    const gh = github({ config: file, heartbeat: stampHeartbeat(fresh(), { periodics: [{ name: 'Weekly retro', at: iso(NOW - 9 * DAY), session: null, state: 'nothing to do' }] }) });
    await run(gh);
    assert.equal(gh.open().length, 1);
  });

  test('reads when the config file last changed once a run', async () => {
    const gh = github({ heartbeat: BODY });
    await run(gh);
    assert.equal(gh.calls.filter((c) => c.path.startsWith(`/repos/${REPO}/commits`)).length, 1);
  });

  test('periodics in the block the file no longer lists are not checked', async () => {
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { periodics: [{ name: 'Gone', at: iso(NOW - 90 * DAY), by: { days: 1 }, session: null, state: 'nothing to do' }] }) });
    await run(gh);
    assert.deepEqual(gh.open(), []);
  });
});

describe('a check that cannot read opens an issue too, never silence', () => {
  const faulted = async (over: Parameters<typeof github>[0], why: RegExp) => {
    const gh = github(over);
    await run(gh);
    const [issue, ...rest] = gh.open();
    assert.deepEqual(rest, []);
    assert.ok(issue !== undefined, 'an issue');
    assert.deepEqual(issue.labels, ['heartbeat', 'ops: alert']);
    assert.match(String(issue.body), why);
    return gh;
  };

  test('no config file on the default branch', async () => { await faulted({ configStatus: 404 }, /\.github\/dispatch\.json/); });
  test('a config file read that fails', async () => { await faulted({ configStatus: 500 }, /HTTP 500/); });
  test('a config file that does not parse', async () => { await faulted({ config: '{ "heartbeat": ' }, /parse/i); });
  test('a heartbeat issue read that fails', async () => { await faulted({ heartbeat: fresh(), heartbeatStatus: 404 }, /#412/); });
  test('a heartbeat issue without governor\'s marker', async () => { await faulted({ heartbeat: 'Someone\'s ticket.' }, /governor:heartbeat/); });

  test('the fault\'s issue is kept, not duplicated, and closes once the check reads again', async () => {
    const gh = await faulted({ configStatus: 404 }, /dispatch\.json/);
    const again = github({ configStatus: 404, issues: gh.issues });
    await run(again);
    assert.equal(again.open().length, 1);
    const healed = github({ heartbeat: fresh(), issues: gh.issues });
    await run(healed);
    assert.deepEqual(healed.open(), []);
  });

  test('a fault leaves the lines\' issues as they are: the check cannot tell they are fresh', async () => {
    const gh = github({ heartbeat: stampHeartbeat(fresh(), { pickup: { at: iso(NOW - 6 * HOUR), started: 1 } }) });
    await run(gh);
    const broken = github({ configStatus: 500, issues: gh.issues });
    await run(broken);
    assert.equal(broken.open().length, 2);
  });

  test('a failure to list or write issues fails the run, so the workflow goes red', async () => {
    await assert.rejects(run(github({ failList: true })), /HTTP 502/);
  });
});

describe('the run\'s inputs', () => {
  test('labels are split on commas and new lines, and the tolerance must be a number of hours', () => {
    assert.deepEqual(checker.labelsOf(' heartbeat, ops: alert\n\nother '), ['heartbeat', 'ops: alert', 'other']);
    assert.deepEqual(checker.labelsOf(''), []);
    assert.equal(checker.toleranceOf('3'), 3);
    assert.equal(checker.toleranceOf('0.5'), 0.5);
    assert.throws(() => checker.toleranceOf('soon'), /tolerance/);
    assert.throws(() => checker.toleranceOf('-1'), /tolerance/);
  });
});
