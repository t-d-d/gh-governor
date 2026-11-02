/**
 * Waits under the `waits` switch: the receiver queues a `wait` fire for an
 * issue opened or edited with a `Blocked until:` line, judged from the
 * payload alone; the fire needs `waits`, so the receiver drops it in a repo
 * with the switch off; and the state table keeps one item per waiting
 * ticket, `wait#<repo>` / `<issue>`, which the bare schedule fire reads.
 *
 * What a turn does with the fire and the items is test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { build, parseFire, waitLine } from '../dispatch/webhook/fire.mjs';
import { droppedBy, switchOf } from '../dispatch/webhook/switches.mjs';
import { GENERIC_SWITCHES, configSchema } from '../dispatch/repo-config.mjs';
import { waitOf } from '../scripts/lib/ready-work.mjs';
import { dynamoState } from '../dispatch/turn.mjs';
import { githubReader } from '../scripts/lib/github-app.mjs';
import { PROMPTS } from '../dispatch/prompts.mjs';
import { WAIT_ENDED_MARKER, WAIT_PROMPT, endedWaits, holdWait, waitEndedComment, waitEndedMarker, waitSpecPrompt } from '../dispatch/waits.mjs';

const REPO = 'acme/factory';
const OWNERS = ['acme'];

const issuesEvent = (action: string, body: string | null, over: Record<string, unknown> = {}) => ({
  action,
  issue: { number: 717, title: 'An issue', labels: [], html_url: `https://github.com/${REPO}/issues/717`, body, user: { login: 't-d-d', type: 'User' }, author_association: 'OWNER', assignees: [] },
  sender: { login: 't-d-d', type: 'User' },
  repository: { full_name: REPO },
  ...over,
});

/** The `wait` fires a delivery queues. */
const waits = (payload: unknown) => routeEvent({ event: 'issues', payload, owners: OWNERS }).fires.filter((f) => f.fire.kind === 'wait');

describe('the receiver: an issue opened or edited with a `Blocked until:` line', () => {
  test('an issue opened with the line queues one wait fire naming it', () => {
    const queued = waits(issuesEvent('opened', 'Blocked until: 2026-11-05\n\nThe rest.'));
    assert.deepEqual(queued.map((q) => q.fire), [{ kind: 'wait', issue: 717, repo: REPO }]);
    assert.equal(queued[0]?.key, 'wait', 'keyed apart from the delivery\'s other fires');
  });

  test('the line is the first non-empty line, in any case, whatever value it holds', () => {
    assert.equal(waits(issuesEvent('opened', '\n\n  blocked UNTIL: next week')).length, 1);
    assert.equal(waits(issuesEvent('opened', 'Blocked until: 2026-13-01')).length, 1, 'an unreadable line is the turn\'s to report');
    assert.equal(waits(issuesEvent('opened', 'The body.\nBlocked until: 2026-11-05')).length, 0, 'not the first line');
    assert.equal(waits(issuesEvent('opened', 'Body.')).length, 0);
    assert.equal(waits(issuesEvent('opened', null)).length, 0);
  });

  test('an issue opened with the line still counts for the periodics, on a fire of its own', () => {
    const { fires } = routeEvent({ event: 'issues', payload: issuesEvent('opened', 'Blocked until: 2026-11-05'), owners: OWNERS });
    assert.deepEqual(fires.map((f) => [f.fire.kind, (f.fire as { counted?: string }).counted]), [['periodics', 'issuesOpened'], ['wait', undefined]]);
  });

  test('an edit whose new or old body holds the line queues one; an edit not touching the body queues none', () => {
    const edited = (body: string, from: string | undefined) => issuesEvent('edited', body, from === undefined ? { changes: { title: { from: 'Old' } } } : { changes: { body: { from } } });
    assert.equal(waits(edited('Blocked until: 2026-11-05', 'Body.')).length, 1, 'the line added');
    assert.equal(waits(edited('Body.', 'Blocked until: 2026-11-05')).length, 1, 'the line taken off');
    assert.equal(waits(edited('Blocked until: 2026-11-09', 'Blocked until: 2026-11-05')).length, 1, 'the date moved');
    assert.equal(waits(edited('Body, longer.', 'Body.')).length, 0, 'neither body holds the line');
    assert.equal(waits(edited('Blocked until: 2026-11-05', undefined)).length, 0, 'only the title changed');
  });

  test('an issue reopened with the line queues one: its item went when it closed', () => {
    assert.equal(waits(issuesEvent('reopened', 'Blocked until: 2026-11-05')).length, 1);
    assert.equal(waits(issuesEvent('reopened', 'Body.')).length, 0);
  });

  test('another repo\'s delivery, a close or a label queues none', () => {
    assert.equal(waits(issuesEvent('opened', 'Blocked until: 2026-11-05', { repository: { full_name: 'someone/else' } })).length, 0);
    assert.equal(waits(issuesEvent('closed', 'Blocked until: 2026-11-05')).length, 0);
    assert.equal(waits(issuesEvent('labeled', 'Blocked until: 2026-11-05', { label: { name: 'mode: afk' } })).length, 0);
  });

  test('the receiver\'s test of the line is the reader\'s', () => {
    for (const body of ['Blocked until: 2026-11-05', ' \nblocked until:2026-11-05 for the logs', 'Blocked until:', 'Blocked until: soon', 'Body.\nBlocked until: 2026-11-05', '', 'Blocked untl: 2026-11-05']) {
      assert.equal(waitLine(body) !== null, waitOf(body).wait !== undefined, JSON.stringify(body));
    }
  });
});

describe('the wait fire', () => {
  test('builds and parses back, and needs a positive issue and its repo', () => {
    const fire = { ...build.wait({ issue: 717 }), repo: REPO };
    assert.deepEqual(parseFire(fire), fire);
    assert.throws(() => parseFire({ kind: 'wait', issue: 0, repo: REPO }), /issue/);
    assert.throws(() => parseFire({ kind: 'wait', repo: REPO }), /issue/);
    assert.throws(() => parseFire({ kind: 'wait', issue: 7 }), /names its repo/);
  });

  test('needs the waits switch, and the receiver drops it where the repo\'s item says waits is off', () => {
    const fire = { ...build.wait({ issue: 717 }), repo: REPO };
    assert.equal(switchOf(fire), 'waits');
    const item = (on: boolean) => new Map(GENERIC_SWITCHES.map((name) => [name, name === 'waits' ? on : true]));
    assert.deepEqual(droppedBy(fire, item(false)), ['waits']);
    assert.equal(droppedBy(fire, item(true)), null);
    assert.equal(droppedBy(fire, null), null);
  });
});

describe('the waits switch', () => {
  test('is a generic switch, off unless the file turns it on', () => {
    assert.ok(GENERIC_SWITCHES.includes('waits'));
    const base = { environment: 'env_x', labels: { ready: ['ready'], claim: 'claimed' } };
    assert.equal(configSchema.parse({ ...base, features: {} }).features.waits, undefined);
    assert.equal(configSchema.parse({ ...base, features: { waits: true } }).features.waits, true);
  });

  test('the spec session after a wait is a prompt kind a repo can replace', () => {
    assert.deepEqual(PROMPTS.waitEndedSpec?.fills, ['issue', 'ready', 'claim']);
  });
});

describe('what governor says when a wait ends', () => {
  test('the comment names the date, and carries a marker of that date', () => {
    const body = waitEndedComment('2026-11-05');
    assert.ok(body.includes(waitEndedMarker('2026-11-05')));
    assert.ok(waitEndedMarker('2026-11-05').startsWith(WAIT_ENDED_MARKER));
    assert.equal(waitEndedMarker('2026-11-05'), '<!-- governor:wait-ended 2026-11-05 -->');
    assert.match(body, /2026-11-05/);
    assert.match(body, /not ready/);
  });

  test('the spec prompt names the ticket and the date, and asks what unblockedSpec asks', () => {
    const prompt = waitSpecPrompt({ issue: 7, title: 'Read the logs', until: '2026-11-05', labels: { ready: ['ready', 'mode: afk'], claim: 'claimed' }, prompts: {} });
    assert.match(prompt, /^Spec #7 'Read the logs'\n/);
    assert.match(prompt, /`Blocked until:` line named 2026-11-05/);
    assert.match(prompt, /`ready` and `mode: afk`/);
    assert.match(prompt, /`claimed`/);
    assert.doesNotMatch(prompt, /blocker closed|merged/);
    const replaced = waitSpecPrompt({ issue: 7, title: 'Read the logs', until: '2026-11-05', labels: { ready: ['ready'], claim: 'claimed' }, prompts: { waitEndedSpec: 'Look again at #{issue}.' } });
    assert.match(replaced, /Look again at #7\./);
    assert.match(replaced, /2026-11-05/, 'the facts stay governor\'s');
  });

  test('the prompt line says how to make a ticket wait', () => {
    assert.match(WAIT_PROMPT, /`Blocked until: YYYY-MM-DD`/);
  });
});

describe('realDeps: a ticket\'s wait item', () => {
  type Sent = { name: string; input: Record<string, any> };
  const conditional = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

  test('a repo\'s waits are one query of its key, read consistently, over every page', async () => {
    const sent: Sent[] = [];
    const pages = [
      { Items: [{ pk: { S: 'wait#acme/factory' }, sk: { S: '7' }, until: { S: '2026-11-05' } }], LastEvaluatedKey: { pk: { S: 'wait#acme/factory' }, sk: { S: '7' } } },
      { Items: [{ pk: { S: 'wait#acme/factory' }, sk: { S: '9' }, until: { S: '2026-12-01' } }] },
    ];
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, any> }) => { sent.push({ name: command.constructor.name, input: command.input }); return pages[sent.length - 1]; } };
    const state = dynamoState(client as never, 'T');
    assert.deepEqual(await state.waits('Acme/Factory'), [{ issue: 7, until: '2026-11-05' }, { issue: 9, until: '2026-12-01' }]);
    assert.deepEqual(sent.map((s) => s.name), ['QueryCommand', 'QueryCommand']);
    assert.equal(sent[0]?.input.ConsistentRead, true);
    assert.deepEqual(sent[0]?.input.ExpressionAttributeValues, { ':pk': { S: 'wait#acme/factory' } });
    assert.deepEqual(sent[1]?.input.ExclusiveStartKey, pages[0]?.LastEvaluatedKey);
  });

  test('a malformed item is a failed read, never a missing one', async () => {
    const state = dynamoState({ send: async () => ({ Items: [{ pk: { S: 'wait#acme/factory' }, sk: { S: '7' }, until: { S: 'soon' } }] }) } as never, 'T');
    await assert.rejects(state.waits(REPO), /malformed/);
    const one = dynamoState({ send: async () => ({ Item: { pk: { S: 'wait#acme/factory' }, sk: { S: '7' } } }) } as never, 'T');
    await assert.rejects(one.wait(REPO, 7), /malformed/);
    const failing = dynamoState({ send: async () => { throw new Error('AccessDeniedException'); } } as never, 'T');
    await assert.rejects(failing.waits(REPO), /AccessDeniedException/);
  });

  test('one ticket\'s item is read by its repo and number; a missing one is null', async () => {
    const sent: Sent[] = [];
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, any> }) => { sent.push({ name: command.constructor.name, input: command.input }); return command.input.Key.sk.S === '7' ? { Item: { ...command.input.Key, until: { S: '2026-11-05' } } } : {}; } };
    const state = dynamoState(client as never, 'T');
    assert.deepEqual(await state.wait(REPO, 7), { until: '2026-11-05' });
    assert.equal(await state.wait(REPO, 9), null);
    assert.equal(sent[0]?.name, 'GetItemCommand');
    assert.equal(sent[0]?.input.ConsistentRead, true);
    assert.deepEqual(sent[0]?.input.Key, { pk: { S: 'wait#acme/factory' }, sk: { S: '7' } });
  });

  test('a put goes only where none stands, or over the date the turn read, and expires a month after its date', async () => {
    const sent: Sent[] = [];
    let refuse = false;
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, any> }) => { sent.push({ name: command.constructor.name, input: command.input }); if (refuse) throw conditional(); return {}; } };
    const state = dynamoState(client as never, 'T');
    assert.equal(await state.recordWait(REPO, 7, null, '2026-11-05'), true);
    assert.equal(sent[0]?.name, 'PutItemCommand');
    assert.deepEqual(sent[0]?.input.Item.until, { S: '2026-11-05' });
    assert.equal(sent[0]?.input.Item.ttl.N, String(Date.parse('2026-12-05T00:00:00Z') / 1000));
    assert.match(String(sent[0]?.input.ConditionExpression), /attribute_not_exists/);
    assert.equal(await state.recordWait(REPO, 7, '2026-11-05', '2026-11-09'), true);
    assert.match(String(sent[1]?.input.ConditionExpression), /#until = :read/);
    assert.deepEqual(sent[1]?.input.ExpressionAttributeValues, { ':read': { S: '2026-11-05' } });
    refuse = true;
    assert.equal(await state.recordWait(REPO, 7, '2026-11-05', '2026-11-09'), false);
  });

  test('a delete goes only over the date the turn read', async () => {
    const sent: Sent[] = [];
    let refuse = false;
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, any> }) => { sent.push({ name: command.constructor.name, input: command.input }); if (refuse) throw conditional(); return {}; } };
    const state = dynamoState(client as never, 'T');
    assert.equal(await state.dropWait(REPO, 7, '2026-11-05'), true);
    assert.equal(sent[0]?.name, 'DeleteItemCommand');
    assert.deepEqual(sent[0]?.input.Key, { pk: { S: 'wait#acme/factory' }, sk: { S: '7' } });
    assert.match(String(sent[0]?.input.ConditionExpression), /#until = :read/);
    refuse = true;
    assert.equal(await state.dropWait(REPO, 7, '2026-11-05'), false);
    const failing = dynamoState({ send: async () => { throw new Error('AccessDeniedException'); } } as never, 'T');
    await assert.rejects(failing.dropWait(REPO, 7, '2026-11-05'), /AccessDeniedException/);
  });
});

describe('a waiting ticket that is gone or moved', () => {
  const LABELS = { ready: ['mode: afk'], claim: 'claimed', claimRemoves: [], exclude: [] };
  const NOW = Date.parse('2026-11-06T01:00:00Z');
  const gone = (status: number) => Object.assign(new Error(`GitHub answered ${status}`), { status });
  /** A state holding issue 7's item, and the deletes asked of it. */
  const stateWith = () => {
    const dropped: Array<[string, number, string]> = [];
    return {
      dropped,
      state: {
        waits: async () => [{ issue: 7, until: '2026-11-05' }],
        wait: async () => ({ until: '2026-11-05' }),
        recordWait: async () => true,
        dropWait: async (repo: string, issue: number, read: string) => { dropped.push([repo, issue, read]); return true; },
      },
    };
  };
  /** A reader whose ticket read is `ticket`, and the comments it was asked to post. */
  const readerWith = (ticket: () => Promise<unknown>) => {
    const comments: Array<[number, string]> = [];
    return {
      comments,
      reader: {
        ticket: ticket as never,
        blockers: async () => [],
        allComments: async () => [],
        comment: async (n: number, body: string) => { comments.push([n, body]); },
      },
    };
  };

  for (const status of [404, 410]) {
    test(`the schedule fire drops the item of a ticket that answers ${status}, and fails nothing`, async () => {
      const { state, dropped } = stateWith();
      const { reader, comments } = readerWith(async () => { throw gone(status); });
      const ended = await endedWaits({ reader, state, repo: REPO, labels: LABELS, spec: true, now: NOW, log: () => {} });
      assert.deepEqual(ended, { specs: [], unread: [] });
      assert.deepEqual(dropped, [[REPO, 7, '2026-11-05']]);
      assert.deepEqual(comments, []);
    });
  }

  test('the schedule fire drops the item of a ticket moved to another repo, and says nothing on the issue it moved to', async () => {
    const { state, dropped } = stateWith();
    const { reader, comments } = readerWith(async () => ({ number: 41, title: 'Moved', state: 'open', labels: [], wait: { until: '2026-11-05' } }));
    const ended = await endedWaits({ reader, state, repo: REPO, labels: LABELS, spec: true, now: NOW, log: () => {} });
    assert.deepEqual(ended, { specs: [], unread: [] });
    assert.deepEqual(dropped, [[REPO, 7, '2026-11-05']]);
    assert.deepEqual(comments, []);
  });

  test('a wait fire for a ticket that is gone drops its item, and does not throw', async () => {
    const { state, dropped } = stateWith();
    const { reader } = readerWith(async () => { throw gone(410); });
    assert.equal(await holdWait({ reader, state, repo: REPO, issue: 7, labels: LABELS, now: NOW, log: () => {} }), 'dropped');
    assert.deepEqual(dropped, [[REPO, 7, '2026-11-05']]);
  });
});

describe('the reader: a ticket\'s link to the wait ticket', () => {
  /** A fetch answering `status` to every call, and the calls it saw. */
  const fakeFetch = (status: number, body: unknown = {}) => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? 'GET', path: new URL(url).pathname, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    return { seen, fetch: fetch as unknown as typeof globalThis.fetch };
  };
  const sleep = async () => {};

  test('a link names its blocker by id, under the ticket\'s blocked_by list', async () => {
    const { seen, fetch } = fakeFetch(201);
    await githubReader({ token: 't', repo: REPO, fetch, sleep }).addBlocker(7, 9413);
    assert.deepEqual(seen, [{ method: 'POST', path: `/repos/${REPO}/issues/7/dependencies/blocked_by`, body: { issue_id: 9413 } }]);
  });

  test('a removal names its blocker by id, and a link already gone is no failure', async () => {
    const { seen, fetch } = fakeFetch(204);
    await githubReader({ token: 't', repo: REPO, fetch, sleep }).removeBlocker(7, 9413);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), [`DELETE /repos/${REPO}/issues/7/dependencies/blocked_by/9413`]);
    await githubReader({ token: 't', repo: REPO, fetch: fakeFetch(404, { message: 'Not Found' }).fetch, sleep }).removeBlocker(7, 9413);
    await assert.rejects(githubReader({ token: 't', repo: REPO, fetch: fakeFetch(422, { message: 'Validation Failed' }).fetch, sleep }).removeBlocker(7, 9413), /422/);
  });

  test('a blocker row and a ticket carry their ids', async () => {
    const rows = await githubReader({ token: 't', repo: REPO, fetch: fakeFetch(200, [{ id: 9413, number: 413, state: 'open', title: 'Waits' }]).fetch, sleep }).blockers(7);
    assert.deepEqual(rows, [{ number: 413, state: 'open', title: 'Waits', id: 9413 }]);
    const ticket = await githubReader({ token: 't', repo: REPO, fetch: fakeFetch(200, { id: 9413, number: 413, state: 'open', title: 'Waits', body: '', labels: [] }).fetch, sleep }).ticket(413);
    assert.equal(ticket.id, 9413);
  });
});

describe('the config file\'s wait ticket', () => {
  const file = (waits: unknown) => ({ environment: 'env_01FACTORY', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { waits: true }, workflows: {}, waits });

  test('`waits: { issue }` names the wait ticket, and anything else there is a fault', () => {
    assert.equal(configSchema.safeParse(file({ issue: 413 })).success, true);
    for (const bad of [{}, { issue: 0 }, { issue: 'one' }, { issue: 413, issues: [414] }]) {
      assert.equal(configSchema.safeParse(file(bad)).success, false, JSON.stringify(bad));
    }
  });

  test('the section is optional', () => {
    const { waits: _, ...without } = file(undefined);
    assert.equal(configSchema.safeParse(without).success, true);
  });
});
