/**
 * What a shipping job, or a red run, on main covers:
 * where its baseline is, the merges since, the PRs its paths pick, each
 * PR's closing tickets and its sessions, or the one reason it covers
 * nothing knowable. The label write and the messages (dispatch/turn.mjs,
 * dispatch/workflow.mjs) read this one fact set. Every read is injected.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coverageOf } from '../dispatch/coverage.mjs';
import { BASELINE_READS_MAX, RUNS_PAGES_MAX, STALE_RUNS_PAUSES_MS } from '../dispatch/runs.mjs';
import { RUNS_PER_PAGE } from '../scripts/lib/github-app.mjs';
import { ticketsOf } from '../dispatch/turn.mjs';
import { FACTORY_WORKFLOWS, WORKFLOW_PATHS, workflowFile } from './helpers/dispatch-workflows.ts';

const REPO = 'acme/factory';
const HEAD = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const OLDER = 'a'.repeat(40);
const SESSION = 'https://claude.ai/code/session_01WROTEIT';
const LABEL = 'deployed: mcp registry';
const PATH = '.github/workflows/publish-mcp.yml';

/** A marked job's name: `name` with the marker, and the commit it built where it names one. */
const marked = (name: string, label: string, commit?: string) => `${name}${commit === undefined ? '' : ` at ${commit}`} · ${label}`;
const MCP_JOB = marked('Publish to MCP Registry', LABEL);
const file = (env: string, on = 'on:\n  workflow_dispatch:\n', jobs = `  publish:\n    name: "${MCP_JOB}"\n    runs-on: ubuntu-latest\n    steps: []\n`) => `name: W\n${on}${env}jobs:\n${jobs}`;
const run = (id: number, conclusion: string, head: string, event = 'workflow_dispatch') => ({ id, status: 'completed', conclusion, event, head_branch: 'main', head_sha: head, html_url: `https://x/${id}`, created_at: `2026-09-25T11:${String(id % 60).padStart(2, '0')}:00Z` });
const pull = (number: number, sha: string, body: string, head = '') => ({ number, title: `PR ${number}`, html_url: `https://x/${number}`, body, merged_at: `2026-09-25T11:0${number % 10}:00Z`, merge_commit_sha: sha, head });
const merge = (n: number) => String(n).padStart(40, '0');
/** The job fire the receiver queues for MCP_JOB succeeding in run 500. */
const invocation = { kind: 'job' as const, name: MCP_JOB, workflow: 'Publish to MCP Registry', branch: 'main', runId: 500, jobId: 9001, url: 'https://x/500/job/9001', headSha: HEAD, label: LABEL, commit: HEAD };
/** The workflow fire for run 500 of the same workflow, red. */
const red = { kind: 'workflow' as const, name: 'Publish to MCP Registry', path: PATH, branch: 'main', event: 'push', runId: 500, url: 'https://x/500', conclusion: 'failure', headSha: HEAD };
const job = (name: string, conclusion = 'success') => ({ name, conclusion, html_url: '' });
const shipped = [job(MCP_JOB)];
const MCP = file('env:\n  TICKET_LABEL_PATHS: server.json\n');

const reader = (over: Record<string, unknown> = {}) => {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      run: async (id: number) => { asked.push(`run ${id}`); return { ...run(id, 'success', HEAD), path: PATH, run_attempt: 1 }; },
      fileAt: async (path: string) => { asked.push(`file ${path}`); return MCP; },
      runJobs: async (id: number) => { asked.push(`jobs ${id}`); return shipped; },
      workflowRuns: async () => { asked.push('runs'); return [run(500, 'success', HEAD), run(499, 'success', BASE)]; },
      compareCommits: async (base: string, head: string) => { asked.push(`compare ${base.slice(0, 1)}...${head.slice(0, 1)}`); return [{ sha: merge(1), message: 'Merge pull request #1 from x' }, { sha: merge(2), message: 'Merge pull request #2 from x' }]; },
      pullsForCommit: async (sha: string) => (sha === merge(1) ? [pull(1, sha, `Closes #11\nFixes #12\n\nBody.\n\n${SESSION}`)] : sha === merge(2) ? [pull(2, sha, 'Closes #21')] : []),
      pullFiles: async (n: number) => { asked.push(`files ${n}`); return n === 1 ? [{ filename: 'README.md', status: 'modified' }, { filename: 'server.json', status: 'modified' }] : [{ filename: 'src/x.ts', status: 'renamed', previous: 'src/y.ts' }]; },
      ...over,
    },
  };
};
type Cursor = { runId: number; commit: string; created: string } | null;
type CursorRead = (workflow: string, label: string | null) => Promise<Cursor>;
const cover = (r: ReturnType<typeof reader>, over: Record<string, unknown> = {}, cursor: CursorRead = async () => null, onBranch?: (branch: string) => Promise<string | null>) =>
  coverageOf({ invocation: { ...invocation, ...over } as never, reader: r.reader as never, repo: REPO, workflows: FACTORY_WORKFLOWS, sleep: async () => {}, cursor, ...(onBranch === undefined ? {} : { onBranch }) });
const coverRed = (r: ReturnType<typeof reader>, over: Record<string, unknown> = {}, cursor: CursorRead = async () => null) =>
  coverageOf({ invocation: { ...red, ...over } as never, reader: r.reader as never, repo: REPO, workflows: FACTORY_WORKFLOWS, sleep: async () => {}, cursor });

describe('coverageOf — a shipping job that succeeded', () => {
  test('covers the merges since the last green run that shipped its label, the PRs its paths pick, and each PR\'s closing tickets', async () => {
    const r = reader();
    const c = await cover(r);
    assert.equal(c.reason, null);
    assert.equal(c.label, LABEL);
    assert.equal(c.workflow, 'publish-mcp.yml');
    assert.deepEqual(c.declared, { paths: ['server.json'], merge: false });
    assert.deepEqual(c.range, { baseline: { id: 499, commit: BASE, created: run(499, 'success', BASE).created_at }, end: HEAD, merges: 2 });
    assert.deepEqual(c.shipped.map((p) => p.number), [1, 2]);
    assert.deepEqual(c.picked.map((p) => p.number), [1]);
    assert.deepEqual([...c.closes], [[1, [11, 12]], [2, [21]]]);
    assert.deepEqual(c.at, { runId: 500, commit: HEAD, created: run(500, 'success', HEAD).created_at });
    assert.ok(r.asked.includes('run 500'), 'the run is read for its workflow file');
    assert.ok(r.asked.includes(`file ${PATH}`), r.asked.join(', '));
    assert.ok(r.asked.includes('compare b...c'), r.asked.join(', '));
    assert.ok(!r.asked.includes('jobs 500'), 'the fire says the job succeeded: its own jobs are not read');
  });

  test('reads each fact once', async () => {
    const r = reader();
    await cover(r);
    assert.deepEqual(r.asked.filter((a, i) => r.asked.indexOf(a) !== i), [], r.asked.join(', '));
  });

  test('`all` picks every PR and reads no PR files', async () => {
    const r = reader({ fileAt: async () => file('env:\n  TICKET_LABEL_PATHS: all\n') });
    const c = await cover(r);
    assert.deepEqual(c.picked.map((p) => p.number), [1, 2]);
    assert.ok(!r.asked.some((a) => a.startsWith('files')));
  });

  test('a closing reference below the body\'s top closes its ticket as GitHub reads it', async () => {
    const r = reader({ pullsForCommit: async (sha: string) => (sha === merge(1) ? [pull(1, sha, 'Fix the parser.\n\nCloses #31')] : []) });
    assert.deepEqual([...(await cover(r)).closes], [[1, [31]]]);
  });

  test('a rename is picked on the path it left', async () => {
    const r = reader({ fileAt: async () => file('env:\n  TICKET_LABEL_PATHS: src/y.ts\n') });
    assert.deepEqual((await cover(r)).picked.map((p) => p.number), [2]);
  });

  test('a baseline that shipped nothing is passed over for the green run before it', async () => {
    const r = reader({
      workflowRuns: async () => [run(500, 'success', HEAD), run(499, 'success', BASE), run(498, 'failure', BASE), run(497, 'success', OLDER)],
      runJobs: async (id: number) => (id === 499 ? [job('Dry run: Publish to MCP Registry')] : shipped),
    });
    const c = await cover(r);
    assert.equal(c.range?.baseline.id, 497);
    assert.ok(r.asked.includes('compare a...c'), r.asked.join(', '));
  });

  // One run earns two labels in turn, and a run that stopped
  // after dev is no baseline for prod.
  test('the baseline is the last green run whose job marked with this label succeeded, not one that shipped another label', async () => {
    const DEV = 'deployed: dev';
    const PROD = 'deployed: prod';
    const r = reader({
      run: async (id: number) => ({ ...run(id, 'success', HEAD), path: WORKFLOW_PATHS.Deliver, run_attempt: 1 }),
      fileAt: async () => file('env:\n  TICKET_LABEL_PATHS: all\n'),
      workflowRuns: async () => [run(500, 'success', HEAD), run(499, 'success', BASE), run(498, 'success', OLDER)],
      runJobs: async (id: number) => (id === 499
        ? [job(marked('dev / Publish (dev)', DEV, BASE)), job(marked('prod / Publish (prod)', PROD, BASE), 'skipped')]
        : [job(marked('dev / Publish (dev)', DEV, OLDER)), job(marked('prod / Publish (prod)', PROD, OLDER))]),
    });
    const asked: Array<[string, string | null]> = [];
    const prod = await cover(r, { name: marked('prod / Publish (prod)', PROD, HEAD), workflow: 'Deliver', label: PROD }, async (workflow, label) => { asked.push([workflow, label]); return null; });
    assert.deepEqual(asked, [['deliver.yml', PROD]], 'the cursor is read for this label');
    assert.equal(prod.range?.baseline.id, 498, 'run 499 shipped dev alone');
    assert.ok(r.asked.includes('compare a...c'), r.asked.join(', '));
    const dev = await cover(r, { name: marked('dev / Publish (dev)', DEV, HEAD), workflow: 'Deliver', label: DEV });
    assert.equal(dev.range?.baseline.id, 499);
  });

  test('the range runs from the commit each run built, where its job names one', async () => {
    const BUILT = 'e'.repeat(40);
    const BEFORE = 'f'.repeat(40);
    const APPLE = 'deployed: app store connect';
    const r = reader({
      run: async (id: number) => ({ ...run(id, 'success', HEAD), path: WORKFLOW_PATHS['Apple release'], run_attempt: 1 }),
      runJobs: async (id: number) => [job(marked('Apple release', APPLE, id === 500 ? BUILT : BEFORE))],
    });
    const c = await cover(r, { name: marked('Apple release', APPLE, BUILT), workflow: 'Apple release', label: APPLE, commit: BUILT });
    assert.ok(r.asked.includes('compare f...e'), r.asked.join(', '));
    assert.equal(c.range?.end, BUILT);
    assert.equal(c.at?.commit, BUILT);
    assert.equal(c.workflow, 'apple-release.yml');
  });

  // The cursor is the newest run a turn planned; a run whose turn refused is past it.
  test('the range starts at the label\'s cursor, past a run whose turn refused', async () => {
    const r = reader({ workflowRuns: async () => [run(500, 'success', HEAD), run(499, 'success', BASE), run(497, 'success', OLDER)] });
    const c = await cover(r, {}, async () => ({ runId: 497, commit: OLDER, created: '2026-09-25T10:00:00Z' }));
    assert.equal(c.range?.baseline.id, 497);
    assert.deepEqual(c.from, { runId: 497, commit: OLDER, created: '2026-09-25T10:00:00Z' });
    assert.ok(r.asked.includes('compare a...c'), r.asked.join(', '));
    assert.ok(!r.asked.includes('jobs 499'), r.asked.join(', '));
  });

  // A re-run attempt, or a second job marked with the same label in one run
  // (Publish Extensions has two), fires again: the cursor keeps it to once.
  test('a cursor at or past the run means a turn planned it: nothing is read past the cursor, and nothing covered', async () => {
    for (const at of [500, 501]) {
      const r = reader();
      const c = await cover(r, { runAttempt: 2 }, async () => ({ runId: at, commit: OLDER, created: '' }));
      assert.match(String(c.reason), /run 500[\s\S]*cursor[\s\S]*run \d+/, `cursor at ${at}`);
      assert.deepEqual([c.range, c.shipped, c.picked], [null, [], []], `cursor at ${at}`);
      assert.equal(c.stale, null, 'nothing to page on');
      assert.ok(!r.asked.some((a) => a.startsWith('compare') || a.startsWith('jobs')), r.asked.join(', '));
    }
  });

  test('a cursor it cannot read covers nothing, and the turn pages on it', async () => {
    const r = reader();
    const c = await cover(r, {}, async () => { throw new Error('AccessDeniedException'); });
    assert.match(String(c.reason), /AccessDeniedException/);
    assert.deepEqual(c.stale, { newest: null });
    assert.ok(!r.asked.some((a) => a.startsWith('compare')), r.asked.join(', '));
  });

  test('a runs list that lacks the run after every re-read covers nothing, naming the newest run it held', async () => {
    const slept: number[] = [];
    const r = reader({ workflowRuns: async () => [run(497, 'success', BASE)] });
    const c = await coverageOf({ invocation: invocation as never, reader: r.reader as never, repo: REPO, workflows: FACTORY_WORKFLOWS, sleep: async (ms: number) => { slept.push(ms); }, cursor: async () => null });
    assert.deepEqual(slept, STALE_RUNS_PAUSES_MS);
    assert.match(String(c.reason), /run 497/);
    assert.equal(c.stale?.newest?.id, 497);
  });

  test('a baseline search that runs out of job reads says so', async () => {
    const runs = [run(500, 'success', HEAD), ...Array.from({ length: BASELINE_READS_MAX + 5 }, (_, i) => run(499 - i, 'success', BASE))];
    const reads: number[] = [];
    const r = reader({
      workflowRuns: async () => runs,
      runJobs: async (id: number) => { reads.push(id); return [job('Dry run: Publish to MCP Registry')]; },
    });
    const c = await cover(r);
    assert.match(String(c.reason), new RegExp(`stopped at the jobs of ${BASELINE_READS_MAX} green runs`));
    assert.equal(reads.length, BASELINE_READS_MAX, 'the candidates\' jobs, never the run\'s own');
  });

  // One rule for a run that shipped no merge its baseline had not.
  test('a job of its baseline\'s own commit, or of a commit its baseline covers, shipped no merge', async () => {
    const own = await cover(reader({ workflowRuns: async () => [run(500, 'success', HEAD), run(499, 'success', HEAD)] }));
    assert.match(String(own.reason), /shipped no merge since run 499/);
    assert.equal(own.range?.baseline.id, 499, 'the range it read is kept');
    const behind = reader({ workflowRuns: async () => [run(500, 'success', HEAD), run(499, 'success', BASE)], compareCommits: async () => [] });
    assert.match(String((await cover(behind)).reason), /shipped no merge since run 499/);
  });

  test('covers nothing, saying why, for a run it cannot read, one of no workflow file, an unreadable or silent file, or no baseline', async () => {
    const cases: Array<[string, ReturnType<typeof reader>, RegExp]> = [
      ['run', reader({ run: async () => { throw new Error('GET /actions/runs/500 failed: 502'); } }), /502/],
      ['path', reader({ run: async (id: number) => ({ ...run(id, 'success', HEAD), path: 'dynamic/pages/pages-build-deployment', run_attempt: 1 }) }), /workflow file/],
      ['404', reader({ fileAt: async () => { throw new Error('GET failed: 404'); } }), /404/],
      ['declares', reader({ fileAt: async () => file('') }), /TICKET_LABEL_PATHS/],
      ['no green', reader({ workflowRuns: async () => [run(500, 'success', HEAD), run(499, 'failure', BASE)] }), /no successful Publish to MCP Registry run that shipped deployed: mcp registry before run 500/],
    ];
    for (const [why, r, want] of cases) {
      const c = await cover(r);
      assert.ok(c.reason !== null && c.reason.length > 0, why);
      assert.match(c.reason, want, why);
      assert.deepEqual(c.shipped, [], why);
      assert.ok(!r.asked.some((a) => a.startsWith('compare')), `${why}: ${r.asked.join(', ')}`);
    }
  });

  test('a PR\'s sessions: the one its footer names, else the live session on its head branch; one with neither is unnamed', async () => {
    const r = reader({
      fileAt: async () => file('env:\n  TICKET_LABEL_PATHS: all\n'),
      pullsForCommit: async (sha: string) => (sha === merge(1) ? [pull(1, sha, `Closes #11\n\n${SESSION}`)] : sha === merge(2) ? [pull(2, sha, 'Closes #21', 'feature/b')] : []),
    });
    const c = await cover(r, {}, async () => null, async (branch) => (branch === 'feature/b' ? 'https://claude.ai/code/session_01LOCAL' : null));
    const { sessions, owned, unnamed } = await c.sessions(c.picked, 'deploys');
    assert.deepEqual([...sessions.values()].map((s) => [s.session, s.own.map((p) => p.number)]), [[SESSION, [1]], ['https://claude.ai/code/session_01LOCAL', [2]]]);
    assert.deepEqual([...owned], [1, 2]);
    assert.deepEqual(unnamed, []);
    const none = await cover(r, {}, async () => null, async () => null);
    assert.match(String((await none.sessions(none.picked, 'deploys')).unnamed[0]?.reason), /no live session holds its head branch feature\/b/);
  });
});

/**
 * A red run of a workflow declaring a deploy target: its target is the
 * final stage's, read off the file's jobs (dispatch/labels.mjs), since no
 * job of its names one.
 */
describe('coverageOf — a red run of a deploy workflow', () => {
  const DELIVER = { ...red, name: 'Deliver', path: WORKFLOW_PATHS.Deliver };
  const PROD = 'deployed: prod';
  const files: string[] = [];
  const deliver = (over: Record<string, unknown> = {}) => reader({
    fileAt: async (path: string) => { files.push(path); return workflowFile(path); },
    runJobs: async (id: number) => (id === 500
      ? [job(marked('dev / Publish (dev)', 'deployed: dev', HEAD)), job(marked('prod / Publish (prod)', PROD, HEAD), 'failure')]
      : [job(marked('dev / Publish (dev)', 'deployed: dev', BASE)), job(marked('prod / Publish (prod)', PROD, BASE))]),
    workflowRuns: async () => [run(500, 'failure', HEAD, 'workflow_run'), run(499, 'success', BASE, 'workflow_run')],
    ...over,
  });

  test('its target is the last shipping label of the file\'s jobs, a uses: job\'s read from the called file; the baseline is that label\'s', async () => {
    const r = deliver();
    const asked: Array<[string, string | null]> = [];
    const c = await coverRed(r, DELIVER, async (workflow, label) => { asked.push([workflow, label]); return null; });
    assert.equal(c.reason, null);
    assert.equal(c.label, PROD);
    assert.deepEqual(asked, [['deliver.yml', PROD]]);
    assert.ok(files.includes(WORKFLOW_PATHS['Deploy Stage']!), files.join(', '));
    assert.equal(c.range?.baseline.id, 499);
    assert.deepEqual(c.shipped.map((p) => p.number), [1, 2]);
    assert.equal(c.jobs.length, 2, 'a red run\'s jobs are read for the failed ones');
    assert.equal(c.at?.commit, HEAD);
  });

  test('a run whose prod job never succeeded is no prod baseline, though its dev job did', async () => {
    const r = deliver({
      workflowRuns: async () => [run(500, 'failure', HEAD, 'workflow_run'), run(499, 'success', BASE, 'workflow_run'), run(498, 'success', OLDER, 'workflow_run')],
      runJobs: async (id: number) => (id === 499
        ? [job(marked('dev / Publish (dev)', 'deployed: dev', BASE)), job(marked('prod / Publish (prod)', PROD, BASE), 'skipped')]
        : [job(marked('dev / Publish (dev)', 'deployed: dev', id === 500 ? HEAD : OLDER)), job(marked('prod / Publish (prod)', PROD, id === 500 ? HEAD : OLDER), id === 500 ? 'failure' : 'success')]),
    });
    const c = await coverRed(r, DELIVER);
    assert.equal(c.range?.baseline.id, 498);
  });

  // A red rollback of a commit its baseline built is still news.
  test('a red run of its baseline\'s own commit shipped no merge; a red rollback did', async () => {
    const redOwn = deliver({ workflowRuns: async () => [run(500, 'failure', HEAD, 'workflow_run'), run(499, 'success', HEAD, 'workflow_run')], runJobs: async (id: number) => [job(marked('prod / Publish (prod)', PROD, HEAD), id === 500 ? 'failure' : 'success')] });
    assert.match(String((await coverRed(redOwn, DELIVER)).reason), /shipped no merge since run 499/);
    const rollback = deliver({
      runJobs: async (id: number) => [job(marked('prod / Publish (prod)', PROD, id === 500 ? HEAD : BASE), id === 500 ? 'failure' : 'success')],
      compareCommits: async () => [],
      pullsForCommit: async (sha: string) => (sha === HEAD ? [pull(5, HEAD, 'x')] : []),
    });
    const c = await coverRed(rollback, DELIVER);
    assert.equal(c.reason, null);
    assert.deepEqual(c.shipped.map((p) => p.number), [5]);
  });

  test('a red release dispatched by hand covers nothing and reads no jobs: whoever dispatched it is watching it', async () => {
    const r = reader();
    const c = await coverRed(r);
    assert.match(String(c.reason), /dispatched by hand/);
    assert.ok(!r.asked.some((a) => a.startsWith('jobs')), r.asked.join(', '));
  });

  test('a red run a merge started is news whichever job stopped it, shipping job run or not', async () => {
    // A train red before its dev stage still failed to release its merges;
    // only a release by hand with no shipping job run (a dry run) deployed
    // nothing anyone is waiting on.
    const r = reader({
      fileAt: async () => workflowFile(WORKFLOW_PATHS['Dispatch stack']!),
      runJobs: async (id: number) => (id === 500
        ? [job('Build the image, apply the stack, probe the task', 'failure')]
        : [job(marked('Build the image, apply the stack, probe the task', 'deployed: the dispatcher', BASE))]),
      workflowRuns: async () => [run(500, 'failure', HEAD, 'push'), run(499, 'success', BASE, 'push')],
    });
    const c = await coverRed(r, { name: 'Dispatch stack', path: WORKFLOW_PATHS['Dispatch stack'] });
    assert.equal(c.reason, null, 'a red run a merge started covers its merges');
    assert.deepEqual(c.shipped.map((p) => p.number), [1, 2]);
  });

  test('a red prod release by hand whose shipping job never ran deployed nothing', async () => {
    const r = reader({
      fileAt: async () => 'name: Release\non:\n  workflow_dispatch:\nenv:\n  TICKET_LABEL_PATHS: all\njobs:\n  ship:\n    name: "Ship at ${{ github.sha }} · deployed: prod"\n    runs-on: ubuntu-latest\n    steps: []\n',
      runJobs: async () => [job(marked('Ship', 'deployed: prod', HEAD), 'skipped')],
    });
    assert.match(String((await coverRed(r, { name: 'Release', path: '.github/workflows/release.yml' })).reason), /deployed nothing/);
  });

  test('a green workflow fire covers nothing: its shipping jobs fired on their own', async () => {
    const r = reader();
    const c = await coverRed(r, { conclusion: 'success' });
    assert.match(String(c.reason), /shipping job/);
    assert.deepEqual(r.asked, []);
  });

  test('covers nothing, saying why, for a run naming no file, an unreadable file, a file with no marked job, or no baseline', async () => {
    const cases: Array<[string, ReturnType<typeof reader>, Record<string, unknown>, RegExp]> = [
      ['no path', deliver(), { ...DELIVER, path: undefined }, /names no workflow file/],
      ['404', deliver({ fileAt: async () => { throw new Error('GET failed: 404'); } }), DELIVER, /404/],
      ['called 404', deliver({ fileAt: async (path: string) => { if (path === WORKFLOW_PATHS.Deliver) return workflowFile(path); throw new Error('GET failed: 404'); } }), DELIVER, /404/],
      ['declares', deliver({ fileAt: async () => 'name: Deliver\non:\n  push:\nenv:\n  TICKET_LABEL_PATHS: all\njobs:\n  a:\n    name: Build\n    runs-on: ubuntu-latest\n    steps: []\n' }), DELIVER, /declares no deploy target/],
      ['no green', deliver({ workflowRuns: async () => [run(500, 'failure', HEAD, 'workflow_run'), run(499, 'failure', BASE, 'workflow_run')] }), DELIVER, /no successful Deliver run that shipped deployed: prod/],
    ];
    for (const [why, r, over, want] of cases) {
      const c = await coverRed(r, over);
      assert.ok(c.reason !== null && c.reason.length > 0, why);
      assert.match(c.reason, want, why);
      assert.deepEqual(c.shipped, [], why);
    }
  });
});

describe('coverageOf — a red CI run', () => {
  const ci = { ...red, name: 'CI', path: '.github/workflows/ci.yml' };
  const ciReader = (runs: ReturnType<typeof run>[], over: Record<string, unknown> = {}) => reader({ workflowRuns: async () => runs, runJobs: async () => [job('test', 'failure')], ...over });

  test('covers the merges since the CI run before it, every one a suspect, reads no workflow file, and reads CI\'s own label-less cursor', async () => {
    const r = ciReader([run(500, 'failure', HEAD, 'push'), run(499, 'success', BASE, 'push')]);
    const asked: Array<[string, string | null]> = [];
    const c = await coverRed(r, ci, async (workflow, label) => { asked.push([workflow, label]); return null; });
    assert.equal(c.reason, null);
    assert.deepEqual(asked, [['ci.yml', null]]);
    assert.equal(c.label, null);
    assert.equal(c.workflow, 'ci.yml');
    assert.equal(c.baseline?.conclusion, 'success');
    assert.deepEqual(c.picked.map((p) => p.number), [1, 2]);
    assert.ok(!r.asked.some((a) => a.startsWith('file')), r.asked.join(', '));
  });

  test('a CI run before it that was red stops the reading there: its breaker was told', async () => {
    const r = ciReader([run(500, 'failure', HEAD, 'push'), run(499, 'failure', BASE, 'push')]);
    const c = await coverRed(r, ci);
    assert.equal(c.baseline?.conclusion, 'failure');
    assert.ok(!r.asked.some((a) => a.startsWith('compare') || a.startsWith('jobs')), r.asked.join(', '));
    assert.equal(c.at?.runId, 500);
  });

  test('a red run newer than the cursor was never planned, so it is passed over for the green one before it', async () => {
    const r = ciReader([run(500, 'failure', HEAD, 'push'), run(499, 'failure', BASE, 'push'), run(498, 'success', OLDER, 'push')]);
    const c = await coverRed(r, ci, async () => ({ runId: 498, commit: OLDER, created: '' }));
    assert.equal(c.baseline?.id, 498);
  });

  // The receiver forwards a red CI run whatever started it; the
  // task refuses one a push did not start: dispatched by hand (`only` one
  // job, say), it tested no merge (dispatcher-workflows.md).
  test('a red CI run a push did not start covers nothing and reads no runs: it tested no merge', async () => {
    for (const event of ['workflow_dispatch', 'schedule', undefined]) {
      let listed = 0;
      const r = ciReader([], { workflowRuns: async () => { listed += 1; return [run(500, 'failure', HEAD, event ?? 'push'), run(499, 'success', BASE, 'push')]; } });
      const c = await coverRed(r, { ...ci, event });
      assert.match(String(c.reason), /not a push: it tested no merge/, String(event));
      assert.equal(listed, 0, `${String(event)}: no runs read`);
    }
  });

  test('a run dispatched by hand says nothing about main', async () => {
    const r = ciReader([run(500, 'failure', HEAD, 'push'), run(499, 'failure', BASE, 'workflow_dispatch'), run(498, 'success', OLDER, 'push')]);
    assert.equal((await coverRed(r, ci)).baseline?.id, 498);
  });

  test('a green CI run covers nothing and reads nothing', async () => {
    const r = ciReader([run(500, 'success', HEAD, 'push')]);
    const c = await coverRed(r, { ...ci, conclusion: 'success' });
    assert.match(String(c.reason), /shipping job/);
    assert.deepEqual(r.asked, []);
  });
});

/**
 * The runs list a baseline is read from: it can lag
 * the run, a branch-filtered index can be days old, and a baseline can sit
 * pages back. A list holding the run holds every run between it and its
 * baseline; one lacking it is read again, and never read a range from.
 */
describe('coverageOf — the runs list', () => {
  test('a runs list lacking the run is read again after a pause, and the fresh one is read from', async () => {
    const lists = [[run(497, 'success', OLDER)], [run(500, 'success', HEAD), run(499, 'success', BASE), run(497, 'success', OLDER)]];
    const slept: number[] = [];
    const r = reader({ workflowRuns: async () => { r.asked.push('runs'); return lists.shift() ?? []; } });
    const c = await coverageOf({ invocation: invocation as never, reader: r.reader as never, repo: REPO, workflows: FACTORY_WORKFLOWS, sleep: async (ms: number) => { slept.push(ms); }, cursor: async () => null });
    assert.deepEqual(slept, [STALE_RUNS_PAUSES_MS[0]]);
    assert.equal(r.asked.filter((a) => a === 'runs').length, 2);
    assert.equal(c.reason, null);
    assert.ok(r.asked.includes('compare b...c'), r.asked.join(', '));
  });

  test('a red CI run whose runs list lacks it covers nothing, naming the newest run it held, and reads no range', async () => {
    const r = reader({ workflowRuns: async () => [run(497, 'success', BASE, 'push')] });
    const c = await coverRed(r, { name: 'CI', path: '.github/workflows/ci.yml' });
    assert.match(String(c.reason), /run 497/);
    assert.equal(c.stale?.newest?.id, 497);
    assert.ok(!r.asked.some((a) => a.startsWith('compare') || a.startsWith('jobs')), r.asked.join(', '));
  });

  test('a runs list holding no run at all is stale, naming no newest run', async () => {
    const c = await cover(reader({ workflowRuns: async () => [] }));
    assert.deepEqual(c.stale, { newest: null });
  });

  // GitHub's branch-filtered list has served an index months old while the unfiltered one held the run (Deploy run 36879724895).
  test('the runs list is read unfiltered, and main\'s runs kept from it', async () => {
    const r = reader({
      workflowRuns: async (_file: string, options: Record<string, unknown> = {}) => ('branch' in options || 'event' in options || 'status' in options
        ? [run(497, 'success', OLDER)]
        : [run(500, 'success', HEAD), run(499, 'success', BASE)]),
    });
    const c = await cover(r);
    assert.equal(c.stale, null);
    assert.equal(c.range?.baseline.id, 499);
  });

  test('a run on another branch is never the baseline, nor makes the list fresh', async () => {
    const onBranch = { head_branch: 'claude/x' };
    const past = await cover(reader({ workflowRuns: async () => [run(500, 'success', HEAD), { ...run(499, 'success', BASE), ...onBranch }, run(498, 'success', OLDER)] }));
    assert.equal(past.range?.baseline.id, 498);
    const branchOnly = await cover(reader({ workflowRuns: async () => [{ ...run(500, 'success', HEAD), ...onBranch }, run(498, 'success', OLDER)] }));
    assert.notEqual(branchOnly.stale, null);
  });

  /** Runs `from` down to `to` of `conclusion`, `over` applied to each. */
  const runsDown = (from: number, to: number, conclusion: string, over: Record<string, unknown> = {}) =>
    Array.from({ length: from - to + 1 }, (_, i) => ({ ...run(from - i, conclusion, OLDER, 'push'), ...over }));
  /** A reader whose runs list pages `all` RUNS_PER_PAGE at a time, newest first. */
  const paged = (all: ReturnType<typeof run>[], over: Record<string, unknown> = {}) => {
    const r = reader({
      workflowRuns: async (_file: string, { page = 1 }: { page?: number } = {}) => { r.asked.push(`runs page ${page}`); return all.slice((page - 1) * RUNS_PER_PAGE, page * RUNS_PER_PAGE); },
      ...over,
    });
    return r;
  };
  const ci = { name: 'CI', path: '.github/workflows/ci.yml' };
  const pages = (r: ReturnType<typeof reader>) => r.asked.filter((a) => a.startsWith('runs'));

  test('a baseline past the first page of runs is read on to, past skipped runs or other branches\' runs', async () => {
    for (const between of [runsDown(499, 420, 'skipped'), runsDown(499, 420, 'success', { head_branch: 'claude/x' })]) {
      const r = paged([run(500, 'success', HEAD), ...between, run(419, 'success', BASE), ...runsDown(418, 380, 'success')]);
      const c = await cover(r);
      assert.deepEqual(pages(r), ['runs page 1', 'runs page 2']);
      assert.equal(c.range?.baseline.id, 419);
      assert.ok(r.asked.includes('compare b...c'), r.asked.join(', '));
    }
  });

  test('a red CI run whose last conclusive run is past the first page reads on to it', async () => {
    const r = paged([run(500, 'failure', HEAD, 'push'), ...runsDown(499, 430, 'cancelled'), run(429, 'success', BASE, 'push')], { runJobs: async () => [job('test', 'failure')] });
    const c = await coverRed(r, ci);
    assert.deepEqual(pages(r), ['runs page 1', 'runs page 2']);
    assert.equal(c.baseline?.id, 429);
  });

  test('runs that run out before a baseline cover nothing, counting the runs of main read once each', async () => {
    const all = [run(500, 'success', HEAD), ...runsDown(499, 431, 'skipped')];
    const out = paged(all);
    const c = await cover(out);
    assert.deepEqual(pages(out), ['runs page 1', 'runs page 2'], 'a short page is the last');
    assert.ok(!out.asked.some((a) => a.startsWith('compare')), 'no range without a baseline');
    assert.match(String(c.reason), /no successful Publish to MCP Registry run that shipped deployed: mcp registry before run 500 in the 70 runs of publish-mcp\.yml/);

    // Ten runs created after page 1 was read shift page 2 ten runs newer.
    const shifted = reader({ workflowRuns: async (_file: string, { page = 1 }: { page?: number } = {}) => (page === 1 ? all.slice(0, RUNS_PER_PAGE) : all.slice((page - 1) * RUNS_PER_PAGE - 10, page * RUNS_PER_PAGE - 10)) });
    assert.match(String((await cover(shifted)).reason), /in the 70 runs of publish-mcp\.yml/);

    const red = paged([run(500, 'failure', HEAD, 'push'), ...runsDown(499, 441, 'cancelled')]);
    assert.match(String((await coverRed(red, ci)).reason), /^no finished CI run before run 500 in the 60 runs of ci\.yml on main/);
    const others = paged([run(500, 'failure', HEAD, 'push'), ...runsDown(499, 480, 'cancelled', { head_branch: 'claude/x' }), ...runsDown(479, 441, 'cancelled')]);
    assert.match(String((await coverRed(others, ci)).reason), /^no finished CI run before run 500 in the 40 runs of ci\.yml on main/);
  });

  test(`a search with no baseline in ${RUNS_PAGES_MAX} pages stops reading, and says so`, async () => {
    const r = paged([run(500, 'success', HEAD), ...runsDown(499, -600, 'skipped')]);
    const c = await cover(r);
    assert.equal(pages(r).length, RUNS_PAGES_MAX);
    assert.match(String(c.reason), new RegExp(`in the ${RUNS_PAGES_MAX * RUNS_PER_PAGE} runs of publish-mcp\\.yml`));
    assert.match(String(c.reason), /stopped reading/);
  });

  test(`a search whose ${BASELINE_READS_MAX} newest green runs shipped nothing reads no further page`, async () => {
    const r = paged([run(500, 'success', HEAD), ...runsDown(499, 300, 'success')], {
      runJobs: async (id: number) => { r.asked.push(`jobs ${id}`); return [job(MCP_JOB, 'skipped')]; },
    });
    const c = await cover(r);
    assert.deepEqual(pages(r), ['runs page 1']);
    assert.equal(r.asked.filter((a) => a.startsWith('jobs')).length, BASELINE_READS_MAX);
    assert.match(String(c.reason), new RegExp(`jobs of ${BASELINE_READS_MAX} green runs`));
    assert.doesNotMatch(String(c.reason), /pages/);
  });

  // One reading feeds the labels and the messages, so each read happens once, a stale first list and a dry-run candidate included.
  test('reads the run, the file, each candidate\'s jobs, the compare, the merges and the PR files once each, across a re-read list and a passed-over candidate', async () => {
    const lists = [[run(499, 'success', BASE)], [run(500, 'success', HEAD), run(498, 'success', HEAD), run(497, 'success', BASE)]];
    const r = reader({
      workflowRuns: async () => { r.asked.push('runs'); return lists.shift() ?? []; },
      runJobs: async (id: number) => { r.asked.push(`jobs ${id}`); return id === 498 ? [job('Dry run: Publish to MCP Registry')] : shipped; },
      pullsForCommit: async (sha: string) => { r.asked.push(`pulls ${sha}`); return sha === merge(1) ? [pull(1, sha, `Closes #11\n\n${SESSION}`)] : sha === merge(2) ? [pull(2, sha, 'Closes #21')] : []; },
    });
    const c = await cover(r);
    assert.equal(c.range?.baseline.id, 497);
    assert.ok([merge(1), merge(2)].every((sha) => r.asked.includes(`pulls ${sha}`)), r.asked.join(', '));
    const twice = r.asked.filter((a, i) => a !== 'runs' && r.asked.indexOf(a) !== i);
    assert.deepEqual(twice, [], r.asked.join(', '));
    assert.equal(r.asked.filter((a) => a === 'runs').length, 2, 'the first read and the one re-read that held the run');
    assert.deepEqual(r.asked.filter((a) => a.startsWith('jobs')).sort(), ['jobs 497', 'jobs 498']);
    assert.deepEqual(r.asked.filter((a) => a.startsWith('files')).sort(), ['files 1', 'files 2']);
  });

  test('a red run of a workflow declaring no target reads no cursor', async () => {
    let read = 0;
    const c = await coverRed(reader({ fileAt: async () => 'name: Deliver\non:\n  push:\njobs: {}\n' }), { name: 'Deliver', path: WORKFLOW_PATHS.Deliver }, async () => { read += 1; return null; });
    assert.equal(read, 0);
    assert.match(String(c.reason), /declares no deploy target/);
  });
});

/** The label write's reading of the fact set: a job fire's label, a merge to close a ticket, the tickets of the PRs the paths pick. */
describe('ticketsOf', () => {
  test('the tickets closed by each picked PR, with the PRs that close each, under the fire\'s label', async () => {
    const c = await cover(reader());
    assert.deepEqual(ticketsOf(invocation as never, c), { label: LABEL, tickets: [{ ticket: 11, prs: [1] }, { ticket: 12, prs: [1] }], reason: null, range: c.range });
  });

  test('a run fire labels nothing, and names no label: a run earns none, its shipping jobs do', async () => {
    const c = await coverRed(reader({ fileAt: async () => workflowFile(WORKFLOW_PATHS.Deliver!) }), { name: 'Deliver', path: WORKFLOW_PATHS.Deliver });
    const t = ticketsOf({ ...red, name: 'Deliver', path: WORKFLOW_PATHS.Deliver } as never, c);
    assert.equal(t.label, null);
    assert.deepEqual(t.tickets, []);
    assert.match(String(t.reason), /shipping job/);
  });

  test('a coverage that stopped short labels nothing, giving its reason', async () => {
    const c = await cover(reader({ workflowRuns: async () => [run(500, 'success', HEAD), run(499, 'failure', BASE)] }));
    const t = ticketsOf(invocation as never, c);
    assert.equal(t.label, LABEL);
    assert.deepEqual(t.tickets, []);
    assert.equal(t.reason, c.reason);
  });

  test('commits since the baseline but no merge among them labels nothing: no PR closed a ticket', async () => {
    const c = await cover(reader({ compareCommits: async () => [{ sha: 'e'.repeat(40), message: 'a commit pushed to main' }] }));
    const t = ticketsOf(invocation as never, c);
    assert.deepEqual(t.tickets, []);
    assert.match(String(t.reason), /shipped no merge since run 499/);
  });

  test('picked PRs that close nothing leave nothing to label, saying so', async () => {
    const c = await cover(reader({ pullsForCommit: async (sha: string) => (sha === merge(1) ? [pull(1, sha, 'No ticket.')] : []) }));
    const t = ticketsOf(invocation as never, c);
    assert.deepEqual(t.tickets, []);
    assert.match(String(t.reason), /closes a ticket its paths pick/);
  });
});
