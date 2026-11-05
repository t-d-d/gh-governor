/**
 * The PR review: the task's `review` turn runs the `pr-review`
 * skill over a PR, through `claude -p` under the stored login, and acts on
 * the answer: a pass merges, a conflict and a fail comment. The comment's
 * marker names the head and the body just reviewed, so the same PR is not
 * read twice, and a fail on the same test, or a conflict after a conflict,
 * edits the last comment instead of posting again.
 *
 * Every I/O is injected: GitHub, the CLI, the drop box, the clock.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEADLINE_MS, exitCodeFor } from '../dispatch/cli.mjs';
import { LAUNCH_TIMEOUT_MS, REVIEW_MARK_WINDOW_MS, REVIEW_WINDOW_MS, redactTranscript, run as runNamed } from '../dispatch/turn.mjs';
import { CONFIG_PATH, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
import { standingLine } from '../dispatch/deliveries.mjs';
import { ANSWER_SCHEMA, PR_FRAME, parseReview, readDigest } from '../dispatch/checklist.mjs';
import { bodyDigest, reviewMarker } from '../dispatch/pr-body.mjs';
import { readFileSync } from 'node:fs';
import { commentKey, commentText, heldPassReason, mergeConflictText, ownerActs, passOf, withoutMarker as withoutMarkerText } from '../dispatch/webhook/review-comment.mjs';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { subscribeLine } from '../dispatch/webhook/subscribe.mjs';
import { APP_ID, BODY, DEPENDABOT_COMMIT, FILES, HEAD, IAM, MERGE_BASE, PASS, REPO, SKILL, cliOutput, dependabotRow, pullRow } from './helpers/dispatch-review-fixtures.ts';
import type { Answer, FileRow, Pull, PullCommit, TicketRow } from './helpers/dispatch-review-fixtures.ts';
import { factoryFile } from './helpers/factory.ts';
import { githubReader } from '../scripts/lib/github-app.mjs';
import { BOT, REVIEW, authorKind, lets } from '../dispatch/trust.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const MOVED = 'ffffffffffffffffffffffffffffffffffffffff';

const LOGIN = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-a',
    refreshToken: 'sk-ant-ort01-r',
    expiresAt: NOW + 3_600_000,
    refreshTokenExpiresAt: NOW + 30 * 86_400_000,
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
  },
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const COSTS: Answer = { answer: 'fail', test: 3, reason: 'the description names no cost for the new module', editable: true };

type Thread = { id: number; body: string; created_at: string; ours: boolean };

/** The factory's CI workflow, as its file's `workflows.ci` names it. */
const CI = '.github/workflows/ci.yml';
type CiRun = { id: number, path: string, status: string, conclusion: string | null, event: string, head_branch: string | null, head_sha: string, html_url: string, created_at: string };
/** A run of the factory's CI at the PR's head, ended green, over `over`. */
const ciRun = (over: Partial<CiRun> = {}): CiRun => ({
  id: 900, path: CI, status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'claude/x', head_sha: HEAD, html_url: `https://github.com/${REPO}/actions/runs/900`, created_at: '2026-09-26T11:00:00Z', ...over,
});

const harness = (over: {
  pulls?: Record<number, Pull | Pull[]>,
  open?: Array<{ number: number, draft: boolean, body?: string, headSha?: string }>,
  thread?: Thread[],
  /** Each PR's own thread, over `thread`. */
  threads?: Record<number, Thread[]>,
  answers?: Answer[] | ((prompt: string) => string),
  merge?: () => Promise<{ merged: boolean, sha: string }>,
  now?: () => number,
  /** What `claude -p --cloud` prints for a send into a session. */
  sent?: string,
  /** The send rejects: a spawn that never started, or one past its budget. */
  sendThrows?: boolean,
  launched?: number,
  files?: FileRow[],
  /** The PR's commits, oldest first. */
  commits?: PullCommit[],
  /** A ticket's fields over the default open `mode: afk` one, null for an issue that does not exist, or the HTTP status its read fails with. */
  tickets?: Record<number, Partial<TicketRow> | null | number>,
  /** Each file's text by `<commit>:<path>`; a read of any other fails, as GitHub's 404 does. */
  texts?: Record<string, string>,
  /** The repo's config file, the factory's by default; its checklist file reads as SKILL. */
  config?: string,
  /** The repo's default branch, `main` by default. */
  base?: string,
  /** The checks the base requires, and the checks at the head. */
  required?: string[],
  checks?: Array<{ name: string, state: 'red' | 'green' | 'pending' }>,
  /** The checks at each head, over `checks`. */
  checksAt?: (sha: string) => Array<{ name: string, state: 'red' | 'green' | 'pending' }>,
  /** The runs the CI workflow's list answers at the head: one green run of the factory's `ci.yml` at HEAD by default. */
  ciRuns?: CiRun[],
  /** The check write: GitHub's refusal, for one that throws. */
  checkRun?: (run: { name: string, sha: string, state: string, title: string, summary: string }) => Promise<void>,
  /** The comment write: GitHub's refusal, for one that throws. */
  comment?: () => Promise<void>,
  /** The sessions the state table says governor started; a string is the error its read fails with. */
  started?: string[] | string,
} = {}) => {
  const checkRuns: Array<{ name: string, sha: string, state: string, title: string, summary: string }> = [];
  /** The review's writes in the order made: each check by its state, the merge, the comment. */
  const writes: string[] = [];
  const comments: Array<{ issue: number, body: string }> = [];
  const commentEdits: Array<{ id: number, body: string }> = [];
  const merges: Array<{ pr: number, sha: string }> = [];
  const judged: Array<{ system: string, prompt: string, schema: unknown }> = [];
  const transcripts: Array<{ sessionId: string, pr: number }> = [];
  const messages: unknown[] = [];
  const launches: unknown[] = [];
  const logged: Array<{ event: string, [key: string]: unknown }> = [];
  const reads: number[] = [];
  const requiredReads: string[] = [];
  const baseReads: Array<[string, string]> = [];
  const fileReads: string[] = [];
  const readerApps: number[] = [];
  const sessionsRead: string[] = [];
  const ciReads: Array<[string, string]> = [];
  const pulls = over.pulls ?? { 767: pullRow() };
  const answers = over.answers ?? [PASS];
  let judgedCount = 0;
  const deps = {
    owners: ['acme'],
    installations: async () => [{ account: 'acme', repos: [REPO] }],
    configFile: async (_repo: string, _token: string, path = CONFIG_PATH) => (path === CONFIG_PATH ? over.config ?? factoryFile(CONFIG_PATH) : SKILL),
    cap: 2,
    now: over.now ?? (() => NOW),
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    secret: { get: async () => LOGIN, put: async () => {} },
    githubToken: async () => 'ghs_t',
    appId: async () => APP_ID,
    reader: (_token: string, appId: number) => { readerApps.push(appId); return {
      // No run but the CI workflow's at the head holds a merge, so the review reads no runs list.
      workflowRuns: async (file: string) => { throw new Error(`the review read the runs of ${file}: only the CI workflow's run at the head holds a merge`); },
      ciRuns: async (path: string, sha: string) => { ciReads.push([path, sha]); return over.ciRuns ?? [ciRun()]; },
      openPulls: async () => over.open ?? [],
      defaultBranch: async () => over.base ?? 'main',
      requiredChecks: async (branch: string) => { requiredReads.push(branch); return over.required ?? []; },
      checksAt: async (sha: string) => over.checksAt?.(sha) ?? over.checks ?? [],
      checkRun: async (run: { name: string, sha: string, state: string, title: string, summary: string }) => {
        if (over.checkRun) await over.checkRun(run);
        checkRuns.push(run);
        writes.push(`check ${run.state}`);
      },
      pullRequest: async (n: number) => {
        reads.push(n);
        const rows = pulls[n];
        if (rows === undefined) throw Object.assign(new Error(`GET /pulls/${n} failed: 404`), { status: 404 });
        if (!Array.isArray(rows)) return rows;
        // Each read the next row, the last one for good: GitHub computing mergeable.
        const seen = reads.filter((r) => r === n).length;
        return rows[Math.min(seen - 1, rows.length - 1)]!;
      },
      pullFiles: async () => over.files ?? FILES,
      pullCommits: async () => over.commits ?? [DEPENDABOT_COMMIT],
      mergeBase: async (base: string, head: string) => { baseReads.push([base, head]); return MERGE_BASE; },
      fileAt: async (path: string, ref: string) => {
        fileReads.push(`${ref}:${path}`);
        const text = over.texts?.[`${ref}:${path}`];
        if (text === undefined) throw Object.assign(new Error(`GET /contents/${path}?ref=${ref} failed: 404`), { status: 404 });
        return text;
      },
      ticket: async (n: number) => {
        const row = over.tickets?.[n];
        if (row === null || typeof row === 'number') {
          const status = row ?? 404;
          throw Object.assign(new Error(`GET /issues/${n} failed: ${status}`), { status });
        }
        return { number: n, title: `Ticket ${n}`, body: '## Acceptance criteria\n\n- It reviews.', state: 'open', labels: ['mode: afk', 'type: nfr', 'workflow: under development'], pull: false, association: 'MEMBER', ...row };
      },
      allComments: async (n: number) => over.threads?.[n] ?? over.thread ?? [],
      comment: async (issue: number, body: string) => { if (over.comment) await over.comment(); comments.push({ issue, body }); writes.push('comment'); },
      updateComment: async (id: number, body: string) => { commentEdits.push({ id, body }); },
      // The send path's reads: the standing line, a fallback's marker and relink.
      openNaming: async () => [],
      comments: async () => [],
      pull: async (n: number) => ({ number: n, body: BODY, open: true }),
      updatePull: async () => {},
      merge: async (pr: number, { sha }: { sha: string }) => {
        merges.push({ pr, sha });
        writes.push('merge');
        return over.merge ? over.merge() : { merged: true, sha: 'm' };
      },
    }; },
    heartbeat: async () => {},
    // Every turn writes its repo's hooks for the receiver; a failed write fails the turn.
    hookTable: { publish: async () => true },
    workspace: { prepare: () => {}, writeLogin: () => {}, readLogin: () => LOGIN, useAccount: () => {} },
    launch: async (l: unknown) => { launches.push(l); return { status: over.launched ?? 0, output: 'https://claude.ai/code/session_01FRESH' }; },
    probe: async () => ({ ok: true, detail: '' }),
    message: async (m: unknown) => { messages.push(m); if (over.sendThrows) throw new Error('the launcher for session_01OWNER ran past 360000 ms'); return { status: 0, output: over.sent ?? '{"ok":true,"session_id":"session_01OWNER","url":"https://claude.ai/code/session_01OWNER"}' }; },
    review: async (r: { system: string, prompt: string, schema: unknown }) => {
      judged.push(r);
      judgedCount += 1;
      if (typeof answers === 'function') return { status: 0, output: answers(r.prompt) };
      const answer = answers[Math.min(judgedCount - 1, answers.length - 1)]!;
      return { status: 0, output: cliOutput(answer, `sess-${judgedCount}`) };
    },
    transcript: async (t: { sessionId: string, pr: number }) => { transcripts.push(t); return { key: `drop/dispatch/2026-09-26/pr-review-${t.pr}-${t.sessionId}.jsonl.gz` }; },
    sleep: async () => {},
    state: {
      startedSession: async (session: string) => {
        sessionsRead.push(session);
        if (typeof over.started === 'string') throw new Error(over.started);
        return (over.started ?? []).includes(session);
      },
    },
  };
  return { deps, sessionsRead, ciReads, checkRuns, writes, comments, commentEdits, merges, judged, transcripts, messages, launches, logged, reads, requiredReads, baseReads, fileReads, readerApps };
};

type Review = { pr: number, outcome: string, reason?: string | null, error?: string | null, test?: number };
type ReviewTurn = { kind: 'review', reviews: Review[], loginStored: boolean };

/** A fire these tests write naming no repo is the factory's: every review fire is (dispatch/repo-config.mjs). */
const run = (event: unknown, deps: Parameters<typeof runNamed>[1]) =>
  runNamed('repo' in (event as object) ? event : { ...(event as object), repo: 'acme/factory' }, deps);

const review = async (event: unknown, h: ReturnType<typeof harness>) => (await run(event, h.deps as never)) as unknown as ReviewTurn;

/** The comment text for a test answer, which is looser than the module's type. */
const textOf = (answer: Answer, conflict = false) => commentText(answer as Parameters<typeof commentText>[0], { conflict });

const marked = (text: string, head = HEAD, body = BODY) => `${text}\n\n${reviewMarker(head, bodyDigest(body))}`;

/** The digest of what the model reads for the harness's PR as it stands by default: its body, its files, ticket #748 and the checklist. */
const READ = readDigest({
  pull: pullRow() as never,
  files: FILES as never,
  tickets: [{ number: 748, title: 'Ticket 748', body: '## Acceptance criteria\n\n- It reviews.', state: 'open', labels: ['mode: afk', 'type: nfr', 'workflow: under development'], pull: false }] as never,
}, SKILL);

/** A comment as a review that asked the model about the default PR writes it: its marker names what the model read. */
const asked = (text: string, head = HEAD, body = BODY) => `${text}\n\n${reviewMarker(head, bodyDigest(body), READ)}`;

type Fire = { kind: string, session?: string, text?: string, on?: number, fallback?: { prompt: string, sessionName: string, issue?: number } };

/** What the receiver queues for a comment the review posted on #767, or edited with `action` `edited`. */
const receiverFires = (comment: string, body = BODY, action = 'created') => routeEvent({
  event: 'issue_comment',
  owners: ['acme'],
  appId: APP_ID,
  payload: {
    action,
    issue: { number: 767, user: { login: 'tdickinson', type: 'User' }, author_association: 'OWNER', title: 'Run the PR review from the dispatcher', html_url: `https://github.com/${REPO}/pull/767`, body, pull_request: { url: 'p' } },
    comment: { id: 1, body: comment, html_url: 'c', user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', performed_via_github_app: { id: APP_ID } },
    repository: { full_name: REPO },
  },
}).fires.map((f) => f.fire as Fire);

describe('run — a review fire, end to end', () => {
  test('a PR the checklist passes is merged with a merge commit pinned to the head reviewed, then commented on', async () => {
    const h = harness();
    const result = await review({ kind: 'review', pr: 767, headSha: HEAD }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'merged']]);
    assert.equal(h.comments.length, 1);
    assert.equal(h.comments[0]!.issue, 767);
    assert.equal(h.comments[0]!.body, `Passes the PR review: ${PASS.reason}.\n\n<!-- governor:pr-review ${HEAD} ${sha256(BODY)} ${READ} -->`);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    assert.equal(exitCodeFor(result as never), 0);
  });

  test('the skill is the system prompt, the PR the prompt, the answer held to the schema, and a pass starts or messages no session', async () => {
    const h = harness();
    await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.judged.length, 1);
    assert.ok(h.judged[0]!.system.startsWith(`${PR_FRAME}\n\n${SKILL}`));
    assert.deepEqual(h.judged[0]!.schema, ANSWER_SCHEMA);
    for (const fact of ['#767', 'Run the PR review from the dispatcher', 'Adds the review fire.', 'src/voices.ts', '#748', 'Ticket 748', 'mode: afk', 'It reviews.']) {
      assert.ok(h.judged[0]!.prompt.includes(fact), `the prompt carries ${fact}`);
    }
    assert.deepEqual(h.launches, []);
    assert.deepEqual(h.messages, []);
  });

  test('the run\'s transcript goes to the drop box, named for the PR it reviewed', async () => {
    const h = harness();
    await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(h.transcripts, [{ sessionId: 'sess-1', pr: 767 }]);
  });

  test('a fail the author session can meet by an edit is one comment naming the test and the sentence, and no merge', async () => {
    const h = harness({ answers: [COSTS] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.deepEqual(h.merges, []);
    assert.match(h.comments[0]!.body, /test 3/);
    assert.match(h.comments[0]!.body, /the description names no cost for the new module/);
    assert.doesNotMatch(h.comments[0]!.body, /A person merges it/);
  });

  test('a fail no edit can meet says a person merges it', async () => {
    const h = harness({ answers: [IAM] });
    await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.comments[0]!.body, asked('Waits for a person: the change adds an IAM grant (test 3). No edit to the description makes it pass. A person merges it.'));
  });

  test('no comment it posts carries the Claude Code footer: the receiver would drop it as the author session\'s own', async () => {
    for (const answer of [PASS, IAM, COSTS]) {
      const h = harness({ answers: [answer] });
      await review({ kind: 'review', pr: 767 }, h);
      for (const { body } of h.comments) {
        assert.doesNotMatch(body, /Generated (by|with) \[Claude Code\]/);
        assert.doesNotMatch(body, /claude\.ai\/code\/session_/);
      }
    }
  });
});

describe('run — a human-only path a ticket\'s mode label waives', () => {
  const OWNER = 'https://claude.ai/code/session_01OWNER';
  const hitl = { 748: { labels: ['mode: hitl', 'type: bug', 'workflow: under development'] } };
  const files = [{ filename: 'CLAUDE.md', status: 'modified' }];

  test('from a session a person started, the label waives it and the PR merges', async () => {
    const h = harness({ tickets: hitl, files });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.sessionsRead, [OWNER]);
  });

  test('from a session governor started, it waits for a person and nothing merges', async () => {
    const h = harness({ tickets: hitl, files, started: [OWNER] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.deepEqual(h.merges, []);
    assert.deepEqual(h.judged, []);
    assert.match(h.comments[0]!.body, /^Waits for a person: `CLAUDE\.md` is on the human-only list[\s\S]*\(test 7\)/);
  });

  test('a record that cannot be read fails the review: nothing merges and nothing is said', async () => {
    const h = harness({ tickets: hitl, files, started: 'AccessDeniedException: dynamodb:GetItem' });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => [r.outcome, r.error]), [['failed', 'AccessDeniedException: dynamodb:GetItem']]);
    assert.deepEqual([h.merges, h.comments], [[], []]);
  });
});

/**
 * The review wakes the PR's session only when it has something
 * to do, and the comment is how it does. The receiver queues an owner-only
 * `message` fire, with the fallback any comment carries, for a fail an edit
 * meets and a conflict; a pass is followed by the merge's own message, and a
 * fail no edit meets waits for a person. The fire runs in its own task, so
 * the send and its fallback have their own deadline, however late in the
 * review turn (a Deploy Prod sweep included) the comment was posted.
 */
describe('run — what reaches the owner session', () => {
  const OWNER = 'https://claude.ai/code/session_01OWNER';
  const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';
  const withoutMarker = (body: string) => body.replace(/\n\n<!-- governor:pr-review [^>]* -->$/, '');

  test('the review turn sends nothing itself, whatever it answers', async () => {
    for (const h of [harness({ answers: [PASS] }), harness({ answers: [IAM] }), harness({ answers: [COSTS] }), harness({ pulls: { 767: pullRow({ mergeable: false }) } })]) {
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.equal(h.comments.length, 1);
      assert.deepEqual(h.messages, []);
      assert.deepEqual(h.launches, []);
      assert.equal(exitCodeFor(result as never), 0);
    }
  });

  test('every review comment reaches the session the PR names, without its marker, and no other subscriber', async () => {
    const body = `${BODY}\n\n${subscribeLine(REVIEWER, ['comments'])}`;
    const at = (over: Parameters<typeof harness>[0]) => ({ ...over, pulls: { 767: pullRow({ body, ...(over?.pulls?.[767] as Partial<Pull> | undefined) }) } });
    for (const [name, h, go] of [
      ['a pass that merges', harness(at({ answers: [PASS] })), (h: ReturnType<typeof harness>) => review({ kind: 'review', pr: 767 }, h)],
      ['a pass the owner merges', tagalong(at({})), reviewTagalong],
      ['a conflict', harness(at({ pulls: { 767: pullRow({ mergeable: false }) } })), (h: ReturnType<typeof harness>) => review({ kind: 'review', pr: 767 }, h)],
      ['an edit', harness(at({ answers: [COSTS] })), (h: ReturnType<typeof harness>) => review({ kind: 'review', pr: 767 }, h)],
      ['a person', harness(at({ answers: [IAM] })), (h: ReturnType<typeof harness>) => review({ kind: 'review', pr: 767 }, h)],
    ] as const) {
      await go(h);
      const fires = receiverFires(h.comments[0]!.body, body);
      assert.deepEqual(fires.map((f) => [f.kind, f.session, f.on]), [['message', OWNER, 767]], name);
      assert.ok(fires[0]!.text!.includes(withoutMarker(h.comments[0]!.body)), `${name}: the comment's text`);
      assert.doesNotMatch(fires[0]!.text!, /governor:pr-review/, `${name}: the marker is the receiver's to read`);
    }
  });

  test('a pass, or a fail only a person meets: the owner hears it with no fallback, since a fresh session would have nothing to do', async () => {
    const merged = harness({ answers: [PASS] });
    const result = await review({ kind: 'review', pr: 767 }, merged);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    const passed = tagalong();
    await reviewTagalong(passed);
    const person = harness({ answers: [IAM] });
    await review({ kind: 'review', pr: 767 }, person);
    for (const h of [merged, passed, person]) {
      const fires = receiverFires(h.comments[0]!.body);
      assert.deepEqual(fires.map((f) => [f.kind, f.session]), [['message', OWNER]], h.comments[0]!.body);
      assert.equal(fires[0]!.fallback, undefined, h.comments[0]!.body);
    }
  });

  test('a fail an edit meets: one message fire into the session the PR names, carrying the comment\'s text and the fallback', async () => {
    const h = harness({ answers: [COSTS] });
    await review({ kind: 'review', pr: 767 }, h);
    const fires = receiverFires(h.comments[0]!.body);
    assert.deepEqual(fires.map((f) => [f.kind, f.session, f.on]), [['message', OWNER, 767]]);
    assert.ok(fires[0]!.text!.includes(withoutMarker(h.comments[0]!.body)), 'the comment\'s text');
    assert.match(fires[0]!.text!, /Do not open a new branch or PR/);
    assert.ok(fires[0]!.fallback, 'the owner is answered either way');
    assert.match(fires[0]!.fallback!.prompt, /yours now/);
    assert.equal(fires[0]!.fallback!.issue, 767);
  });

  test('a conflict: one message fire telling the session the base merge is its to push, with the fallback', async () => {
    const h = harness({ pulls: { 767: pullRow({ mergeable: false }) } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['conflict']);
    const fires = receiverFires(h.comments[0]!.body);
    assert.deepEqual(fires.map((f) => [f.kind, f.session]), [['message', OWNER]]);
    assert.ok(fires[0]!.text!.includes(withoutMarker(h.comments[0]!.body)));
    assert.ok(fires[0]!.fallback);
  });

  test('a fail said already is an edit in place, which the receiver does not deliver', async () => {
    const h = harness({ answers: [{ ...COSTS, reason: 'no cost is named for the module' }], thread: [{ id: 41, body: marked(textOf(COSTS), MOVED), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.equal(h.commentEdits.length, 1);
  });

  test('only the owner hears it: a subscriber reads the comment', async () => {
    const body = `${BODY}\n\n${subscribeLine(REVIEWER, ['comments'])}`;
    const h = harness({ answers: [COSTS], pulls: { 767: pullRow({ body }) } });
    await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(receiverFires(h.comments[0]!.body, body).map((f) => f.session), [OWNER]);
  });

  // Its owner, if any, is the live session on its head branch, which the task finds.
  test('a PR naming no session: the comment, and one fire for whichever session holds its head branch', async () => {
    const body = 'Closes #748\n\nA person\'s PR.';
    const h = harness({ answers: [COSTS], pulls: { 767: pullRow({ body }) } });
    await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(receiverFires(h.comments[0]!.body, body).map((f) => [f.kind, f.session, (f as { byBranch?: true }).byBranch]), [['message', undefined, true]]);
  });

  test('late in a sweep: the last PR\'s comment still carries the owner\'s fallback, and nothing is logged untold', async () => {
    let t = NOW;
    const h = harness({
      answers: [COSTS],
      now: () => { const at = t; t += 2 * 60 * 1000; return at; },
      open: [{ number: 767, draft: false }, { number: 773, draft: false }],
      pulls: { 767: pullRow(), 773: pullRow({ number: 773, html_url: `https://github.com/${REPO}/pull/773` }) },
    });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'commented'], [773, 'commented']]);
    assert.ok(!h.logged.some((l) => 'untold' in l), JSON.stringify(h.logged));
    for (const { body } of h.comments) assert.ok(receiverFires(body)[0]?.fallback, 'each comment\'s fire carries the fallback');
  });

  // A check run or a status names a commit, and a fork's PR is not listed on
  // a run's payload, so the receiver's fire carries the commit alone.
  test('a review fire carrying a commit reviews each open PR whose head is that commit, at that head, and nothing else', async () => {
    const OTHER = 'c'.repeat(40);
    const h = harness({
      open: [
        { number: 767, draft: false, headSha: HEAD },
        { number: 773, draft: false, headSha: OTHER },
        { number: 774, draft: false, headSha: HEAD },
      ],
      pulls: { 767: pullRow(), 774: pullRow({ number: 774, html_url: `https://github.com/${REPO}/pull/774` }) },
    });
    const result = await review({ kind: 'review', headSha: HEAD }, h);
    assert.deepEqual(result.reviews.map((r) => r.pr), [767, 774]);
    assert.ok(!h.reads.includes(773), 'a PR at another head is not read');
    assert.equal(exitCodeFor(result as never), 0);
  });

  // The push's own fire posted the `neutral` check at this head: one per
  // check that ends would pile up a check run each.
  test('a review fire carrying a commit posts no second neutral check on a PR whose author may not summon governor', async () => {
    const h = harness({ open: [{ number: 767, draft: false, headSha: HEAD }], pulls: { 767: pullRow({ association: 'CONTRIBUTOR' }) } });
    const result = await review({ kind: 'review', headSha: HEAD }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'skipped']]);
    assert.match(String(result.reviews[0]!.reason), /CONTRIBUTOR/);
    assert.deepEqual(h.checkRuns, []);
    const named = harness({ pulls: { 767: pullRow({ association: 'CONTRIBUTOR' }) } });
    await review({ kind: 'review', pr: 767, headSha: HEAD }, named);
    assert.deepEqual(named.checkRuns.map((c) => c.state), ['neutral'], 'a fire naming the PR still posts it');
  });

  test('a review fire carrying a commit no open PR is at reviews nothing', async () => {
    const h = harness({ open: [{ number: 767, draft: false, headSha: 'c'.repeat(40) }] });
    const result = await review({ kind: 'review', headSha: HEAD }, h);
    assert.deepEqual(result.reviews, []);
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.checkRuns, []);
    assert.deepEqual(h.comments, []);
    assert.equal(exitCodeFor(result as never), 0);
  });

  test('the owner\'s fire, refused, starts the fallback in its own turn: a fresh session told to take the PR over', async () => {
    const h = harness({ answers: [COSTS] });
    await review({ kind: 'review', pr: 767 }, h);
    const [fire] = receiverFires(h.comments[0]!.body);
    const refused = harness({ sent: '{"ok":false,"error":"cloud session session_01OLD is archived and cannot accept new messages"}' });
    const told = await run(fire, refused.deps as never);
    assert.equal(refused.launches.length, 1);
    const launch = refused.launches[0] as { prompt: string, sessionName: string };
    assert.ok(launch.prompt.includes(withoutMarker(h.comments[0]!.body)));
    assert.match(launch.prompt, /yours now/);
    assert.match(launch.sessionName, /#767/);
    assert.equal(exitCodeFor(told as never), 0);
    assert.ok((refused.messages[0] as { text: string }).text.endsWith(standingLine([], { repo: REPO, closing: false })), 'the standing line');
  });
});

describe('run — what a review skips, saying nothing', () => {
  test('a draft, a closed PR, a PR into another branch, and a head and body the last marker already names', async () => {
    for (const [pull, thread, why] of [
      [pullRow({ draft: true }), [], /draft/],
      // A stacked PR: a pass would merge it into its base branch, not main.
      [pullRow({ base: 'claude/the-pr-below' }), [], /into claude\/the-pr-below, not main/],
      [pullRow({ state: 'closed' }), [], /closed/],
      [pullRow(), [{ id: 5, body: marked('Waits for a person: x (test 3).'), created_at: 't', ours: true }], /already reviewed/],
    ] as const) {
      const h = harness({ pulls: { 767: pull }, thread: [...thread] });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped']);
      assert.match(String(result.reviews[0]!.reason), why);
      assert.deepEqual(h.judged, [], 'the CLI is not run');
      assert.deepEqual(h.comments, []);
      assert.deepEqual(h.commentEdits, []);
      assert.equal(exitCodeFor(result as never), 0);
    }
  });

  test('a fire for a head the PR has moved past: the push\'s own fire reviews the new one', async () => {
    const h = harness({ pulls: { 767: pullRow({ headSha: MOVED }) } });
    const result = await review({ kind: 'review', pr: 767, headSha: HEAD }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(h.judged, []);
  });

  test('a marker a person or another bot wrote is not the review\'s: only the dispatcher\'s App\'s counts', async () => {
    const h = harness({ thread: [{ id: 5, body: marked('Passes.'), created_at: 't', ours: false }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
  });

  test('a new body or a new head under the last marker is read again', async () => {
    for (const thread of [
      [{ id: 5, body: marked('Waits for a person: x (test 3).', MOVED), created_at: 't', ours: true }],
      [{ id: 5, body: marked('Waits for a person: x (test 3).', HEAD, 'an older body'), created_at: 't', ours: true }],
    ]) {
      const h = harness({ thread });
      await review({ kind: 'review', pr: 767 }, h);
      assert.equal(h.judged.length, 1);
    }
  });

  test('a PR by someone who may not summon the dispatcher is not reviewed: only a person merges it', async () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
      const h = harness({ pulls: { 767: pullRow({ association }) } });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped'], association);
      assert.deepEqual(h.judged, [], association);
      assert.deepEqual(h.merges, [], association);
    }
  });

  test('a PR by an author the repo\'s trust.review lists is reviewed, whoever they are; one it leaves out gets the neutral check naming the list', async () => {
    const opened = JSON.parse(factoryFile(CONFIG_PATH));
    const config = JSON.stringify({ ...opened, trust: { ...opened.trust, review: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } });
    const stranger = harness({ config, pulls: { 767: pullRow({ association: 'NONE' }) } });
    await review({ kind: 'review', pr: 767 }, stranger);
    assert.equal(stranger.judged.length, 1, 'the model reads a NONE author\'s PR where review lists NONE');
    const owners = JSON.stringify({ ...opened, pickup: { ...opened.pickup, by: ['OWNER'] }, trust: { ...opened.trust, review: ['OWNER'] } });
    const member = harness({ config: owners, pulls: { 767: pullRow({ association: 'MEMBER' }) } });
    const result = await review({ kind: 'review', pr: 767 }, member);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(member.judged, []);
    assert.deepEqual(member.checkRuns.map((c) => c.state), ['neutral']);
    assert.match(member.checkRuns[0]!.summary, /trust\.review/);
    assert.match(member.checkRuns[0]!.summary, /A person merges it\./);
  });

  test('a PR GitHub marks as a bot\'s is judged as BOT by trust.review, whatever its login', async () => {
    const row = { number: 767, title: 't', body: '', state: 'open', draft: false, base: { ref: 'main' }, head: { sha: HEAD }, html_url: '', user: { login: 'Copilot', type: 'Bot' }, author_association: 'COLLABORATOR' };
    const fetch = (async () => new Response(JSON.stringify(row), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const pull = await githubReader({ token: 't', repo: REPO, fetch, sleep: async () => {} }).pullRequest(767);
    assert.equal(authorKind(pull), BOT);
    assert.ok(lets([BOT], pull), 'a review listing BOT reads it');
    assert.ok(!lets(REVIEW, pull), 'the default review, which leaves BOT out, does not');
  });
});

/**
 * Dependabot's bumps: read by the Dependabot list in .github/dispatch.json,
 * not the checklist. Its body is its own template and its files are
 * dependency manifests the human-only list holds for a session's change.
 */
describe('run — a Dependabot PR', () => {
  const PIP: FileRow[] = [{ filename: 'normalize-lambda/requirements.txt', status: 'modified' }];

  test('a bump of files on the Dependabot list, every commit Dependabot\'s, is merged pinned to its head without the model, then commented on', async () => {
    const h = harness({ pulls: { 767: dependabotRow() }, files: PIP });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    assert.deepEqual(h.judged, [], 'the model is not asked');
    assert.deepEqual(h.transcripts, []);
    assert.equal(h.comments.length, 1);
    assert.match(h.comments[0]!.body, /^Passes the PR review: /);
    assert.match(h.comments[0]!.body, /Dependabot/);
    assert.ok(h.comments[0]!.body.includes('normalize-lambda/requirements.txt'), h.comments[0]!.body);
    assert.ok(h.comments[0]!.body.endsWith(reviewMarker(HEAD, bodyDigest(dependabotRow().body))));
    assert.deepEqual(receiverFires(h.comments[0]!.body, dependabotRow().body).map((f) => [f.kind, (f as { byBranch?: true }).byBranch, f.fallback]), [['message', true, undefined]], 'a pass reaches whichever session holds its branch, if one does, and takes nothing over');
    assert.equal(exitCodeFor(result as never), 0);
  });

  test('the bumps Dependabot raises here merge: npm at the root, pip in each Lambda, bundler in each store shell', async () => {
    for (const files of [
      ['package.json', 'package-lock.json'],
      ['package-lock.json'],
      ['normalize-lambda/requirements.txt'],
      ['kokoro-lambda/requirements.txt'],
      ['clients/android/Gemfile.lock'],
      ['clients/android/Gemfile.lock', 'clients/apple/Gemfile.lock'],
      ['clients/apple/Gemfile', 'clients/apple/Gemfile.lock'],
    ]) {
      const h = harness({ pulls: { 767: dependabotRow() }, files: files.map((filename) => ({ filename, status: 'modified' })) });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged'], files.join(', '));
    }
  });

  test('a file off the Dependabot list waits for a person, naming it, and starts no session to take it over', async () => {
    for (const filename of ['dispatch/package-lock.json', '.github/workflows/ci.yml', 'kokoro-lambda/Dockerfile', 'src/voices.ts']) {
      const h = harness({ pulls: { 767: dependabotRow() }, files: [...PIP, { filename, status: 'modified' }] });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented'], filename);
      assert.deepEqual(h.merges, [], filename);
      assert.deepEqual(h.judged, [], filename);
      assert.match(h.comments[0]!.body, /^Waits for a person: /, filename);
      assert.ok(h.comments[0]!.body.includes(filename), h.comments[0]!.body);
      assert.match(h.comments[0]!.body, /A person merges it\./);
      assert.deepEqual(receiverFires(h.comments[0]!.body, dependabotRow().body).map((f) => f.fallback), [undefined], filename);
    }
  });

  test('a file on the list added, removed or renamed waits for a person: a bump only modifies a manifest', async () => {
    for (const file of [
      { filename: 'normalize-lambda/requirements.txt', status: 'added' },
      { filename: 'package-lock.json', status: 'removed' },
      { filename: 'package-lock.json', status: 'renamed', previous: 'npm-shrinkwrap.json' },
    ]) {
      const h = harness({ pulls: { 767: dependabotRow() }, files: [file] });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented'], file.status);
      assert.deepEqual(h.merges, [], file.status);
      assert.ok(h.comments[0]!.body.includes(file.filename), h.comments[0]!.body);
    }
  });

  test('a commit someone else pushed, or one GitHub did not verify, waits for a person, naming the commit', async () => {
    const OTHER = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
    for (const commit of [
      { sha: OTHER, author: 'a-member', committer: 'web-flow', verified: true },
      { sha: OTHER, author: null, committer: null, verified: false },
      { sha: OTHER, author: 'dependabot[bot]', committer: 'web-flow', verified: false },
      { sha: OTHER, author: 'dependabot[bot]', committer: 'a-member', verified: true },
    ]) {
      const h = harness({ pulls: { 767: dependabotRow() }, files: PIP, commits: [DEPENDABOT_COMMIT, commit] });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented'], JSON.stringify(commit));
      assert.deepEqual(h.merges, []);
      assert.ok(h.comments[0]!.body.includes(OTHER.slice(0, 12)), h.comments[0]!.body);
      assert.match(h.comments[0]!.body, /A person merges it\./);
    }
  });

  test('a hold said already edits its comment in place on Dependabot\'s rebase', async () => {
    const files: FileRow[] = [...PIP, { filename: 'src/voices.ts', status: 'modified' }];
    const first = harness({ pulls: { 767: dependabotRow() }, files });
    await review({ kind: 'review', pr: 767 }, first);
    const said = first.comments[0]!.body;
    const h = harness({ pulls: { 767: dependabotRow({ headSha: MOVED }) }, files, ciRuns: [ciRun({ head_sha: MOVED })], thread: [{ id: 9, body: said, created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.equal(h.commentEdits[0]!.id, 9);
  });

  test('a conflict is Dependabot\'s to rebase: no comment and no merge, and the rebase\'s push is reviewed', async () => {
    const h = harness({ pulls: { 767: [dependabotRow({ mergeable: null }), dependabotRow({ mergeable: false })] }, files: PIP });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped']);
    assert.match(String(result.reviews[0]!.reason), /Dependabot rebases/);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.merges, []);
  });

  test('another bot, or a person outside the repository, is still not read: only Dependabot is', async () => {
    for (const over of [{ author: 'renovate[bot]' }, { author: 'dependabot' }, { author: 'someone' }]) {
      const h = harness({ pulls: { 767: dependabotRow(over) }, files: PIP });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped'], over.author);
      assert.deepEqual(h.merges, [], over.author);
      assert.deepEqual(h.comments, [], over.author);
    }
  });

  test('a session\'s PR changing the same manifests is still held to the checklist and the human-only list', async () => {
    const h = harness({ files: [{ filename: 'package-lock.json', status: 'modified' }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.match(h.comments[0]!.body, /human-only list/);
    assert.deepEqual(h.merges, []);
  });
});

describe('run — a fail said already', () => {
  // Worded as before #780, so a comment already posted still matches a fail on its test.
  const said = 'Waits for a person: the change adds an IAM grant (test 3). No edit to the description meets this one. A person merges it.';

  test('the same test and editable moves the marker in the existing comment to the head and body just reviewed', async () => {
    const h = harness({ answers: [IAM], thread: [{ id: 41, body: marked(said, MOVED), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: asked(textOf(IAM)) }]);
  });

  test('the same test and editable, reworded, edits the existing comment to the new words and posts nothing', async () => {
    const reworded: Answer = { ...IAM, reason: 'it grants a new IAM permission to the task role' };
    const h = harness({ answers: [reworded], thread: [{ id: 41, body: marked(said, MOVED), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: asked(textOf(reworded)) }]);
  });

  test('a different test, or the same test with a different editable, is a new comment', async () => {
    for (const answer of [{ ...IAM, test: 5 }, COSTS] as Answer[]) {
      const h = harness({ answers: [answer], thread: [{ id: 41, body: marked(said, MOVED), created_at: 't', ours: true }] });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented'], JSON.stringify(answer));
      assert.equal(h.comments.length, 1);
      assert.deepEqual(h.commentEdits, []);
    }
  });

  test('a fail after a conflict comment is a new comment', async () => {
    const conflict = textOf({ answer: 'pass', reason: 'closes #748 as written' }, true);
    const h = harness({ answers: [IAM], thread: [{ id: 41, body: marked(conflict, MOVED), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.equal(h.comments.length, 1);
    assert.deepEqual(h.commentEdits, []);
  });
});

describe('run — a conflict said already', () => {
  const said = textOf({ answer: 'pass', reason: 'closes #748 as written' }, true);

  test('a conflict after a conflict comment, reworded, edits that comment to the new words and posts nothing', async () => {
    const h = harness({ pulls: { 767: pullRow({ mergeable: false }) }, thread: [{ id: 41, body: marked(said, HEAD, 'an older body'), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: asked(textOf(PASS, true)) }]);
    assert.deepEqual(h.merges, []);
  });

  test('a conflict after a merge to main\'s conflict comment edits that comment and posts nothing: the owner was told of it', async () => {
    const merged = mergeConflictText({ mainSha: MOVED, merged: 793 });
    const h = harness({ pulls: { 767: pullRow({ mergeable: false }) }, thread: [{ id: 41, body: marked(merged, HEAD, `${BODY}\n${merged}`), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: asked(textOf(PASS, true)) }]);
  });

  test('a conflict after a fail comment is a new comment', async () => {
    const h = harness({ pulls: { 767: pullRow({ mergeable: false }) }, thread: [{ id: 41, body: marked(textOf(IAM), MOVED), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['conflict']);
    assert.equal(h.comments.length, 1);
    assert.deepEqual(h.commentEdits, []);
  });
});

/**
 * A PR that catches up to its base gets a new head, and the model would be
 * asked the question it already answered: its prompt holds the PR's title
 * and body, the tickets it closes, its changed-file lines and any quoted
 * files' text, none of which a merge from main changes. Where the last
 * review at an earlier head was a pass, and what the model would read hashes
 * the same, the pass is posted again at the new head with no model call.
 * Every test decided in code still runs first, and a fail is never reused.
 */
describe('run: a pass reused at a new head', () => {
  const EARLIER = 'e'.repeat(40);
  const LATER = '9'.repeat(40);
  const QUOTED = 'docs/constraints/review.md';
  /** Each file's text at the merge base and at `head`, the quoted rule changed from `before` to `after`. */
  const ruleTexts = (head: string, before = 'The old rule.', after = 'The new rule.') => ({ [`${MERGE_BASE}:${QUOTED}`]: before, [`${head}:${QUOTED}`]: after });
  type Over = Parameters<typeof harness>[0];
  /** The review's comment at EARLIER, by a turn reviewing the PR there, over `over`. */
  const reviewedAt = async (head: string, over: Over = {}, thread: Thread[] = []) => {
    const h = harness({ pulls: { 767: pullRow({ headSha: head, mergeable: false }) }, ciRuns: [ciRun({ head_sha: head })], thread, ...over });
    await review({ kind: 'review', pr: 767 }, h);
    const said = h.comments[0]?.body ?? h.commentEdits[0]?.body;
    assert.ok(said !== undefined, 'the earlier review posted a comment');
    return said;
  };
  const ours = (body: string): Thread[] => [{ id: 41, body, created_at: 't', ours: true }];

  test('a PR passed at one head, given a new head with the same body, tickets and file list, passes at the new head with no model call', async () => {
    // The #414 shape: a conflict at the earlier head, the model's pass in it, and a push that only merges main.
    const earlier = await reviewedAt(EARLIER);
    assert.match(earlier, /^Passes the PR review, but conflicts with its base/);
    const h = harness({ thread: ours(earlier) });
    const result = await review({ kind: 'review', pr: 767, headSha: HEAD }, h);
    assert.deepEqual(h.judged, [], 'no model call');
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.checkRuns.map((c) => [c.sha, c.state]), [[HEAD, 'success']], 'the check names the new head');
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    const said = h.comments[0]!.body;
    assert.match(said, new RegExp(`^Passes the PR review: ${PASS.reason}\\. Reuses the answer given at ${EARLIER}: nothing the model reads has changed since\\.\\n\\n<!-- governor:pr-review ${HEAD} ${sha256(BODY)} [0-9a-f]{64} -->$`));
  });

  test('a pass the owner merges is reused too, and a reused pass again at a later head names the head the answer was given at', async () => {
    const earlier = await reviewedAt(EARLIER, { config: tagalongFile(), tickets: { 748: { labels: ['claimed'] } }, pulls: { 767: pullRow({ headSha: EARLIER }) } });
    assert.match(earlier, /^Passes the PR review: .* The repo's owner merges it\./);
    const middle = await reviewedAt(HEAD, { config: tagalongFile(), tickets: { 748: { labels: ['claimed'] } }, pulls: { 767: pullRow() }, answers: () => { throw new Error('the model was asked'); } }, ours(earlier));
    assert.match(middle, new RegExp(`^Passes the PR review: ${PASS.reason}\\. Reuses the answer given at ${EARLIER}: nothing the model reads has changed since\\. The repo's owner merges it\\.\\n\\n<!-- governor:pr-review ${HEAD} `));
    const h = tagalong({ pulls: { 767: pullRow({ headSha: LATER }) }, ciRuns: [ciRun({ head_sha: LATER })], thread: ours(middle) });
    const result = await reviewTagalong(h);
    assert.deepEqual(h.judged, []);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['passed']);
    assert.deepEqual(h.checkRuns.map((c) => [c.sha, c.state]), [[LATER, 'success']]);
    assert.match(h.comments[0]!.body, new RegExp(`Reuses the answer given at ${EARLIER}: .*\\n\\n<!-- governor:pr-review ${LATER} `));
  });

  test('a quoted file the same at the base and the head reuses the pass', async () => {
    const files: FileRow[] = [...FILES, { filename: QUOTED, status: 'modified' }];
    const earlier = await reviewedAt(EARLIER, { files, texts: ruleTexts(EARLIER) });
    const h = harness({ files, texts: ruleTexts(HEAD), thread: ours(earlier) });
    await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(h.judged, []);
    assert.match(h.comments[0]!.body, /^Passes the PR review: .* Reuses the answer given at /);
  });

  test('a new head that changes the file list, a closing ticket\'s text or labels, or a quoted file\'s text at the base or the head asks the model', async () => {
    const files: FileRow[] = [...FILES, { filename: QUOTED, status: 'modified' }];
    const earlier = await reviewedAt(EARLIER, { files, texts: ruleTexts(EARLIER) });
    const changes: Array<[string, Over]> = [
      ['the file list', { files: [...files, { filename: 'src/added.ts', status: 'added' }], texts: ruleTexts(HEAD) }],
      ['a file\'s status', { files: [FILES[0]!, { filename: 'docs/claude-code-setup.md', status: 'removed' }, files[2]!], texts: ruleTexts(HEAD) }],
      ['the ticket\'s text', { files, texts: ruleTexts(HEAD), tickets: { 748: { body: '## Acceptance criteria\n\n- It reviews, and says why.' } } }],
      ['the ticket\'s labels', { files, texts: ruleTexts(HEAD), tickets: { 748: { labels: ['mode: afk', 'type: nfr', 'workflow: under development', 'size: s'] } } }],
      ['the quoted file at the base', { files, texts: ruleTexts(HEAD, 'The older rule.') }],
      ['the quoted file at the head', { files, texts: ruleTexts(HEAD, 'The old rule.', 'The newer rule.') }],
      ['the title', { files, texts: ruleTexts(HEAD), pulls: { 767: pullRow({ title: 'Another title' }) } }],
    ];
    for (const [what, over] of changes) {
      const h = harness({ ...over, thread: ours(earlier) });
      await review({ kind: 'review', pr: 767 }, h);
      assert.equal(h.judged.length, 1, what);
      assert.doesNotMatch(h.comments[0]?.body ?? '', /Reuses the answer/, what);
    }
  });

  test('a new head whose last review failed asks the model', async () => {
    const earlier = await reviewedAt(EARLIER, { answers: [COSTS], pulls: { 767: pullRow({ headSha: EARLIER }) } });
    assert.match(earlier, /^Waits for a description edit: /);
    const h = harness({ thread: ours(earlier) });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.judged.length, 1);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
  });

  test('a tests-in-code fail at the new head still fails, whatever the earlier pass', async () => {
    const earlier = await reviewedAt(EARLIER);
    const red = harness({ thread: ours(earlier), required: ['gate'], checks: [{ name: 'gate', state: 'red' }] });
    await review({ kind: 'review', pr: 767 }, red);
    assert.match(red.comments[0]!.body, /^Waits for a push: the required check `gate` is red on its head \(test 8\)/);
    assert.deepEqual(red.checkRuns.map((c) => c.state), ['failure']);
    const conflict = harness({ thread: ours(earlier), pulls: { 767: pullRow({ mergeable: false }) } });
    const conflicted = await review({ kind: 'review', pr: 767 }, conflict);
    assert.deepEqual(conflicted.reviews.map((r) => r.outcome), ['marker-moved'], 'the conflict comment is edited to the new head');
    assert.deepEqual(conflict.merges, []);
    assert.deepEqual(conflict.checkRuns.map((c) => c.state), ['failure']);
    const human = harness({ thread: ours(earlier), files: [...FILES, { filename: 'infra/stack.yml', status: 'modified' }] });
    await review({ kind: 'review', pr: 767 }, human);
    assert.match(human.comments[0]!.body, /^Waits for a person: `infra\/stack\.yml` is on the human-only list/);
    for (const h of [red, conflict, human]) {
      assert.deepEqual(h.judged, []);
      assert.deepEqual(h.merges, []);
    }
  });

  test('a marker with no hash asks the model', async () => {
    const earlier = await reviewedAt(EARLIER);
    const unhashed = earlier.replace(/ [0-9a-f]{64} -->$/, ' -->');
    assert.match(unhashed, new RegExp(`<!-- governor:pr-review ${EARLIER} ${sha256(BODY)} -->$`));
    const h = harness({ thread: ours(unhashed) });
    await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.judged.length, 1);
  });

  test('a body edited since the pass asks the model', async () => {
    const earlier = await reviewedAt(EARLIER);
    const h = harness({ thread: ours(earlier), pulls: { 767: pullRow({ body: `${BODY}\n\nOne more line.` }) } });
    await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.judged.length, 1);
  });
});

const RUN_URL = `https://github.com/${REPO}/actions/runs/900`;
/** The held pass as the earlier review wrote it, still on PRs reviewed before the change. It carries no `governor` check. */
const HELD = `Passes the PR review: ${PASS.reason}. The merge waits for Deploy Prod run [900](${RUN_URL}) (in_progress) to end, and the review after it merges.`;

/**
 * No run holds a merge but the PR's own CI run at its head. An earlier
 * review held every pass while a Deploy Prod run was unfinished; the one
 * delivery workflow needs no hold, so a deploy, or any run but the CI
 * workflow's at the head, holds nothing. The CI run at the head is test 8's,
 * as a required check is, and its end queues the review again. A PR whose
 * newest review is a held pass from before this change is merged on its
 * next review with the judgement kept, so no PR waits on a sweep that no
 * longer comes.
 */
describe('fitness: run — no run but the CI workflow\'s at the head holds a merge (dispatcher-workflows.md)', () => {
  test('no code path holds a merge for a deploy\'s run: the review takes no promotion, and the turn reads no deploy runs', () => {
    const review = readFileSync(new URL('../dispatch/review.mjs', import.meta.url), 'utf8');
    const turn = readFileSync(new URL('../dispatch/turn.mjs', import.meta.url), 'utf8');
    for (const [text, name] of [[review, 'review.mjs'], [turn, 'turn.mjs']] as const) {
      assert.doesNotMatch(text, /promotion\s*[:=(]/, `${name} takes or asks a promotion`);
      assert.doesNotMatch(text, /deploy-prod\.yml|workflowRuns\('deliver\.yml'/, `${name} reads a deploy workflow's runs`);
      assert.doesNotMatch(text, /\('held'\)|'held'\s*\|\s*'skipped'/, `${name} knows a held outcome`);
    }
    assert.doesNotMatch(review, /workflowRuns\(/, 'the review reads no workflow\'s runs list, only the CI workflow\'s runs at the head');
    assert.equal(heldPassReason(HELD), `${PASS.reason}.`, 'the old held pass is still read, so it merges');
  });

  test('a pass merges whatever else is running: the review reads only the CI workflow\'s runs, at the PR\'s head', async () => {
    const h = harness({ ciRuns: [ciRun(), ciRun({ id: 901, path: '.github/workflows/deploy-prod.yml', status: 'in_progress', conclusion: null })] });
    const result = await review({ kind: 'review', pr: 767, headSha: HEAD }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.ciReads, [[CI, HEAD]]);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    assert.deepEqual(h.comments, [{ issue: 767, body: asked(textOf(PASS)) }]);
  });

  test('a repo whose file names no `workflows.ci` reads no workflow runs', async () => {
    const h = tagalong();
    assert.deepEqual((await reviewTagalong(h)).reviews.map((r) => r.outcome), ['passed']);
    assert.deepEqual(h.ciReads, []);
  });

  test('a repo whose CI runs only after the merge sets `review.waitForCi` false: the review reads no workflow runs', async () => {
    const opened = JSON.parse(factoryFile(CONFIG_PATH));
    const config = JSON.stringify({ ...opened, review: { ...opened.review, waitForCi: false } });
    for (const runs of [[], [ciRun({ conclusion: 'failure' })], [ciRun({ status: 'in_progress', conclusion: null })]]) {
      const h = harness({ config, ciRuns: runs });
      const turn = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['merged'], JSON.stringify(runs));
      assert.equal(h.judged.length, 1, 'the review reaches the model');
      assert.deepEqual(h.ciReads, [], 'no workflow runs are read');
      assert.deepEqual(h.checkRuns.map((c) => c.state), ['success']);
    }
  });

  test('with `review.waitForCi` false, a required check or a `requireChecks` entry still fails or holds test 8', async () => {
    const opened = JSON.parse(factoryFile(CONFIG_PATH));
    const config = (review: Record<string, unknown> = {}) => JSON.stringify({ ...opened, review: { ...opened.review, waitForCi: false, ...review } });
    const red = harness({ config: config(), required: ['gate'], checks: [{ name: 'gate', state: 'red' }], ciRuns: [] });
    await review({ kind: 'review', pr: 767 }, red);
    assert.equal(red.judged.length, 0);
    assert.match(red.comments[0]!.body, /^Waits for a push: the required check `gate` is red on its head \(test 8\)\./);
    const pending = harness({ config: config(), required: ['gate'], checks: [{ name: 'gate', state: 'pending' }], ciRuns: [] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, pending)).reviews.map((r) => r.outcome), ['skipped']);
    assert.equal(pending.checkRuns[0]!.title, 'Waits for its required checks to finish.');
    const listed = harness({ config: config({ requireChecks: ['codeql'] }), checks: [{ name: 'codeql', state: 'red' }], ciRuns: [] });
    await review({ kind: 'review', pr: 767 }, listed);
    assert.match(listed.comments[0]!.body, /^Waits for a push: the required check `codeql` is red on its head \(test 8\)\./);
    const unposted = harness({ config: config({ requireChecks: ['codeql'] }), ciRuns: [] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, unposted)).reviews.map((r) => r.outcome), ['skipped']);
    for (const h of [red, pending, listed, unposted]) assert.deepEqual(h.ciReads, []);
  });

  test('a PR whose newest review is a held pass from before the change is merged on its next review without judging, and its comment edited to say so', async () => {
    const h = harness({ thread: [{ id: 41, body: marked(HELD), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.judged, []);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: marked(`${textOf(PASS)} Merged once the promotion ended.`) }]);
    assert.deepEqual(receiverFires(h.commentEdits[0]!.body, BODY, 'edited'), [], 'an edit is no new delivery');
  });

  test('a held pass is held to the facts again when it merges: a ticket closed since fails in code, unjudged and unmerged', async () => {
    const h = harness({ tickets: { 748: { state: 'closed' } }, thread: [{ id: 41, body: marked(HELD), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.match(String(result.reviews[0]!.reason), /#748[\s\S]*\(test 1\)/);
    assert.deepEqual(h.judged, []);
    assert.deepEqual(h.merges, []);
    assert.deepEqual(h.commentEdits, []);
    assert.equal(h.comments.length, 1);
  });

  test('a held pass on a human-only path, however its comment came to be, is not merged', async () => {
    const h = harness({ files: [{ filename: '.claude/skills/pr-review/SKILL.md', status: 'modified' }], thread: [{ id: 41, body: marked(HELD), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.match(String(result.reviews[0]!.reason), /test 7/);
    assert.deepEqual(h.merges, []);
  });

  test('a conflict found on a held pass follows the conflict path: a new comment the owner hears', async () => {
    const h = harness({ pulls: { 767: pullRow({ mergeable: false }) }, thread: [{ id: 41, body: marked(HELD), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['conflict']);
    assert.deepEqual(h.judged, []);
    assert.deepEqual(h.merges, []);
    assert.deepEqual(h.comments.map((c) => c.body), [marked(textOf(PASS, true))]);
    assert.equal(receiverFires(h.comments[0]!.body).length, 1);
  });

  test('the review reads the thread as the dispatcher\'s own App, whose comments alone carry a review marker', async () => {
    const h = harness();
    await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(h.readerApps, [APP_ID]);
  });

  test('another bot\'s held pass at the current head and body is judged again, not merged on', async () => {
    const h = harness({ thread: [{ id: 41, body: marked(HELD), created_at: 't', ours: false }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.judged.length, 1);
    assert.deepEqual(h.commentEdits, []);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.equal(h.comments.length, 1);
  });

  test('a held pass on an older head or body is judged again', async () => {
    for (const body of [marked(HELD, MOVED), marked(HELD, HEAD, 'an older body')]) {
      const h = harness({ thread: [{ id: 41, body, created_at: 't', ours: true }] });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.equal(h.judged.length, 1);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
      assert.equal(h.comments.length, 1);
    }
  });
});

describe('run — the merge', () => {
  test('mergeable not yet computed is read again until it is; null is not a conflict', async () => {
    const h = harness({ pulls: { 767: [pullRow({ mergeable: null }), pullRow({ mergeable: null }), pullRow({ mergeable: true })] } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.ok(h.reads.length >= 3);
  });

  test('a conflict is a comment telling the author session the base merge is its to push, and no merge', async () => {
    const h = harness({ pulls: { 767: [pullRow({ mergeable: null }), pullRow({ mergeable: false })] } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['conflict']);
    assert.deepEqual(h.merges, []);
    assert.match(h.comments[0]!.body, /conflict/i);
    assert.match(h.comments[0]!.body, /base/);
    assert.match(h.comments[0]!.body, /governor:pr-review/);
    assert.equal(exitCodeFor(result as never), 0);
  });

  test('mergeable GitHub never computes is a fault, with nothing posted', async () => {
    const h = harness({ pulls: { 767: pullRow({ mergeable: null }) } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['failed']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.merges, []);
    assert.equal(exitCodeFor(result as never), 1);
  });

  test('a push while the review ran: nothing is posted or merged, and the push\'s fire reviews it', async () => {
    const h = harness({ pulls: { 767: [pullRow(), pullRow({ headSha: MOVED })] } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.merges, []);
  });

  test('a merge the App may not make is refused out loud: the turn fails, so dispatch-failed says so', async () => {
    const h = harness({ merge: async () => { throw Object.assign(new Error('PUT /repos/acme/factory/pulls/767/merge failed: 403 Forbidden: Resource not accessible by integration'), { status: 403 }); } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['failed']);
    assert.match(String(result.reviews[0]!.error), /403/);
    assert.equal(exitCodeFor(result as never), 1);
    // No marker names the head, so the next fire reads it again.
    assert.deepEqual(h.comments, []);
  });

  test('a PR turned back into a draft while the review ran is not merged', async () => {
    const h = harness({ pulls: { 767: [pullRow(), pullRow({ draft: true })] } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(h.merges, []);
    assert.deepEqual(h.comments, []);
  });

  test('a PR retargeted off main while the review ran is not merged', async () => {
    const h = harness({ pulls: { 767: [pullRow(), pullRow({ base: 'claude/the-pr-below' })] } });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(h.merges, []);
    assert.deepEqual(h.comments, []);
  });

});


/**
 * A fail the author session meets, by an edit or a claim, beside a test 7
 * no edit meets: a person merges the PR, and the session still hears its
 * part, which the person's merge would otherwise carry (a closing
 * keyword below the top lines, beside a `.claude/**` path).
 */
describe('run — the author session\'s part of a PR a person merges', () => {
  const OWNER = 'https://claude.ai/code/session_01OWNER';
  const HOOK: FileRow = { filename: '.claude/skills/pii-tokenise/hooks/register.js', status: 'modified' };
  const PROSE = 'Closes #748\n\n## Left for later\n\n- Dismissed: `Closes #12 and #13` read as prose.\n\nhttps://claude.ai/code/session_01OWNER';
  const edit = /^Waits for a description edit, then a person: /;
  const person = /^Waits for a person: /;
  /** The session's part, then the path a person merges past. */
  const inOrder = (text: string, test: number) => new RegExp(`\\(test ${test}\\)\\. [\\s\\S]*Test 7 fails whatever the description says: [\\s\\S]*${HOOK.filename.replace(/\./g, '\\.')}[\\s\\S]* A person merges it\\.`).test(text);

  test('a closing keyword below the top lines, beside a human-only path: the edit, then the person, and the owner session hears it', async () => {
    const h = harness({ pulls: { 767: pullRow({ body: PROSE }) }, files: [...FILES, HOOK] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(h.judged, []);
    assert.deepEqual(h.merges, []);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    const text = h.comments[0]!.body;
    assert.match(text, edit, text);
    assert.ok(text.includes('`Closes #12`'), text);
    assert.ok(inOrder(text, 1), text);
    assert.deepEqual(receiverFires(text, PROSE).map((f) => [f.kind, f.session]), [['message', OWNER]]);
  });

  test('every test-1 fail an edit meets is the session\'s beside a human-only path: an issue that does not exist, a pull request', async () => {
    for (const ticket of [null, { pull: true }]) {
      const h = harness({ tickets: { 748: ticket }, files: [HOOK] });
      await review({ kind: 'review', pr: 767 }, h);
      const text = h.comments[0]!.body;
      assert.match(text, edit, text);
      assert.ok(inOrder(text, 1), text);
      assert.equal(receiverFires(text).length, 1, text);
    }
  });

  test('a ticket still `ready for development`, beside a human-only path: the claim, then the person, and the owner session hears it', async () => {
    const h = harness({ tickets: { 748: { labels: ['mode: afk', 'type: nfr', 'workflow: ready for development'] } }, files: [HOOK] });
    await review({ kind: 'review', pr: 767 }, h);
    const text = h.comments[0]!.body;
    assert.match(text, /^Waits for its ticket to be claimed, then a person: /, text);
    assert.match(text, /#748, is not yet `workflow: under development`[\s\S]*\(test 1\)/, text);
    assert.ok(inOrder(text, 1), text);
    assert.deepEqual(receiverFires(text).map((f) => [f.kind, f.session]), [['message', OWNER]]);
  });

  test('a test-1 fail no edit meets, beside a human-only path, is a person\'s alone: the owner hears it, and no fallback takes the PR over', async () => {
    const h = harness({ tickets: { 748: { state: 'closed' } }, files: [HOOK] });
    await review({ kind: 'review', pr: 767 }, h);
    const text = h.comments[0]!.body;
    assert.match(text, person, text);
    assert.deepEqual(receiverFires(text).map((f) => [f.session, f.fallback]), [[OWNER, undefined]]);
  });

  test('the session\'s edit made, the next review says the person\'s part alone, in a new comment the owner hears with no fallback', async () => {
    const before = harness({ pulls: { 767: pullRow({ body: PROSE }) }, files: [HOOK] });
    await review({ kind: 'review', pr: 767 }, before);
    const fixed = PROSE.replace('`Closes #12 and #13`', 'a closing keyword in code');
    const h = harness({ pulls: { 767: pullRow({ body: fixed }) }, files: [HOOK], thread: [{ id: 41, body: before.comments[0]!.body, created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.deepEqual(h.commentEdits, []);
    const text = h.comments[0]!.body;
    assert.match(text, person, text);
    assert.deepEqual(receiverFires(text, fixed).map((f) => [f.session, f.fallback]), [[OWNER, undefined]]);
  });

  test('a person\'s fail said already, then an edit the session owes: a new comment the owner session hears, not an edit in place', async () => {
    const before = harness({ files: [HOOK] });
    await review({ kind: 'review', pr: 767 }, before);
    assert.match(before.comments[0]!.body, person);
    const h = harness({ pulls: { 767: pullRow({ body: PROSE }) }, files: [HOOK], thread: [{ id: 41, body: before.comments[0]!.body, created_at: 't', ours: true }] });
    await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(h.commentEdits, []);
    assert.match(h.comments[0]!.body, edit);
    assert.equal(receiverFires(h.comments[0]!.body, PROSE).length, 1);
  });
});

describe('run — the answer', () => {
  test('an answer the CLI did not give, or not in the schema, is a fault with nothing posted', async () => {
    for (const output of [
      'not json',
      JSON.stringify({ type: 'result', is_error: true, result: 'overloaded', session_id: 's' }),
      JSON.stringify({ type: 'result', is_error: false, result: '{"answer":"maybe"}', session_id: 's' }),
      JSON.stringify({ type: 'result', is_error: false, result: '{"answer":"fail","reason":"no test named"}', session_id: 's' }),
    ]) {
      const h = harness({ answers: () => output });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['failed'], output);
      assert.deepEqual(h.comments, []);
      assert.deepEqual(h.merges, []);
    }
  });
});

describe('run — a review of every open PR', () => {
  test('a fire naming no PR reads each open, non-draft PR in turn', async () => {
    const h = harness({
      open: [{ number: 767, draft: false }, { number: 773, draft: true }, { number: 780, draft: false }],
      pulls: { 767: pullRow(), 780: pullRow({ number: 780 }) },
      answers: [IAM, COSTS],
    });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'commented'], [780, 'commented']]);
    assert.deepEqual(h.comments.map((c) => c.issue), [767, 780]);
  });

  test('a sweep reads the default branch\'s required checks once, not once per PR', async () => {
    const h = harness({
      open: [{ number: 767, draft: false }, { number: 780, draft: false }],
      pulls: { 767: pullRow(), 780: pullRow({ number: 780 }) },
      answers: [IAM, COSTS],
      required: ['gate'],
    });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => r.pr), [767, 780]);
    assert.deepEqual(h.requiredReads, ['main']);
  });

  test('one PR\'s fault does not stop the next', async () => {
    const h = harness({ open: [{ number: 4389, draft: false }, { number: 767, draft: false }], answers: [IAM] });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[4389, 'failed'], [767, 'commented']]);
    assert.equal(exitCodeFor(result as never), 1);
  });

  test('past its window, no further review starts: the rest get the out-of-time check', async () => {
    let t = NOW;
    const h = harness({
      open: [{ number: 767, draft: false }, { number: 780, draft: false }],
      pulls: { 767: pullRow(), 780: pullRow({ number: 780 }) },
      answers: [IAM],
      now: () => { t += 4 * 60 * 1000; return t; },
    });
    const result = await review({ kind: 'review' }, h);
    assert.equal(h.judged.length, 1);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'commented'], [780, 'out-of-time']]);
  });

  // A PR the window kept the turn from reaching would otherwise wait, with
  // no check, on a ruleset that requires `governor`: it fails loudly
  // instead, through the review's usual skips.
  describe('fitness: a PR the review turn ran out of time for fails the `governor` check (dispatcher-review.md)', () => {
    const OTHER_HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
    const PENDING_HEAD = 'dddddddddddddddddddddddddddddddddddddddd';
    const late = (over: Parameters<typeof harness>[0] = {}) => {
      let t = NOW;
      const h = harness({
        open: [767, 780, 781, 782, 783, 784, 785, 786].map((number) => ({ number, draft: false })),
        pulls: {
          767: pullRow(),
          780: pullRow({ number: 780, headSha: OTHER_HEAD }),
          781: pullRow({ number: 781 }),
          782: pullRow({ number: 782, headSha: OTHER_HEAD, draft: true }),
          783: pullRow({ number: 783, headSha: OTHER_HEAD, base: 'trunk' }),
          784: pullRow({ number: 784, headSha: PENDING_HEAD }),
          785: pullRow({ number: 785, headSha: OTHER_HEAD, association: 'NONE' }),
          786: pullRow({ number: 786, headSha: OTHER_HEAD, state: 'closed' }),
        },
        // #781 was reviewed at its head with its body, and passed.
        threads: { 781: [{ id: 9, body: marked(textOf(PASS)), created_at: 't', ours: true }] },
        required: ['gate'],
        checksAt: (sha) => [{ name: 'gate', state: sha === PENDING_HEAD ? 'pending' : 'green' }],
        // The CI run at each head has finished green: only #784's required check waits.
        ciRuns: [HEAD, OTHER_HEAD, PENDING_HEAD].map((sha) => ciRun({ head_sha: sha })),
        // The one review the window let start runs past it.
        answers: () => { t += REVIEW_WINDOW_MS + 1; return cliOutput(IAM); },
        now: () => t,
        ...over,
      });
      return { h, at: (ms: number) => { t = ms; }, now: () => t };
    };

    test('past its window, each PR the turn did not reach fails the governor check, through the review\'s usual skips', async () => {
      const { h } = late();
      const result = await review({ kind: 'review' }, h);
      assert.equal(h.judged.length, 1, 'no review starts past the window');
      assert.deepEqual(h.checkRuns.map((c) => [c.sha, c.state]), [
        [HEAD, 'neutral'],
        [OTHER_HEAD, 'failure'],
        [PENDING_HEAD, 'in_progress'],
        [OTHER_HEAD, 'neutral'],
      ]);
      const failed = h.checkRuns[1]!;
      assert.equal(failed.title, 'The PR review did not run.');
      assert.match(failed.summary, /ran out of time before it reached this pull request/);
      assert.match(failed.summary, /A push or an edit to the description runs it again\./);
      assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [
        [767, 'commented'], [780, 'out-of-time'], [781, 'skipped'], [782, 'skipped'], [783, 'skipped'], [784, 'skipped'], [785, 'skipped'], [786, 'skipped'],
      ]);
      assert.deepEqual(h.comments.map((c) => c.issue), [767], 'a PR not reached gets the check, no comment');
      assert.deepEqual(h.merges, []);
      assert.equal(exitCodeFor(result as never), 0);
    });

    test('a 403 on the out-of-time check is logged and passed over, and the turn\'s outcome is as it was', async () => {
      const { h } = late({
        checkRun: async (run) => {
          if (run.state === 'failure') throw Object.assign(new Error('POST /check-runs failed: 403 Resource not accessible by integration'), { status: 403 });
        },
      });
      const result = await review({ kind: 'review' }, h);
      const refused = result.reviews.find((r) => r.pr === 780) as Review & { check?: string };
      assert.equal(refused.outcome, 'out-of-time');
      assert.match(String(refused.check), /^refused: .*403/);
      assert.equal(exitCodeFor(result as never), 0);
    });

    test('past the second limit nothing more is written, and the rest are logged', async () => {
      const holder: { at?: (ms: number) => void } = {};
      const { h, at } = late({
        // The first out-of-time check lands past the second limit.
        checkRun: async (run) => { if (run.state === 'failure') holder.at!(NOW + REVIEW_MARK_WINDOW_MS + 1); },
      });
      holder.at = at;
      const result = await review({ kind: 'review' }, h);
      assert.deepEqual(h.checkRuns.map((c) => c.state), ['neutral', 'failure']);
      assert.deepEqual(result.reviews.map((r) => r.pr), [767, 780]);
      const line = h.logged.find((l) => l.event === 'dispatch-review' && Array.isArray(l.unreviewed));
      assert.deepEqual(line?.unreviewed, [781, 782, 783, 784, 785, 786]);
      assert.match(String(line?.reason), /out of time/);
    });

    test('a review let start runs out its budget and the checks still fit inside the deadline', () => {
      assert.ok(REVIEW_WINDOW_MS + LAUNCH_TIMEOUT_MS < REVIEW_MARK_WINDOW_MS, 'the second limit falls after the last review the window let start can end');
      assert.ok(REVIEW_MARK_WINDOW_MS + 5 * 60_000 <= DEADLINE_MS, 'a check started before the second limit, its unbudgeted reads and the store-back end inside the deadline');
    });

    test('a held pass the turn ran out of time for gets the out-of-time check: it carries no check of its own', async () => {
      const { h } = late({ threads: { 781: [{ id: 9, body: marked(HELD), created_at: 't', ours: true }] } });
      const result = await review({ kind: 'review' }, h);
      assert.deepEqual(result.reviews.find((r) => r.pr === 781)?.outcome, 'out-of-time');
      assert.deepEqual(h.checkRuns.filter((c) => c.sha === HEAD).map((c) => c.state), ['neutral', 'failure']);
      assert.deepEqual(h.merges, []);
    });
  });

  // The account's session limit resets by itself, and a limited PR is
  // reviewed on its next push or edit: no
  // operator acts, so the turn does not fail (it paged the errors alarm
  // twice on 2026-09-30 before this).
  const refusal = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: 's' });
  const SESSION = refusal('You\'ve hit your session limit · resets 12:40am (UTC)');
  const WEEKLY = refusal('You\'ve hit your weekly limit · resets Oct 6, 12am (UTC)');
  const three = () => ({
    open: [{ number: 767, draft: false }, { number: 773, draft: false }, { number: 780, draft: false }],
    // #773 closes a closed ticket: decided in code, no run.
    pulls: { 767: pullRow(), 773: pullRow({ number: 773, body: BODY.replace('#748', '#754') }), 780: pullRow({ number: 780 }) },
    tickets: { 754: { state: 'closed' } },
  });

  test('the account\'s session limit is no fault, starts no further run, and still settles PRs decided in code', async () => {
    const h = harness({ ...three(), answers: () => SESSION });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'limited'], [773, 'commented'], [780, 'limited']]);
    assert.match(String(result.reviews[2]!.error), /session limit/);
    // #780's own run never started: its error says so, not that a run of it failed.
    assert.match(String(result.reviews[2]!.error), /no run started for #780/);
    assert.match(String(result.reviews[2]!.error), /#767/);
    assert.equal(h.judged.length, 1);
    assert.deepEqual(h.comments.map((c) => c.issue), [773]);
    assert.deepEqual(h.merges, []);
    assert.equal(exitCodeFor(result as never), 0);
  });

  test('each review\'s log line carries its run\'s tokens and cost, a limited run\'s too, and leaves out what the result line lacks', async () => {
    const usage = { input_tokens: 9, output_tokens: 210, cache_read_input_tokens: 4100, cache_creation_input_tokens: 650 };
    const spent = { inputTokens: 9, outputTokens: 210, cacheReadTokens: 4100, cacheCreationTokens: 650, costUsd: 0.031 };
    const answered = (prompt: string) => prompt.includes('#767')
      ? JSON.stringify({ ...JSON.parse(cliOutput(PASS)), usage, total_cost_usd: 0.031 })
      : cliOutput(PASS);
    const open = [{ number: 767, draft: false }, { number: 780, draft: false }];
    const h = harness({ open, pulls: { 767: pullRow(), 780: pullRow({ number: 780 }) }, answers: answered });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'merged'], [780, 'merged']]);
    const line = (pr: number) => h.logged.find((l) => l.event === 'dispatch-review' && l.pr === pr)!;
    assert.deepEqual(line(767).usage, spent);
    assert.ok(!('usage' in line(780)), JSON.stringify(line(780)));

    const limited = harness({ ...three(), answers: () => JSON.stringify({ ...JSON.parse(SESSION), usage, total_cost_usd: 0.031 }) });
    await review({ kind: 'review' }, limited);
    const logged = (pr: number) => limited.logged.find((l) => l.event === 'dispatch-review' && l.pr === pr)!;
    assert.equal(logged(767).outcome, 'limited');
    assert.deepEqual(logged(767).usage, spent);
    // #773 was decided in code and #780's run never started: neither spent anything.
    assert.ok(!('usage' in logged(773)) && !('usage' in logged(780)), JSON.stringify(limited.logged));
  });

  test('a weekly limit is still a fault, and starts no further run either', async () => {
    const h = harness({ ...three(), answers: () => WEEKLY });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => [r.pr, r.outcome]), [[767, 'failed'], [773, 'commented'], [780, 'failed']]);
    assert.equal(h.judged.length, 1);
    assert.equal(exitCodeFor(result as never), 1);
  });

  test('only the CLI\'s own refusal is a limit: an answer quoting one is a fault', async () => {
    const quoted = JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: JSON.stringify({ answer: 'maybe', reason: 'You\'ve hit your session limit' }) });
    const h = harness({ answers: () => quoted });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['failed']);
  });

  test('the refusal is read whatever its apostrophe or case', () => {
    for (const text of ['You’ve hit your session limit · resets 1am', 'Session limit reached']) {
      assert.throws(() => parseReview(refusal(text)), (error: { limit?: string }) => error.limit === 'session', text);
    }
    assert.throws(() => parseReview(WEEKLY), (error: { limit?: string }) => error.limit === 'weekly');
    assert.throws(() => parseReview(refusal('overloaded')), (error: { limit?: string }) => error.limit === undefined);
  });
});

/**
 * Any served repo's review, from its own `review` settings. A
 * t-d-d repo whose owner merges turns the review on with `merge: false`.
 */
const TAGALONG = 't-d-d/tagalong';
const TAGALONG_CHECKLIST = '# Tagalong review\n\nPass a PR that says what it changes.';
const tagalongFile = (review: Record<string, unknown> = {}, features: Record<string, boolean> = { prReview: true }) => JSON.stringify({
  environment: 'env_01TAG',
  labels: { ready: ['ready'], claim: 'claimed' },
  features,
  review: { checklist: TAGALONG_CHECKLIST, merge: false, ...review },
});
const tagalong = (over: Parameters<typeof harness>[0] = {}, review: Record<string, unknown> = {}, features?: Record<string, boolean>) => {
  const h = harness({ config: tagalongFile(review, features), tickets: { 748: { labels: ['claimed'] } }, ...over });
  (h.deps as { owners: string[] }).owners = ['acme', 't-d-d'];
  return h;
};
const reviewTagalong = (h: ReturnType<typeof harness>) => review({ kind: 'review', pr: 767, repo: TAGALONG }, h);

describe('fitness: a pass merges only where merge is on, and approves nothing (dispatcher-review.md)', () => {
  test('a pass in a repo whose file sets merge false is the comment and the check, with no merge call and no approval', async () => {
    const h = tagalong();
    const turn = await reviewTagalong(h);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['passed']);
    assert.deepEqual(h.merges, []);
    assert.deepEqual(h.writes, ['check success', 'comment']);
    assert.match(h.comments[0]!.body, /^Passes the PR review: .* The repo's owner merges it\.\n\n<!-- governor:pr-review /, 'the comment keeps the marker, so the same head and body are not read twice');
    assert.doesNotMatch(h.comments[0]!.body, /Approved/);
  });

  test('the repo\'s own checklist is the model\'s prompt, not the factory\'s', async () => {
    const h = tagalong();
    await reviewTagalong(h);
    assert.ok(h.judged[0]!.system.startsWith(`${PR_FRAME}\n\n${TAGALONG_CHECKLIST}`), h.judged[0]!.system);
    assert.ok(!h.judged[0]!.system.includes(SKILL));
  });

  test('a pass where merge is on, set or left out, completes its check as success before the merge call', async () => {
    for (const merge of [true, undefined]) {
      const h = tagalong({}, { merge });
      await reviewTagalong(h);
      assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }], String(merge));
      assert.deepEqual(h.writes, ['check success', 'merge', 'comment'], String(merge));
    }
    const factory = harness();
    await review({ kind: 'review', pr: 767 }, factory);
    assert.deepEqual(factory.writes, ['check success', 'merge', 'comment']);
  });

  test('a fail or a conflict where merge is off is the comment and the check, and nothing else: no dismissal to make', async () => {
    const failed = tagalong({ answers: [COSTS] });
    const conflicted = tagalong({ pulls: { 767: pullRow({ mergeable: false }) } });
    assert.deepEqual((await reviewTagalong(failed)).reviews.map((r) => r.outcome), ['commented']);
    assert.deepEqual((await reviewTagalong(conflicted)).reviews.map((r) => r.outcome), ['conflict']);
    for (const h of [failed, conflicted]) {
      assert.deepEqual(h.merges, []);
      assert.deepEqual(h.writes, ['check failure', 'comment']);
    }
  });
});

/**
 * The `governor` check: the review's verdict where a ruleset can require
 * it. `neutral` passes a required check, so only a pull request handed to
 * a person gets it.
 */
describe('fitness: the review posts its verdict as the `governor` check (dispatcher-review.md)', () => {
  const HOOK: FileRow = { filename: '.claude/skills/pii-tokenise/hooks/register.js', status: 'modified' };
  const PROSE = 'Closes #748\n\n## Left for later\n\n- Dismissed: `Closes #12 and #13` read as prose.\n\nhttps://claude.ai/code/session_01OWNER';

  test('each verdict posts one check at the head reviewed, its first sentence the title and the comment\'s words the summary; a fail the author session meets is never neutral', async () => {
    const cases: Array<[string, ReturnType<typeof harness>, string, () => Promise<unknown>]> = [];
    const add = (name: string, h: ReturnType<typeof harness>, state: string, repo = REPO) => {
      cases.push([name, h, state, () => (repo === TAGALONG ? reviewTagalong(h) : review({ kind: 'review', pr: 767 }, h))]);
    };
    add('a pass that merges', harness(), 'success');
    add('a pass the owner merges', tagalong(), 'success', TAGALONG);
    add('a pass that conflicts', harness({ pulls: { 767: pullRow({ mergeable: false }) } }), 'failure');
    add('an edit', harness({ answers: [COSTS] }), 'failure');
    add('a claim', tagalong({ tickets: { 748: { labels: ['ready'] } } }), 'failure', TAGALONG);
    add('a push', tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }] }), 'failure', TAGALONG);
    add('an edit, then a person', harness({ pulls: { 767: pullRow({ body: PROSE }) }, files: [...FILES, HOOK] }), 'failure');
    add('a claim, then a person', harness({ tickets: { 748: { labels: ['mode: afk', 'type: nfr', 'workflow: ready for development'] } }, files: [HOOK] }), 'failure');
    add('a person', harness({ answers: [IAM] }), 'neutral');
    for (const [name, h, state, go] of cases) {
      await go();
      const said = withoutMarkerText(h.comments[0]!.body);
      assert.deepEqual(h.checkRuns.map((c) => [c.name, c.sha, c.state]), [['governor', HEAD, state]], name);
      assert.equal(h.checkRuns[0]!.summary, said, name);
      // A first sentence past 200 characters is cut, and says so.
      const title = h.checkRuns[0]!.title;
      assert.ok(said.startsWith(title.replace(/…$/, '')), `${name}: ${title}`);
      assert.ok(title.length <= 200, `${name}: ${title.length}`);
      assert.match(title, /[.!?…]$/, name);
      if (ownerActs(said)) assert.equal(state, 'failure', `${name}: neutral would pass a required check the session still owes`);
    }
    assert.equal(cases[3]![1].checkRuns[0]!.title, 'Waits for a description edit: the description names no cost for the new module (test 3).');
  });

  test('a required check not finished posts the check in progress, and nothing else', async () => {
    const h = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'pending' }] });
    const turn = await reviewTagalong(h);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(h.checkRuns.map((c) => [c.name, c.sha, c.state]), [['governor', HEAD, 'in_progress']]);
    assert.match(h.checkRuns[0]!.summary, /`gate`/);
    assert.deepEqual(h.writes, ['check in_progress']);
  });

  test('a bump is read by the Dependabot list whatever trust.review says', async () => {
    const opened = JSON.parse(factoryFile(CONFIG_PATH));
    const config = JSON.stringify({ ...opened, pickup: { ...opened.pickup, by: ['OWNER'] }, trust: { ...opened.trust, review: ['OWNER'] } });
    const h = harness({ config, pulls: { 767: dependabotRow() }, files: [{ filename: 'normalize-lambda/requirements.txt', status: 'modified' }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
  });

  test('an author who may not summon governor gets a neutral check saying a person merges it', async () => {
    const h = harness({ pulls: { 767: pullRow({ association: 'CONTRIBUTOR' }) } });
    const turn = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(h.checkRuns.map((c) => [c.sha, c.state]), [[HEAD, 'neutral']]);
    assert.match(h.checkRuns[0]!.summary, /A person merges it\./);
    assert.deepEqual(h.writes, ['check neutral']);
  });

  test('a review that does not finish posts failure, saying it did not run, why, and that a push or an edit runs it again', async () => {
    const refusal = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'You\'ve hit your session limit · resets 12:40am (UTC)', session_id: 's' });
    const limited = harness({ answers: () => refusal });
    const refused = harness({ merge: async () => { throw Object.assign(new Error('PUT /repos/acme/factory/pulls/767/merge failed: 405 Method Not Allowed'), { status: 405 }); } });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, limited)).reviews.map((r) => r.outcome), ['limited']);
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, refused)).reviews.map((r) => r.outcome), ['failed']);
    for (const [h, why] of [[limited, /session limit/], [refused, /405/]] as const) {
      const last = h.checkRuns.at(-1)!;
      assert.deepEqual([last.name, last.sha, last.state], ['governor', HEAD, 'failure']);
      assert.match(last.title, /did not run/);
      assert.match(last.summary, why);
      assert.match(last.summary, /A push or an edit to the description runs it again\./);
      assert.deepEqual(h.comments, [], 'no marker, so the next fire reads it again');
    }
    assert.deepEqual(refused.writes, ['check success', 'merge', 'check failure'], 'the refused merge\'s success is overwritten');
  });

  test('every other skip posts nothing: a closed PR, a draft, another base, a head and body reviewed already, a moved head, a Dependabot conflict', async () => {
    const reviewed = [{ id: 5, body: marked('Waits for a person: x (test 3).'), created_at: 't', ours: true }];
    for (const [name, h, fire] of [
      ['closed', harness({ pulls: { 767: pullRow({ state: 'closed' }) } }), { pr: 767 }],
      ['draft', harness({ pulls: { 767: pullRow({ draft: true }) } }), { pr: 767 }],
      ['base', harness({ pulls: { 767: pullRow({ base: 'claude/below' }) } }), { pr: 767 }],
      ['reviewed', harness({ thread: reviewed }), { pr: 767 }],
      ['moved', harness({ pulls: { 767: pullRow({ headSha: MOVED }) } }), { pr: 767, headSha: HEAD }],
      ['dependabot', tagalong({ pulls: { 767: dependabotRow({ mergeable: false }) }, files: [{ filename: 'package-lock.json', status: 'modified' }] }, { dependabot: ['/package-lock.json'] }), { pr: 767, repo: TAGALONG }],
    ] as const) {
      const turn = await review({ kind: 'review', ...fire }, h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped'], name);
      assert.deepEqual(h.checkRuns, [], name);
    }
  });

  test('a required `governor` in progress or red does not stop the review: test 8 leaves out the review\'s own check', async () => {
    for (const state of ['pending', 'red'] as const) {
      const h = tagalong({ required: ['governor', 'gate'], checks: [{ name: 'governor', state }, { name: 'gate', state: 'green' }] });
      const turn = await reviewTagalong(h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['passed'], state);
      assert.equal(h.judged.length, 1, state);
    }
    const bodyEdited = tagalong({ required: ['governor'], checks: [{ name: 'governor', state: 'red' }], thread: [{ id: 7, body: marked(textOf(COSTS), HEAD, 'an older body'), created_at: 'a', ours: true }] });
    assert.deepEqual((await reviewTagalong(bodyEdited)).reviews.map((r) => r.outcome), ['passed'], 'its own earlier failure is no red required check');
  });

  test('a 403 on the check write leaves the review\'s outcome as it was, and the review says it was refused', async () => {
    const forbidden = async () => { throw Object.assign(new Error('POST /repos/acme/factory/check-runs failed: 403 Forbidden: Resource not accessible by integration'), { status: 403 }); };
    for (const [h, go, outcome] of [
      [harness({ checkRun: forbidden }), (h: ReturnType<typeof harness>) => review({ kind: 'review', pr: 767 }, h), 'merged'],
      [tagalong({ checkRun: forbidden }), reviewTagalong, 'passed'],
      [harness({ checkRun: forbidden, answers: [COSTS] }), (h: ReturnType<typeof harness>) => review({ kind: 'review', pr: 767 }, h), 'commented'],
      [tagalong({ checkRun: forbidden, required: ['gate'], checks: [{ name: 'gate', state: 'pending' }] }), reviewTagalong, 'skipped'],
    ] as const) {
      const turn = await go(h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), [outcome]);
      assert.match(String((turn.reviews[0] as { check?: unknown }).check), /403/, outcome);
      assert.equal(exitCodeFor(turn as never), 0, outcome);
      assert.ok(h.logged.some((l) => l.event === 'dispatch-review' && /403/.test(String(l.check))), outcome);
    }
  });

  test('a comment refused after the merge leaves the merged head\'s check as success: the review ran', async () => {
    const h = harness({ comment: async () => { throw Object.assign(new Error('POST /repos/acme/factory/issues/767/comments failed: 502 Bad Gateway'), { status: 502 }); } });
    const turn = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['failed']);
    assert.deepEqual(h.writes, ['check success', 'merge']);
  });

  test('any other refusal of the check write fails the review before its comment: no marker, so the next fire reads it again', async () => {
    const h = harness({ checkRun: async () => { throw Object.assign(new Error('POST /repos/acme/factory/check-runs failed: 502 Bad Gateway'), { status: 502 }); } });
    const turn = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['failed']);
    assert.match(String(turn.reviews[0]!.error), /502/);
    assert.deepEqual([h.merges, h.comments], [[], []]);
  });
});

describe('fitness: the settings checks decide before the model (dispatcher-review.md)', () => {
  test('a ticket breaking the repo\'s ticket rules fails test 1 in code, the rule\'s own labels named', async () => {
    const forbidden = tagalong({ tickets: { 748: { labels: ['claimed', 'epic'] } } }, { tickets: { forbid: [{ labels: ['epic'] }] } });
    await reviewTagalong(forbidden);
    const required = tagalong({}, { tickets: { require: [{ labels: ['size: s', 'size: m'] }] } });
    await reviewTagalong(required);
    const waived = tagalong({ tickets: { 748: { labels: ['claimed', 'epic', 'split'] } } }, { tickets: { forbid: [{ labels: ['epic'], unless: ['split'] }] } });
    await reviewTagalong(waived);
    assert.deepEqual([forbidden.judged, required.judged].map((j) => j.length), [0, 0]);
    assert.match(forbidden.comments[0]!.body, /^Waits for a person: the ticket it closes, #748, is `epic` \(test 1\)/);
    assert.match(required.comments[0]!.body, /#748, carries none of `size: s`, `size: m` \(test 1\)/);
    assert.equal(waived.judged.length, 1, 'a waiving label lets the ticket through');
  });

  test('a ticket not carrying the repo\'s claim label is told to claim it where it still carries the ready labels, and waits for a person otherwise', async () => {
    const ready = tagalong({ tickets: { 748: { labels: ['ready'] } } });
    await reviewTagalong(ready);
    assert.match(ready.comments[0]!.body, /^Waits for its ticket to be claimed: the ticket it closes, #748, is not yet `claimed`/);
    const neither = tagalong({ tickets: { 748: { labels: [] } } });
    await reviewTagalong(neither);
    assert.match(neither.comments[0]!.body, /^Waits for a person: the ticket it closes, #748, is not `claimed`, nor ready to claim/);
    assert.deepEqual([ready.judged.length, neither.judged.length], [0, 0]);
  });

  test('a change on the repo\'s human-only list fails test 7 in code; one an `unless` label waives does not', async () => {
    const listed = tagalong({ files: [{ filename: 'infra/stack.yml', status: 'modified' }] }, { humanOnly: [{ glob: 'infra/**', reason: 'the stacks' }] });
    await reviewTagalong(listed);
    assert.equal(listed.judged.length, 0);
    assert.match(listed.comments[0]!.body, /`infra\/stack\.yml` is on the human-only list \(`infra\/\*\*`: the stacks\) \(test 7\)/);
    const waived = tagalong({ files: [{ filename: 'infra/stack.yml', status: 'modified' }], tickets: { 748: { labels: ['claimed', 'paired'] } } }, { humanOnly: [{ glob: 'infra/**', reason: 'the stacks', unless: ['paired'] }] });
    await reviewTagalong(waived);
    assert.equal(waived.judged.length, 1);
  });

  test('a required check red on the head fails test 8 in code, for the author session\'s push; a red check not required, or a required one green, goes to the model', async () => {
    const red = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }, { name: 'lint', state: 'green' }] });
    await reviewTagalong(red);
    assert.equal(red.judged.length, 0);
    const text = red.comments[0]!.body;
    assert.match(text, /^Waits for a push: the required check `gate` is red on its head \(test 8\)\. A push that turns it green meets it, and the review runs again on the push\./);
    assert.ok(ownerActs(withoutMarkerText(text)), 'the author session hears it: the push is its');
    for (const over of [{ required: ['gate'], checks: [{ name: 'gate', state: 'green' }, { name: 'lint', state: 'red' }] }, { required: [], checks: [{ name: 'gate', state: 'red' }] }] as const) {
      const h = tagalong({ required: [...over.required], checks: [...over.checks] });
      await reviewTagalong(h);
      assert.equal(h.judged.length, 1, JSON.stringify(over));
    }
  });

  test('a Dependabot bump on the repo\'s list still fails a red required check', async () => {
    const h = tagalong({ pulls: { 767: dependabotRow() }, files: [{ filename: 'package-lock.json', status: 'modified' }], required: ['gate'], checks: [{ name: 'gate', state: 'red' }] }, { dependabot: ['/package-lock.json'] });
    await reviewTagalong(h);
    assert.equal(h.judged.length, 0);
    assert.match(h.comments[0]!.body, /^Waits for a push: .* \(test 8\)/);
  });
});

describe('run — required checks still running, or run again', () => {
  test('a required check still running, or not yet started, skips the review with no comment: the run\'s end reviews it', async () => {
    for (const checks of [[{ name: 'gate', state: 'pending' as const }], []]) {
      const h = tagalong({ required: ['gate'], checks });
      const turn = await reviewTagalong(h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped'], JSON.stringify(checks));
      assert.match(String(turn.reviews[0]!.reason), /`gate`.*not finished/);
      assert.deepEqual([h.judged.length, h.comments.length, h.merges.length], [0, 0, 0]);
      assert.deepEqual(h.checkRuns.map((c) => c.state), ['in_progress']);
    }
  });

  test('a required check with a skipped run and a run still going of its name skips the review: the green one does not finish it', async () => {
    // `checksAt` reads a skipped run as green: a pull_request run that skips `gate` beside the push run still going.
    for (const checks of [
      [{ name: 'gate', state: 'green' as const }, { name: 'gate', state: 'pending' as const }],
      [{ name: 'gate', state: 'pending' as const }, { name: 'gate', state: 'green' as const }],
    ]) {
      const h = tagalong({ required: ['gate'], checks });
      const turn = await reviewTagalong(h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped'], JSON.stringify(checks));
      assert.match(String(turn.reviews[0]!.reason), /`gate`.*not finished/);
      assert.deepEqual([h.judged.length, h.comments.length, h.merges.length], [0, 0, 0]);
      assert.deepEqual(h.checkRuns.map((c) => c.state), ['in_progress']);
    }
  });

  test('a required check with any red run reads red, even beside a green and a pending run of its name; one whose only run was skipped reads green', async () => {
    const red = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'green' }, { name: 'gate', state: 'pending' }, { name: 'gate', state: 'red' }] });
    await reviewTagalong(red);
    assert.equal(red.judged.length, 0);
    assert.match(red.comments[0]!.body, /^Waits for a push: the required check `gate` is red on its head \(test 8\)/);
    // `checksAt` reads a skipped run as green, so a lone green is a lone skipped run here.
    const skipped = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'green' }] });
    assert.deepEqual((await reviewTagalong(skipped)).reviews.map((r) => r.outcome), ['passed']);
    assert.equal(skipped.judged.length, 1);
  });

  test('a test-8 fail at the same head and body is read again: a re-run that turns the check green is reviewed', async () => {
    const red = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }] });
    await reviewTagalong(red);
    const thread = [{ id: 7, body: red.comments[0]!.body, created_at: 'a', ours: true }];
    const green = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'green' }], thread });
    assert.deepEqual((await reviewTagalong(green)).reviews.map((r) => r.outcome), ['passed']);
    assert.equal(green.judged.length, 1);
    const still = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }], thread });
    assert.deepEqual((await reviewTagalong(still)).reviews.map((r) => r.outcome), ['marker-moved'], 'still red: the comment stands, edited in place');
  });
});

describe('run — the CI workflow\'s run at the head (test 8)', () => {
  test('a red CI run at the head fails test 8 for the author session\'s push, naming the workflow file, and the model is not asked', async () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']) {
      const h = harness({ ciRuns: [ciRun({ conclusion })] });
      const turn = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['commented'], conclusion);
      assert.equal(h.judged.length, 0, conclusion);
      assert.deepEqual(h.merges, [], conclusion);
      const text = h.comments[0]!.body;
      assert.match(text, /^Waits for a push: the CI workflow `\.github\/workflows\/ci\.yml` is red on its head \(test 8\)\. A push that turns it green meets it, and the review runs again on the push\./, conclusion);
      assert.ok(ownerActs(withoutMarkerText(text)), 'the author session hears it: the push is its');
      assert.deepEqual(h.checkRuns.map((c) => c.state), ['failure'], conclusion);
    }
  });

  test('a CI run not finished, or none at the head, skips the review and posts `governor` in progress', async () => {
    for (const runs of [[ciRun({ status: 'in_progress', conclusion: null })], [ciRun({ status: 'queued', conclusion: null })], []]) {
      const h = harness({ ciRuns: runs });
      const turn = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped'], JSON.stringify(runs));
      assert.match(String(turn.reviews[0]!.reason), /CI workflow `\.github\/workflows\/ci\.yml`.*not finished/);
      assert.deepEqual([h.judged.length, h.comments.length, h.merges.length], [0, 0, 0]);
      assert.deepEqual(h.checkRuns.map((c) => [c.sha, c.state]), [[HEAD, 'in_progress']]);
      assert.match(h.checkRuns[0]!.summary, /`\.github\/workflows\/ci\.yml`/);
    }
  });

  test('a green or skipped CI run lets the review reach the model', async () => {
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      const h = harness({ ciRuns: [ciRun({ conclusion })] });
      const turn = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['merged'], conclusion);
      assert.equal(h.judged.length, 1, conclusion);
    }
  });

  test('the latest CI run at the head decides: a re-run that ended green passes, one still going waits', async () => {
    const green = harness({ ciRuns: [ciRun({ id: 902, created_at: '2026-09-26T11:30:00Z' }), ciRun({ conclusion: 'failure' })] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, green)).reviews.map((r) => r.outcome), ['merged']);
    const going = harness({ ciRuns: [ciRun({ conclusion: 'failure' }), ciRun({ id: 902, status: 'in_progress', conclusion: null, created_at: '2026-09-26T11:30:00Z' })] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, going)).reviews.map((r) => r.outcome), ['skipped']);
  });

  test('another workflow\'s run, or a CI run at another commit, does not count', async () => {
    const other = harness({ ciRuns: [ciRun({ path: '.github/workflows/e2e.yml', conclusion: 'failure' }), ciRun()] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, other)).reviews.map((r) => r.outcome), ['merged']);
    const elsewhere = harness({ ciRuns: [ciRun({ head_sha: MOVED, conclusion: 'failure', created_at: '2026-09-26T11:30:00Z' }), ciRun()] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, elsewhere)).reviews.map((r) => r.outcome), ['merged']);
    for (const runs of [[ciRun({ path: '.github/workflows/e2e.yml' })], [ciRun({ head_sha: MOVED })]]) {
      const h = harness({ ciRuns: runs });
      assert.deepEqual((await review({ kind: 'review', pr: 767 }, h)).reviews.map((r) => r.outcome), ['skipped'], 'no CI run at the head: it waits');
      assert.equal(h.judged.length, 0);
    }
  });

  test('a test-8 fail from the CI run is read again at the same head and body', async () => {
    const red = harness({ ciRuns: [ciRun({ conclusion: 'failure' })] });
    await review({ kind: 'review', pr: 767 }, red);
    const thread = [{ id: 7, body: red.comments[0]!.body, created_at: 'a', ours: true }];
    const green = harness({ thread });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, green)).reviews.map((r) => r.outcome), ['merged']);
    assert.equal(green.judged.length, 1);
    const still = harness({ ciRuns: [ciRun({ conclusion: 'failure' })], thread });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, still)).reviews.map((r) => r.outcome), ['marker-moved'], 'still red: the comment stands, edited in place');
  });

  test('a repo whose CI is also a required check reads both, to the same result', async () => {
    const red = harness({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }], ciRuns: [ciRun({ conclusion: 'failure' })] });
    await review({ kind: 'review', pr: 767 }, red);
    assert.equal(red.judged.length, 0);
    assert.match(red.comments[0]!.body, /^Waits for a push: the required check `gate` and the CI workflow `\.github\/workflows\/ci\.yml` are red on its head \(test 8\)/);
    const pending = harness({ required: ['gate'], checks: [{ name: 'gate', state: 'pending' }], ciRuns: [ciRun({ status: 'in_progress', conclusion: null })] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, pending)).reviews.map((r) => r.outcome), ['skipped']);
    assert.deepEqual(pending.checkRuns.map((c) => c.state), ['in_progress']);
    const green = harness({ required: ['gate'], checks: [{ name: 'gate', state: 'green' }] });
    assert.deepEqual((await review({ kind: 'review', pr: 767 }, green)).reviews.map((r) => r.outcome), ['merged']);
  });

  test('a Dependabot bump on the repo\'s list still fails a red CI run', async () => {
    const h = harness({ pulls: { 767: dependabotRow() }, files: [{ filename: 'package-lock.json', status: 'modified' }], ciRuns: [ciRun({ conclusion: 'failure' })] });
    await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.judged.length, 0);
    assert.match(h.comments[0]!.body, /^Waits for a push: the CI workflow .* \(test 8\)/);
  });
});

/**
 * The checks a repo's `review.requireChecks` lists: test 8 reads them as it
 * reads the checks GitHub requires. A private repo on a free plan can
 * require none, so its file names the checks the review waits for.
 */
describe('run, the checks the review section lists (test 8)', () => {
  test('a listed check red on the head fails test 8 for the author session\'s push, before the model', async () => {
    const h = tagalong({ checks: [{ name: 'codeql', state: 'red' }] }, { requireChecks: ['codeql'] });
    const turn = await reviewTagalong(h);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['commented']);
    assert.equal(h.judged.length, 0);
    const text = h.comments[0]!.body;
    assert.match(text, /^Waits for a push: the required check `codeql` is red on its head \(test 8\)\./);
    assert.ok(ownerActs(withoutMarkerText(text)), 'the author session hears it: the push is its');
    assert.deepEqual(h.checkRuns.map((c) => c.state), ['failure']);
  });

  test('a listed check not finished, or not posted, skips the review with `governor` in progress', async () => {
    for (const checks of [[{ name: 'codeql', state: 'pending' as const }], [], [{ name: 'lint', state: 'green' as const }]]) {
      const h = tagalong({ checks }, { requireChecks: ['codeql'] });
      const turn = await reviewTagalong(h);
      assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped'], JSON.stringify(checks));
      assert.match(String(turn.reviews[0]!.reason), /`codeql`.*not finished/);
      assert.deepEqual([h.judged.length, h.comments.length], [0, 0]);
      assert.deepEqual(h.checkRuns.map((c) => [c.sha, c.state]), [[HEAD, 'in_progress']]);
      assert.match(h.checkRuns[0]!.summary, /`codeql`/);
    }
  });

  test('a listed check green lets the review reach the model, beside GitHub\'s required ones', async () => {
    const h = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'green' }, { name: 'codeql', state: 'green' }] }, { requireChecks: ['codeql'] });
    assert.deepEqual((await reviewTagalong(h)).reviews.map((r) => r.outcome), ['passed']);
    assert.equal(h.judged.length, 1);
    const red = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'green' }, { name: 'codeql', state: 'red' }] }, { requireChecks: ['codeql'] });
    await reviewTagalong(red);
    assert.equal(red.judged.length, 0, 'GitHub requiring other checks does not hide a listed one');
  });

  test('a name GitHub also requires counts once', async () => {
    const red = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }] }, { requireChecks: ['gate', 'gate'] });
    await reviewTagalong(red);
    assert.match(red.comments[0]!.body, /^Waits for a push: the required check `gate` is red on its head \(test 8\)\./);
    const pending = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'pending' }] }, { requireChecks: ['gate'] });
    await reviewTagalong(pending);
    assert.equal(pending.checkRuns[0]!.title, 'Waits for its required checks to finish.');
    assert.equal(pending.checkRuns[0]!.summary, `The PR review runs when the required check \`gate\` has finished on ${HEAD.slice(0, 12)}.`);
  });

  test('a listed `governor` is left out, as a required one is', async () => {
    const h = tagalong({ checks: [{ name: 'governor', state: 'red' }] }, { requireChecks: ['governor'] });
    assert.deepEqual((await reviewTagalong(h)).reviews.map((r) => r.outcome), ['passed']);
  });
});

describe('run — any served repo\'s review', () => {
  test('reads PRs into the repo\'s default branch: a `trunk` repo reviews a PR into trunk and skips one into main', async () => {
    const into = tagalong({ base: 'trunk', pulls: { 767: pullRow({ base: 'trunk' }) } });
    assert.deepEqual((await reviewTagalong(into)).reviews.map((r) => r.outcome), ['passed']);
    const stacked = tagalong({ base: 'trunk' });
    const turn = await reviewTagalong(stacked);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['skipped']);
    assert.match(String(turn.reviews[0]!.reason), /into main, not trunk/);
  });

  test('a repo whose file leaves prReview off refuses the fire before the login', async () => {
    const h = tagalong({}, {}, { pickup: true });
    const turn = await run({ kind: 'review', pr: 767, repo: TAGALONG }, h.deps as never) as unknown as { refusal?: string };
    assert.match(String(turn.refusal), /does not turn prReview on/);
    assert.deepEqual([h.judged.length, h.comments.length], [0, 0]);
  });
});

describe('the comment\'s parts', () => {
  test('passOf reads the model\'s pass back from a pass, one the owner merges, a conflict and a reused pass, and nothing from a fail or a held pass', () => {
    const at = 'e'.repeat(40);
    const reason = 'closes #748 as written. Nothing is left open';
    const passes = { answer: 'pass', reason } as const;
    assert.deepEqual(passOf(textOf(passes)), { reason: `${reason}.`, reused: null });
    assert.deepEqual(passOf(commentText(passes, { conflict: false, merge: false })), { reason: `${reason}.`, reused: null });
    assert.deepEqual(passOf(textOf(passes, true)), { reason: `${reason}.`, reused: null });
    for (const conflict of [false, true]) {
      for (const merge of [false, true]) {
        const text = commentText({ ...passes, reused: at }, { conflict, merge });
        assert.match(text, new RegExp(`Reuses the answer given at ${at}: nothing the model reads has changed since\\.`));
        assert.deepEqual(passOf(text), { reason: `${reason}.`, reused: at }, text);
      }
    }
    assert.equal(passOf(textOf(IAM)), null);
    assert.equal(passOf(textOf(COSTS)), null);
    assert.equal(passOf(HELD), null);
    assert.equal(passOf(mergeConflictText({ mainSha: MOVED, merged: 793 })), null, 'a merge to main\'s conflict carries no answer of the model\'s');
  });

  test('commentKey names a fail comment by its test and editable, and a conflict comment as one, never by the reason', () => {
    const quoting: Answer = { ...IAM, reason: 'the grant (test 2). No edit to the description meets it' };
    assert.notEqual(commentKey(textOf(IAM)), null);
    assert.equal(commentKey(textOf(IAM)), commentKey(textOf(quoting)));
    assert.notEqual(commentKey(textOf(IAM)), commentKey(textOf(COSTS)));
    assert.notEqual(commentKey(textOf(IAM)), commentKey(textOf({ ...IAM, test: 7 })));
    assert.notEqual(commentKey(textOf(PASS, true)), null);
    assert.equal(commentKey(textOf(PASS, true)), commentKey(textOf({ answer: 'pass', reason: 'every criterion is answered at merge' }, true)));
    assert.notEqual(commentKey(textOf(PASS, true)), commentKey(textOf(IAM)));
    assert.notEqual(commentKey(textOf(PASS, true)), commentKey(textOf(COSTS)));
    assert.equal(commentKey(mergeConflictText({ mainSha: MOVED, merged: 793 })), commentKey(textOf(PASS, true)), 'a merge to main\'s conflict is the same conflict');
    assert.equal(commentKey(textOf(PASS)), null);
  });

  test('a claim fail has its own key, and its owner acts on it', () => {
    const claim = { answer: 'fail', test: 1, reason: 'the ticket it closes, #748, is `workflow: ready for development`', editable: true, claim: true };
    const text = commentText(claim as never, { conflict: false });
    assert.notEqual(commentKey(text), null);
    assert.equal(commentKey(text), commentKey(commentText({ ...claim, reason: 'reworded' } as never, { conflict: false })));
    assert.notEqual(commentKey(text), commentKey(textOf({ answer: 'fail', test: 1, reason: 'x', editable: true })));
    assert.notEqual(commentKey(text), commentKey(textOf({ answer: 'fail', test: 1, reason: 'x', editable: false })));
    assert.equal(ownerActs(text), true);
  });

  test('a fail whose first test the session meets and whose later test a person meets has its own key, and its owner acts on it', () => {
    const later = { test: 7, reason: '`dispatch/review.mjs` is on the human-only list (`dispatch/**`: the dispatcher)' };
    const edit = { answer: 'fail', test: 1, reason: 'the body closes #12 (`Closes #12`) below its top lines', editable: false, person: later };
    const claim = { answer: 'fail', test: 1, reason: 'the ticket it closes, #748, is still `workflow: ready for development`: nobody claimed it', editable: false, claim: true, person: later };
    const plain = [textOf({ answer: 'fail', test: 1, reason: 'x', editable: true }), textOf({ answer: 'fail', test: 1, reason: 'x', editable: false }), commentText({ ...claim, person: undefined } as never, { conflict: false }), textOf(PASS, true)];
    for (const owed of [edit, claim]) {
      const text = commentText(owed as never, { conflict: false });
      assert.notEqual(commentKey(text), null, text);
      assert.equal(commentKey(text), commentKey(commentText({ ...owed, reason: 'reworded', person: { ...later, reason: 'reworded too' } } as never, { conflict: false })), text);
      for (const other of plain) assert.notEqual(commentKey(text), commentKey(other), `${text} | ${other}`);
      assert.equal(ownerActs(text), true, text);
    }
    assert.notEqual(commentKey(commentText(edit as never, { conflict: false })), commentKey(commentText(claim as never, { conflict: false })));
    assert.equal(ownerActs(textOf({ answer: 'fail', test: 1, reason: 'x', editable: false })), false, 'a person\'s alone');
  });

  test('commentText has the ticket\'s shapes', () => {
    assert.equal(commentText(PASS as never, { conflict: false }), `Passes the PR review: ${PASS.reason}.`);
    assert.equal(commentText(IAM as never, { conflict: false }), 'Waits for a person: the change adds an IAM grant (test 3). No edit to the description makes it pass. A person merges it.');
    assert.match(commentText(COSTS as never, { conflict: false }), /^Waits for a description edit: the description names no cost for the new module \(test 3\)\./);
    const person = { test: 7, reason: '`dispatch/review.mjs` is on the human-only list (`dispatch/**`: the dispatcher)' };
    assert.equal(
      commentText({ answer: 'fail', test: 1, reason: 'the body closes #12 (`Closes #12`) below its top lines', editable: false, person } as never, { conflict: false }),
      'Waits for a description edit, then a person: the body closes #12 (`Closes #12`) below its top lines (test 1). An edit to the description meets test 1, and the review runs again on the edit. Test 7 fails whatever the description says: `dispatch/review.mjs` is on the human-only list (`dispatch/**`: the dispatcher). A person merges it.',
    );
  });

  test('commentText on a first failed test an edit meets, blocked by a later one no edit meets, does not call the first unmeetable', async () => {
    const blocked = { answer: 'fail', test: 1, reason: 'the body closes #748, which is no issue in this repository, and dispatch/review.mjs is on the human-only list (test 7)', editable: false };
    const text = commentText(blocked as never, { conflict: false });
    assert.match(text, /^Waits for a person: /);
    assert.doesNotMatch(text, /meets this one/);
    assert.match(text, /No edit to the description makes it pass\./);
  });
});

/** The factory's checklist as a review turn reads it: the file its config file names, off the default branch. */
const factoryChecklist = async () => {
  const read = readConfig(factoryFile(CONFIG_PATH));
  assert.ok(read.ok, JSON.stringify(read));
  const resolved = await resolveFiles(read.config, async (path) => factoryFile(path));
  assert.ok(resolved.ok, JSON.stringify(resolved));
  return String(resolved.config.review?.checklist);
};

describe('the review\'s real I/O, as far as a merge gate may reach', () => {
  test('the factory\'s checklist is the pr-review skill its file names, read without its frontmatter', async () => {
    const text = await factoryChecklist();
    assert.match(text, /^# PR review/);
    assert.doesNotMatch(text, /disable-model-invocation/);
  });

  test('a transcript loses the tokens and the writer secret before it ships', () => {
    const secret = 'abcdef0123456789abcdef0123456789';
    const out = redactTranscript(`ghs_${'a'.repeat(36)} Bearer ${'b'.repeat(40)} sk-ant-oat01-${'c'.repeat(20)} AKIA${'D'.repeat(16)} ${secret}`, secret);
    for (const gone of ['ghs_', 'b'.repeat(40), 'sk-ant-oat01', 'AKIA', secret]) assert.ok(!out.includes(gone), `${gone} is gone: ${out}`);
    // Every token shape a session's own export redacts, its gh-token marker included.
    assert.equal(redactTranscript('gh-token:v1.shorttoken rest', secret), 'gh-token:<redacted> rest');
  });
});
