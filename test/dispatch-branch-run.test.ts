/**
 * Who hears of a run dispatched on a branch, and what (dispatch/branch-run.mjs).
 *
 * The session that wrote the commit the run tested dispatched it, and waits
 * on it before it raises or readies its PR: its `Claude-Session` trailer
 * names it. A local session writes no trailer, so with none the live local
 * session holding the branch is asked for. Every read is injected.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_DEPTH, commitSession, planBranchRun } from '../dispatch/branch-run.mjs';
import { UNATTENDED } from '../dispatch/webhook/fire.mjs';

const REPO = 'acme/factory';
const HEAD = 'e'.repeat(40);
const BRANCH = 'claude/emulator-share-x1';
const SESSION = 'https://claude.ai/code/session_01DISPATCHED';
const LOCAL = 'https://claude.ai/code/session_01LOCAL';

type Commit = { sha: string; message: string; parents: string[] };

const invocation = (over: Record<string, unknown> = {}) => ({
  kind: 'branch-run' as const,
  name: 'Emulator',
  runId: 600,
  url: `https://github.com/${REPO}/actions/runs/600`,
  conclusion: 'success',
  headSha: HEAD,
  branch: BRANCH,
  runAttempt: 1,
  ...over,
});

const jobs = [
  { name: 'share', conclusion: 'failure', html_url: `https://github.com/${REPO}/actions/runs/600/job/1` },
  { name: 'probe', conclusion: 'timed_out', html_url: `https://github.com/${REPO}/actions/runs/600/job/3` },
  { name: 'image', conclusion: 'success', html_url: `https://github.com/${REPO}/actions/runs/600/job/2` },
  { name: 'billing', conclusion: 'cancelled', html_url: `https://github.com/${REPO}/actions/runs/600/job/4` },
];

/** A reader over `commits`, recording what it was asked. */
const readerOf = (commits: Record<string, Commit>) => {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      commit: async (sha: string) => {
        asked.push(`commit ${sha}`);
        const found = commits[sha];
        if (found === undefined) throw new Error(`GET /commits/${sha}: 404`);
        return found;
      },
      runJobs: async (id: number) => {
        asked.push(`jobs ${id}`);
        return jobs;
      },
    },
  };
};

const trailered = (sha: string, session = SESSION): Commit => ({ sha, message: `Probe the share save\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: ${session}`, parents: ['0'.repeat(40)] });

describe('commitSession', () => {
  test('reads the session off the commit\'s trailer', async () => {
    const { reader } = readerOf({ [HEAD]: trailered(HEAD) });
    assert.equal(await commitSession(reader.commit, HEAD), SESSION);
  });

  test('follows a catch-up merge with no trailer to its first parent, the branch it was made on', async () => {
    const OWN = 'c'.repeat(40);
    const MAIN = 'd'.repeat(40);
    const { reader } = readerOf({
      [HEAD]: { sha: HEAD, message: "Merge remote-tracking branch 'origin/main' into claude/x", parents: [OWN, MAIN] },
      [OWN]: trailered(OWN),
      [MAIN]: trailered(MAIN, 'https://claude.ai/code/session_01SOMEONEELSE'),
    });
    assert.equal(await commitSession(reader.commit, HEAD), SESSION);
  });

  test('names nobody for a commit with no trailer, a merge GitHub\'s button wrote, or merges past the depth', async () => {
    const person = readerOf({ [HEAD]: { sha: HEAD, message: 'A fix a person wrote', parents: ['0'.repeat(40)] } });
    assert.equal(await commitSession(person.reader.commit, HEAD), null);

    // An empty trailer does not borrow the next line's text as a session.
    const empty = readerOf({ [HEAD]: { sha: HEAD, message: 'Fix\n\nClaude-Session:\nnot-a-session', parents: ['0'.repeat(40)] } });
    assert.equal(await commitSession(empty.reader.commit, HEAD), null);

    // A branch cut from main and dispatched before any commit of its own:
    // its head is main's, whose first parents are other PRs' merges.
    const BEFORE = 'b'.repeat(40);
    const onMain = readerOf({
      [HEAD]: { sha: HEAD, message: 'Merge pull request #907 from acme/claude/other\n\nThe other change', parents: [BEFORE, 'f'.repeat(40)] },
      [BEFORE]: trailered(BEFORE, 'https://claude.ai/code/session_01SOMEONEELSE'),
    });
    assert.equal(await commitSession(onMain.reader.commit, HEAD), null);
    assert.deepEqual(onMain.asked, [`commit ${HEAD}`], 'main\'s history is not walked');

    const chain: Record<string, Commit> = {};
    const shas = Array.from({ length: MERGE_DEPTH + 1 }, (_, i) => String(i + 1).repeat(40));
    shas.forEach((sha, i) => { chain[sha] = { sha, message: 'Merge branch \'x\'', parents: [shas[i + 1] ?? HEAD, 'f'.repeat(40)] }; });
    chain[HEAD] = trailered(HEAD);
    const deep = readerOf(chain);
    assert.equal(await commitSession(deep.reader.commit, shas[0]!), null);
    assert.equal(deep.asked.length, MERGE_DEPTH);
  });

  test('a commit it cannot read throws: a read that failed is not a commit nobody wrote', async () => {
    const { reader } = readerOf({});
    await assert.rejects(commitSession(reader.commit, HEAD), /404/);
  });
});

describe('planBranchRun', () => {
  test('green: the session that wrote the commit hears the run, its branch, the commit and the verdict, and no jobs are read', async () => {
    const { reader, asked } = readerOf({ [HEAD]: trailered(HEAD) });
    const plan = await planBranchRun({ invocation: invocation(), reader, onBranch: async () => { throw new Error('not asked'); } });
    assert.equal(plan.session, SESSION);
    const text = String(plan.text);
    for (const part of ['Emulator', 'run 600', BRANCH, HEAD.slice(0, 12), 'success', `https://github.com/${REPO}/actions/runs/600`]) {
      assert.ok(text.includes(part), `${part}: ${text}`);
    }
    assert.match(text, /commit it (ran|tested) on|wrote the commit/i);
    assert.match(text, /wait is over/, 'names the wait it ends');
    assert.doesNotMatch(text, /skill|pre-push/, 'names no repo\'s skill: a session finds its own through its CLAUDE.md (#991)');
    assert.match(text, /did not dispatch it/, 'a session told of a run it did not start owes nothing');
    assert.ok(!text.includes(UNATTENDED), 'a message to a session that exists says nothing of who attends it (#883)');
    assert.ok(!asked.some((a) => a.startsWith('jobs')), asked.join(', '));
    assert.match(plan.reason, /Claude-Session|trailer/);
  });

  test('red: it names the failed jobs, not the passed or cancelled ones, and asks for a fix and a re-run', async () => {
    for (const conclusion of ['failure', 'timed_out', 'startup_failure']) {
      const { reader } = readerOf({ [HEAD]: trailered(HEAD) });
      const plan = await planBranchRun({ invocation: invocation({ conclusion }), reader });
      const text = String(plan.text);
      assert.ok(text.includes(conclusion), text);
      assert.match(text, /share \(https:\/\/github\.com\/acme\/factory\/actions\/runs\/600\/job\/1\)/);
      assert.match(text, /probe \(https:\/\/github\.com\/acme\/factory\/actions\/runs\/600\/job\/3\)/, 'a timed-out job is a failed job');
      assert.doesNotMatch(text, /\bimage\b/, 'a job that passed is not a failed job');
      assert.doesNotMatch(text, /\bbilling\b/, 'a cancelled job is a fail-fast\'s echo');
      assert.match(text, /Read the failed jobs' logs and find the cause\./);
      assert.doesNotMatch(text, /skill|ops-tooling|pre-push/, 'names no repo\'s skill (#991)');
      assert.match(text, /re-run/);
      assert.match(text, /still your branch's head/, 'a push since the dispatch may have fixed it already');
    }
  });

  test('cancelled: no verdict, and no bare re-run, since a newer dispatch in a shared queue replaces a waiting run', async () => {
    const { reader, asked } = readerOf({ [HEAD]: trailered(HEAD) });
    const plan = await planBranchRun({ invocation: invocation({ conclusion: 'cancelled' }), reader });
    const text = String(plan.text);
    assert.ok(text.includes('cancelled'), text);
    assert.match(text, /no verdict/);
    // Re-running on cue would cancel the run that replaced it, whose session
    // is then told to re-run: two sessions cancelling each other's runs.
    assert.match(text, /replac/, 'names the replacement a concurrency queue makes');
    assert.match(text, /queued or in progress/, 'asks it to look before re-running');
    assert.doesNotMatch(text, /skill/);
    assert.ok(!asked.some((a) => a.startsWith('jobs')));
  });

  test('skipped: no verdict, so a re-run', async () => {
    const { reader, asked } = readerOf({ [HEAD]: trailered(HEAD) });
    const plan = await planBranchRun({ invocation: invocation({ conclusion: 'skipped' }), reader });
    assert.ok(String(plan.text).includes('skipped'));
    assert.match(String(plan.text), /no verdict/);
    assert.match(String(plan.text), /re-run/);
    assert.doesNotMatch(String(plan.text), /skill/);
    assert.ok(!asked.some((a) => a.startsWith('jobs')));
  });

  test('a re-run names its attempt', async () => {
    const { reader } = readerOf({ [HEAD]: trailered(HEAD) });
    const plan = await planBranchRun({ invocation: invocation({ runAttempt: 3 }), reader });
    assert.match(String(plan.text), /attempt 3/);
    const first = await planBranchRun({ invocation: invocation(), reader });
    assert.doesNotMatch(String(first.text), /attempt/);
  });

  test('a commit no session signed: the live local session holding the branch hears it, told that it holds the branch', async () => {
    const { reader } = readerOf({ [HEAD]: { sha: HEAD, message: 'Fix the share', parents: ['0'.repeat(40)] } });
    const asked: string[] = [];
    const plan = await planBranchRun({ invocation: invocation(), reader, onBranch: async (branch) => { asked.push(branch); return LOCAL; } });
    assert.deepEqual(asked, [BRANCH]);
    assert.equal(plan.session, LOCAL);
    assert.match(String(plan.text), /hold the branch/);
    assert.match(plan.reason, /local session|holds/);
  });

  test('nobody signed the commit and nobody holds the branch: no text, and the reason says why', async () => {
    const { reader } = readerOf({ [HEAD]: { sha: HEAD, message: 'A fix a person wrote', parents: ['0'.repeat(40)] } });
    const none = await planBranchRun({ invocation: invocation(), reader, onBranch: async () => null });
    assert.deepEqual([none.session, none.text], [null, null]);
    assert.ok(none.reason.includes(BRANCH), none.reason);
    const unasked = await planBranchRun({ invocation: invocation(), reader });
    assert.deepEqual([unasked.session, unasked.text], [null, null]);
  });

  test('red, and its jobs cannot be read: the waiting session still hears the verdict, pointed at the run page', async () => {
    const { reader } = readerOf({ [HEAD]: trailered(HEAD) });
    const plan = await planBranchRun({
      invocation: invocation({ conclusion: 'failure' }),
      reader: { ...reader, runJobs: async () => { throw new Error('GET /actions/runs/600/jobs: 502'); } },
    });
    assert.equal(plan.session, SESSION);
    const text = String(plan.text);
    assert.match(text, /failure/);
    assert.match(text, /could not be read/);
    assert.match(text, /run page/);
    assert.match(plan.reason, /502/, 'the read that failed is in the logged reason');
  });

  test('a lookup that fails throws: a waiting session untold is the dispatcher failing', async () => {
    const unreadable = readerOf({});
    await assert.rejects(planBranchRun({ invocation: invocation(), reader: unreadable.reader }), /404/);
    const { reader } = readerOf({ [HEAD]: { sha: HEAD, message: 'Fix', parents: [] } });
    await assert.rejects(planBranchRun({ invocation: invocation(), reader, onBranch: async () => { throw new Error('GET /v1/code/sessions: 503'); } }), /503/);
  });
});
