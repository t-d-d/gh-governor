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
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, configSchema, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
import { bodyDigest } from '../dispatch/pr-body.mjs';
import { exitCodeFor } from '../dispatch/cli.mjs';
import { run as runTurn } from '../dispatch/turn.mjs';
import { cliResult } from '../dispatch/cli-answer.mjs';
import {
  DEFAULT_TICKET_CHECKLIST, LINKED_BODY_LIMIT, LINKED_LIMIT, OPEN_LISTED, TICKET_ANSWER_SCHEMA, TICKET_FRAME,
  LOOP_LIMIT, checklistFor, conclusionsFor, keyFor, loopMarker, reviewTicket, ticketMarker,
} from '../dispatch/ticket-review.mjs';
import { check } from '../checker/config-check.mjs';
import { planSchedule } from '../scripts/lib/dispatch-router.mjs';
import { factoryFile } from './helpers/factory.ts';
import { importClosure } from './helpers/imports.ts';
import { APP_ID } from './helpers/dispatch-review-fixtures.ts';

const REPO = 'acme/factory';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

type Conclusions = { success?: string[], failure?: string[], neutral?: string[] };
type TypeEntry = { labels: string[], checklist?: string, conclusions?: Conclusions };
type Review = { name: string, when: { on: 'opened', labels?: string[], exclude?: string[], by?: string[] }, conclusions?: Conclusions, checklist?: string, types?: TypeEntry[] };

/** The labels each conclusion of `triage` adds in the label tests. */
const TRIAGE: Conclusions = { success: ['triaged'], failure: ['triage: needs edit'], neutral: ['triage: needs a person'] };

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
  /** The labels the repo has; default every label but the conclusions' own. */
  repoLabels?: string[],
  /** Throws for a label write GitHub refuses. */
  labelWrite?: (op: string, label: string) => void,
  /** The thread grows with each comment posted, as GitHub's does. */
  live?: boolean,
  /** Who added each of the ticket's starting labels; governor's App where unnamed. */
  adders?: Record<string, string>,
  /** Throws for a read of the ticket's label events GitHub refuses. */
  addsRead?: () => void,
} = {}) => {
  const comments: Array<{ issue: number, body: string }> = [];
  const runs: Array<{ system: string, prompt: string, schema: unknown }> = [];
  const transcripts: Array<{ sessionId: string, key: string }> = [];
  const logged: Array<{ event: string, [key: string]: unknown }> = [];
  const openReads: number[] = [];
  let threadReads = 0;
  const answers = over.answers ?? [PASSES];
  /** Every write to the ticket, in order: label removes, creates, adds and comments. */
  const ops: string[] = [];
  /** The ticket's labels and body as GitHub holds them now. */
  const live = { labels: [...ticketRow(over.ticket).labels], body: ticketRow(over.ticket).body };
  const repoLabels = new Set(over.repoLabels ?? ['type: bug', 'type: enhancement', 'mode: afk']);
  const thread: Thread[] = [...(over.thread ?? [])];
  /** The ticket's `labeled` events, oldest first, as GitHub's events API holds them. */
  const adds = live.labels.map((label) => {
    const actor = over.adders?.[label] ?? 'governor-app[bot]';
    return { label, actor, bot: actor.endsWith('[bot]'), ours: over.adders?.[label] === undefined };
  });
  let addsReads = 0;
  const reader = {
    ticket: async (n: number) => {
      if (over.gone?.includes(n)) throw Object.assign(new Error(`GET /issues/${n} failed: 410`), { status: 410 });
      if (n === 501) return ticketRow({ ...over.ticket, labels: [...live.labels], body: live.body });
      const row = over.issues?.[n];
      if (row === undefined || row === null) throw Object.assign(new Error(`GET /issues/${n} failed: 404`), { status: 404 });
      return ticketRow({ number: n, title: `Issue ${n}`, body: `Body of ${n}.`, ...row });
    },
    parentIssue: async () => (over.parent === undefined || over.parent === null ? null : { repo: REPO, ...ticketRow({ number: 390, title: 'The PRD', body: 'Non-goals: none.' }), ...over.parent }),
    openIssues: async (max: number) => { openReads.push(max); return over.open ?? [{ number: 501, title: 'Spend the retry budget once' }, { number: 502, title: 'Another' }]; },
    allComments: async () => { threadReads += 1; return over.live === true ? [...thread] : over.thread ?? []; },
    comment: async (issue: number, body: string) => {
      if (over.comment) await over.comment(body);
      comments.push({ issue, body });
      ops.push(`comment ${/review: ([^.]+)\./.exec(body)?.[1] ?? '?'}`);
      thread.push({ id: thread.length + 100, body, created_at: '2026-11-04T00:00:00Z', ours: true });
    },
    ensureLabel: async (name: string) => {
      over.labelWrite?.('ensure', name);
      if (!repoLabels.has(name)) { repoLabels.add(name); ops.push(`create ${name}`); }
    },
    addLabels: async (issue: number, labels: string[]) => {
      for (const label of labels) over.labelWrite?.('add', label);
      assert.equal(issue, 501);
      for (const label of labels) {
        assert.ok(repoLabels.has(label), `${label} was ensured before it was added`);
        if (!live.labels.includes(label)) live.labels.push(label);
        adds.push({ label, actor: 'governor-app[bot]', bot: true, ours: true });
      }
      ops.push(`add ${labels.join(', ')}`);
    },
    labelAdds: async (issue: number) => {
      assert.equal(issue, 501);
      addsReads += 1;
      over.addsRead?.();
      return adds.map((a) => ({ ...a }));
    },
    removeLabel: async (issue: number, label: string) => {
      over.labelWrite?.('remove', label);
      assert.equal(issue, 501);
      live.labels = live.labels.filter((l) => l !== label);
      ops.push(`remove ${label}`);
    },
  };
  const config = {
    ticketReviews: over.reviews ?? [{ name: 'triage', when: { on: 'opened' as const } }],
    ...(over.trusted === undefined ? {} : { trust: { review: over.trusted } }),
    ...(over.heartbeat === undefined ? {} : { heartbeat: { issue: over.heartbeat } }),
    ...(over.waits === undefined ? {} : { waits: { issue: over.waits } }),
  };
  const run = async (request: { system: string, prompt: string, schema: unknown }) => {
    runs.push(request);
    const answer = answers[Math.min(runs.length - 1, answers.length - 1)]!;
    return { status: 0, output: typeof answer === 'string' ? answer : cliOutput(answer, `sess-${runs.length}`) };
  };
  const transcript = async (t: { sessionId: string, key: string }) => { transcripts.push(t); return { key: t.key }; };
  const log = (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); };
  const review = () => reviewTicket({ repo: REPO, issue: 501, reader, config: config as never, run, transcript, log });
  /** A person or session edits the ticket's body, or its labels. */
  const edit = (change: { body?: string, labels?: string[] }) => { if (change.body !== undefined) live.body = change.body; if (change.labels !== undefined) live.labels = [...change.labels]; };
  /** A person adds a label to the ticket by hand. */
  const label = (name: string, actor = 'a-member') => { if (!live.labels.includes(name)) live.labels.push(name); adds.push({ label: name, actor, bot: false, ours: false }); };
  return { review, comments, runs, transcripts, logged, openReads, threadReads: () => threadReads, addsReads: () => addsReads, ops, live, edit, label, reader };
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
      ['a key no slice has built', [{ name: 'triage', when: { on: 'opened' }, model: 'x' }]],
      ['an empty checklist', [{ name: 'triage', when: { on: 'opened' }, checklist: ' ' }]],
      ['a conclusion GitHub does not use', [{ name: 'triage', when: { on: 'opened' }, conclusions: { passed: ['ok'] } }]],
      ['a conclusion that is not a list', [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: 'ok' } }]],
      ['an empty types', [{ name: 'triage', when: { on: 'opened' }, types: [] }]],
      ['a type with no label', [{ name: 'triage', when: { on: 'opened' }, types: [{ labels: [] }] }]],
      ['a type\'s unknown key', [{ name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'], when: {} }] }]],
      ['a type\'s conclusion GitHub does not use', [{ name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'], conclusions: { passed: ['ok'] } }] }]],
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

  test('conclusions names the labels each conclusion adds, each none where unset', () => {
    const read = file([{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['triaged'] } }]);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.ticketReviews?.[0]?.conclusions, { success: ['triaged'], failure: [], neutral: [] });
    const bare = file([{ name: 'triage', when: { on: 'opened' } }]);
    assert.ok(bare.ok);
    assert.deepEqual(bare.config.ticketReviews?.[0]?.conclusions, { success: [], failure: [], neutral: [] });
  });
});

describe('fitness: dispatcher-review.md, the config check warns of a ticket review trust.review never lets in', () => {
  const outsiders = ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE'];
  const checkOf = async (over: Record<string, unknown>) => {
    const text = JSON.stringify({ environment: 'env_1', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { ticketReviews: true }, ...over });
    assert.ok(readConfig(text).ok, 'governor reads the file');
    return check({ read: async (path: string) => (path === CONFIG_PATH ? text : null), paths: async () => ({ paths: [], truncated: false }), labels: async () => ['mode: afk', 'claimed'], issueBody: async () => null } as never);
  };
  const deadOnes = (warnings: string[]) => warnings.filter((w) => /trust\.review/.test(w));

  test('a review whose by shares nothing with the default trust.review warns, naming the review, its by and trust.review', async () => {
    const checked = await checkOf({ ticketReviews: [{ name: 'community', when: { on: 'opened', by: outsiders } }] });
    assert.deepEqual(checked.errors, []);
    const [warning, ...rest] = deadOnes(checked.warnings);
    assert.deepEqual(rest, []);
    assert.match(warning ?? '', /^ticketReviews\.community: /);
    assert.match(warning ?? '', /CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, NONE/);
    assert.match(warning ?? '', /trust\.review lets in OWNER, MEMBER, COLLABORATOR/);
  });

  test('a review left at its default by warns where trust.review lets in none of it', async () => {
    const checked = await checkOf({ trust: { review: ['CONTRIBUTOR'] }, ticketReviews: [{ name: 'triage', when: { on: 'opened' } }] });
    const [warning, ...rest] = deadOnes(checked.warnings);
    assert.deepEqual(rest, []);
    assert.match(warning ?? '', /^ticketReviews\.triage: /);
    assert.match(warning ?? '', /OWNER, MEMBER, COLLABORATOR/);
    assert.match(warning ?? '', /trust\.review lets in CONTRIBUTOR/);
  });

  test('a review sharing one value with trust.review, or one trust.review lets outsiders into, does not warn', async () => {
    assert.deepEqual(deadOnes((await checkOf({ ticketReviews: [{ name: 'triage', when: { on: 'opened' } }, { name: 'mixed', when: { on: 'opened', by: ['OWNER', ...outsiders] } }] })).warnings), []);
    const open = await checkOf({ trust: { review: ['OWNER', 'MEMBER', 'COLLABORATOR', ...outsiders] }, ticketReviews: [{ name: 'community', when: { on: 'opened', by: outsiders } }] });
    assert.deepEqual(deadOnes(open.warnings), []);
  });
});

describe('fitness: dispatcher-review.md and dispatcher-repos.md, the conclusions a config may name', () => {
  const base = { environment: 'env_1', labels: { ready: ['mode: afk', 'triaged'], claim: 'claimed' }, features: { ticketReviews: true } };
  const text = (over: Record<string, unknown>) => JSON.stringify({ ...base, ...over });
  const refused = async (over: Record<string, unknown>, ...words: RegExp[]) => {
    const read = readConfig(text(over));
    assert.equal(read.ok, false, 'governor\'s config read refuses it');
    const fault = read.ok ? '' : read.fault;
    for (const word of words) assert.match(fault, word);
    const checked = await check({ read: async (path: string) => (path === CONFIG_PATH ? text(over) : null), paths: async () => [] } as never);
    assert.equal(checked.errors.length, 1, 'the config check refuses it');
    for (const word of words) assert.match(checked.errors[0]!, word);
  };

  test('one label under two conclusions of one review is refused, naming the review and the label', async () => {
    await refused({ ticketReviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['triaged', 'seen'], neutral: ['seen'] } }] }, /triage/, /"seen"/);
  });

  test('one label in the conclusions of two reviews is refused, naming both reviews and the label', async () => {
    await refused({ ticketReviews: [
      { name: 'triage', when: { on: 'opened' }, conclusions: { success: ['triaged'], failure: ['looked at'] } },
      { name: 'community', when: { on: 'opened', by: ['NONE'] }, conclusions: { neutral: ['looked at'] } },
    ] }, /triage/, /community/, /"looked at"/);
  });

  test('a review whose by reaches beyond trust.auto and names a ready label in any conclusion is refused', async () => {
    const trust = { auto: ['OWNER'], task: ['OWNER', 'MEMBER', 'COLLABORATOR'] };
    await refused({ trust, ticketReviews: [{ name: 'triage', when: { on: 'opened', by: ['OWNER', 'COLLABORATOR'] }, conclusions: { success: ['triaged'] } }] }, /triage/, /"triaged"/, /COLLABORATOR/, /trust\.auto/);
    await refused({ trust, ticketReviews: [{ name: 'triage', when: { on: 'opened', by: ['OWNER', 'COLLABORATOR'] }, conclusions: { neutral: ['mode: afk'] } }] }, /"mode: afk"/);
    // The default by is owners, members and collaborators, past an auto of the owner alone.
    await refused({ trust, ticketReviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['triaged'] } }] }, /triage/, /MEMBER/);
  });

  test('a review open to outsiders reads trust.auto as narrowed, and an unset auto is the three with a say', async () => {
    await refused({ ticketReviews: [{ name: 'community', when: { on: 'opened', by: ['NONE', 'CONTRIBUTOR'] }, conclusions: { success: ['triaged'] } }] }, /community/, /NONE, CONTRIBUTOR/);
    // trust.relay narrows an unset auto as autoOf does.
    await refused({ trust: { relay: ['OWNER', 'BOT'] }, ticketReviews: [{ name: 'triage', when: { on: 'opened', by: ['OWNER', 'MEMBER'] }, conclusions: { success: ['triaged'] } }] }, /MEMBER/);
  });

  test('a review inside trust.auto may ready a ticket, and one beyond it may name labels that ready nothing', () => {
    const ok = (over: Record<string, unknown>) => { const read = readConfig(text(over)); assert.ok(read.ok, JSON.stringify(read)); };
    ok({ trust: { auto: ['OWNER'], task: ['OWNER', 'MEMBER', 'COLLABORATOR'] }, ticketReviews: [{ name: 'triage', when: { on: 'opened', by: ['OWNER'] }, conclusions: { success: ['triaged'] } }] });
    ok({ ticketReviews: [
      { name: 'triage', when: { on: 'opened' }, conclusions: { success: ['triaged'], failure: ['triage: needs edit'] } },
      { name: 'community', when: { on: 'opened', by: ['NONE'] }, conclusions: { success: ['community: reviewed'], failure: ['community: needs info'] } },
    ] });
  });

  test('labels are compared as GitHub compares them, ignoring case', async () => {
    // GitHub adds the repo's "mode: afk" for "MODE: AFK", so the outsider rule must see it as the ready label.
    await refused({ ticketReviews: [{ name: 'community', when: { on: 'opened', by: ['NONE'] }, conclusions: { success: ['MODE: AFK'] } }] }, /community/, /"MODE: AFK"/);
    await refused({ ticketReviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['Seen'], neutral: ['seen'] } }] }, /triage/, /"seen"/);
    await refused({ ticketReviews: [
      { name: 'triage', when: { on: 'opened' }, conclusions: { success: ['Looked at'] } },
      { name: 'community', when: { on: 'opened', by: ['NONE'] }, conclusions: { neutral: ['looked at'] } },
    ] }, /triage/, /community/, /"looked at"/);
  });

  test('the outsider rule reads only trust.auto, not trust.task', () => {
    // task wider than auto lets nobody new in: the rule is about what governor sets going by itself.
    const read = readConfig(text({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR'], task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'], relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'BOT'], review: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'BOT'] }, ticketReviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['triaged'] } }] }));
    assert.ok(read.ok, JSON.stringify(read));
  });

  test('the factory\'s review names labels for its conclusions', () => {
    const read = readConfig(factoryFile(CONFIG_PATH));
    assert.ok(read.ok);
    const [triage] = read.config.ticketReviews ?? [];
    for (const conclusion of ['success', 'failure', 'neutral'] as const) assert.ok((triage?.conclusions[conclusion] ?? []).length > 0, conclusion);
  });
});

describe('fitness: dispatcher-repos.md, a ticket review\'s checklists are prompt values read from the default branch', () => {
  const config = (ticketReviews: unknown) => {
    const read = readConfig(JSON.stringify({ environment: 'env_1', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { ticketReviews: true }, ticketReviews }));
    assert.ok(read.ok, JSON.stringify(read));
    return read.config;
  };
  const files = (texts: Record<string, string>) => async (path: string) => texts[path] ?? null;

  test('a checklist and each type\'s checklist, as text or as a file, are read into text', async () => {
    const file = config([{
      name: 'triage', when: { on: 'opened' }, checklist: { file: '.github/triage.md' },
      types: [{ labels: ['type: bug'], checklist: 'Bugs name their repro.' }, { labels: ['type: enhancement'], checklist: { file: '.github/enhancement.md' } }, { labels: ['type: chore'] }],
    }]);
    const resolved = await resolveFiles(file, files({ '.github/triage.md': '---\nname: triage\n---\n\n# Ours\n', '.github/enhancement.md': 'Enhancements name a user.' }));
    assert.ok(resolved.ok, JSON.stringify(resolved));
    const [triage] = resolved.config.ticketReviews ?? [];
    assert.equal(triage?.checklist, '# Ours');
    assert.deepEqual(triage?.types?.map((t) => t.checklist), ['Bugs name their repro.', 'Enhancements name a user.', undefined]);
  });

  test('a missing or empty checklist file makes the config invalid, naming the key and the path', async () => {
    const missing = await resolveFiles(config([{ name: 'triage', when: { on: 'opened' }, checklist: { file: '.github/gone.md' } }]), files({}));
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? '' : missing.fault, /ticketReviews\.triage\.checklist: \.github\/gone\.md is not on the default branch/);
    const empty = await resolveFiles(config([{ name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'] }, { labels: ['type: chore'], checklist: { file: '.github/chore.md' } }] }]), files({ '.github/chore.md': '---\nname: x\n---\n' }));
    assert.equal(empty.ok, false);
    assert.match(empty.ok ? '' : empty.fault, /ticketReviews\.triage\.types\.1\.checklist: \.github\/chore\.md is empty/);
  });

  test('the config check fails a missing checklist file as governor\'s read does', async () => {
    const text = JSON.stringify({ environment: 'env_1', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { ticketReviews: true }, ticketReviews: [{ name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'], checklist: { file: '.github/bug.md' } }] }] });
    const checked = await check({ read: async (path: string) => (path === CONFIG_PATH ? text : null), paths: async () => ({ paths: [], truncated: false }), labels: async () => ['mode: afk', 'claimed'], issueBody: async () => null } as never);
    assert.equal(checked.errors.length, 1);
    assert.match(checked.errors[0]!, /ticketReviews\.triage\.types\.0\.checklist: \.github\/bug\.md/);
  });

  test('the factory\'s review has a checklist file and a types entry, and both read', async () => {
    const read = readConfig(factoryFile(CONFIG_PATH));
    assert.ok(read.ok);
    const resolved = await resolveFiles(read.config, async (path) => { try { return factoryFile(path); } catch { return null; } });
    assert.ok(resolved.ok, JSON.stringify(resolved));
    const [triage] = resolved.config.ticketReviews ?? [];
    assert.ok((triage?.checklist ?? '').length > 0);
    assert.ok((triage?.types ?? []).length > 0);
    assert.ok((triage?.types ?? []).some((t) => (t.checklist ?? '').length > 0));
  });
});

describe('fitness: dispatcher-review.md and dispatcher-repos.md, the conclusions a types entry may name', () => {
  const base = { environment: 'env_1', labels: { ready: ['mode: afk', 'triaged'], claim: 'claimed' }, features: { ticketReviews: true } };
  const text = (over: Record<string, unknown>) => JSON.stringify({ ...base, ...over });
  const refused = async (over: Record<string, unknown>, ...words: RegExp[]) => {
    const read = readConfig(text(over));
    assert.equal(read.ok, false, 'governor\'s config read refuses it');
    const fault = read.ok ? '' : read.fault;
    for (const word of words) assert.match(fault, word);
    const checked = await check({ read: async (path: string) => (path === CONFIG_PATH ? text(over) : null), paths: async () => [] } as never);
    assert.equal(checked.errors.length, 1, 'the config check refuses it');
    for (const word of words) assert.match(checked.errors[0]!, word);
  };
  const ok = (over: Record<string, unknown>) => { const read = readConfig(text(over)); assert.ok(read.ok, JSON.stringify(read)); };

  test('one label under two conclusions of one review, across its default and its entries, is refused', async () => {
    await refused({ ticketReviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['seen'] }, types: [{ labels: ['type: bug'], conclusions: { failure: ['Seen'] } }] }] }, /triage/, /"Seen"/);
    await refused({ ticketReviews: [{ name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'], conclusions: { success: ['seen'] } }, { labels: ['type: chore'], conclusions: { neutral: ['seen'] } }] }] }, /triage/, /"seen"/);
  });

  test('the same label under the same conclusion in the default and an entry is allowed', () => {
    ok({ ticketReviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: { success: ['triaged'] }, types: [{ labels: ['type: bug'], conclusions: { success: ['triaged', 'mode: afk'] } }] }] });
  });

  test('one label in two reviews\' conclusions, where either names it in an entry, is refused', async () => {
    await refused({ ticketReviews: [
      { name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'], conclusions: { failure: ['looked at'] } }] },
      { name: 'community', when: { on: 'opened', by: ['NONE'] }, conclusions: { neutral: ['looked at'] } },
    ] }, /triage/, /community/, /"looked at"/);
  });

  test('a review whose by reaches beyond trust.auto and whose bug entry names a ready label is refused', async () => {
    await refused({ ticketReviews: [{ name: 'community', when: { on: 'opened', by: ['NONE'] }, conclusions: { success: ['community: reviewed'] }, types: [{ labels: ['type: bug'], conclusions: { success: ['mode: afk'] } }] }] }, /community/, /"mode: afk"/, /NONE/, /trust\.auto/, /ticketReviews\.0\.types\.0\.conclusions: the community review names the ready label/);
  });

  test('a conclusion that names a label a types entry matches on is refused, in the default or in an entry', async () => {
    await refused({ ticketReviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: { neutral: ['Type: Bug'] }, types: [{ labels: ['type: bug'] }] }] }, /triage/, /"Type: Bug"/, /type/);
    await refused({ ticketReviews: [{ name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'] }, { labels: ['type: chore'], conclusions: { failure: ['type: bug'] } }] }] }, /triage/, /"type: bug"/);
    // Another review's type label is a type too: applying it would change what that review reads.
    await refused({ ticketReviews: [
      { name: 'triage', when: { on: 'opened' }, types: [{ labels: ['type: bug'] }] },
      { name: 'scope', when: { on: 'opened' }, conclusions: { success: ['type: bug'] } },
    ] }, /scope/, /"type: bug"/);
  });
});

describe('fitness: dispatcher-review.md, a ticket review\'s checklists and labels per ticket type', () => {
  const BUG: TypeEntry = { labels: ['type: bug'], checklist: 'Bugs name their repro.', conclusions: { success: ['triaged', 'mode: afk'] } };
  const SMALL: TypeEntry = { labels: ['size: small', 'size: tiny'], checklist: 'Small tickets name one file.', conclusions: { neutral: ['small: needs a person'], success: ['small: passed'] } };
  const review = (over: Partial<Review> = {}): Review => ({ name: 'triage', when: { on: 'opened' }, conclusions: TRIAGE, ...over });
  const asTicket = (labels: string[]) => ticketRow({ labels });

  test('a review\'s own checklist replaces the default, after governor\'s frame', async () => {
    const h = harness({ reviews: [review({ checklist: '# Ours\n\nCheck one thing.' })] });
    await h.review();
    assert.equal(h.runs[0]!.system, `${TICKET_FRAME}\n\n# Ours\n\nCheck one thing.`);
    assert.ok(!h.runs[0]!.system.includes(DEFAULT_TICKET_CHECKLIST));
  });

  test('a ticket matching two entries gets both checklists after the base, in file order; one matching none gets the base alone', () => {
    const r = review({ checklist: 'Base.', types: [SMALL, BUG] }) as never;
    assert.equal(checklistFor(r, asTicket(['Type: Bug', 'size: tiny'])), 'Base.\n\nSmall tickets name one file.\n\nBugs name their repro.');
    assert.equal(checklistFor(r, asTicket(['type: enhancement'])), 'Base.');
    assert.equal(checklistFor(review({ types: [BUG] }) as never, asTicket(['type: bug'])), `${DEFAULT_TICKET_CHECKLIST}\n\nBugs name their repro.`);
    assert.equal(checklistFor(review({ types: [{ labels: ['type: bug'] }] }) as never, asTicket(['type: bug'])), DEFAULT_TICKET_CHECKLIST);
  });

  test('the run reads the ticket\'s checklists, and a ticket with no type label is reviewed, not failed for lacking one', async () => {
    const h = harness({ reviews: [review({ types: [BUG] })], ticket: { labels: [] } });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'commented');
    assert.equal(h.runs[0]!.system, `${TICKET_FRAME}\n\n${DEFAULT_TICKET_CHECKLIST}`);
    const bug = harness({ reviews: [review({ types: [BUG] })] });
    await bug.review();
    assert.equal(bug.runs[0]!.system, `${TICKET_FRAME}\n\n${DEFAULT_TICKET_CHECKLIST}\n\nBugs name their repro.`);
  });

  test('for each conclusion, the labels come from the first matching entry that names it, and otherwise from the default', () => {
    const r = review({ types: [SMALL, BUG, { labels: ['type: bug'], conclusions: { success: ['never'], failure: ['bug: needs repro'] } }] }) as never;
    assert.deepEqual(conclusionsFor(r, asTicket(['type: bug', 'size: small'])), { success: ['small: passed'], failure: ['bug: needs repro'], neutral: ['small: needs a person'] });
    assert.deepEqual(conclusionsFor(r, asTicket(['type: bug'])), { success: ['triaged', 'mode: afk'], failure: ['bug: needs repro'], neutral: TRIAGE.neutral });
    assert.deepEqual(conclusionsFor(r, asTicket([])), { success: TRIAGE.success, failure: TRIAGE.failure, neutral: TRIAGE.neutral });
  });

  test('a bug\'s success adds mode: afk, and a success on an enhancement never removes it', async () => {
    const repoLabels = ['type: bug', 'type: enhancement', 'mode: afk', 'triaged', 'triage: needs edit'];
    const bug = harness({ reviews: [review({ types: [BUG] })], ticket: { labels: ['type: bug'] }, repoLabels });
    await bug.review();
    assert.deepEqual(bug.live.labels, ['type: bug', 'triaged', 'mode: afk']);
    const enhancement = harness({ reviews: [review({ types: [BUG] })], ticket: { labels: ['type: enhancement', 'mode: afk'] }, repoLabels });
    await enhancement.review();
    assert.deepEqual(enhancement.ops, ['add triaged', 'comment passes']);
    assert.deepEqual(enhancement.live.labels, ['type: enhancement', 'mode: afk', 'triaged']);
  });

  test('a failure takes off a label an entry\'s success named, even where the ticket\'s type has changed since', async () => {
    const h = harness({ reviews: [review({ types: [BUG] })], answers: [GAPS], ticket: { labels: ['type: enhancement', 'triaged', 'mode: afk'] }, repoLabels: ['type: enhancement', 'triaged', 'mode: afk', 'triage: needs edit'] });
    await h.review();
    assert.deepEqual(h.ops, ['remove triaged', 'remove mode: afk', 'add triage: needs edit', 'comment waits for an edit']);
  });

  test('with types, adding or removing a label an entry names changes the key; with no types the key is the body\'s digest', () => {
    const r = review({ types: [BUG, SMALL] }) as never;
    const key = keyFor(r, asTicket(['type: bug']));
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(key, KEY);
    assert.equal(keyFor(r, asTicket(['Type: Bug', 'anything'])), key, 'a label no entry names, and case, leave it');
    assert.notEqual(keyFor(r, asTicket(['type: bug', 'size: tiny'])), key);
    assert.notEqual(keyFor(r, asTicket([])), key);
    assert.equal(keyFor(r, asTicket(['size: tiny', 'type: bug'])), keyFor(r, asTicket(['type: bug', 'size: tiny'])), 'sorted');
    assert.equal(keyFor(review() as never, asTicket(['type: bug', 'size: tiny'])), KEY);
  });

  test('a ticket whose type label changes is reviewed again, and one whose other labels change is not', async () => {
    const h = harness({ reviews: [review({ types: [BUG] })], live: true });
    await h.review();
    h.edit({ labels: [...h.live.labels, 'anything'] });
    await h.review();
    assert.equal(h.runs.length, 1);
    h.edit({ labels: h.live.labels.filter((l) => l !== 'type: bug').concat('type: enhancement') });
    await h.review();
    assert.equal(h.runs.length, 2);
  });

  test('the marker carries the key with the ticket\'s type', async () => {
    const h = harness({ reviews: [review({ types: [BUG] })] });
    await h.review();
    assert.ok(h.comments[0]!.body.endsWith(ticketMarker('triage', 'success', keyFor(review({ types: [BUG] }) as never, ticketRow()))));
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

  test('labels and exclude match the ticket\'s labels in any case, as GitHub does', async () => {
    const excluded = harness({ ticket: { labels: ['workflow: under development'] }, reviews: [{ name: 'exclude', when: { on: 'opened', exclude: ['Workflow: Under Development'] } }] });
    const skipped = (await excluded.review()).reviews[0]!;
    assert.equal(skipped.outcome, 'skipped');
    assert.deepEqual(excluded.comments, []);
    assert.deepEqual(excluded.runs, []);
    const required = harness({ ticket: { labels: ['Type: Bug'] }, reviews: [{ name: 'labels', when: { on: 'opened', labels: ['type: bug'] } }] });
    assert.equal((await required.review()).reviews[0]!.outcome, 'commented');
    assert.equal(required.comments.length, 1);
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
  test('governor\'s frame and the default checklist are the system prompt, the answer held to the schema', async () => {
    const h = harness();
    await h.review();
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

describe('fitness: dispatcher-review.md, the loop guard stops a review that keeps failing', () => {
  /** The review's markers on the thread, oldest first, one comment each. */
  const rounds = (...conclusions: string[]) => conclusions.map((c, i) => posted('triage', c, `a${i}`, true, i + 1));
  const guard = (name = 'triage', ours = true, id = 99): Thread => ({ id, body: `Stopped.\n\n${loopMarker(name)}`, created_at: '2026-11-02T00:00:00Z', ours });
  const fails = (n: number) => rounds(...Array.from({ length: n }, () => 'failure'));
  const guards = (h: ReturnType<typeof harness>) => h.comments.filter((c) => c.body.includes('governor:ticket-review-loop'));

  test('the limit is five, and the guard\'s marker names the review', () => {
    assert.equal(LOOP_LIMIT, 5);
    assert.equal(loopMarker('triage'), '<!-- governor:ticket-review-loop triage -->');
  });

  test('at the fifth failure in a row, governor posts one guard comment ending in its marker, and logs at error', async () => {
    const h = harness({ thread: fails(4), answers: [GAPS] });
    const result = await h.review();
    assert.deepEqual(result.reviews.map((r) => [r.name, r.outcome, r.conclusion]), [['triage', 'commented', 'failure']]);
    assert.equal(h.comments.length, 2);
    assert.match(h.comments[0]!.body, /^Triage review: waits for an edit\./);
    const [stop] = guards(h);
    assert.ok(stop!.body.endsWith(loopMarker('triage')), stop!.body);
    assert.match(stop!.body, /^Triage review: stopped on this ticket after 5 failures in a row\./);
    assert.match(stop!.body, /person decides/);
    assert.match(stop!.body, /Deleting this comment/);
    const line = h.logged.find((l) => l.event === 'dispatch-ticket-review-loop');
    assert.deepEqual(line, { event: 'dispatch-ticket-review-loop', level: 'error', repo: REPO, issue: 501, review: 'triage', count: 5 });
    assert.equal(exitCodeFor({ kind: 'ticketReview', reviews: result.reviews } as never), 0);
  });

  test('the fourth failure in a row, or a fifth run that does not fail, posts no guard', async () => {
    for (const [thread, answer] of [[fails(3), GAPS], [fails(4), PASSES], [fails(4), { conclusion: 'neutral', text: 'It repeats #502.' }]] as const) {
      const h = harness({ thread, answers: [answer] });
      await h.review();
      assert.deepEqual(guards(h), []);
      assert.equal(h.logged.some((l) => l.event === 'dispatch-ticket-review-loop'), false);
    }
  });

  test('a success or neutral between failures starts the count again', async () => {
    for (const between of ['success', 'neutral']) {
      const h = harness({ thread: rounds('failure', 'failure', between, 'failure', 'failure', 'failure'), answers: [GAPS] });
      await h.review();
      assert.deepEqual(guards(h), [], between);
    }
    const h = harness({ thread: rounds('failure', 'failure', 'success', 'failure', 'failure', 'failure', 'failure'), answers: [GAPS] });
    await h.review();
    assert.equal(guards(h).length, 1);
  });

  test('another review\'s failures do not count toward this one\'s', async () => {
    const thread = [...fails(2), ...[3, 4, 5].map((id) => posted('other', 'failure', `b${id}`, true, id))];
    const h = harness({ thread, answers: [GAPS] });
    await h.review();
    assert.deepEqual(guards(h), []);
  });

  test('with the guard on the thread, later edits do not run that review, and other reviews on the ticket still run', async () => {
    const h = harness({ thread: [...fails(5), guard()], reviews: [{ name: 'triage', when: { on: 'opened' } }, { name: 'second', when: { on: 'opened' } }], answers: [PASSES] });
    const result = await h.review();
    assert.deepEqual(result.reviews.map((r) => [r.name, r.outcome]), [['triage', 'skipped'], ['second', 'commented']]);
    assert.match(String(result.reviews[0]!.reason), /loop guard/);
    assert.equal(h.runs.length, 1);
    assert.match(h.comments[0]!.body, /^Second review/);
    const line = h.logged.find((l) => l.event === 'dispatch-ticket-review' && l.review === 'triage');
    assert.equal(line?.level, 'info');
    assert.equal(line?.outcome, 'skipped');
  });

  test('a guard for another review does not stop this one', async () => {
    const h = harness({ thread: [guard('other')] });
    await h.review();
    assert.equal(h.runs.length, 1);
  });

  test('after the guard is deleted, the review runs at the next edit, and the guard comes back only at the tenth failure in a row', async () => {
    const sixth = harness({ thread: fails(5), answers: [GAPS] });
    await sixth.review();
    assert.equal(sixth.runs.length, 1);
    assert.deepEqual(guards(sixth), []);
    for (const n of [6, 7, 8]) {
      const h = harness({ thread: fails(n), answers: [GAPS] });
      await h.review();
      assert.deepEqual(guards(h), [], `failure ${n + 1}`);
    }
    const tenth = harness({ thread: fails(9), answers: [GAPS] });
    await tenth.review();
    assert.equal(guards(tenth).length, 1);
    assert.match(guards(tenth)[0]!.body, /after 10 failures in a row/);
    assert.equal(tenth.logged.find((l) => l.event === 'dispatch-ticket-review-loop')?.count, 10);
  });

  test('a guard marker in a comment governor\'s App did not post, or one quoted mid-comment, stops nothing', async () => {
    const quoted: Thread = { id: 98, body: `It said ${loopMarker('triage')} here.\n\nMore text.`, created_at: '2026-11-02T00:00:00Z', ours: true };
    for (const row of [guard('triage', false), quoted]) {
      const h = harness({ thread: [...fails(5), row] });
      await h.review();
      assert.equal(h.runs.length, 1, row.body);
    }
  });

  test('the guard\'s marker is never read as a review\'s, so it spends no round', async () => {
    const h = harness({ thread: [posted('triage', 'failure', 'a'), guard('other')] });
    await h.review();
    assert.match(h.runs[0]!.prompt, /This is round 2 of this review\./);
    const named = harness({ thread: [guard('triage-loop')], reviews: [{ name: 'triage-loop', when: { on: 'opened' } }, { name: 'triage', when: { on: 'opened' } }] });
    const result = await named.review();
    assert.deepEqual(result.reviews.map((r) => r.outcome), ['skipped', 'commented']);
    assert.match(named.runs[0]!.prompt, /This is round 1 of this review\./);
  });

  test('a refused guard comment leaves the review standing, logs at error, and makes the turn exit 1', async () => {
    let calls = 0;
    const h = harness({ thread: fails(4), answers: [GAPS], comment: async () => { calls += 1; if (calls === 2) throw Object.assign(new Error('POST failed: 403'), { status: 403 }); } });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'commented');
    assert.equal(result.reviews[0]!.conclusion, 'failure');
    assert.equal(h.comments.length, 1);
    const line = h.logged.find((l) => l.event === 'dispatch-ticket-review-loop');
    assert.equal(line?.level, 'error');
    assert.match(String(line?.error), /403/);
    assert.equal(exitCodeFor({ kind: 'ticketReview', reviews: result.reviews } as never), 1);
  });
});

describe('fitness: dispatcher-review.md, a conclusion applies the labels the repo names', () => {
  const triage = (when: Review['when'] = { on: 'opened' }): Review => ({ name: 'triage', when, conclusions: TRIAGE });

  test('a run removes the labels the other two conclusions name, then adds its own, then posts its comment, and touches no other label', async () => {
    const h = harness({ reviews: [triage()], ticket: { labels: ['type: bug', 'mode: afk', 'triage: needs edit', 'triage: needs a person', 'anything else'] }, repoLabels: ['type: bug', 'mode: afk', 'triaged', 'triage: needs edit', 'triage: needs a person', 'anything else'] });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'commented');
    assert.deepEqual(h.ops, ['remove triage: needs edit', 'remove triage: needs a person', 'add triaged', 'comment passes']);
    assert.deepEqual(h.live.labels, ['type: bug', 'mode: afk', 'anything else', 'triaged']);
  });

  test('a label the ticket lacks is not removed, and one it carries is not added again', async () => {
    const h = harness({ reviews: [triage()], answers: [GAPS], ticket: { labels: ['type: bug', 'triage: needs edit'] }, repoLabels: ['type: bug', 'triage: needs edit'] });
    await h.review();
    assert.deepEqual(h.ops, ['comment waits for an edit']);
  });

  test('each conclusion adds its own labels', async () => {
    for (const [answer, added] of [[PASSES, 'triaged'], [GAPS, 'triage: needs edit'], [{ conclusion: 'neutral', text: 'It builds a non-goal.' }, 'triage: needs a person']] as const) {
      const h = harness({ reviews: [triage()], answers: [answer] });
      await h.review();
      assert.ok(h.live.labels.includes(added), `${answer.conclusion} adds ${added}`);
    }
  });

  test('a ticket that fails, then passes after an edit, carries the success labels and none of the failure labels', async () => {
    const h = harness({ reviews: [triage()], answers: [GAPS, PASSES], live: true });
    await h.review();
    assert.deepEqual(h.live.labels, ['type: bug', 'triage: needs edit']);
    h.edit({ body: `${BODY}\n\nNow with what done looks like.` });
    await h.review();
    assert.deepEqual(h.live.labels, ['type: bug', 'triaged']);
    assert.equal(h.runs.length, 2);
  });

  test('a label the repo lacks is created before it is added', async () => {
    const h = harness({ reviews: [triage()], repoLabels: ['type: bug'] });
    await h.review();
    assert.deepEqual(h.ops, ['create triaged', 'add triaged', 'comment passes']);
  });

  test('a label the ticket carries in another case is the same label: it is removed by the name it carries, and not added again', async () => {
    const h = harness({ reviews: [triage()], answers: [GAPS], ticket: { labels: ['type: bug', 'Triaged', 'Triage: Needs Edit'] }, repoLabels: ['type: bug', 'Triaged', 'Triage: Needs Edit'] });
    await h.review();
    assert.deepEqual(h.ops, ['remove Triaged', 'comment waits for an edit']);
  });

  test('a label governor creates carries a description GitHub accepts, at most 100 characters, whatever the review\'s name', async () => {
    const descriptions: string[] = [];
    const name = 'a'.repeat(64);
    const h = harness({ reviews: [{ name, when: { on: 'opened' }, conclusions: TRIAGE }], repoLabels: ['type: bug'] });
    const ensure = h.reader.ensureLabel;
    h.reader.ensureLabel = async (label: string, description?: string) => { descriptions.push(String(description)); await ensure(label); };
    await h.review();
    assert.equal(descriptions.length, 1);
    assert.ok(descriptions[0]!.length <= 100, `${descriptions[0]!.length} characters`);
  });

  test('a review that names no labels writes none', async () => {
    const h = harness({ reviews: [{ name: 'triage', when: { on: 'opened' } }], answers: [GAPS] });
    await h.review();
    assert.deepEqual(h.ops, ['comment waits for an edit']);
  });

  test('a label already gone when it is removed counts as removed', async () => {
    const h = harness({ reviews: [triage()], ticket: { labels: ['type: bug', 'triage: needs edit'] }, labelWrite: (op) => { if (op === 'remove') throw Object.assign(new Error('DELETE failed: 404'), { status: 404 }); } });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'commented');
    assert.deepEqual(h.ops, ['create triaged', 'add triaged', 'comment passes']);
  });

  for (const refused of ['remove', 'ensure', 'add']) {
    test(`a label ${refused} GitHub refuses posts no comment, logs at error, lets the other reviews run, exits 1, and the next edit runs the review again`, async () => {
      let refuse = true;
      const h = harness({
        reviews: [triage(), { name: 'scope', when: { on: 'opened' } }],
        ticket: { labels: ['type: bug', 'triage: needs edit'] },
        repoLabels: ['type: bug', 'triage: needs edit'],
        live: true,
        labelWrite: (op) => { if (refuse && op === refused) throw Object.assign(new Error(`${op} failed: 403`), { status: 403 }); },
      });
      const result = await h.review();
      assert.deepEqual(result.reviews.map((r) => [r.name, r.outcome]), [['triage', 'failed'], ['scope', 'commented']]);
      assert.match(String(result.reviews[0]!.error), /403/);
      assert.deepEqual(h.comments.map((c) => c.body.split(' review:')[0]), ['Scope']);
      const line = h.logged.find((l) => l.event === 'dispatch-ticket-review' && l.review === 'triage');
      assert.equal(line?.level, 'error');
      assert.equal(exitCodeFor({ kind: 'ticketReview', reviews: result.reviews } as never), 1);
      refuse = false;
      h.edit({ body: `${BODY}\n\nEdited.` });
      const again = await h.review();
      assert.deepEqual(again.reviews.map((r) => [r.name, r.outcome]), [['triage', 'commented'], ['scope', 'commented']]);
      assert.ok(h.live.labels.includes('triaged'));
      assert.ok(!h.live.labels.includes('triage: needs edit'));
    });
  }

  test('an add GitHub refuses after a removal went through does not say no label changed', async () => {
    const h = harness({
      reviews: [triage()], answers: [PASSES], live: true,
      ticket: { labels: ['type: bug', 'triage: needs edit'] },
      labelWrite: (op) => { if (op === 'add') throw Object.assign(new Error('add failed: 403'), { status: 403 }); },
    });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'failed');
    assert.ok(!h.live.labels.includes('triage: needs edit'), 'the removal went through');
    assert.match(String(result.reviews[0]!.error), /refused to add "triaged"/);
    assert.doesNotMatch(String(result.reviews[0]!.error), /no label changed/);
  });

  test('a refused write never leaves an earlier success label under a later failure unsaid', async () => {
    const h = harness({ reviews: [triage()], answers: [GAPS], ticket: { labels: ['type: bug', 'triaged'] }, labelWrite: (op) => { if (op === 'remove') throw Object.assign(new Error('DELETE failed: 403'), { status: 403 }); } });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'failed');
    assert.ok(h.live.labels.includes('triaged'));
    assert.ok(h.logged.some((l) => l.event === 'dispatch-ticket-review' && l.level === 'error' && /triaged/.test(String(l.error))));
  });

  test('the loop guard still comes after the review\'s comment, at the fifth failure in a row', async () => {
    const thread = [1, 2, 3, 4].map((i) => posted('triage', 'failure', `${i}`.repeat(8), true, i));
    const h = harness({ reviews: [triage()], answers: [GAPS], thread, ticket: { labels: ['type: bug', 'triage: needs edit'] }, repoLabels: ['type: bug', 'triage: needs edit'] });
    await h.review();
    assert.deepEqual(h.ops, ['comment waits for an edit', 'comment stopped on this ticket after 5 failures in a row']);
    const fresh = harness({ reviews: [triage()], answers: [GAPS], thread, ticket: { labels: ['type: bug', 'triaged'] } });
    await fresh.review();
    assert.deepEqual(fresh.ops, ['remove triaged', 'create triage: needs edit', 'add triage: needs edit', 'comment waits for an edit', 'comment stopped on this ticket after 5 failures in a row']);
  });

  test('a ready label from the review\'s success gates pickup: the next sweep selects a ticket the review passed, and not after a later failure', async () => {
    const LABELS = { ready: ['mode: afk', 'triaged'], claim: 'claimed', exclude: ['type: prd'] };
    const h = harness({ reviews: [triage()], answers: [PASSES, GAPS], ticket: { labels: ['type: bug', 'mode: afk'] }, live: true });
    const sweep = () => planSchedule({
      sources: [{
        repo: REPO,
        labels: LABELS,
        reader: {
          readyIssues: async () => [{ number: 501, title: 'Spend the retry budget once', state: 'open', created_at: '2026-10-01T00:00:00Z', labels: [...h.live.labels], association: 'MEMBER' }],
          blockers: async () => [],
          blocking: async () => [],
          comments: async () => [],
        },
      }],
      cap: 1,
      now: Date.parse('2026-11-04T12:00:00Z'),
    } as never);
    assert.deepEqual(await sweep(), [], 'not ready before the review has passed it');
    const passed = await h.review();
    assert.deepEqual(Object.keys(passed), ['reviews'], 'the review queues no pickup fire');
    assert.deepEqual((await sweep()).map((d) => d.issue), [501]);
    h.edit({ body: `${BODY}\n\nEdited.` });
    await h.review();
    assert.deepEqual(await sweep(), []);
  });

  test('a member\'s hold label stays on a success, though the review\'s neutral names it', async () => {
    const HOLD: Conclusions = { success: ['triaged'], failure: ['triage: needs edit'], neutral: ['mode: human'] };
    const h = harness({ reviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: HOLD }], answers: [PASSES], ticket: { labels: ['type: bug', 'mode: afk'] }, live: true });
    h.label('mode: human');
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'commented');
    assert.ok(h.live.labels.includes('mode: human'), 'a person\'s hold stays');
    assert.deepEqual(h.ops, ['create triaged', 'add triaged', 'comment passes']);
    assert.ok(h.logged.some((l) => l.event === 'dispatch-ticket-review-labels' && Array.isArray(l.kept) && (l.kept as string[]).includes('mode: human')));
  });

  test('a neutral label governor\'s App added comes off on a later success', async () => {
    const HOLD: Conclusions = { success: ['triaged'], failure: ['triage: needs edit'], neutral: ['mode: human'] };
    const h = harness({ reviews: [{ name: 'triage', when: { on: 'opened' }, conclusions: HOLD }], answers: [{ conclusion: 'neutral', text: 'It builds a non-goal.' }, PASSES], live: true });
    await h.review();
    assert.ok(h.live.labels.includes('mode: human'));
    h.edit({ body: `${BODY}\n\nNo longer a non-goal.` });
    await h.review();
    assert.deepEqual(h.live.labels, ['type: bug', 'triaged']);
  });

  test('a label governor added and a person added again after is the person\'s, and stays; one only a person added stays in any case', async () => {
    const h = harness({ reviews: [triage()], answers: [PASSES], ticket: { labels: ['type: bug', 'triage: needs edit', 'Triage: Needs A Person'] }, adders: { 'Triage: Needs A Person': 'a-member' } });
    // GitHub records no `labeled` event for a label the ticket still
    // carries, so the person takes it off before adding it again.
    h.edit({ labels: ['type: bug', 'Triage: Needs A Person'] });
    h.label('triage: needs edit');
    await h.review();
    assert.deepEqual(h.live.labels, ['type: bug', 'Triage: Needs A Person', 'triage: needs edit', 'triaged']);
  });

  test('a label no labeled event names is not governor\'s, and stays', async () => {
    const h = harness({ reviews: [triage()], answers: [PASSES], ticket: { labels: ['type: bug', 'triage: needs edit'] } });
    h.reader.labelAdds = async () => [];
    await h.review();
    assert.ok(h.live.labels.includes('triage: needs edit'));
  });

  test('a run whose read of the label events fails changes no label, logs at error, posts no comment, and the next edit runs it again', async () => {
    let refuse = true;
    const h = harness({
      reviews: [triage()], answers: [PASSES], live: true,
      ticket: { labels: ['type: bug', 'triage: needs edit'] },
      addsRead: () => { if (refuse) throw Object.assign(new Error('GET /events failed: 502'), { status: 502 }); },
    });
    const result = await h.review();
    assert.equal(result.reviews[0]!.outcome, 'failed');
    assert.deepEqual(h.ops, []);
    assert.deepEqual(h.comments, []);
    const line = h.logged.find((l) => l.event === 'dispatch-ticket-review' && l.review === 'triage');
    assert.equal(line?.level, 'error');
    assert.match(String(line?.error), /502/);
    assert.equal(exitCodeFor({ kind: 'ticketReview', reviews: result.reviews } as never), 1);
    refuse = false;
    h.edit({ body: `${BODY}\n\nEdited.` });
    const again = await h.review();
    assert.equal(again.reviews[0]!.outcome, 'commented');
    assert.deepEqual(h.live.labels, ['type: bug', 'triaged']);
  });

  test('the label events are not read where the ticket carries nothing to take off', async () => {
    const h = harness({ reviews: [triage()], answers: [PASSES] });
    await h.review();
    assert.equal(h.addsReads(), 0);
  });

  test('the ticket review shares no code with pickup', () => {
    const closure = [...importClosure(ROOT, 'dispatch/ticket-review.mjs')];
    const pickup = ['scripts/lib/ready-work.mjs', 'scripts/lib/dispatch-router.mjs', 'dispatch/pickup.mjs', 'dispatch/launch-plan.mjs'];
    assert.deepEqual(closure.filter((path) => pickup.includes(path)), []);
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
    const added: string[] = [];
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
        ensureLabel: async () => {},
        addLabels: async (_n: number, labels: string[]) => { added.push(...labels); },
        removeLabel: async () => {},
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
    return { result: result as unknown as { kind: string, refusal?: string, reviews?: Array<{ outcome: string }> }, comments, runs, added };
  };

  test('with the switch on, the fixture\'s review labels the ticket through the GitHub reader and comments on it', async () => {
    const { result, comments, added } = await turn(factoryFile(CONFIG_PATH));
    assert.equal(result.kind, 'ticketReview');
    const triage = (readConfig(factoryFile(CONFIG_PATH)) as { config: { ticketReviews: Array<{ conclusions: { success: string[] } }> } }).config.ticketReviews[0]!;
    assert.deepEqual(added, triage.conclusions.success);
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
