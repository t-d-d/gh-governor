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
import { exitCodeFor } from '../dispatch/cli.mjs';
import { redactTranscript, run as runNamed } from '../dispatch/turn.mjs';
import { CONFIG_PATH, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
import { standingLine } from '../dispatch/deliveries.mjs';
import { ANSWER_SCHEMA, parseReview } from '../dispatch/checklist.mjs';
import { bodyDigest, reviewMarker } from '../dispatch/pr-body.mjs';
import { readFileSync } from 'node:fs';
import { commentKey, commentText, heldPassReason, mergeConflictText, ownerActs, withoutMarker as withoutMarkerText } from '../dispatch/webhook/review-comment.mjs';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { subscribeLine } from '../dispatch/webhook/subscribe.mjs';
import { APP_ID, BODY, DEPENDABOT_COMMIT, FILES, HEAD, IAM, MERGE_BASE, PASS, REPO, SKILL, cliOutput, dependabotRow, pullRow } from './helpers/dispatch-review-fixtures.ts';
import type { Answer, FileRow, Pull, PullCommit, TicketRow } from './helpers/dispatch-review-fixtures.ts';
import { factoryFile } from './helpers/factory.ts';

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

const harness = (over: {
  pulls?: Record<number, Pull | Pull[]>,
  open?: Array<{ number: number, draft: boolean, body?: string }>,
  thread?: Thread[],
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
  /** The PR's submitted reviews. */
  reviews?: Array<{ id: number, state: string, body: string, bot: boolean }>,
  /** The sessions the state table says governor started; a string is the error its read fails with. */
  started?: string[] | string,
} = {}) => {
  const dismissals: Array<{ pr: number, id: number }> = [];
  const approvals: Array<{ pr: number, sha: string, body: string }> = [];
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
      // No run holds a merge, so the review reads none.
      workflowRuns: async (file: string) => { throw new Error(`the review read the runs of ${file}: a merge is never held`); },
      openPulls: async () => over.open ?? [],
      defaultBranch: async () => over.base ?? 'main',
      requiredChecks: async (branch: string) => { requiredReads.push(branch); return over.required ?? []; },
      checksAt: async () => over.checks ?? [],
      approve: async (pr: number, { sha, body }: { sha: string, body: string }) => { approvals.push({ pr, sha, body }); },
      pullReviews: async () => over.reviews ?? [],
      dismissReview: async (pr: number, id: number) => { dismissals.push({ pr, id }); },
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
        return { number: n, title: `Ticket ${n}`, body: '## Acceptance criteria\n\n- It reviews.', state: 'open', labels: ['mode: afk', 'type: nfr', 'workflow: under development'], pull: false, ...row };
      },
      allComments: async () => over.thread ?? [],
      comment: async (issue: number, body: string) => { comments.push({ issue, body }); },
      updateComment: async (id: number, body: string) => { commentEdits.push({ id, body }); },
      // The send path's reads: the standing line, a fallback's marker and relink.
      openNaming: async () => [],
      comments: async () => [],
      pull: async (n: number) => ({ number: n, body: BODY }),
      updatePull: async () => {},
      merge: async (pr: number, { sha }: { sha: string }) => {
        merges.push({ pr, sha });
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
  return { deps, sessionsRead, approvals, dismissals, comments, commentEdits, merges, judged, transcripts, messages, launches, logged, reads, requiredReads, baseReads, fileReads, readerApps };
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

type Fire = { kind: string, session?: string, text?: string, on?: number, fallback?: { prompt: string, sessionName: string, issue?: number } };

/** What the receiver queues for a comment the review posted on #767. */
const receiverFires = (comment: string, body = BODY) => routeEvent({
  event: 'issue_comment',
  owners: ['acme'],
  appId: APP_ID,
  payload: {
    action: 'created',
    issue: { number: 767, title: 'Run the PR review from the dispatcher', html_url: `https://github.com/${REPO}/pull/767`, body, pull_request: { url: 'p' } },
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
    assert.equal(h.comments[0]!.body, `Passes the PR review: ${PASS.reason}.\n\n<!-- governor:pr-review ${HEAD} ${sha256(BODY)} -->`);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    assert.equal(exitCodeFor(result as never), 0);
  });

  test('the skill is the system prompt, the PR the prompt, the answer held to the schema, and a pass starts or messages no session', async () => {
    const h = harness();
    await review({ kind: 'review', pr: 767 }, h);
    assert.equal(h.judged.length, 1);
    assert.ok(h.judged[0]!.system.startsWith(SKILL));
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
    assert.equal(h.comments[0]!.body, marked('Waits for a person: the change adds an IAM grant (test 3). No edit to the description makes it pass. A person merges it.'));
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

  test('a pass: the comment and the merge, and the receiver queues nothing for it', async () => {
    const h = harness({ answers: [PASS] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.equal(h.merges.length, 1);
    assert.deepEqual(receiverFires(h.comments[0]!.body), []);
  });

  test('a fail no edit meets: the comment, and the receiver queues nothing for it', async () => {
    const h = harness({ answers: [IAM] });
    await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(receiverFires(h.comments[0]!.body), []);
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
    assert.deepEqual(receiverFires(h.comments[0]!.body, dependabotRow().body), [], 'nobody is woken by a pass');
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

  test('a file off the Dependabot list waits for a person, naming it, and wakes nobody', async () => {
    for (const filename of ['dispatch/package-lock.json', '.github/workflows/ci.yml', 'kokoro-lambda/Dockerfile', 'src/voices.ts']) {
      const h = harness({ pulls: { 767: dependabotRow() }, files: [...PIP, { filename, status: 'modified' }] });
      const result = await review({ kind: 'review', pr: 767 }, h);
      assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented'], filename);
      assert.deepEqual(h.merges, [], filename);
      assert.deepEqual(h.judged, [], filename);
      assert.match(h.comments[0]!.body, /^Waits for a person: /, filename);
      assert.ok(h.comments[0]!.body.includes(filename), h.comments[0]!.body);
      assert.match(h.comments[0]!.body, /A person merges it\./);
      assert.deepEqual(receiverFires(h.comments[0]!.body, dependabotRow().body), [], filename);
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
    const h = harness({ pulls: { 767: dependabotRow({ headSha: MOVED }) }, files, thread: [{ id: 9, body: said, created_at: 't', ours: true }] });
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
    assert.deepEqual(h.commentEdits, [{ id: 41, body: marked(textOf(IAM)) }]);
  });

  test('the same test and editable, reworded, edits the existing comment to the new words and posts nothing', async () => {
    const reworded: Answer = { ...IAM, reason: 'it grants a new IAM permission to the task role' };
    const h = harness({ answers: [reworded], thread: [{ id: 41, body: marked(said, MOVED), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: marked(textOf(reworded)) }]);
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
    assert.deepEqual(h.commentEdits, [{ id: 41, body: marked(textOf(PASS, true)) }]);
    assert.deepEqual(h.merges, []);
  });

  test('a conflict after a merge to main\'s conflict comment edits that comment and posts nothing: the owner was told of it', async () => {
    const merged = mergeConflictText({ mainSha: MOVED, merged: 793 });
    const h = harness({ pulls: { 767: pullRow({ mergeable: false }) }, thread: [{ id: 41, body: marked(merged, HEAD, `${BODY}\n${merged}`), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['marker-moved']);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: marked(textOf(PASS, true)) }]);
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
 * A merge is never held. An earlier review held every pass while a Deploy
 * Prod run was unfinished; the one delivery workflow needs no hold, so the
 * review merges a pass whatever is running. A PR whose newest review is a
 * held pass from before this change is merged on its next review with the
 * judgement kept, so no PR waits on a sweep that no longer comes.
 */
describe('fitness: run — no run holds a merge (dispatcher-workflows.md)', () => {
  const RUN_URL = `https://github.com/${REPO}/actions/runs/900`;
  /** The held pass as the earlier review wrote it, still on PRs reviewed before the change. */
  const HELD = `Passes the PR review: ${PASS.reason}. The merge waits for Deploy Prod run [900](${RUN_URL}) (in_progress) to end, and the review after it merges.`;

  test('no code path holds a merge for a run of any workflow: the review takes no promotion, and the turn reads no deploy runs', () => {
    const review = readFileSync(new URL('../dispatch/review.mjs', import.meta.url), 'utf8');
    const turn = readFileSync(new URL('../dispatch/turn.mjs', import.meta.url), 'utf8');
    for (const [text, name] of [[review, 'review.mjs'], [turn, 'turn.mjs']] as const) {
      assert.doesNotMatch(text, /promotion\s*[:=(]/, `${name} takes or asks a promotion`);
      assert.doesNotMatch(text, /deploy-prod\.yml|workflowRuns\('deliver\.yml'/, `${name} reads a deploy workflow's runs`);
      assert.doesNotMatch(text, /\('held'\)|'held'\s*\|\s*'skipped'/, `${name} knows a held outcome`);
    }
    assert.equal(heldPassReason(HELD), `${PASS.reason}.`, 'the old held pass is still read, so it merges');
  });

  test('a pass merges whatever is running: the review reads no workflow runs', async () => {
    const h = harness();
    const result = await review({ kind: 'review', pr: 767, headSha: HEAD }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    assert.deepEqual(h.comments, [{ issue: 767, body: marked(textOf(PASS)) }]);
  });

  test('a PR whose newest review is a held pass from before the change is merged on its next review without judging, and its comment edited to say so', async () => {
    const h = harness({ thread: [{ id: 41, body: marked(HELD), created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['merged']);
    assert.deepEqual(h.judged, []);
    assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }]);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.commentEdits, [{ id: 41, body: marked(`${textOf(PASS)} Merged once the promotion ended.`) }]);
    assert.deepEqual(receiverFires(h.commentEdits[0]!.body), []);
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

  test('a test-1 fail no edit meets, beside a human-only path, is a person\'s alone: nobody is woken', async () => {
    const h = harness({ tickets: { 748: { state: 'closed' } }, files: [HOOK] });
    await review({ kind: 'review', pr: 767 }, h);
    const text = h.comments[0]!.body;
    assert.match(text, person, text);
    assert.deepEqual(receiverFires(text), []);
  });

  test('the session\'s edit made, the next review says the person\'s part alone, in a new comment that wakes nobody', async () => {
    const before = harness({ pulls: { 767: pullRow({ body: PROSE }) }, files: [HOOK] });
    await review({ kind: 'review', pr: 767 }, before);
    const fixed = PROSE.replace('`Closes #12 and #13`', 'a closing keyword in code');
    const h = harness({ pulls: { 767: pullRow({ body: fixed }) }, files: [HOOK], thread: [{ id: 41, body: before.comments[0]!.body, created_at: 't', ours: true }] });
    const result = await review({ kind: 'review', pr: 767 }, h);
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['commented']);
    assert.deepEqual(h.commentEdits, []);
    const text = h.comments[0]!.body;
    assert.match(text, person, text);
    assert.deepEqual(receiverFires(text, fixed), []);
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

  test('past its window, no further review starts, and the rest are named', async () => {
    let t = NOW;
    const h = harness({
      open: [{ number: 767, draft: false }, { number: 780, draft: false }],
      pulls: { 767: pullRow(), 780: pullRow({ number: 780 }) },
      answers: [IAM],
      now: () => { t += 4 * 60 * 1000; return t; },
    });
    const result = await review({ kind: 'review' }, h);
    assert.deepEqual(result.reviews.map((r) => r.pr), [767]);
    assert.ok(h.logged.some((l) => l.event === 'dispatch-review' && Array.isArray(l.unreviewed) && (l.unreviewed as number[]).includes(780)));
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

describe('fitness: a pass merges only where merge is on (dispatcher-review.md)', () => {
  test('a pass in a repo whose file sets merge false is an approving review pinned to the head, and no merge call', async () => {
    const h = tagalong();
    const turn = await reviewTagalong(h);
    assert.deepEqual(turn.reviews.map((r) => r.outcome), ['approved']);
    assert.deepEqual(h.merges, []);
    assert.equal(h.approvals.length, 1);
    assert.equal(h.approvals[0]!.sha, HEAD);
    assert.equal(h.approvals[0]!.body, h.comments[0]!.body, 'the approval says what the comment says, marker and all');
    assert.match(h.approvals[0]!.body, /^Passes the PR review: .* Approved: the repo's owner merges it\.\n\n<!-- governor:pr-review /);
    assert.match(h.comments[0]!.body, /Approved: the repo's owner merges it\.[\s\S]*governor:pr-review/, 'the comment keeps the marker, so the same head and body are not read twice');
    assert.ok(!ownerActs(withoutMarkerText(h.comments[0]!.body)), 'an approval asks nothing of the author session');
  });

  test('the repo\'s own checklist is the model\'s prompt, not the factory\'s', async () => {
    const h = tagalong();
    await reviewTagalong(h);
    assert.ok(h.judged[0]!.system.startsWith(TAGALONG_CHECKLIST), h.judged[0]!.system);
    assert.ok(!h.judged[0]!.system.includes(SKILL));
  });

  test('a pass where merge is on, set or left out, merges and approves nothing', async () => {
    for (const merge of [true, undefined]) {
      const h = tagalong({}, { merge });
      await reviewTagalong(h);
      assert.deepEqual(h.merges, [{ pr: 767, sha: HEAD }], String(merge));
      assert.deepEqual(h.approvals, [], String(merge));
    }
    const factory = harness();
    await review({ kind: 'review', pr: 767 }, factory);
    assert.equal(factory.merges.length, 1);
    assert.deepEqual(factory.approvals, []);
  });

  test('a fail or a conflict where merge is off approves nothing', async () => {
    const failed = tagalong({ answers: [COSTS] });
    await reviewTagalong(failed);
    const conflicted = tagalong({ pulls: { 767: pullRow({ mergeable: false }) } });
    await reviewTagalong(conflicted);
    for (const h of [failed, conflicted]) {
      assert.deepEqual(h.approvals, []);
      assert.deepEqual(h.merges, []);
    }
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
    assert.deepEqual(red.approvals, []);
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
      assert.deepEqual([h.judged.length, h.comments.length, h.approvals.length, h.merges.length], [0, 0, 0, 0]);
    }
  });

  test('a test-8 fail at the same head and body is read again: a re-run that turns the check green is reviewed', async () => {
    const red = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }] });
    await reviewTagalong(red);
    const thread = [{ id: 7, body: red.comments[0]!.body, created_at: 'a', ours: true }];
    const green = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'green' }], thread });
    assert.deepEqual((await reviewTagalong(green)).reviews.map((r) => r.outcome), ['approved']);
    assert.equal(green.judged.length, 1);
    const still = tagalong({ required: ['gate'], checks: [{ name: 'gate', state: 'red' }], thread });
    assert.deepEqual((await reviewTagalong(still)).reviews.map((r) => r.outcome), ['marker-moved'], 'still red: the comment stands, edited in place');
  });

  test('where merge is off, a head that no longer passes dismisses the dispatcher\'s approval of an earlier one; a person\'s stands', async () => {
    const reviews = [
      { id: 1, state: 'APPROVED', body: `Passes the PR review: fine. Approved: the repo's owner merges it.\n\n${reviewMarker(MOVED, bodyDigest(BODY))}`, bot: true },
      { id: 2, state: 'APPROVED', body: 'LGTM', bot: false },
      { id: 3, state: 'DISMISSED', body: `x\n\n${reviewMarker(MOVED, bodyDigest(BODY))}`, bot: true },
    ];
    const failed = tagalong({ answers: [COSTS], reviews });
    await reviewTagalong(failed);
    assert.deepEqual(failed.dismissals, [{ pr: 767, id: 1 }]);
    const passed = tagalong({ reviews });
    await reviewTagalong(passed);
    assert.deepEqual(passed.dismissals, [], 'a pass approves the new head; the old approval does no harm');
    assert.match(passed.approvals[0]!.body, /governor:pr-review/, 'the approval carries the marker, so a later fail finds it');
    const merging = harness({ answers: [COSTS], reviews });
    await review({ kind: 'review', pr: 767 }, merging);
    assert.deepEqual(merging.dismissals, [], 'a repo that merges approves nothing to dismiss');
  });
});

describe('run — any served repo\'s review', () => {
  test('reads PRs into the repo\'s default branch: a `trunk` repo reviews a PR into trunk and skips one into main', async () => {
    const into = tagalong({ base: 'trunk', pulls: { 767: pullRow({ base: 'trunk' }) } });
    assert.deepEqual((await reviewTagalong(into)).reviews.map((r) => r.outcome), ['approved']);
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
