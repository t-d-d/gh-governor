/**
 * Ticket reviews (dispatch/ticket-review.mjs): on an issue opened, reopened
 * or with its body edited, governor runs each review the repo's
 * `ticketReviews` list holds whose selector the ticket meets, as one
 * `claude -p` with no tools under governor's own frame and default
 * checklist, and posts the model's conclusion as one comment ending in the
 * review's marker.
 *
 * Every I/O is injected: GitHub, the CLI, the drop box.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, configSchema, readConfig } from '../dispatch/repo-config.mjs';
import { bodyDigest } from '../dispatch/pr-body.mjs';
import { exitCodeFor } from '../dispatch/cli.mjs';
import { run as runTurn } from '../dispatch/turn.mjs';
import { cliResult } from '../dispatch/cli-answer.mjs';
import {
  DEFAULT_TICKET_CHECKLIST, LINKED_BODY_LIMIT, LINKED_LIMIT, OPEN_LISTED, TICKET_ANSWER_SCHEMA, TICKET_FRAME,
  reviewTicket, ticketMarker,
} from '../dispatch/ticket-review.mjs';
import { factoryFile } from './helpers/factory.ts';
import { APP_ID } from './helpers/dispatch-review-fixtures.ts';

const REPO = 'acme/factory';
const BODY = '## Problem\n\nThe retry budget is spent twice.\n\n## Done when\n\n- The budget is spent once.\n\nParent PRD: #390';
const KEY = bodyDigest(BODY);

type Ticket = { number: number, title: string, body: string, state: string, labels: string[], pull: boolean, author: string, association: string };
type Thread = { id: number, body: string, created_at: string, ours: boolean };
type Conclusion = { conclusion: string, text: string };

const ticketRow = (over: Partial<Ticket> = {}): Ticket => ({
  number: 501, title: 'Spend the retry budget once', body: BODY, state: 'open', labels: ['type: bug'], pull: false, author: 'a-member', association: 'MEMBER', ...over,
});

/** What `claude -p --output-format json --json-schema` prints for a conclusion. */
const cliOutput = (answer: unknown, sessionId = 'sess-1') => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer), session_id: sessionId, structured_output: answer,
  usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01,
});

/** What the CLI prints for a run it refused. */
const cliError = (text: string, sessionId = 'sess-x') => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: sessionId });

const PASSES: Conclusion = { conclusion: 'success', text: 'It states the problem and what done looks like.' };
const GAPS: Conclusion = { conclusion: 'failure', text: 'No problem is stated, and nothing says when it is done.' };

type Review = { name: string, when: { on: 'opened', labels?: string[], exclude?: string[], by?: string[] } };

const harness = (over: {
  ticket?: Partial<Ticket>,
  /** Other issues by number; null for one that does not exist. */
  issues?: Record<number, Partial<Ticket> | null>,
  parent?: Partial<Ticket> & { repo?: string } | null,
  open?: Array<{ number: number, title: string }>,
  thread?: Thread[],
  reviews?: Review[],
  trusted?: string[],
  answers?: Array<string | Conclusion>,
  comment?: (body: string) => Promise<void>,
  heartbeat?: number,
  waits?: number,
  /** Issues GitHub answers 410 for: deleted. */
  gone?: number[],
} = {}) => {
  const comments: Array<{ issue: number, body: string }> = [];
  const runs: Array<{ system: string, prompt: string, schema: unknown, replace?: boolean }> = [];
  const transcripts: Array<{ sessionId: string, key: string }> = [];
  const logged: Array<{ event: string, [key: string]: unknown }> = [];
  const openReads: number[] = [];
  let threadReads = 0;
  const answers = over.answers ?? [PASSES];
  const reader = {
    ticket: async (n: number) => {
      if (over.gone?.includes(n)) throw Object.assign(new Error(`GET /issues/${n} failed: 410`), { status: 410 });
      if (n === 501) return ticketRow(over.ticket);
      const row = over.issues?.[n];
      if (row === undefined || row === null) throw Object.assign(new Error(`GET /issues/${n} failed: 404`), { status: 404 });
      return ticketRow({ number: n, title: `Issue ${n}`, body: `Body of ${n}.`, ...row });
    },
    parentIssue: async () => (over.parent === undefined || over.parent === null ? null : { repo: REPO, ...ticketRow({ number: 390, title: 'The PRD', body: 'Non-goals: none.' }), ...over.parent }),
    openIssues: async (max: number) => { openReads.push(max); return over.open ?? [{ number: 501, title: 'Spend the retry budget once' }, { number: 502, title: 'Another' }]; },
    allComments: async () => { threadReads += 1; return over.thread ?? []; },
    comment: async (issue: number, body: string) => { if (over.comment) await over.comment(body); comments.push({ issue, body }); },
  };
  const config = {
    ticketReviews: over.reviews ?? [{ name: 'triage', when: { on: 'opened' as const } }],
    ...(over.trusted === undefined ? {} : { trust: { review: over.trusted } }),
    ...(over.heartbeat === undefined ? {} : { heartbeat: { issue: over.heartbeat } }),
    ...(over.waits === undefined ? {} : { waits: { issue: over.waits } }),
  };
  const run = async (request: { system: string, prompt: string, schema: unknown, replace?: boolean }) => {
    runs.push(request);
    const answer = answers[Math.min(runs.length - 1, answers.length - 1)]!;
    return { status: 0, output: typeof answer === 'string' ? answer : cliOutput(answer, `sess-${runs.length}`) };
  };
  const transcript = async (t: { sessionId: string, key: string }) => { transcripts.push(t); return { key: t.key }; };
  const log = (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); };
  const review = () => reviewTicket({ repo: REPO, issue: 501, reader, config: config as never, run, transcript, log });
  return { review, comments, runs, transcripts, logged, openReads, threadReads: () => threadReads };
};

/** A comment governor's App posted, carrying a marker. */
const posted = (name: string, conclusion: string, key: string, ours = true, id = 1): Thread => ({
  id, body: `Earlier.\n\n${ticketMarker(name, conclusion, key)}`, created_at: '2026-11-01T00:00:00Z', ours,
});

describe('the ticketReviews config', () => {
  const file = (ticketReviews: unknown, on = true) => readConfig(JSON.stringify({
    environment: 'env_1', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { ticketReviews: on }, ticketReviews,
  }));

  test('a review needs a name and when.on, and every other key has a default', () => {
    const read = file([{ name: 'triage', when: { on: 'opened' } }]);
    assert.ok(read.ok, JSON.stringify(read));
  });

  test('the switch on needs at least one review, and off is off unless the file turns it on', () => {
    assert.equal(file([]).ok, false);
    assert.equal(file(undefined).ok, false);
    const off = readConfig(JSON.stringify({ environment: 'env_1', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: {} }));
    assert.ok(off.ok);
    assert.notEqual(off.config.features.ticketReviews, true);
  });

  test('two reviews sharing a name, a name off the pattern, an event but opened, or a by GitHub does not use, is invalid', () => {
    const faults: Array<[string, unknown]> = [
      ['shared name', [{ name: 'triage', when: { on: 'opened' } }, { name: 'triage', when: { on: 'opened', labels: ['x'] } }]],
      ['a space', [{ name: 'my review', when: { on: 'opened' } }]],
      ['a capital', [{ name: 'Triage', when: { on: 'opened' } }]],
      ['the marker\'s end', [{ name: 'a-->', when: { on: 'opened' } }]],
      ['labelled', [{ name: 'triage', when: { on: 'labelled' } }]],
      ['no on', [{ name: 'triage', when: {} }]],
      ['by BOT', [{ name: 'triage', when: { on: 'opened', by: ['BOT'] } }]],
      ['by a stranger', [{ name: 'triage', when: { on: 'opened', by: ['STRANGER'] } }]],
      ['a later slice\'s key', [{ name: 'triage', when: { on: 'opened' }, checklist: 'x' }]],
      ['conclusions', [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['ok'] } }]],
      ['types', [{ name: 'triage', when: { on: 'opened' }, types: [] }]],
    ];
    for (const [why, list] of faults) assert.equal(file(list).ok, false, why);
  });

  test('by takes every author_association GitHub uses', () => {
    const by = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE'];
    assert.ok(file([{ name: 'community', when: { on: 'opened', by, labels: ['a'], exclude: ['b'] } }]).ok);
  });

  test('the factory turns the switch on with a review', () => {
    const read = readConfig(factoryFile(CONFIG_PATH));
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.config.features.ticketReviews, true);
    assert.ok((read.config.ticketReviews ?? []).length > 0);
  });

  test('the schema is the zod schema\'s', () => {
    assert.ok(configSchema);
  });
});

describe('reviewTicket: which reviews run', () => {
  test('a ticket that meets a review\'s selector gets one comment, in the format, ending in its marker', async () => {
    const h = harness();
    const result = await h.review();
    assert.deepEqual(result.reviews.map((r) => [r.name, r.outcome, r.conclusion]), [['triage', 'commented', 'success']]);
    assert.deepEqual(h.comments, [{ issue: 501, body: `Triage review: passes. ${PASSES.text}\n\n${ticketMarker('triage', 'success', KEY)}` }]);
    assert.equal(ticketMarker('triage', 'success', KEY), `<!-- governor:ticket-review triage success ${KEY} -->`);
  });

  test('each conclusion has its words', async () => {
    const neutral = { conclusion: 'neutral', text: 'It builds a non-goal of #390: ranking tickets.' };
    for (const [answer, words] of [[GAPS, 'waits for an edit'], [neutral, 'waits for a person'], [PASSES, 'passes']] as const) {
      const h = harness({ answers: [answer] });
      await h.review();
      assert.equal(h.comments[0]!.body, `Triage review: ${words}. ${answer.text}\n\n${ticketMarker('triage', answer.conclusion, KEY)}`);
    }
  });

  test('a ticket that fails the selector on labels, exclude or by gets none', async () => {
    const reviews: Review[] = [
      { name: 'labels', when: { on: 'opened', labels: ['type: bug', 'triage: wanted'] } },
      { name: 'exclude', when: { on: 'opened', exclude: ['claimed', 'type: bug'] } },
      { name: 'by', when: { on: 'opened', by: ['OWNER'] } },
    ];
    const h = harness({ reviews });
    const result = await h.review();
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(result.reviews.map((r) => [r.name, r.outcome]), [['labels', 'skipped'], ['exclude', 'skipped'], ['by', 'skipped']]);
  });

  test('labels must all be there, and by reads a missing association as NONE', async () => {
    assert.equal((await harness({ reviews: [{ name: 'labels', when: { on: 'opened', labels: ['type: bug'] } }] }).review()).reviews[0]!.outcome, 'commented');
    const none = harness({ ticket: { association: undefined as never }, trusted: ['NONE'], reviews: [{ name: 'community', when: { on: 'opened', by: ['NONE'] } }] });
    assert.equal((await none.review()).reviews[0]!.outcome, 'commented');
  });

  test('by defaults to owners, members and collaborators', async () => {
    const h = harness({ ticket: { association: 'CONTRIBUTOR' }, trusted: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] });
    assert.equal((await h.review()).reviews[0]!.outcome, 'skipped');
    assert.deepEqual(h.comments, []);
  });

  test('a ticket whose author trust.review shuts out gets no review, whatever the review\'s by says', async () => {
    const h = harness({ ticket: { association: 'NONE' }, reviews: [{ name: 'community', when: { on: 'opened', by: ['NONE'] } }] });
    const result = await h.review();
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.runs, []);
    assert.match(String(result.skipped), /trust\.review/);
    const narrowed = harness({ ticket: { association: 'MEMBER' }, trusted: ['OWNER'] });
    assert.deepEqual((await narrowed.review(), narrowed.comments), []);
  });

  test('where two reviews\' selectors match, both run, in file order, each with its own name', async () => {
    const h = harness({ reviews: [{ name: 'triage', when: { on: 'opened' } }, { name: 'second-look', when: { on: 'opened' } }], answers: [PASSES, GAPS] });
    await h.review();
    assert.equal(h.comments.length, 2);
    assert.match(h.comments[0]!.body, /^Triage review: passes\./);
    assert.match(h.comments[0]!.body, /governor:ticket-review triage success /);
    assert.match(h.comments[1]!.body, /^Second-look review: waits for an edit\./);
    assert.match(h.comments[1]!.body, /governor:ticket-review second-look failure /);
  });

  test('a fire for a ticket whose key has not changed since the review\'s newest marker runs nothing for that review', async () => {
    const h = harness({ thread: [posted('triage', 'failure', 'ab12'), posted('triage', 'success', KEY, true, 2)] });
    const result = await h.review();
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.comments, []);
    assert.equal(result.reviews[0]!.outcome, 'skipped');
    const older = harness({ thread: [posted('triage', 'success', KEY), posted('triage', 'failure', 'ab12', true, 2)] });
    await older.review();
    assert.equal(older.runs.length, 1, 'only the newest marker counts');
  });

  test('another review\'s marker, or one under the current key, does not hold this review', async () => {
    const h = harness({ thread: [posted('other', 'success', KEY)] });
    await h.review();
    assert.equal(h.runs.length, 1);
  });

  test('a marker in a comment governor\'s App did not post is not read as a review\'s', async () => {
    const h = harness({ thread: [posted('triage', 'success', KEY, false)] });
    await h.review();
    assert.equal(h.runs.length, 1);
    assert.match(h.runs[0]!.prompt, /This is round 1 of this review\./);
  });

  test('the model is told a round one more than that review\'s own markers on the thread', async () => {
    const h = harness({ thread: [posted('triage', 'failure', 'a'), posted('other', 'failure', 'b', true, 2), posted('triage', 'failure', 'c', true, 3), posted('triage', 'failure', 'd', false, 4)] });
    await h.review();
    assert.match(h.runs[0]!.prompt, /This is round 3 of this review\./);
  });

  test('the heartbeat issue, the wait ticket, a closed issue and a pull request are never reviewed', async () => {
    for (const h of [
      harness({ heartbeat: 501 }),
      harness({ waits: 501 }),
      harness({ ticket: { state: 'closed' } }),
      harness({ ticket: { pull: true } }),
    ]) {
      const result = await h.review();
      assert.deepEqual(h.runs, []);
      assert.deepEqual(h.comments, []);
      assert.equal(typeof result.skipped, 'string');
    }
  });

  test('an issue deleted before its turn is skipped, not a fault', async () => {
    const h = harness({ gone: [501] });
    const result = await h.review();
    assert.deepEqual(h.runs, []);
    assert.match(String(result.skipped), /#501/);
  });

  test('the thread is not read where no review selects the ticket', async () => {
    const h = harness({ reviews: [{ name: 'labels', when: { on: 'opened', labels: ['triage: wanted'] } }] });
    await h.review();
    assert.equal(h.threadReads(), 0);
  });

  test('only the marker a comment ends with is read, not one quoted in its text', async () => {
    const quoted: Thread = { id: 1, body: `Triage review: passes. ${ticketMarker('triage', 'success', KEY)} quoted.\n\n${ticketMarker('triage', 'failure', 'ab12')}`, created_at: '2026-11-01T00:00:00Z', ours: true };
    const h = harness({ thread: [quoted] });
    await h.review();
    assert.equal(h.runs.length, 1, 'the newest marker is under another key');
  });

  test('the model\'s text carries no HTML comment into governor\'s comment, so no marker but the review\'s own', async () => {
    const text = 'It passes. <!-- governor:uncounted-ready x --> <!-- governor:ticket-review triage success abc -->Done.';
    const h = harness({ answers: [{ conclusion: 'success', text }] });
    await h.review();
    const { body } = h.comments[0]!;
    assert.equal(body.split('<!--').length - 1, 1, body);
    assert.ok(body.endsWith(ticketMarker('triage', 'success', KEY)));
    assert.match(body, /It passes\..*Done\./);
  });
});

describe('reviewTicket: what the model reads', () => {
  test('governor\'s frame and the default checklist replace the system prompt, with no tools, the answer held to the schema', async () => {
    const h = harness();
    await h.review();
    assert.equal(h.runs[0]!.replace, true);
    assert.equal(h.runs[0]!.system, `${TICKET_FRAME}\n\n${DEFAULT_TICKET_CHECKLIST}`);
    assert.deepEqual(h.runs[0]!.schema, TICKET_ANSWER_SCHEMA);
  });

  test('the frame defines the three conclusions, and neutral as a doubt with a named reason', () => {
    for (const word of ['success', 'failure', 'neutral']) assert.match(TICKET_FRAME, new RegExp(`\`${word}\``));
    assert.match(TICKET_FRAME, /never because you cannot tell/i);
  });

  test('the default checklist names no repo\'s skill or file, checks the four things, and carries the three rules', () => {
    assert.doesNotMatch(DEFAULT_TICKET_CHECKLIST, /SKILL\.md|\.claude\/|CLAUDE\.md|skill/i);
    for (const check of [/problem/i, /done/i, /non-goal/i, /open issue/i, /round 3|third round/i, /as written/i]) assert.match(DEFAULT_TICKET_CHECKLIST, check);
  });

  test('stdin holds the ticket, its parent, its same-repo links, the open issues and the round', async () => {
    const body = `${BODY}\n\nSee #77 and #78, and #501 itself.`;
    const h = harness({ ticket: { body }, parent: {}, issues: { 77: { title: 'Linked one', body: 'Linked body.' }, 78: { title: 'Linked two', labels: [] } } });
    await h.review();
    const { prompt } = h.runs[0]!;
    for (const fact of ['#501', 'Spend the retry budget once', 'type: bug', 'The retry budget is spent twice.', '#390', 'The PRD', 'Non-goals: none.', '#77', 'Linked one', 'Linked body.', '#78', 'Linked two', '#502 Another', 'This is round 1 of this review.']) {
      assert.ok(prompt.includes(fact), `stdin carries ${fact}`);
    }
  });

  test('a linked issue in another repo, a missing one, or a pull request is skipped with an info log', async () => {
    const body = `${BODY}\n\nSee other/repo#5, https://github.com/other/repo/issues/6, #80 and #81.`;
    const h = harness({ ticket: { body }, issues: { 81: { pull: true, title: 'A PR' } } });
    await h.review();
    const skips = h.logged.filter((l) => l.event === 'dispatch-ticket-review-link');
    assert.ok(skips.length >= 4, JSON.stringify(skips));
    assert.ok(skips.every((l) => l.level === 'info'));
    assert.doesNotMatch(h.runs[0]!.prompt, /A PR/);
  });

  test('a linked issue GitHub answers 410 for, deleted, is skipped with an info log', async () => {
    const h = harness({ ticket: { body: `${BODY}\n\nSee #82.` }, gone: [82] });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'commented');
    assert.ok(h.logged.some((l) => l.event === 'dispatch-ticket-review-link' && l.link === '#82' && l.level === 'info'));
  });

  test('the open issues listed leave out the ticket itself', async () => {
    const h = harness();
    await h.review();
    assert.doesNotMatch(h.runs[0]!.prompt, /^#501 /m);
    assert.match(h.runs[0]!.prompt, /^#502 Another$/m);
  });

  test('a parent in another repo is skipped with an info log', async () => {
    const h = harness({ parent: { repo: 'other/repo', title: 'Elsewhere' } });
    await h.review();
    assert.doesNotMatch(h.runs[0]!.prompt, /Elsewhere/);
    assert.ok(h.logged.some((l) => l.event === 'dispatch-ticket-review-link' && l.level === 'info'));
  });

  test('the caps hold, and stdin says what it left out', async () => {
    const links = Array.from({ length: LINKED_LIMIT + 3 }, (_, i) => 600 + i);
    const issues = Object.fromEntries(links.map((n) => [n, { title: `L${n}`, body: 'x'.repeat(LINKED_BODY_LIMIT + 100) }]));
    const open = Array.from({ length: OPEN_LISTED + 1 }, (_, i) => ({ number: 1000 + i, title: `Open ${i}` }));
    const h = harness({ ticket: { body: `${BODY}\n\n${links.map((n) => `#${n}`).join(' ')}` }, issues, open });
    await h.review();
    const { prompt } = h.runs[0]!;
    assert.ok(!prompt.includes(`L${links.at(-1)}`), 'the links past the cap are not read');
    assert.ok(!prompt.includes('x'.repeat(LINKED_BODY_LIMIT + 1)), 'a linked body is cut');
    assert.ok(!prompt.includes(`#${1000 + OPEN_LISTED} `), 'the open issues past the cap are not listed');
    assert.match(prompt, /left out/i);
    assert.deepEqual(h.openReads, [OPEN_LISTED]);
  });
});

describe('reviewTicket: a run that does not answer', () => {
  test('a failed run, or an answer outside the schema, posts no marker, lets the other reviews run, and is a failure', async () => {
    for (const bad of [cliError('the API answered 500'), cliOutput({ conclusion: 'maybe', text: 'x' }), cliOutput({ conclusion: 'success', text: '' }), 'no json at all']) {
      const h = harness({ reviews: [{ name: 'triage', when: { on: 'opened' } }, { name: 'second', when: { on: 'opened' } }], answers: [bad, PASSES] });
      const result = await h.review();
      assert.deepEqual(result.reviews.map((r) => [r.name, r.outcome]), [['triage', 'failed'], ['second', 'commented']], bad);
      assert.equal(h.comments.length, 1);
      assert.match(h.comments[0]!.body, /^Second review/);
      const line = h.logged.find((l) => l.event === 'dispatch-ticket-review' && l.review === 'triage');
      assert.equal(line?.level, 'error');
      assert.equal(exitCodeFor({ kind: 'ticketReview', reviews: result.reviews } as never), 1);
    }
  });

  test('a comment GitHub refuses leaves no marker, logs at error, and the other reviews still run', async () => {
    let calls = 0;
    const h = harness({ reviews: [{ name: 'triage', when: { on: 'opened' } }, { name: 'second', when: { on: 'opened' } }], comment: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('POST failed: 403'), { status: 403 }); } });
    const result = await h.review();
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['failed', 'commented']);
    assert.equal(exitCodeFor({ kind: 'ticketReview', reviews: result.reviews } as never), 1);
  });

  test('a run the session limit stops posts nothing, does not alarm, and no later review runs', async () => {
    const h = harness({ reviews: [{ name: 'triage', when: { on: 'opened' } }, { name: 'second', when: { on: 'opened' } }], answers: [cliError('Claude AI usage limit reached: you have hit your session limit')] });
    const result = await h.review();
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['limited', 'limited']);
    assert.equal(h.runs.length, 1);
    assert.deepEqual(h.comments, []);
    assert.ok(h.logged.filter((l) => l.event === 'dispatch-ticket-review').every((l) => l.level !== 'error'));
    assert.equal(exitCodeFor({ kind: 'ticketReview', reviews: result.reviews } as never), 0);
  });

  test('the weekly limit is a fault', async () => {
    const h = harness({ answers: [cliError('You have hit your weekly limit')] });
    const result = await h.review();
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['failed']);
  });
});

describe('reviewTicket: what it logs and keeps', () => {
  test('each run logs dispatch-ticket-review with the repo, issue, review, conclusion and usage', async () => {
    const h = harness();
    await h.review();
    const line = h.logged.find((l) => l.event === 'dispatch-ticket-review');
    assert.equal(line?.repo, REPO);
    assert.equal(line?.issue, 501);
    assert.equal(line?.review, 'triage');
    assert.equal(line?.conclusion, 'success');
    assert.deepEqual(line?.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  });

  test('the transcript goes to the drop box keyed by the review, the issue and the session', async () => {
    const h = harness();
    await h.review();
    assert.deepEqual(h.transcripts, [{ sessionId: 'sess-1', key: 'ticket-review-triage-501-sess-1' }]);
  });
});

describe('cliResult: the CLI result line both reviews read', () => {
  test('reads the session, the spend and the answer, and names the limit a refusal met', () => {
    const read = cliResult(cliOutput({ conclusion: 'success', text: 't' }));
    assert.equal(read.sessionId, 'sess-1');
    assert.deepEqual(read.answer, { conclusion: 'success', text: 't' });
    assert.throws(() => cliResult('nothing'), /printed no answer/);
    assert.throws(() => cliResult(cliError('you hit your session limit')), (e: { limit?: string, sessionId?: string }) => e.limit === 'session' && e.sessionId === 'sess-x');
  });
});

describe('run: a ticketReview fire through the turn', () => {
  const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'sk-ant-ort01-r', expiresAt: Date.parse('2026-11-04T13:00:00Z'), refreshTokenExpiresAt: Date.parse('2026-12-04T12:00:00Z'), scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'] } });
  const turn = async (config: string) => {
    const comments: Array<{ issue: number, body: string }> = [];
    const runs: unknown[] = [];
    const deps = {
      owners: ['acme'],
      installations: async () => [{ account: 'acme', repos: [REPO] }],
      configFile: async (_r: string, _t: string, path = CONFIG_PATH) => (path === CONFIG_PATH ? config : '# A checklist.'),
      cap: 2,
      now: () => Date.parse('2026-11-04T12:00:00Z'),
      log: () => {},
      secret: { get: async () => LOGIN, put: async () => {} },
      githubToken: async () => 'ghs_t',
      appId: async () => APP_ID,
      reader: () => ({
        ticket: async (n: number) => ticketRow({ number: n }),
        parentIssue: async () => null,
        openIssues: async () => [],
        allComments: async () => [],
        comment: async (issue: number, body: string) => { comments.push({ issue, body }); },
        openNaming: async () => [],
      }),
      hookTable: { publish: async () => true },
      workspace: { prepare: () => {}, writeLogin: () => {}, readLogin: () => LOGIN, useAccount: () => {} },
      launch: async () => ({ status: 0, output: '' }),
      probe: async () => ({ ok: true, detail: '' }),
      message: async () => ({ status: 0, output: '' }),
      review: async (r: unknown) => { runs.push(r); return { status: 0, output: cliOutput(PASSES) }; },
      transcript: async () => ({ skipped: 'none' }),
      sleep: async () => {},
      sessions: { list: async () => ({ data: [] }), get: async () => null, events: async () => ({ data: [] }) },
      archive: async () => ({ ok: true }),
      state: {},
    };
    const result = await runTurn({ kind: 'ticketReview', issue: 501, repo: REPO }, deps as never);
    return { result: result as unknown as { kind: string, refusal?: string, reviews?: Array<{ outcome: string }> }, comments, runs };
  };

  test('with the switch on, the fixture\'s review comments on the ticket', async () => {
    const { result, comments } = await turn(factoryFile(CONFIG_PATH));
    assert.equal(result.kind, 'ticketReview');
    assert.deepEqual(result.reviews?.map((r) => r.outcome), ['commented']);
    assert.equal(comments.length, 1);
    assert.equal(exitCodeFor(result as never), 0);
  });

  test('with the switch off, no review runs', async () => {
    const file = JSON.parse(factoryFile(CONFIG_PATH)) as { features: Record<string, boolean> };
    file.features.ticketReviews = false;
    const { result, comments, runs } = await turn(JSON.stringify(file));
    assert.match(String(result.refusal), /ticketReviews/);
    assert.deepEqual(comments, []);
    assert.deepEqual(runs, []);
  });
});
