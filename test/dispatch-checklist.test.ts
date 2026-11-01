/**
 * The PR review's checklist: a PR's facts in, the answer
 * out. Tests 1 and 7 and the state of the tickets a PR names are decided in
 * code; the rest is the model's, its one port faked here with a canned
 * `claude -p` output. What follows the answer (the merge, the comment, the
 * held pass) is the review turn's, in test/dispatch-review.test.ts.
 *
 * Each case reads its facts through `readFacts` over a fake reader, as the
 * turn does, and checks the answer and the comment text it makes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_SCHEMA,
  checklist,
  cliJudge,
  CONSTRAINT_ANSWER_SCHEMA,
  constraintsLeft,
  decideInCode,
  dependabotAnswer,
  COMMITS_LISTED,
  FILES_LISTED,
  globMatches,
  humanOnlyHits,
  parseReview,
  reviewPrompt,
} from '../dispatch/checklist.mjs';
import { bodyDigest, reviewMarker } from '../dispatch/pr-body.mjs';
import { readFacts } from '../dispatch/review.mjs';
import { commentText } from '../dispatch/webhook/review-comment.mjs';
import { DEPENDABOT } from '../dispatch/webhook/fire.mjs';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { APP_ID, BODY, FILES, HEAD, IAM, MERGE_BASE, PASS, FACTORY_REVIEW, FACTORY_RULES, REPO, SKILL, cliOutput, pullRow } from './helpers/dispatch-review-fixtures.ts';
import type { Answer, FileRow, Pull, TicketRow } from './helpers/dispatch-review-fixtures.ts';

/**
 * The checklist over one PR's facts, read as the turn reads them, with the
 * model answering from `answers` in turn.
 */
const ask = async (over: {
  body?: string,
  /** The PR, over the default #767. */
  pull?: Pull,
  files?: FileRow[],
  /** A ticket's fields over the default open, claimed `mode: afk` one, null for an issue that does not exist, or the HTTP status its read fails with. */
  tickets?: Record<number, Partial<TicketRow> | null | number>,
  open?: Array<{ number: number, draft: boolean, body?: string }>,
  /** Each file's text by `<commit>:<path>`; a read of any other fails, as GitHub's 404 does. */
  texts?: Record<string, string>,
  answers?: Answer[],
  /** Where the model's requests go, for a case whose checklist throws. */
  judged?: unknown[],
  /** The checks the base requires, and the checks at the head. */
  required?: string[],
  checks?: Array<{ name: string, red: boolean }>,
  /** The sessions governor's state table says it started; a string is the error its read fails with. */
  started?: string[] | string,
} = {}) => {
  const judged = (over.judged ?? []) as Array<{ system: string, prompt: string, schema: unknown }>;
  const baseReads: Array<[string, string]> = [];
  const fileReads: string[] = [];
  let openReads = 0;
  const answers = over.answers ?? [PASS];
  const reader = {
    requiredChecks: async () => over.required ?? [],
    checksAt: async () => over.checks ?? [],
    pullFiles: async () => over.files ?? FILES,
    openPulls: async () => { openReads += 1; return over.open ?? []; },
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
  };
  const pull = over.pull ?? pullRow(over.body === undefined ? {} : { body: over.body });
  const judge = cliJudge({
    skill: SKILL,
    run: async (r) => {
      judged.push(r);
      return { output: cliOutput(answers[Math.min(judged.length - 1, answers.length - 1)]!, `sess-${judged.length}`) };
    },
    transcript: async () => ({ key: 'k' }),
    log: () => {},
  });
  const sessionsRead: string[] = [];
  const started = async (session: string) => {
    sessionsRead.push(session);
    if (typeof over.started === 'string') throw new Error(over.started);
    return (over.started ?? []).includes(session);
  };
  const facts = await readFacts(reader as never, pull as never, started);
  const answer = await checklist({ ...facts, rules: FACTORY_RULES }, judge);
  return { answer, text: commentText(answer, { conflict: false }), judged, baseReads, fileReads, openReads, sessionsRead };
};

/** What the receiver queues for the review's comment on #767 saying `text`. */
const receiverFires = (text: string, body = BODY) => routeEvent({
  event: 'issue_comment',
  owners: ['acme'],
  appId: APP_ID,
  payload: {
    action: 'created',
    issue: { number: 767, title: 'Run the PR review from the dispatcher', html_url: `https://github.com/${REPO}/pull/767`, body, pull_request: { url: 'p' } },
    comment: { id: 1, body: `${text}\n\n${reviewMarker(HEAD, bodyDigest(body))}`, html_url: 'c', user: { login: 'governor-app[bot]', type: 'Bot' }, author_association: 'NONE', performed_via_github_app: { id: APP_ID } },
    repository: { full_name: REPO },
  },
}).fires.map((f) => f.fire as { kind: string, session?: string });

describe('tests 1 and 7, decided in code before any model call', () => {
  const person = /^Waits for a person: /;
  const edit = /^Waits for a description edit: /;

  test('a change to a human-only path fails test 7 with the path and the list\'s reason for it, and the model is not asked', async () => {
    const h = await ask({ files: [...FILES, { filename: 'dispatch/review.mjs', status: 'modified' }] });
    assert.equal(h.answer.answer, 'fail');
    assert.deepEqual(h.judged, [], 'the CLI is not run');
    const text = h.text;
    assert.match(text, person);
    assert.match(text, /\(test 7\)/);
    assert.ok(text.includes('dispatch/review.mjs'), text);
    assert.ok(text.includes('the dispatcher, which runs this review and merges on its answer'), text);
  });

  test('a rename out of a human-only path is a change to it', async () => {
    const h = await ask({ files: [{ filename: 'src/renamed.ts', status: 'renamed', previous: 'src/billing/entitlements.ts' }] });
    assert.deepEqual(h.judged, []);
    assert.match(h.text, /src\/billing\/entitlements\.ts[\s\S]*\(test 7\)/);
  });

  test('a body closing no ticket passes test 1: the model judges it on its description alone, and passes', async () => {
    const h = await ask({ body: 'Adds a thing.\n\nhttps://claude.ai/code/session_01OWNER' });
    assert.equal(h.judged.length, 1);
    assert.match(h.judged[0]!.prompt, /closes no ticket/i);
    assert.equal(h.answer.answer, 'pass');
  });

  test('a body closing no ticket still fails test 7 on a human-only path, for a person', async () => {
    const h = await ask({ body: 'Adds a thing.', files: [{ filename: 'docs/constraints/promotion-gate.md', status: 'added' }] });
    assert.deepEqual(h.judged, []);
    assert.equal(h.answer.answer, 'fail');
    const reason = h.text;
    assert.match(reason, person);
    assert.match(reason, /docs\/constraints\/promotion-gate\.md[\s\S]*\(test 7\)/);
    assert.doesNotMatch(reason, /test 1/);
  });

  test('a body closing several tickets passes test 1 when each would alone, and the model reads them all', async () => {
    const h = await ask({ body: 'Closes #748 and fixes #754.' });
    assert.equal(h.judged.length, 1);
    assert.match(h.judged[0]!.prompt, /#### #748: /);
    assert.match(h.judged[0]!.prompt, /#### #754: /);
    assert.equal(h.answer.answer, 'pass');
  });

  test('a closing keyword beside an issue number below the top `Closes #N` lines fails test 1 for an edit, whatever that issue\'s state', async () => {
    // "#853 fixed #840" in the Outcome closed #840 as far as GitHub
    // was concerned, and the review read it as a ticket the PR closes.
    const bodies: Array<[string, string]> = [
      ['fixed #840', 'Closes #748\n\n## Outcome\n\nThe marker is gone. #853 fixed #840, but a later PR re-added it.\n\nhttps://claude.ai/code/session_01OWNER'],
      ['Closes #840', 'Removes the marker.\n\nCloses #840\n\nhttps://claude.ai/code/session_01OWNER'],
    ];
    for (const [words, body] of bodies) {
      for (const ticket of [{ state: 'closed' }, {}, { labels: ['mode: hitl', 'type: nfr'] }, null]) {
        const h = await ask({ body, tickets: { 840: ticket } });
        const why = `${words} ${JSON.stringify(ticket)}`;
        assert.deepEqual(h.judged, [], why);
        assert.equal(h.answer.answer, 'fail', why);
        assert.equal(h.answer.answer, 'fail', why);
        const text = h.text;
        assert.match(text, edit, text);
        assert.ok(text.includes(`\`${words}\``), text);
        assert.ok(text.includes('every closing statement goes in the `Closes #N` lines at the top of the body, lines holding nothing else'), text);
        assert.match(text, /\(test 1\)/, text);
        assert.deepEqual(receiverFires(text, body).map((f) => f.kind), ['message'], 'the owner session hears it');
      }
    }
  });

  test('every closing reference below the top is named in the one fail, so one edit meets it', async () => {
    const h = await ask({ body: 'Closes #748\n\n#9 fixed #840, and this fixes #847.' });
    const reason = h.text;
    assert.match(reason, edit);
    assert.ok(reason.includes('`fixed #840`') && reason.includes('`fixes #847`'), reason);
  });

  test('a body closing another repo\'s issue fails test 1 for an edit, naming each reference and both fixes, and the owner session hears it', async () => {
    const url = 'https://github.com/other/repo/issues/9';
    for (const [refs, body] of [
      [['other/repo#9'], 'Closes other/repo#9\n\nhttps://claude.ai/code/session_01OWNER'],
      [['other/repo#9'], `Closes ${url}\n\nhttps://claude.ai/code/session_01OWNER`],
      [['other/repo#9', 'else/where#3'], `Closes #748\nCloses ${url}\n\nThis also fixes else/where#3.\n\nhttps://claude.ai/code/session_01OWNER`],
    ] as Array<[string[], string]>) {
      const h = await ask({ body });
      assert.deepEqual(h.judged, [], body);
      const text = h.text;
      assert.match(text, edit, text);
      assert.match(text, /\(test 1\)/, text);
      for (const ref of refs) assert.ok(text.includes(ref), text);
      assert.ok(text.includes('close it from a PR in its own repo'), text);
      assert.ok(text.includes('open an issue here and mark it as blocked by that issue'), text);
      assert.deepEqual(receiverFires(text, body).map((f) => f.kind), ['message'], 'the owner session hears it');
    }
  });

  test('a body closing another repo\'s issue and closing one below its top names both in the one fail, so one edit meets it', async () => {
    const h = await ask({ body: 'Closes #748\nCloses other/repo#9\n\nThis fixes #840 and fixes else/where#3.' });
    const text = h.text;
    assert.match(text, edit, text);
    assert.ok(text.includes('`fixes #840`'), text);
    assert.ok(text.includes('other/repo#9') && text.includes('else/where#3'), text);
    assert.ok(text.includes('outside this repo'), text);
  });

  test('this repo\'s own issue closed by `owner/repo#N` or by URL is a closing ticket, as before', async () => {
    for (const body of [`Closes ${REPO}#748`, `Closes https://github.com/${REPO}/issues/748`]) {
      const h = await ask({ body });
      assert.equal(h.judged.length, 1, body);
      assert.match(h.judged[0]!.prompt, /#### #748: /);
      assert.equal(h.answer.answer, 'pass');
    }
  });

  test('a closing keyword in prose fails for an edit even beside a ticket the top lines close', async () => {
    const h = await ask({ body: 'Closes #748\n\nThe new fire fixes #748 by reading the body.' });
    assert.deepEqual(h.judged, []);
    assert.match(h.text, edit);
    assert.ok(h.text.includes('`fixes #748`'), h.text);
  });

  test('each ticket a body closes is held to test 1: one failing fails the PR, naming it', async () => {
    const h = await ask({ body: 'Closes #748 and fixes #754.', tickets: { 754: { state: 'closed' } } });
    assert.deepEqual(h.judged, []);
    assert.equal(h.answer.answer, 'fail');
    const reason = h.text;
    assert.match(reason, person);
    assert.match(reason, /#754[\s\S]*\(test 1\)/);
    assert.doesNotMatch(reason, /#748/);
  });

  test('among several tickets, one no edit meets makes test 1 not editable, whatever order they come in', async () => {
    for (const body of ['Closes #748 and fixes #754.', 'Closes #754 and fixes #748.']) {
      const h = await ask({ body, tickets: { 748: null, 754: { state: 'closed' } } });
      const reason = h.text;
      assert.match(reason, person, body);
      assert.match(reason, /#754[\s\S]*\(test 1\)/, body);
    }
  });

  test('a ticket that is not an open implementation ticket with a mode fails test 1, and no edit meets it', async () => {
    for (const ticket of [
      { labels: ['type: nfr'] },
      { labels: ['mode: afk', 'type: adr'] },
      { labels: ['mode: afk', 'type: prd'] },
      { state: 'closed' },
    ]) {
      const h = await ask({ tickets: { 748: ticket } });
      assert.deepEqual(h.judged, [], JSON.stringify(ticket));
      assert.equal(h.answer.answer, 'fail', JSON.stringify(ticket));
      assert.match(h.text, person, JSON.stringify(ticket));
      assert.match(h.text, /#748[\s\S]*\(test 1\)/, JSON.stringify(ticket));
    }
  });

  test('a ticket closed by its URL or owner/repo#N form is held to test 1 like #N: a closed one never reaches the model', async () => {
    for (const ref of [`https://github.com/${REPO}/issues/748`, `${REPO}#748`]) {
      const h = await ask({ body: `Closes ${ref}\n\nAdds a thing.`, tickets: { 748: { state: 'closed' } } });
      assert.deepEqual(h.judged, [], ref);
      assert.equal(h.answer.answer, 'fail', ref);
      assert.match(h.text, /#748[\s\S]*\(test 1\)/, ref);
    }
  });

  test('a closing number that is a pull request, no issue, a deleted issue or one moved to another repository fails test 1, and an edit can meet it', async () => {
    // 410: GitHub's answer for a deleted issue. A moved issue's read follows
    // the redirect to the new repository's issue, under another number.
    for (const ticket of [{ pull: true }, null, 410, { number: 17 }]) {
      const h = await ask({ tickets: { 748: ticket } });
      assert.deepEqual(h.judged, [], JSON.stringify(ticket));
      assert.match(h.text, edit, JSON.stringify(ticket));
      assert.match(h.text, /\(test 1\)/, JSON.stringify(ticket));
    }
  });

  test('test 1 an edit could meet, with a human-only path, never says the edit makes it pass: the sentence names test 7\'s path and a person merges', async () => {
    const h = await ask({ tickets: { 748: null }, files: [{ filename: '.claude/skills/pr-review/SKILL.md', status: 'modified' }] });
    const reason = h.text;
    assert.doesNotMatch(reason, edit);
    assert.match(reason, /\(test 1\)/);
    assert.ok(reason.includes('.claude/skills/pr-review/SKILL.md') && /test 7/i.test(reason.replace(/\(test 1\)/, '')), reason);
    assert.match(reason, /A person merges it\.$/, reason);
  });

  test('a PR at GitHub\'s file-list cap fails test 7: a path past the cap could be on the list unseen', async () => {
    const files = Array.from({ length: FILES_LISTED }, (_, i) => ({ filename: `src/gen/f${i}.ts`, status: 'added' }));
    const h = await ask({ files });
    assert.deepEqual(h.judged, []);
    assert.equal(h.answer.answer, 'fail');
    const reason = h.text;
    assert.match(reason, person);
    assert.match(reason, /\(test 7\)/);
    assert.ok(reason.includes(String(FILES_LISTED)), reason);
  });

  describe('a readied ADR', () => {
    const READIED = ['mode: afk', 'type: adr', 'workflow: under development'];
    const adr = (first: string, labels = READIED) => ({ labels, body: `${first}\n\n## Decision\n\nIt is decided.\n\n## Fitness functions\n\n- A test holds it.` });
    const LINE = 'Constraint now lives at docs/constraints/promotion-gate.md';
    const CONSTRAINT: FileRow = { filename: 'docs/constraints/promotion-gate.md', status: 'modified' };

    test('a prose closing of the ADR itself asks for an edit, and its constraint files stay decided', async () => {
      const h = await ask({ body: 'Closes #748\n\nThis fixes #748 by landing the file.', tickets: { 748: adr(LINE) }, files: [CONSTRAINT] });
      const reason = h.text;
      assert.match(reason, edit, reason);
      assert.match(reason, /\(test 1\)/);
      assert.doesNotMatch(reason, /test 7/);
    });

    test('passes test 1 and goes to the model: it carries a workflow and a mode label', async () => {
      const h = await ask({ tickets: { 748: adr(LINE) } });
      assert.equal(h.judged.length, 1);
      assert.equal(h.answer.answer, 'pass');
    });

    test('an ADR without a readied workflow label, or without a mode label, fails test 1, and no edit meets it', async () => {
      for (const labels of [
        ['mode: afk', 'type: adr'],
        ['type: adr', 'workflow: ready for development'],
        ['mode: afk', 'type: adr', 'workflow: wontfix'],
        ['mode: afk', 'type: adr', 'workflow: duplicate'],
      ]) {
        const h = await ask({ tickets: { 748: adr(LINE, labels) } });
        assert.deepEqual(h.judged, [], JSON.stringify(labels));
        assert.match(h.text, person, JSON.stringify(labels));
        assert.match(h.text, /#748[\s\S]*\(test 1\)/, JSON.stringify(labels));
        // "Self-landing" names one way an ADR lands; test 1 asks only whether
        // the ADR is readied.
        assert.match(h.text, /is `type: adr` \(it passes only with one of `workflow: ready for development`, `workflow: under development`\)|carries none of `mode: afk`/, JSON.stringify(labels));
        assert.doesNotMatch(h.text, /land itself|self-landing/i, JSON.stringify(labels));
      }
    });

    test('a readied ADR that is `mode: hitl` passes test 1, and only the constraint files its line names pass test 7', async () => {
      const labels = ['mode: hitl', 'type: adr', 'workflow: under development'];
      const named = await ask({ tickets: { 748: adr(LINE, labels) }, files: [CONSTRAINT, { filename: 'dispatch/review.mjs', status: 'modified' }] });
      assert.equal(named.judged.length, 1);
      assert.equal(named.answer.answer, 'pass');
      const unnamed = await ask({ tickets: { 748: adr(LINE, labels) }, files: [CONSTRAINT, { filename: 'docs/constraints/auth.md', status: 'added' }] });
      assert.deepEqual(unnamed.judged, []);
      assert.match(unnamed.text, /docs\/constraints\/auth\.md[\s\S]*\(test 7\)/);
    });

    test('passes test 7 for the constraint files its first line names, and only those', async () => {
      const two = 'Constraint now lives at docs/constraints/promotion-gate.md, `docs/constraints/deploy-gates.md`';
      for (const [first, files] of [
        [LINE, [...FILES, CONSTRAINT]],
        [two, [CONSTRAINT, { filename: 'docs/constraints/deploy-gates.md', status: 'added' }]],
      ] as const) {
        const h = await ask({ tickets: { 748: adr(first) }, files: [...files] });
        assert.equal(h.judged.length, 1, first);
        assert.equal(h.answer.answer, 'pass', first);
      }
    });

    // An added file: a modified one no ADR names is the model's to read.
    test('a constraint file the line does not name, a line not first, a rename from an unnamed file, or a named path outside docs/constraints fails test 7', async () => {
      for (const [first, files, path] of [
        [LINE, [CONSTRAINT, { filename: 'docs/constraints/auth.md', status: 'added' }], 'docs/constraints/auth.md'],
        [`Some preamble.\n${LINE}`, [{ ...CONSTRAINT, status: 'added' }], CONSTRAINT.filename],
        [LINE, [{ filename: CONSTRAINT.filename, status: 'renamed', previous: 'docs/constraints/deploy-gates.md' }], 'docs/constraints/deploy-gates.md'],
        ['Constraint now lives at dispatch/review.mjs', [{ filename: 'dispatch/review.mjs', status: 'modified' }], 'dispatch/review.mjs'],
        ['Constraint now lives at docs/constraints/README.md', [{ filename: 'docs/constraints/README.md', status: 'modified' }], 'docs/constraints/README.md'],
        ['Constraint now lives at docs/constraints/sub/x.md', [{ filename: 'docs/constraints/sub/x.md', status: 'added' }], 'docs/constraints/sub/x.md'],
      ] as const) {
        const h = await ask({ tickets: { 748: adr(first) }, files: [...files] });
        const reason = h.text;
        assert.deepEqual(h.judged, [], first);
        assert.match(reason, person, first);
        assert.match(reason, /\(test 7\)/, first);
        assert.ok(reason.includes(`\`${path}\``), reason);
      }
    });

    test('two readied ADRs closed together each clear the constraint files they name', async () => {
      const h = await ask({
        body: 'Closes #748. Closes #754.',
        tickets: { 748: adr(LINE), 754: adr('Constraint now lives at docs/constraints/deploy-gates.md') },
        files: [CONSTRAINT, { filename: 'docs/constraints/deploy-gates.md', status: 'modified' }],
      });
      assert.equal(h.judged.length, 1);
      assert.equal(h.answer.answer, 'pass');
    });

    test('a readied ADR clears its constraint files while another ticket the body closes fails test 1 an edit meets', async () => {
      const h = await ask({
        body: 'Closes #748. Closes #754.',
        tickets: { 748: adr(LINE), 754: null },
        files: [CONSTRAINT],
      });
      const reason = h.text;
      assert.deepEqual(h.judged, []);
      assert.match(reason, edit);
      assert.match(reason, /#754[\s\S]*\(test 1\)/);
      assert.doesNotMatch(reason, /test 7/);
    });

    test('a constraint file added closing no ADR fails test 7, whatever the ticket says', async () => {
      const h = await ask({ tickets: { 748: { body: LINE } }, files: [{ ...CONSTRAINT, status: 'added' }] });
      assert.deepEqual(h.judged, []);
      assert.match(h.text, /docs\/constraints\/promotion-gate\.md[\s\S]*\(test 7\)/);
    });
  });

  /**
   * A `mode: hitl` or `mode: human` ticket is worked in a session a person
   * started and steered, so its PR has had its person already: it passes
   * test 1 and skips test 7.
   */
  describe('a ticket its person worked: `mode: hitl` or `mode: human`', () => {
    const LISTED: FileRow[] = [
      { filename: '.claude/settings.json', status: 'modified' },
      { filename: 'dispatch/review.mjs', status: 'modified' },
      { filename: '.github/dispatch.json', status: 'modified' },
      { filename: 'src/billing/entitlements.ts', status: 'modified' },
    ];
    const worked = (mode: string, workflow = 'workflow: under development') => ({ labels: [mode, 'type: bug', workflow] });

    test('passes tests 1 and 7 whatever human-only paths it changes, and passes', async () => {
      for (const mode of ['mode: hitl', 'mode: human']) {
        const h = await ask({ tickets: { 748: worked(mode) }, files: LISTED });
        assert.equal(h.judged.length, 1, mode);
        assert.deepEqual(h.judged[0]!.schema, ANSWER_SCHEMA, mode);
        assert.match(h.judged[0]!.system, /Tests 1 and 7 are already decided/, mode);
        assert.equal(h.answer.answer, 'pass', mode);
      }
    });

    test('its constraint files keep their rule: changing what one means takes an ADR, not a person', async () => {
      const added = await ask({ tickets: { 748: worked('mode: hitl') }, files: [...LISTED, { filename: 'docs/constraints/auth.md', status: 'added' }] });
      const reason = added.text;
      assert.deepEqual(added.judged, []);
      assert.match(reason, person, reason);
      assert.ok(reason.includes('`docs/constraints/auth.md`') && /\(test 7\)/.test(reason), reason);
      assert.doesNotMatch(reason, /\.claude\/settings\.json|dispatch\/review\.mjs/, 'only the constraint file is named');
      const path = 'docs/constraints/auth.md';
      const modified = await ask({ tickets: { 748: worked('mode: human') }, files: [...LISTED, { filename: path, status: 'modified' }], texts: { [`${MERGE_BASE}:${path}`]: 'before', [`${HEAD}:${path}`]: 'after' } });
      assert.equal(modified.judged.length, 1);
      assert.deepEqual(modified.judged[0]!.schema, CONSTRAINT_ANSWER_SCHEMA, 'the model reads the modified one');
    });

    test('beside an afk ticket it clears nothing: the afk work was nobody\'s to watch', async () => {
      const h = await ask({ body: 'Closes #748. Closes #754.', tickets: { 754: worked('mode: hitl') }, files: LISTED });
      assert.deepEqual(h.judged, []);
      assert.match(h.text, /\(test 7\)/);
    });

    test('several, all worked by their person, clear the list together', async () => {
      const h = await ask({ body: 'Closes #748. Closes #754.', tickets: { 748: worked('mode: human'), 754: worked('mode: hitl') }, files: LISTED });
      assert.equal(h.judged.length, 1);
      assert.equal(h.answer.answer, 'pass');
    });

    // The label says who should work the ticket, not who did: a summons on
    // it starts a session nobody watches.
    test('from a session governor started, it clears nothing: the label is not a person having read the diff', async () => {
      for (const mode of ['mode: hitl', 'mode: human']) {
        const h = await ask({ tickets: { 748: worked(mode) }, files: LISTED, started: ['https://claude.ai/code/session_01OWNER'] });
        assert.deepEqual(h.sessionsRead, ['https://claude.ai/code/session_01OWNER'], mode);
        assert.deepEqual(h.judged, [], mode);
        assert.match(h.text, person, mode);
        assert.match(h.text, /\(test 7\)/, mode);
      }
    });

    test('from a session a person started, or a body naming none, it still clears the list', async () => {
      for (const body of [BODY, 'Closes #748.\n\nWorked by hand.']) {
        const h = await ask({ body, tickets: { 748: worked('mode: hitl') }, files: LISTED, started: ['https://claude.ai/code/session_01OTHER'] });
        assert.equal(h.answer.answer, 'pass', body);
      }
      const unnamed = await ask({ body: 'Closes #748.', tickets: { 748: worked('mode: hitl') }, files: LISTED, started: 'unreachable' });
      assert.deepEqual(unnamed.sessionsRead, [], 'a body naming no session asks the table nothing');
    });

    test('a record that cannot be read fails the review, rather than waive', async () => {
      await assert.rejects(ask({ tickets: { 748: worked('mode: hitl') }, files: LISTED, started: 'AccessDeniedException' }), /AccessDeniedException/);
    });

    test('where no label waives a listed path, the table is not read, and a read that would fail fails nothing', async () => {
      const unlisted = await ask({ tickets: { 748: worked('mode: hitl') }, files: [{ filename: 'src/app.ts', status: 'modified' }], started: 'AccessDeniedException' });
      assert.deepEqual(unlisted.sessionsRead, [], 'no listed path: nothing to waive');
      assert.equal(unlisted.answer.answer, 'pass');
      const afk = await ask({ tickets: { 748: worked('mode: afk') }, files: LISTED, started: 'AccessDeniedException' });
      assert.deepEqual(afk.sessionsRead, [], 'an afk ticket waives nothing');
      assert.match(afk.text, /\(test 7\)/);
    });

    test('still `ready for development`, it is told to claim it, and test 7 is not named', async () => {
      const h = await ask({ tickets: { 748: worked('mode: human', 'workflow: ready for development') }, files: LISTED });
      const reason = h.text;
      assert.deepEqual(h.judged, []);
      assert.match(reason, /^Waits for its ticket to be claimed: /, reason);
      assert.doesNotMatch(reason, /test 7/, reason);
    });

    test('one failing test 1 on its own clears nothing: the human-only path is named', async () => {
      for (const [ticket, open] of [
        [{ ...worked('mode: hitl'), state: 'closed' }, []],
        [worked('mode: hitl'), [{ number: 773, draft: false, body: 'Closes #748.' }]],
      ] as const) {
        const h = await ask({ tickets: { 748: ticket }, files: LISTED, open: [...open] });
        const reason = h.text;
        assert.deepEqual(h.judged, [], reason);
        assert.match(reason, person, reason);
        assert.match(reason, /\(test 1\)/, reason);
        assert.ok(reason.includes('.claude/settings.json') && /test 7/.test(reason.replace(/\(test 1\)/, '')), reason);
      }
    });

    test('a ticket with no mode label fails test 1 for a person, and names the modes', async () => {
      const h = await ask({ tickets: { 748: { labels: ['type: nfr', 'workflow: under development'] } } });
      const reason = h.text;
      assert.deepEqual(h.judged, []);
      assert.match(reason, person, reason);
      assert.match(reason, /#748[\s\S]*mode: afk[\s\S]*hitl[\s\S]*human[\s\S]*\(test 1\)/, reason);
    });
  });

  test('a PR passing 1 and 7 goes to the model, told they are decided', async () => {
    const h = await ask();
    assert.equal(h.judged.length, 1);
    assert.ok(h.judged[0]!.system.startsWith(SKILL), 'the skill is the system prompt');
    assert.match(h.judged[0]!.system, /Tests 1 and 7 are already decided/);
    assert.equal(h.answer.answer, 'pass');
  });
});

/**
 * A constraint file the PR modifies, and no ADR it closes names, is
 * the model's to read on test 7, before and after. Every other constraint
 * change, and every other human-only path, is still the code's.
 */
describe('a constraint file the code leaves to the model', () => {
  const person = /^Waits for a person: /;
  const PATH = 'docs/constraints/billing-store-cards.md';
  const EDIT: FileRow = { filename: PATH, status: 'modified' };
  const BEFORE = '# Billing\n\n- No steering (plain-browser Apple-billed users get the URL).';
  const AFTER = '# Billing\n\n- No steering (Apple-billed users outside the Apple shell get the URL).';
  const texts = { [`${MERGE_BASE}:${PATH}`]: BEFORE, [`${HEAD}:${PATH}`]: AFTER };
  const MEANING: Answer = { answer: 'fail', test: 7, reason: `\`${PATH}\` adds an exception inside a store shell`, editable: true };

  test('a modified constraint file no ADR names goes to the model with its text at the merge base and at the head, and passes', async () => {
    const h = await ask({ files: [...FILES, EDIT], texts });
    assert.equal(h.judged.length, 1);
    const { prompt, system, schema } = h.judged[0]!;
    assert.ok(prompt.includes(BEFORE) && prompt.includes(AFTER), prompt);
    assert.ok(prompt.indexOf(BEFORE) < prompt.indexOf(AFTER), 'before, then after');
    assert.ok(system.startsWith(SKILL));
    assert.match(system, /test 7 for the files the prompt quotes/i);
    assert.deepEqual(schema, CONSTRAINT_ANSWER_SCHEMA);
    // Before is the merge base, not main's tip: what main gained since is not the PR's.
    assert.deepEqual(h.baseReads, [['main', HEAD]]);
    assert.deepEqual([...h.fileReads].sort(), [`${HEAD}:${PATH}`, `${MERGE_BASE}:${PATH}`]);
    assert.equal(h.answer.answer, 'pass');
  });

  test('a change the model finds alters a rule waits for a person on test 7, whatever it said of an edit, and wakes no session', async () => {
    const h = await ask({ files: [EDIT], texts, answers: [MEANING] });
    assert.equal(h.answer.answer, 'fail');
    assert.equal(h.answer.answer, 'fail');
    const text = h.text;
    assert.match(text, person);
    assert.match(text, /\(test 7\)/);
    assert.ok(text.includes(PATH), text);
    assert.deepEqual(receiverFires(text), []);
  });

  test('the code still decides test 7 before any model call: a constraint file added, removed or renamed, the README, or another human-only path beside it', async () => {
    for (const [files, path] of [
      [[{ filename: PATH, status: 'added' }], PATH],
      [[{ filename: PATH, status: 'removed' }], PATH],
      [[{ filename: 'docs/constraints/billing-store-google-cards.md', status: 'renamed', previous: PATH }], PATH],
      [[{ filename: 'docs/constraints/README.md', status: 'modified' }], 'docs/constraints/README.md'],
      [[EDIT, { filename: 'dispatch/review.mjs', status: 'modified' }], 'dispatch/review.mjs'],
      [[EDIT, { filename: 'docs/constraints/auth.md', status: 'added' }], 'docs/constraints/auth.md'],
    ] as const) {
      const h = await ask({ files: [...files], texts });
      const reason = h.text;
      assert.deepEqual(h.judged, [], JSON.stringify(files));
      assert.deepEqual(h.fileReads, [], JSON.stringify(files));
      assert.match(reason, person, reason);
      assert.match(reason, /\(test 7\)/, reason);
      assert.ok(reason.includes(`\`${path}\``), reason);
    }
  });

  test('a constraint file a readied ADR names is decided, not read: the model answers tests 2 to 6', async () => {
    const adr = { labels: ['mode: afk', 'type: adr', 'workflow: under development'], body: `Constraint now lives at ${PATH}\n\n## Fitness functions\n\n- A test holds it.` };
    const h = await ask({ tickets: { 748: adr }, files: [EDIT], texts });
    assert.equal(h.judged.length, 1);
    assert.deepEqual(h.judged[0]!.schema, ANSWER_SCHEMA);
    assert.match(h.judged[0]!.system, /Tests 1 and 7 are already decided/);
    assert.deepEqual(h.fileReads, []);
  });

  test('a test-1 fail beside a modified constraint file is the edit alone: test 7 is not yet the code\'s to fail, and nothing is read', async () => {
    const h = await ask({ tickets: { 748: null }, files: [EDIT], texts });
    const reason = h.text;
    assert.deepEqual(h.judged, []);
    assert.deepEqual(h.fileReads, []);
    assert.match(reason, /^Waits for a description edit: /, reason);
    assert.match(reason, /\(test 1\)/, reason);
    assert.doesNotMatch(reason, /test 7/, reason);
  });

  test('a PR changing no constraint file reads none, and the model answers tests 2 to 6', async () => {
    const h = await ask();
    assert.deepEqual(h.baseReads, []);
    assert.deepEqual(h.fileReads, []);
    assert.deepEqual(h.judged[0]!.schema, ANSWER_SCHEMA);
  });

  test('a constraint file whose text cannot be read fails the checklist: nothing is judged or answered', async () => {
    const judged: unknown[] = [];
    await assert.rejects(ask({ files: [EDIT], texts: { [`${HEAD}:${PATH}`]: AFTER }, judged }), /404/);
    assert.deepEqual(judged, []);
  });
});

/**
 * The model finds a first test an edit meets and a later one no edit
 * meets. It names the later one in `person`, as `decideInCode` does for
 * test 7, and the author session hears its edit first.
 */
describe('a model-judged edit beside a later test no edit meets', () => {
  const OWNER = 'https://claude.ai/code/session_01OWNER';
  const EDIT_THEN = /^Waits for a description edit, then a person: /;
  const CRITERION = 'no criterion is answered at merge';
  const PATH = 'docs/constraints/billing-store-cards.md';
  const texts = { [`${MERGE_BASE}:${PATH}`]: '# Billing\n\n- A rule.', [`${HEAD}:${PATH}`]: '# Billing\n\n- Another rule.' };

  test('an edit on test 2 and a cost test 3 refuses: the edit, then the person, and the owner session hears it', async () => {
    const answer: Answer = { answer: 'fail', test: 2, reason: CRITERION, editable: false, person: { test: 3, reason: IAM.reason } };
    const h = await ask({ answers: [answer] });
    assert.equal(h.answer.answer, 'fail');
    assert.equal(h.answer.answer, 'fail');
    const text = h.text;
    assert.match(text, EDIT_THEN, text);
    assert.ok(text.includes(`${CRITERION} (test 2). An edit to the description meets test 2`), text);
    assert.ok(text.includes(`Test 3 fails whatever the description says: ${IAM.reason}. A person merges it.`), text);
    assert.deepEqual(receiverFires(text).map((f) => [f.kind, f.session]), [['message', OWNER]]);
  });

  test('an edit on test 2 and a constraint file whose rule changes: the edit, then the person on test 7, and the owner session hears it', async () => {
    const answer: Answer = { answer: 'fail', test: 2, reason: CRITERION, editable: false, person: { test: 7, reason: `\`${PATH}\` changes a rule` } };
    const h = await ask({ files: [{ filename: PATH, status: 'modified' }], texts, answers: [answer] });
    assert.deepEqual(h.judged[0]!.schema, CONSTRAINT_ANSWER_SCHEMA);
    const text = h.text;
    assert.match(text, EDIT_THEN, text);
    assert.match(text, /\(test 2\)[\s\S]*Test 7 fails whatever the description says: /, text);
    assert.deepEqual(receiverFires(text).map((f) => [f.kind, f.session]), [['message', OWNER]]);
  });

  test('a later test only a person meets and no edit owed is a person\'s alone: nobody is woken', async () => {
    const h = await ask({ answers: [{ ...IAM, reason: `${IAM.reason}, and test 5 names no owner a person has not decided` }] });
    assert.match(h.text, /^Waits for a person: /);
    assert.deepEqual(receiverFires(h.text), []);
  });
});

/**
 * The state of the tickets a PR names, read before the model is. The
 * ticket it closes must be claimed and closed by no other open PR; every
 * ticket the Verification table or Left for later names as an owner must
 * exist and be open.
 */
describe('the state of the tickets a PR names', () => {
  const person = /^Waits for a person: /;
  const edit = /^Waits for a description edit: /;
  const OWNER = 'https://claude.ai/code/session_01OWNER';

  test('a ticket still `ready for development` fails test 1, and the author session is told to claim it', async () => {
    const h = await ask({ tickets: { 748: { labels: ['mode: afk', 'type: nfr', 'workflow: ready for development'] } } });
    assert.deepEqual(h.judged, []);
    assert.equal(h.answer.answer, 'fail');
    const text = h.text;
    assert.match(text, /^Waits for its ticket to be claimed: /);
    assert.match(text, /#748[\s\S]*\(test 1\)/);
    assert.match(text, /workflow: under development/);
    assert.equal(h.answer.answer, 'fail');
    const fires = receiverFires(text);
    assert.deepEqual(fires.map((f) => [f.kind, f.session]), [['message', OWNER]], 'the owner session hears it');
  });

  test('a claimed readied ADR passes; one still `ready for development` is told to claim it', async () => {
    const adr = (state: string) => ({ labels: ['mode: afk', 'type: adr', state], body: 'Constraint now lives at docs/constraints/promotion-gate.md' });
    const claimed = await ask({ tickets: { 748: adr('workflow: under development') } });
    assert.equal(claimed.judged.length, 1);
    const ready = await ask({ tickets: { 748: adr('workflow: ready for development') } });
    assert.deepEqual(ready.judged, []);
    assert.match(ready.text, /^Waits for its ticket to be claimed: /);
  });

  test('an open ticket in no workflow, or one that is not under development, fails test 1 for a person', async () => {
    for (const labels of [['mode: afk', 'type: nfr'], ['mode: afk', 'type: nfr', 'workflow: verified'], ['mode: afk', 'type: nfr', 'workflow: needs elaboration']]) {
      const h = await ask({ tickets: { 748: { labels } } });
      assert.deepEqual(h.judged, [], JSON.stringify(labels));
      assert.match(h.text, person, JSON.stringify(labels));
      assert.match(h.text, /#748[\s\S]*under development[\s\S]*\(test 1\)/, JSON.stringify(labels));
    }
  });

  test('a closed ticket fails test 1 for a person, claimed or not', async () => {
    const h = await ask({ tickets: { 748: { state: 'closed', labels: ['mode: afk', 'type: nfr', 'workflow: ready for development'] } } });
    assert.match(h.text, person);
    assert.match(h.text, /#748, is closed[\s\S]*\(test 1\)/);
  });

  test('two open PRs closing one ticket both wait for a person, each comment naming the other', async () => {
    const other = pullRow({ number: 773, html_url: `https://github.com/${REPO}/pull/773` });
    const open = [{ number: 767, draft: false, body: BODY }, { number: 773, draft: true, body: BODY }];
    for (const [pr, named] of [[767, 773], [773, 767]] as const) {
      const h = await ask({ pull: pr === 767 ? pullRow() : other, open });
      assert.deepEqual(h.judged, [], String(pr));
      assert.equal(h.answer.answer, 'fail', String(pr));
      const reason = h.text;
      assert.match(reason, person, String(pr));
      assert.match(reason, new RegExp(`#${named}[\\s\\S]*#748|#748[\\s\\S]*#${named}`), reason);
      assert.match(reason, /\(test 1\)/, reason);
    }
  });

  test('another open PR closing a different ticket, or naming this one without a closing keyword, is no duplicate', async () => {
    const h = await ask({ open: [{ number: 767, draft: false, body: BODY }, { number: 773, draft: false, body: 'Closes #754. Builds on #748.' }] });
    assert.equal(h.judged.length, 1);
    assert.equal(h.answer.answer, 'pass');
  });

  const VERIFIED = (owner: string, later = 'None.') => `Closes #748\n\nAdds it.\n\n## Verification\n\n| Acceptance criterion | Answered by | Green at |\n|---|---|---|\n| It reviews | \`test/x.test.ts\` after #822 | merge |\n| It runs nightly | nothing yet | ${owner} |\n\n## Left for later\n\n${later}\n\nhttps://claude.ai/code/session_01OWNER`;

  test('a Verification row owned by a closed, missing or pull-request number fails test 5 with the number, and an edit meets it', async () => {
    for (const owner of [{ state: 'closed' }, null, { pull: true }]) {
      const h = await ask({ body: VERIFIED('#859'), tickets: { 859: owner } });
      assert.deepEqual(h.judged, [], JSON.stringify(owner));
      const reason = h.text;
      assert.match(reason, edit, reason);
      assert.match(reason, /#859[\s\S]*\(test 5\)/, reason);
    }
  });

  test('a Left for later line owned by a closed or missing ticket fails test 6 with the number, and an edit meets it', async () => {
    for (const owner of [{ state: 'closed' }, null]) {
      const h = await ask({ body: VERIFIED('nightly', '- #865 the prod run, once the grant deploys.\n- Declined: a sweep nobody reads.'), tickets: { 865: owner } });
      assert.deepEqual(h.judged, [], JSON.stringify(owner));
      const reason = h.text;
      assert.match(reason, edit, reason);
      assert.match(reason, /#865[\s\S]*\(test 6\)/, reason);
    }
  });

  test('owners that are open go to the model; a closed number outside the owner cells is no owner', async () => {
    const body = VERIFIED('#859', '- #865 the prod run.');
    const h = await ask({ body, tickets: { 822: { state: 'closed' } } });
    assert.equal(h.judged.length, 1);
    assert.equal(h.answer.answer, 'pass');
  });

  test('a closed owner with a human-only path waits for the owner\'s edit, then a person on test 7, and the owner session hears it', async () => {
    const h = await ask({ body: VERIFIED('#859'), tickets: { 859: { state: 'closed' } }, files: [{ filename: 'dispatch/review.mjs', status: 'modified' }] });
    const reason = h.text;
    assert.match(reason, /^Waits for a description edit, then a person: /, reason);
    assert.match(reason, /#859[\s\S]*\(test 5\)[\s\S]*Test 7 fails whatever the description says: `dispatch\/review\.mjs`/, reason);
    assert.deepEqual(receiverFires(h.text, VERIFIED('#859')).map((f) => [f.kind, f.session]), [['message', OWNER]]);
  });

  test('a ready ADR changing the constraint file it names is told to claim it, not sent to a person', async () => {
    const ticket = { labels: ['mode: afk', 'type: adr', 'workflow: ready for development'], body: 'Constraint now lives at docs/constraints/promotion-gate.md' };
    const h = await ask({ tickets: { 748: ticket }, files: [{ filename: 'docs/constraints/promotion-gate.md', status: 'modified' }] });
    assert.deepEqual(h.judged, []);
    assert.match(h.text, /^Waits for its ticket to be claimed: /);
    assert.doesNotMatch(h.text, /test 7/);
  });

  test('a Verification row owned by the ticket the PR closes fails test 5: the merge closes that ticket', async () => {
    const h = await ask({ body: VERIFIED('#748') });
    assert.deepEqual(h.judged, []);
    const reason = h.text;
    assert.match(reason, edit, reason);
    assert.match(reason, /#748[\s\S]*\(test 5\)/, reason);
  });

  test('a body closing no ticket has its owners read too: a closed one fails test 6, open ones go to the model', async () => {
    const ticketless = (later: string) => VERIFIED('nightly', later).replace('Closes #748\n\n', '');
    const closed = await ask({ body: ticketless('- #865 the prod run.'), tickets: { 865: { state: 'closed' } } });
    assert.deepEqual(closed.judged, []);
    assert.match(closed.text, /^Waits for a description edit: [\s\S]*#865[\s\S]*\(test 6\)/);
    const open = await ask({ body: ticketless('- #865 the prod run.') });
    assert.equal(open.judged.length, 1);
    assert.equal(open.answer.answer, 'pass');
  });

  test('the open PRs are read only when the body closes a ticket', async () => {
    for (const [body, reads] of [['No ticket.', 0], ['Closes #748. Closes #754.', 1]] as const) {
      const h = await ask({ body });
      assert.equal(h.openReads, reads, body);
    }
  });

  test('another open PR closing any one of several tickets waits for a person, naming that ticket', async () => {
    const h = await ask({ body: 'Closes #748. Closes #754.', open: [{ number: 773, draft: false, body: 'Closes #754.' }] });
    assert.deepEqual(h.judged, []);
    const reason = h.text;
    assert.match(reason, person);
    assert.match(reason, /#773[\s\S]*#754[\s\S]*\(test 1\)/);
  });

  test('another open PR closing a ticket in prose still closes it, so it waits for a person', async () => {
    const h = await ask({ body: 'Closes #748.', open: [{ number: 773, draft: false, body: 'Adds it.\n\nThis also fixes #748 on the way.' }] });
    assert.deepEqual(h.judged, []);
    const reason = h.text;
    assert.match(reason, person);
    assert.match(reason, /#773[\s\S]*#748[\s\S]*\(test 1\)/);
  });

  test('of several tickets, the unclaimed ones are named for the author session to claim', async () => {
    const ready = { labels: ['mode: afk', 'type: nfr', 'workflow: ready for development'] };
    const h = await ask({ body: 'Closes #748. Closes #754. Closes #761.', tickets: { 748: ready, 761: ready } });
    assert.deepEqual(h.judged, []);
    const reason = h.text;
    assert.match(reason, /^Waits for its ticket to be claimed: /);
    assert.match(reason, /#748[\s\S]*#761[\s\S]*\(test 1\)/);
    assert.doesNotMatch(reason, /#754/);
    assert.match(reason, /The author session claims each ticket named/);
  });

  test('a Verification row owned by any ticket the PR closes fails test 5', async () => {
    const h = await ask({ body: VERIFIED('#754').replace('Closes #748', 'Closes #748\nCloses #754') });
    assert.deepEqual(h.judged, []);
    assert.match(h.text, /#754[\s\S]*\(test 5\)/);
  });

  test('the model is told the owners were checked', async () => {
    const h = await ask();
    assert.match(h.judged[0]!.system, /Left for later/);
  });
});

describe('the checklist\'s parts', () => {
  test('decideInCode fails test 1 for an edit on a prose closing, and a fail no edit meets still comes first', () => {
    const ticket = { number: 748, title: 'T', body: '', state: 'open', labels: ['mode: afk', 'type: nfr', 'workflow: under development'], pull: false };
    const prose = [{ number: 840, text: 'fixed #840' }];
    const answer = decideInCode({ files: [], tickets: [ticket], rules: { ...FACTORY_RULES, humanOnly: [] }, prose });
    assert.ok(answer?.answer === 'fail', JSON.stringify(answer));
    assert.equal(answer.test, 1);
    assert.equal(answer.editable, true);
    assert.ok(answer.reason.includes('`fixed #840`'), answer.reason);
    const closed = decideInCode({ files: [], tickets: [{ ...ticket, state: 'closed' }], rules: { ...FACTORY_RULES, humanOnly: [] }, prose });
    assert.ok(closed?.answer === 'fail', JSON.stringify(closed));
    assert.equal(closed.editable, false);
    assert.match(closed.reason, /#748/);
  });

  test('decideInCode skips the human-only list but the constraint files for a PR closing only claimed hitl or human tickets', () => {
    const files = [{ filename: '.claude/settings.json', status: 'modified' }, { filename: 'docs/constraints/auth.md', status: 'modified' }];
    const ticket = (mode: string) => ({ number: 748, title: 'T', body: '', state: 'open', labels: [mode, 'type: bug', 'workflow: under development'], pull: false });
    for (const mode of ['mode: hitl', 'mode: human']) {
      assert.equal(decideInCode({ files, tickets: [ticket(mode)], rules: FACTORY_RULES }), null, mode);
      assert.deepEqual(constraintsLeft(files, [ticket(mode)], FACTORY_RULES), ['docs/constraints/auth.md'], `${mode}: the model still reads the constraint file`);
      const added = decideInCode({ files: [{ filename: 'docs/constraints/auth.md', status: 'added' }], tickets: [ticket(mode)], rules: FACTORY_RULES });
      assert.equal(added?.answer === 'fail' && added.test, 7, mode);
    }
    assert.equal(decideInCode({ files, tickets: [ticket('mode: afk')], rules: FACTORY_RULES })?.answer, 'fail');
    assert.equal(decideInCode({ files, tickets: [], rules: FACTORY_RULES })?.answer, 'fail', 'closing no ticket clears nothing');
  });

  test('parseReview takes the structured output, or the JSON in the result text, and refuses anything else', () => {
    assert.deepEqual(parseReview(cliOutput(IAM, 's9')), { sessionId: 's9', answer: IAM });
    const fenced = JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: 'Here:\n```json\n{"answer":"pass","reason":"fine"}\n```' });
    assert.deepEqual(parseReview(fenced).answer, { answer: 'pass', reason: 'fine' });
    assert.throws(() => parseReview(JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: '{"answer":"fail","test":9,"reason":"x","editable":true}' })), /test/);
    assert.throws(() => parseReview(''), /answer/);
    // Tests 1 and 7 are the code's: a model naming either is off the checklist it was given.
    for (const t of [1, 7]) {
      assert.throws(() => parseReview(cliOutput({ ...IAM, test: t })), /test/, `test ${t}`);
    }
    assert.deepEqual([ANSWER_SCHEMA.properties.test.minimum, ANSWER_SCHEMA.properties.test.maximum], [2, 6]);
  });

  test('parseReview reads the run\'s tokens and cost from the result line, and leaves out what it does not carry', () => {
    const usage = { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 5600, cache_creation_input_tokens: 780, server_tool_use: { web_search_requests: 0 } };
    const line = (extra: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(cliOutput(IAM, 's9')), ...extra });
    assert.deepEqual(parseReview(line({ usage, total_cost_usd: 0.0421 })), {
      sessionId: 's9',
      answer: IAM,
      usage: { inputTokens: 12, outputTokens: 340, cacheReadTokens: 5600, cacheCreationTokens: 780, costUsd: 0.0421 },
    });
    assert.deepEqual(parseReview(line({ usage: { input_tokens: 12, output_tokens: 'many', cache_read_input_tokens: -1, cache_creation_input_tokens: 1.5 } })).usage, { inputTokens: 12 });
    assert.deepEqual(parseReview(line({ total_cost_usd: 0.5 })).usage, { costUsd: 0.5 });
    assert.ok(!('usage' in parseReview(line({ usage: null, total_cost_usd: 'free' }))), 'a line with no numbers gives no usage');
    // A failed run still says what it spent.
    const failed = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'You\'ve hit your session limit', session_id: 's', usage, total_cost_usd: 0.01 });
    assert.throws(() => parseReview(failed), (error: { usage?: unknown, limit?: string }) => {
      assert.deepEqual(error.usage, { inputTokens: 12, outputTokens: 340, cacheReadTokens: 5600, cacheCreationTokens: 780, costUsd: 0.01 });
      assert.equal(error.limit, 'session');
      return true;
    });
    const refused = JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: 'no', total_cost_usd: 0.02 });
    assert.throws(() => parseReview(refused), (error: { usage?: unknown }) => {
      assert.deepEqual(error.usage, { costUsd: 0.02 });
      return true;
    });
  });

  test('cliJudge\'s spend report failing changes no answer and drops no transcript', async () => {
    const logged: Array<{ event: string, context: Record<string, unknown> }> = [];
    const judge = cliJudge({
      skill: SKILL,
      run: async () => ({ output: JSON.stringify({ ...JSON.parse(cliOutput(PASS, 's1')), total_cost_usd: 0.03 }) }),
      transcript: async () => ({ key: 'k' }),
      log: (event, context) => { logged.push({ event, context }); },
      spent: () => { throw new Error('the meter broke'); },
    });
    assert.deepEqual(await judge({ pull: pullRow() as never, files: FILES as never, tickets: [] }), PASS);
    assert.ok(logged.some((l) => l.event === 'dispatch-review-transcript' && l.context.sessionId === 's1'), JSON.stringify(logged));
  });

  test('parseReview takes test 7 only under the schema that leaves constraint files to the model', () => {
    const MEANING = { answer: 'fail' as const, test: 7, reason: 'a rule changes', editable: false };
    assert.deepEqual(parseReview(cliOutput(MEANING), CONSTRAINT_ANSWER_SCHEMA).answer, MEANING);
    assert.deepEqual(parseReview(cliOutput(IAM), CONSTRAINT_ANSWER_SCHEMA).answer, IAM);
    for (const t of [1, 8]) assert.throws(() => parseReview(cliOutput({ ...MEANING, test: t }), CONSTRAINT_ANSWER_SCHEMA), /test/, `test ${t}`);
    assert.throws(() => parseReview(cliOutput(MEANING)), /test/, 'the default schema keeps test 7 the code\'s');
    assert.deepEqual([CONSTRAINT_ANSWER_SCHEMA.properties.test.minimum, CONSTRAINT_ANSWER_SCHEMA.properties.test.maximum], [2, 7]);
  });

  test('parseReview takes a later test only a person meets beside the first, later than it and on the schema\'s list, and refuses anything else', () => {
    const answer = { answer: 'fail' as const, test: 2, reason: 'no criterion is answered', editable: false, person: { test: 3, reason: 'the change adds an IAM grant' } };
    assert.deepEqual(parseReview(cliOutput(answer)).answer, answer);
    // The first test is the session's to meet; the whole answer is not editable.
    assert.deepEqual(parseReview(cliOutput({ ...answer, editable: true })).answer, answer);
    const constraint = { ...answer, person: { test: 7, reason: 'a rule changes' } };
    assert.deepEqual(parseReview(cliOutput(constraint), CONSTRAINT_ANSWER_SCHEMA).answer, constraint);
    for (const person of [{ test: 2, reason: 'x' }, { test: 1, reason: 'x' }, { test: 7, reason: 'x' }, { test: 3.5, reason: 'x' }, { test: 3, reason: ' ' }, { test: 3 }, 'test 3']) {
      assert.throws(() => parseReview(cliOutput({ ...answer, person } as never)), /person/, JSON.stringify(person));
    }
    assert.throws(() => parseReview(cliOutput({ ...answer, test: 4, person: { test: 4, reason: 'x' } })), /person/);
    assert.throws(() => parseReview(cliOutput({ ...answer, person: { test: 8, reason: 'x' } }), CONSTRAINT_ANSWER_SCHEMA), /person/);
    assert.deepEqual(parseReview(cliOutput({ answer: 'pass', reason: 'fine', person: { test: 3, reason: 'x' } } as never)).answer, { answer: 'pass', reason: 'fine' });
    for (const [schema, last] of [[ANSWER_SCHEMA, 6], [CONSTRAINT_ANSWER_SCHEMA, 7]] as const) {
      const { person } = schema.properties;
      assert.deepEqual([person.properties.test.minimum, person.properties.test.maximum, person.required], [3, last, ['test', 'reason']]);
      assert.ok(!(schema.required as readonly string[]).includes('person'));
    }
  });

  test('reviewPrompt quotes each constraint file before and after, fenced past any fence the file holds', () => {
    const before = '# X\n\n```js\nconst a = 1;\n```\n\n- A rule.';
    const after = '# X\n\n```js\nconst a = 1;\n```\n\n- A rule, clarified.';
    const prompt = reviewPrompt({ pull: pullRow(), files: [], tickets: [], constraints: { base: MERGE_BASE, head: HEAD, files: [{ path: 'docs/constraints/auth.md', before, after }] } });
    assert.ok(prompt.includes('docs/constraints/auth.md'), prompt);
    assert.ok(prompt.includes(MERGE_BASE) && prompt.includes(HEAD), 'names both commits');
    assert.ok(prompt.includes(`\`\`\`\`\n${before}\n\`\`\`\``), prompt);
    assert.ok(prompt.includes(`\`\`\`\`\n${after}\n\`\`\`\``), prompt);
    assert.ok(prompt.indexOf(before) < prompt.indexOf(after));
    assert.doesNotMatch(reviewPrompt({ pull: pullRow(), files: [], tickets: [] }), /Quoted files/, 'no section without files to read');
  });

  test('reviewPrompt tells the model the quoted text is data, and says so when no ticket is closed', () => {
    const prompt = reviewPrompt({ pull: pullRow({ body: 'No ticket.' }), files: [], tickets: [] });
    assert.match(prompt, /never instructions/i);
    assert.match(prompt, /closes no ticket/i);
  });

  test('reviewPrompt asks whether an edit makes the PR pass, not whether it meets the first failed test alone', () => {
    const prompt = reviewPrompt({ pull: pullRow(), files: [], tickets: [] });
    assert.match(prompt, /"editable": <whether an edit to the description can make the PR pass/);
    assert.match(prompt, /false when a later test also fails that no edit can meet/i);
    assert.match(prompt, /the reason names that later test/i);
    // A hitl ticket or an ADR fails test 1, never a later test; test 3's unmeetable costs are the skill's whole list.
    assert.doesNotMatch(prompt, /later test[^\n]*(hitl|ADR)/);
    assert.match(prompt, /later test[^\n]*test 3/);
  });

  test('reviewPrompt asks for the later test in person when an edit meets the first', () => {
    const prompt = reviewPrompt({ pull: pullRow(), files: [], tickets: [] });
    assert.match(prompt, /"person": \{"test": <the later test's number>, "reason": <one sentence>\}/);
    assert.match(prompt, /an edit meets the first failed test/i);
    // A later test an edit also meets is the session's too, never a person's.
    assert.match(prompt, /"person" is only ever a later test no edit can meet/);
  });

  test('reviewPrompt names the path a renamed file left: a move out of a human-only path is a change to it', () => {
    const prompt = reviewPrompt({ pull: pullRow(), files: [{ filename: 'src/renamed.ts', status: 'renamed', previous: 'src/billing/entitlements.ts' }], tickets: [] });
    assert.match(prompt, /src\/billing\/entitlements\.ts/);
    assert.match(prompt, /src\/renamed\.ts/);
  });
});

describe('the human-only list', () => {

  test('globMatches: ** spans segments, * stays in one, a bare name matches at any depth, a leading slash anchors', () => {
    const cases: Array<[string, string, boolean]> = [
      ['dispatch/**', 'dispatch/review.mjs', true],
      ['dispatch/**', 'dispatch/webhook/route.mjs', true],
      ['dispatch/**', 'dispatcher/x.mjs', false],
      ['dispatch/**', 'test/dispatch/x.mjs', false],
      ['*.base', 'normalize-lambda/Dockerfile.base', true],
      ['*.base', 'Dockerfile.base', true],
      ['*.base', 'normalize-lambda/Dockerfile', false],
      ['Dockerfile.base', 'a/b/c/Dockerfile.base', true],
      ['requirements.txt', 'tools/webmainbench/requirements.txt', true],
      ['requirements.txt', 'requirements.txt.bak', false],
      ['/CLAUDE.md', 'CLAUDE.md', true],
      ['/CLAUDE.md', 'test/e2e/CLAUDE.md', false],
      ['src/apple-*', 'src/apple-webhook.ts', true],
      ['src/apple-*', 'src/pipeline/apple-webhook.ts', false],
      ['src/*subscription*', 'src/reconcile-subscription.ts', true],
      ['.github/workflows/deploy*.yml', '.github/workflows/deploy-prod.yml', true],
      ['.github/workflows/deploy*.yml', '.github/workflows/e2e.yml', false],
      ['config/tiers.json', 'config/tiers.json', true],
      ['config/tiers.json', 'config/tiers.jsonx', false],
      ['a.b', 'axb', false],
    ];
    for (const [glob, path, expected] of cases) assert.equal(globMatches(glob, path), expected, `${glob} ~ ${path}`);
  });

  // Each entry against a real path it must catch: a glob that catches
  // nothing in the tree is a list entry nobody checked.
  const CATCHES: Record<string, string> = {
    'docs/constraints/**': 'docs/constraints/promotion-gate.md',
    '/CLAUDE.md': 'CLAUDE.md',
    '.claude/**': '.claude/skills/pr-review/SKILL.md',
    'infra/**': 'infra/governor.cfn.yml',
    'serverless/**': 'serverless/functions.yml',
    '.github/workflows/deploy*.yml': '.github/workflows/deploy-stage.yml',
    '.github/workflows/deliver.yml': '.github/workflows/deliver.yml',
    '.github/workflows/dispatch.yml': '.github/workflows/dispatch.yml',
    'dispatch/**': 'dispatch/review.mjs',
    '.github/workflows/e2e.yml': '.github/workflows/e2e.yml',
    'test/e2e/lib/gate.ts': 'test/e2e/lib/gate.ts',
    'scripts/refuse-unless-dev-serves.sh': 'scripts/refuse-unless-dev-serves.sh',
    'src/billing/entitlements.ts': 'src/billing/entitlements.ts',
    'src/billing/webhook.ts': 'src/billing/webhook.ts',
    'src/billing/**/*subscription*': 'src/billing/reconcile-subscription.ts',
    'src/billing/apple/**': 'src/billing/apple/webhook.ts',
    'src/billing/google/**': 'src/billing/google/purchase.ts',
    'src/billing/stripe/**': 'src/billing/stripe/schedule.ts',
    'src/billing/pack*': 'src/billing/pack-credit.ts',
    'src/billing/auto-topup*': 'src/billing/auto-topup.ts',
    'src/oauth/**': 'src/oauth/token.ts',
    'src/mcp/authorizations*': 'src/mcp/authorizations.ts',
    'clients/shared/auth.js': 'clients/shared/auth.js',
    'clients/shared/*billing*': 'clients/shared/google-play-billing.js',
    'config/tiers.json': 'config/tiers.json',
    'config/packs.json': 'config/packs.json',
    'config/capacity-register.json': 'config/capacity-register.json',
    '/package.json': 'package.json',
    '/package-lock.json': 'package-lock.json',
    'requirements.txt': 'kokoro-lambda/requirements.txt',
    'kokoro-lambda/Dockerfile': 'kokoro-lambda/Dockerfile',
    'stitcher-lambda/Dockerfile': 'stitcher-lambda/Dockerfile',
    'Dockerfile.base': 'normalize-lambda/Dockerfile.base',
    '.github/actions/lambda-image/**': '.github/actions/lambda-image/action.yml',
    '.github/actions/normalize-base-image/**': '.github/actions/normalize-base-image/action.yml',
    '.github/workflows/build-normalize-base.yml': '.github/workflows/build-normalize-base.yml',
    '.github/dispatch.json': '.github/dispatch.json',
  };

  test('every entry catches the path pinned beside it, and every pinned glob is on the list', () => {
    assert.deepEqual(FACTORY_RULES.humanOnly.map((e) => e.glob).sort(), Object.keys(CATCHES).sort());
    for (const { glob } of FACTORY_RULES.humanOnly) {
      const path = CATCHES[glob]!;
      assert.ok(globMatches(glob, path), `${glob} catches ${path}`);
    }
  });

  test('what #816 took off, and what the list never named, pass', () => {
    const clear = ['normalize-lambda/Dockerfile', 'clients/web/package.json', 'test/e2e/CLAUDE.md', 'src/voices.ts', 'config/voices.json', 'docs/claude-code-setup.md'];
    assert.deepEqual(humanOnlyHits(clear.map((filename) => ({ filename, status: 'modified' })), FACTORY_RULES.humanOnly), []);
  });

  test('humanOnlyHits reads a rename\'s old path, once per path, with its entry', () => {
    const hits = humanOnlyHits([
      { filename: 'src/x.ts', status: 'renamed', previous: 'src/billing/apple/x.ts' },
      { filename: 'dispatch/a.mjs', status: 'modified' },
    ], FACTORY_RULES.humanOnly);
    assert.deepEqual(hits.map((h) => [h.path, h.glob]), [['src/billing/apple/x.ts', 'src/billing/apple/**'], ['dispatch/a.mjs', 'dispatch/**']]);
  });

  test('decideInCode leaves a PR passing both to the model', () => {
    const ticket = { number: 748, title: 't', body: '', state: 'open', labels: ['mode: afk', 'workflow: under development'], pull: false };
    assert.equal(decideInCode({ files: FILES, tickets: [ticket], rules: FACTORY_RULES }), null);
    assert.equal(decideInCode({ files: FILES, tickets: [ticket], rules: FACTORY_RULES, others: [], owners: { verification: [{ ...ticket, number: 859 }], later: [] } }), null);
    assert.equal(decideInCode({ files: FILES, tickets: [], rules: FACTORY_RULES }), null, 'a PR needs no ticket');
  });
});

describe('the Dependabot list', () => {
  const COMMIT = { sha: HEAD, author: DEPENDABOT, committer: 'web-flow', verified: true };
  const modified = (...paths: string[]): FileRow[] => paths.map((filename) => ({ filename, status: 'modified' }));

  /** Each entry, and a manifest it catches. */
  const CATCHES: Record<string, string> = {
    '/package.json': 'package.json',
    '/package-lock.json': 'package-lock.json',
    'normalize-lambda/requirements.txt': 'normalize-lambda/requirements.txt',
    'kokoro-lambda/requirements.txt': 'kokoro-lambda/requirements.txt',
    'tools/webmainbench/requirements.txt': 'tools/webmainbench/requirements.txt',
    'clients/*/Gemfile': 'clients/android/Gemfile',
    'clients/*/Gemfile.lock': 'clients/apple/Gemfile.lock',
  };

  test('every entry catches the manifest pinned beside it, and none reaches the dispatcher\'s own: a bad bump there would stop the review that merges it', () => {
    assert.deepEqual([...FACTORY_REVIEW.dependabot].sort(), Object.keys(CATCHES).sort());
    for (const glob of FACTORY_REVIEW.dependabot) {
      const path = CATCHES[glob]!;
      assert.ok(globMatches(glob, path), `${glob} catches ${path}`);
    }
    for (const path of ['dispatch/package.json', 'dispatch/package-lock.json', '.github/dispatch.json', 'kokoro-lambda/Dockerfile', '.github/workflows/ci.yml', 'clients/web/package.json']) {
      assert.ok(!FACTORY_REVIEW.dependabot.some((glob) => globMatches(glob, path)), path);
    }
  });

  test('a bump of manifests on the list, every commit Dependabot\'s and verified, passes, naming the files', () => {
    const answer = dependabotAnswer({ files: modified('package.json', 'package-lock.json'), commits: [COMMIT], list: FACTORY_REVIEW.dependabot });
    assert.equal(answer.answer, 'pass');
    assert.match(answer.reason, /`package\.json`, `package-lock\.json`/);
  });

  test('anything beside the bump fails test 7 for a person: no edit to Dependabot\'s description meets it', () => {
    const OTHER = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
    for (const [facts, named] of [
      [{ files: modified('package-lock.json', 'src/voices.ts'), commits: [COMMIT] }, 'src/voices.ts'],
      [{ files: [{ filename: 'package-lock.json', status: 'added' }], commits: [COMMIT] }, 'package-lock.json'],
      [{ files: modified('package-lock.json'), commits: [COMMIT, { sha: OTHER, author: 'a-member', committer: 'web-flow', verified: true }] }, OTHER.slice(0, 12)],
      [{ files: modified('package-lock.json'), commits: [{ sha: OTHER, author: DEPENDABOT, committer: 'web-flow', verified: false }] }, OTHER.slice(0, 12)],
      [{ files: modified('package-lock.json'), commits: [{ sha: OTHER, author: null, committer: 'web-flow', verified: true }] }, OTHER.slice(0, 12)],
      // A member's own signed commit, its author set to Dependabot's address: verified, but GitHub did not commit it.
      [{ files: modified('package-lock.json'), commits: [{ sha: OTHER, author: DEPENDABOT, committer: 'a-member', verified: true }] }, OTHER.slice(0, 12)],
      [{ files: modified('package-lock.json'), commits: [{ sha: OTHER, author: DEPENDABOT, committer: null, verified: true }] }, OTHER.slice(0, 12)],
      [{ files: Array.from({ length: FILES_LISTED }, () => ({ filename: 'package-lock.json', status: 'modified' })), commits: [COMMIT] }, String(FILES_LISTED)],
      [{ files: modified('package-lock.json'), commits: Array.from({ length: COMMITS_LISTED }, () => COMMIT) }, String(COMMITS_LISTED)],
      [{ files: modified('package-lock.json'), commits: [] }, 'no commit'],
      [{ files: [], commits: [COMMIT] }, 'no file'],
    ] as const) {
      const answer = dependabotAnswer({ ...facts, files: [...facts.files], commits: [...facts.commits], list: FACTORY_REVIEW.dependabot });
      assert.equal(answer.answer, 'fail', named);
      assert.deepEqual([answer.answer === 'fail' && answer.test, answer.answer === 'fail' && answer.editable], [7, false], named);
      assert.ok(answer.reason.includes(named), answer.reason);
      assert.match(commentText(answer, { conflict: false }), /^Waits for a person: .* A person merges it\.$/s);
    }
  });

  test('an empty list holds every bump for a person', () => {
    assert.equal(dependabotAnswer({ files: modified('package-lock.json'), commits: [COMMIT], list: [] }).answer, 'fail');
  });
});
