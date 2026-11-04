/**
 * `trust.start`: who may set work going, by readying a ticket or writing a
 * summons. A ready label counts only when its latest add was by someone in
 * `start`, or by governor's own App (`startRefused`,
 * scripts/lib/ready-work.mjs). At the default `start` nothing is looked up;
 * a narrowed one looks each adder up (`startKinds`, dispatch/start.mjs).
 * What each path does with the answer is test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readsAdders, startRefused, uncountedReady } from '../scripts/lib/ready-work.mjs';
import { judgeReady, startKinds } from '../dispatch/start.mjs';

const READY = ['workflow: ready for development', 'mode: afk'];
const THREE = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const OWNER_ONLY = ['OWNER'];
const by = (actor: string, extra: { bot?: boolean, ours?: boolean } = {}) => READY.map((label) => ({ label, actor, bot: false, ours: false, ...extra }));
const owners = { author: 'acme', association: 'OWNER' };
const strangers = { author: 'stranger', association: 'NONE' };

describe('readsAdders: whether a ticket\'s label events are read', () => {
  test('at the default start, only for a ticket whose author has no say, as before', () => {
    for (const association of THREE) assert.equal(readsAdders({ association }, THREE), false, association);
    for (const association of ['NONE', 'CONTRIBUTOR']) assert.equal(readsAdders({ association }, THREE), true, association);
    assert.equal(readsAdders({}, THREE), true, 'an association not read is no say');
  });

  test('for every ticket once start is narrowed', () => {
    for (const association of [...THREE, 'NONE']) assert.equal(readsAdders({ association }, OWNER_ONLY), true, association);
  });
});

describe('startRefused: the ready labels whose latest add was by no one in start', () => {
  test('at the default start it is the rule #392 shipped, on a stranger\'s ticket', () => {
    assert.deepEqual(startRefused(strangers, by('triager'), READY, THREE), []);
    assert.deepEqual(startRefused(strangers, by('stranger'), READY, THREE).map((r) => r.why), ['template', 'template']);
    assert.deepEqual(startRefused(strangers, by('github-actions[bot]', { bot: true }), READY, THREE).map((r) => r.why), ['bot', 'bot']);
    assert.deepEqual(startRefused(strangers, [], READY, THREE).map((r) => r.why), ['unknown', 'unknown']);
    assert.deepEqual(startRefused(strangers, [...by('stranger'), ...by('governor[bot]', { bot: true, ours: true })], READY, THREE), [], 'governor\'s own App counts');
  });

  test('uncountedReady still answers as before', () => {
    assert.deepEqual(uncountedReady(strangers, by('stranger'), READY), READY);
    assert.deepEqual(uncountedReady(strangers, by('triager'), READY), []);
    assert.deepEqual(uncountedReady(owners, by('stranger'), READY), []);
  });

  test('narrowed, a person other than the author is judged by what the lookup says', () => {
    const kinds = new Map([['acme', 'OWNER'], ['pat', 'COLLABORATOR']]);
    const kindOf = (login: string) => kinds.get(login.toLowerCase()) ?? null;
    assert.deepEqual(startRefused(strangers, by('acme'), READY, OWNER_ONLY, kindOf), []);
    assert.deepEqual(startRefused(strangers, by('ACME'), READY, OWNER_ONLY, kindOf), [], 'logins compare in any case');
    assert.deepEqual(startRefused(owners, by('pat'), READY, OWNER_ONLY, kindOf), READY.map((label) => ({ label, actor: 'pat', bot: false, why: 'outside', kind: 'COLLABORATOR' })));
    assert.deepEqual(startRefused(owners, by('ghost'), READY, OWNER_ONLY, kindOf).map((r) => r.why), ['unread', 'unread'], 'a failed lookup counts for nothing');
  });

  test('narrowed, the author is judged by the association on the issue, and nothing is looked up for them', () => {
    const kindOf = () => { throw new Error('looked up'); };
    assert.deepEqual(startRefused(owners, by('acme'), READY, OWNER_ONLY, kindOf), []);
    const member = { author: 'mel', association: 'MEMBER' };
    assert.deepEqual(startRefused(member, by('mel'), READY, OWNER_ONLY, kindOf).map((r) => r.why), ['outside', 'outside']);
    assert.deepEqual(startRefused(strangers, by('stranger'), READY, OWNER_ONLY, kindOf).map((r) => r.why), ['template', 'template'], 'a stranger\'s own template stays a template');
  });

  test('narrowed, a bot is never in start, on anyone\'s ticket, but governor\'s own App is', () => {
    const kindOf = () => 'OWNER';
    assert.deepEqual(startRefused(owners, by('github-actions[bot]', { bot: true }), READY, OWNER_ONLY, kindOf).map((r) => r.why), ['bot', 'bot']);
    assert.deepEqual(startRefused(owners, by('labeller[bot]'), READY, OWNER_ONLY, kindOf).map((r) => r.why), ['bot', 'bot'], 'a [bot] login is a bot whatever the row says');
    assert.deepEqual(startRefused(owners, by('governor[bot]', { bot: true, ours: true }), READY, OWNER_ONLY, kindOf), []);
  });
});

/** A reader that answers the two lookups, counting each read. */
const lookups = (type: string | Error, outside: string[] | Error = []) => {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      repoOwnerType: async () => { asked.push('owner'); if (type instanceof Error) throw type; return type; },
      outsideCollaborators: async () => { asked.push('outside'); if (outside instanceof Error) throw outside; return outside; },
    },
  };
};

describe('startKinds: who an adder is, where start is narrowed', () => {
  test('the repo owner\'s login is OWNER, with nothing read', async () => {
    const { reader, asked } = lookups('User');
    const { kinds } = await startKinds({ reader, repo: 'acme/factory', logins: ['Acme'] });
    assert.equal(kinds.get('acme'), 'OWNER');
    assert.deepEqual(asked, []);
  });

  test('on a user\'s repo anyone else who can add a label is a COLLABORATOR', async () => {
    const { reader, asked } = lookups('User');
    const { kinds } = await startKinds({ reader, repo: 'acme/factory', logins: ['pat'] });
    assert.equal(kinds.get('pat'), 'COLLABORATOR');
    assert.deepEqual(asked, ['owner']);
  });

  test('on an org\'s repo the outside-collaborator list tells COLLABORATOR from MEMBER', async () => {
    const { reader } = lookups('Organization', ['Pat']);
    const { kinds } = await startKinds({ reader, repo: 'acme/factory', logins: ['pat', 'mel'] });
    assert.equal(kinds.get('pat'), 'COLLABORATOR');
    assert.equal(kinds.get('mel'), 'MEMBER');
  });

  test('a lookup that fails leaves every adder but the owner unknown, and says why', async () => {
    for (const reader of [lookups(new Error('HTTP 502')).reader, lookups('Organization', new Error('HTTP 403')).reader]) {
      const { kinds, error } = await startKinds({ reader, repo: 'acme/factory', logins: ['acme', 'pat'] });
      assert.equal(kinds.get('acme'), 'OWNER');
      assert.equal(kinds.has('pat'), false);
      assert.match(String(error), /HTTP (502|403)/);
    }
  });
});

describe('judgeReady: whether a ticket\'s ready labels count, read once for the selection and the claim', () => {
  const reader = (adds: ReturnType<typeof by>, type: string | Error = 'User') => {
    const { reader: looked, asked } = lookups(type);
    let reads = 0;
    return { asked, reads: () => reads, reader: { ...looked, labelAdds: async () => { reads += 1; return adds; } } };
  };
  const ticket = (who: { author: string, association: string }) => ({ number: 9, ...who });

  test('at the default start an owner\'s ticket counts, its events unread and no one looked up', async () => {
    const r = reader(by('github-actions[bot]', { bot: true }));
    assert.deepEqual(await judgeReady({ reader: r.reader, repo: 'acme/factory', ticket: ticket(owners), ready: READY, start: THREE }), { counts: true });
    assert.equal(r.reads(), 0);
    assert.deepEqual(r.asked, []);
  });

  test('at the default start a stranger\'s ticket a triager readied counts, with no one looked up', async () => {
    const r = reader(by('triager'));
    assert.deepEqual(await judgeReady({ reader: r.reader, repo: 'acme/factory', ticket: ticket(strangers), ready: READY, start: THREE }), { counts: true });
    assert.deepEqual(r.asked, []);
  });

  test('a template, a bot or no event is an outsider, for the warn line', async () => {
    for (const adds of [by('stranger'), by('github-actions[bot]', { bot: true }), []]) {
      const judged = await judgeReady({ reader: reader(adds).reader, repo: 'acme/factory', ticket: ticket(strangers), ready: READY, start: THREE });
      assert.ok('outsider' in judged, JSON.stringify(judged));
      assert.deepEqual(judged.outsider.labels, READY);
    }
    const judged = await judgeReady({ reader: reader(by('github-actions[bot]', { bot: true })).reader, repo: 'acme/factory', ticket: ticket(owners), ready: READY, start: OWNER_ONLY });
    assert.ok('outsider' in judged, 'narrowed, a bot on an owner\'s ticket is one too');
  });

  test('narrowed, a collaborator\'s label is a person outside start, for the info line', async () => {
    const judged = await judgeReady({ reader: reader(by('pat')).reader, repo: 'acme/factory', ticket: ticket(owners), ready: READY, start: OWNER_ONLY });
    assert.deepEqual(judged, { counts: false, unstarted: { repo: 'acme/factory', issue: 9, start: OWNER_ONLY, by: READY.map((label) => ({ label, actor: 'pat', kind: 'COLLABORATOR' })) } });
  });

  test('narrowed, the owner\'s label counts: a session acts through the owner\'s account', async () => {
    const r = reader(by('acme'));
    assert.deepEqual(await judgeReady({ reader: r.reader, repo: 'acme/factory', ticket: ticket({ author: 'pat', association: 'COLLABORATOR' }), ready: READY, start: OWNER_ONLY }), { counts: true });
    assert.deepEqual(r.asked, []);
  });

  test('narrowed, a lookup that fails counts the label for nothing, and says why', async () => {
    const judged = await judgeReady({ reader: reader(by('pat'), new Error('HTTP 502')).reader, repo: 'acme/factory', ticket: ticket(owners), ready: READY, start: OWNER_ONLY });
    assert.ok('unread' in judged, JSON.stringify(judged));
    assert.match(judged.unread.error, /HTTP 502/);
    assert.deepEqual(judged.unread.logins, ['pat']);
  });
});
