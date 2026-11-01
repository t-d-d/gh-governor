/**
 * Hooks: an outside system fires a session in a served repo by posting
 * signed text to the receiver (dispatch/webhook/hook.mjs, route.mjs). The
 * key is derived from one stack secret, so governor stores no key and no
 * request carries one; the signature covers a timestamp and the raw body,
 * so a stranger's post and a stale replay both get 401, and the queue's
 * deduplication drops a replay inside its window.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { HOOK_CLOCK_AHEAD_MS, HOOK_CLOCK_BEHIND_MS, HOOK_DEDUP_WINDOW_MS, HOOK_TEXT_LIMIT, hookKey, hookPath, hookSignature, readSignature } from '../dispatch/webhook/hook.mjs';
import { handle } from '../dispatch/webhook/route.mjs';
import { hookTable, type Counted } from '../dispatch/webhook/hook-table.mjs';
import { HOOK_KEY_STALE } from '../dispatch/hooks.mjs';
import { HOOK_PER_HOUR_MAX, FIRE_BUDGET, fireWeight, parseFire } from '../dispatch/webhook/fire.mjs';
import { configSchema, readConfig, resolveFiles, switchOf } from '../dispatch/repo-config.mjs';
import { CONFIG_PATH } from '../dispatch/repo-config.mjs';
import { factoryFile } from './helpers/factory.ts';

const HOOK_SECRET = 'hook-secret-test';
const REPO = 'acme/factory';
const HOOK = 'operator-prod';
const NOW = Date.parse('2026-09-21T12:00:00Z');
const T = Math.floor(NOW / 1000);

const keyOf = (repo = REPO, hook = HOOK, version = 1) => hookKey(HOOK_SECRET, repo, hook, version);

const harness = (over: Record<string, unknown> = {}) => {
  const queued: Array<{ message: Record<string, unknown>, dedupId?: string }> = [];
  const logged: Array<Record<string, unknown>> = [];
  const deps = {
    secret: async () => 'whsec_test',
    hookSecret: async () => HOOK_SECRET,
    owners: ['acme'],
    selectLabels: [],
    appId: 5075844,
    now: () => NOW,
    // The hook table's item for the repo: none unless a test says otherwise.
    listedHooks: async (_repo: string): Promise<ReadonlyMap<string, { keyVersion: number, perHour: number }> | null> => null,
    // The hour's count: always under the cap unless a test says otherwise.
    countFire: async (_repo: string, _hook: string, _at: number, _cap: number, _signature: string): Promise<Counted> => 'counted',
    enqueue: async (message: Record<string, unknown>, dedupId?: string) => {
      queued.push({ message, ...(dedupId === undefined ? {} : { dedupId }) });
      return `m-${queued.length}`;
    },
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    ...over,
  };
  return { deps, queued, logged };
};

/** A hook request, signed with the key for `repo`, `hook` and `version` unless a header is given. */
const fire = (body: string, { repo = REPO, hook = HOOK, version = 1, t = T, header }: { repo?: string, hook?: string, version?: number, t?: number, header?: string | null } = {}) => ({
  path: `/hooks/${repo}/${hook}`,
  headers: header === null ? {} : { 'Governor-Signature': header ?? hookSignature({ key: keyOf(repo, hook, version), version, t, body }) },
  body,
  isBase64Encoded: false,
});

const TEXT = JSON.stringify({ text: 'ALARM: api 5xx' });

describe('the hook key and signature', () => {
  // A caller in another repo checks its own code against these numbers.
  test('one known answer: the key, and the header over a body', () => {
    const key = hookKey('hook-secret-fake', 'acme/factory', 'operator-prod', 1);
    assert.equal(key, '205f2b1fcecbb68c2b36ae4e97e3bfc952512a0e2d0edfd7911ea3b61ef8d9b0');
    assert.equal(
      hookSignature({ key, version: 1, t: 1790000000, body: '{"text":"ALARM: api 5xx"}' }),
      'v=1,t=1790000000,sha256=c1e2dcef847df26ed853c9e8d28795ab208bc950307acd3248c7eaa1c88180ee',
    );
  });

  test('the key is the HMAC of <owner>/<repo>|<hook>|v<version> under the secret, and the signature is keyed with its hex digits as text', () => {
    const key = createHmac('sha256', HOOK_SECRET).update(`${REPO}|${HOOK}|v3`).digest('hex');
    assert.equal(hookKey(HOOK_SECRET, REPO, HOOK, 3), key);
    const hex = createHmac('sha256', key).update(`${T}.${TEXT}`).digest('hex');
    assert.equal(hookSignature({ key, version: 3, t: T, body: TEXT }), `v=3,t=${T},sha256=${hex}`);
  });

  test('each repo, hook and version has its own key', () => {
    const keys = new Set([keyOf(), keyOf('acme/other'), keyOf(REPO, 'operator-dev'), keyOf(REPO, HOOK, 2)]);
    assert.equal(keys.size, 4);
  });

  test('reads only a header of the exact shape', () => {
    const hex = 'a'.repeat(64);
    assert.deepEqual(readSignature(`v=2,t=${T},sha256=${hex}`), { version: 2, t: T, hex });
    for (const bad of [undefined, '', `t=${T},v=2,sha256=${hex}`, `v=0,t=${T},sha256=${hex}`, `v=2,t=${T},sha256=${hex.slice(1)}`, `v=2,t=${T},sha256=${hex.toUpperCase()}`, `v=2,t=x,sha256=${hex}`, `v=2,t=${T},sha256=${hex} `]) {
      assert.equal(readSignature(bad), null, String(bad));
    }
  });

  test('a hook path names the repo and the hook; any other path is not a hook\'s', () => {
    assert.deepEqual(hookPath('/hooks/acme/factory/operator-prod'), { repo: REPO, hook: HOOK });
    assert.equal(hookPath('/'), undefined);
    assert.equal(hookPath(undefined), undefined);
    assert.equal(hookPath('/github'), undefined);
    for (const bad of ['/hooks/', '/hooks/acme/factory', '/hooks/acme/factory/Operator', '/hooks/acme/factory/op_prod', '/hooks/acme/factory/op/extra', '/hooks/ac me/factory/op']) {
      assert.equal(hookPath(bad), null, bad);
    }
  });
});

describe('handle — a hook fire', () => {
  test('a valid request gets 202 and queues one hook fire naming the repo, the hook, the key version and the text, deduplicated by its signature', async () => {
    const { deps, queued, logged } = harness();
    const request = fire(TEXT);
    const response = await handle(request, deps);
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]!.message.fire, { kind: 'hook', hook: HOOK, keyVersion: 1, text: 'ALARM: api 5xx', at: new Date(NOW).toISOString(), repo: REPO });
    assert.equal(queued[0]!.dedupId, readSignature(request.headers['Governor-Signature'])!.hex);
    assert.deepEqual(parseFire(queued[0]!.message.fire), queued[0]!.message.fire, 'the task reads back what the receiver queued');
    assert.ok(logged.some((l) => l.event === 'webhook-queued' && l.kind === 'hook'));
  });

  test('the same request twice queues under the same deduplication id, so the queue drops the replay', async () => {
    const { deps, queued } = harness();
    const request = fire(TEXT);
    await handle(request, deps);
    await handle(request, deps);
    assert.equal(queued[0]!.dedupId, queued[1]!.dedupId);
  });

  test('a missing or malformed header, a bad signature, or another hook\'s key gets 401 and queues nothing', async () => {
    const otherKey = hookSignature({ key: keyOf(REPO, 'operator-dev'), version: 1, t: T, body: TEXT });
    const wrongVersion = hookSignature({ key: keyOf(REPO, HOOK, 1), version: 2, t: T, body: TEXT });
    for (const header of [null, 'nonsense', `v=1,t=${T},sha256=${'0'.repeat(64)}`, otherKey, wrongVersion]) {
      const { deps, queued } = harness();
      const response = await handle(fire(TEXT, { header }), deps);
      assert.equal(response.statusCode, 401, String(header));
      assert.equal(queued.length, 0);
    }
  });

  test('a signature over other bytes gets 401', async () => {
    const { deps, queued } = harness();
    const signed = fire(TEXT);
    const response = await handle({ ...signed, body: JSON.stringify({ text: 'ALARM: something else' }) }, deps);
    assert.equal(response.statusCode, 401);
    assert.equal(queued.length, 0);
  });

  test('a timestamp more than 30 seconds ahead of the receiver\'s clock, or more than 4 minutes 25 seconds behind it, gets 401; one inside is taken', async () => {
    for (const [t, status] of [[T + 31, 401], [T + 29, 202], [T + 30, 202], [T - 264, 202], [T - 265, 202], [T - 266, 401]] as const) {
      const { deps, queued } = harness();
      const response = await handle(fire(TEXT, { t }), deps);
      assert.equal(response.statusCode, status, `t ${t - T}`);
      assert.equal(queued.length, status === 202 ? 1 : 0);
    }
  });

  // A valid request can be replayed for as long as it stays valid, which is
  // the sum of the two limits. The queue drops a duplicate only inside its
  // deduplication window, which runs from the first send, not from the clock
  // check. A replay that takes longer than the first request to reach the
  // queue could land after the queue has forgotten the first send and start
  // a second session, so the sum stays a margin under the window.
  const DEDUP_MARGIN_MS = 5 * 1000;
  test('the clock limits ahead and behind add up to at least 5 seconds under the queue\'s deduplication window', () => {
    assert.equal(HOOK_DEDUP_WINDOW_MS, 5 * 60 * 1000, 'an SQS FIFO queue deduplicates for five minutes');
    assert.equal(HOOK_CLOCK_AHEAD_MS, 30 * 1000);
    assert.equal(HOOK_CLOCK_BEHIND_MS, 265 * 1000);
    assert.ok(HOOK_CLOCK_AHEAD_MS + HOOK_CLOCK_BEHIND_MS <= HOOK_DEDUP_WINDOW_MS - DEDUP_MARGIN_MS, `${HOOK_CLOCK_AHEAD_MS} + ${HOOK_CLOCK_BEHIND_MS} leaves less than ${DEDUP_MARGIN_MS} under ${HOOK_DEDUP_WINDOW_MS}`);
  });

  test('never logs the signature or the key', async () => {
    const { deps, logged } = harness();
    const good = fire(TEXT);
    await handle(good, deps);
    await handle(fire(TEXT, { header: `v=1,t=${T},sha256=${'1'.repeat(64)}` }), deps);
    await handle(fire(TEXT, { t: T - 3600 }), deps);
    const text = JSON.stringify(logged);
    assert.ok(!text.includes(readSignature(good.headers['Governor-Signature'])!.hex), text);
    assert.ok(!text.includes('1'.repeat(64)), text);
    assert.ok(!text.includes(keyOf()), text);
    assert.ok(!text.includes(HOOK_SECRET), text);
    assert.ok(logged.some((l) => l.event === 'hook-refused'), text);
  });

  test('a valid request for an owner not on the list gets 200, queues nothing, and logs at info', async () => {
    const { deps, queued, logged } = harness();
    const response = await handle(fire(TEXT, { repo: 'stranger/repo' }), deps);
    assert.equal(response.statusCode, 200);
    assert.equal(queued.length, 0);
    const line = logged.find((l) => l.event === 'hook-ignored');
    assert.equal(line?.level, 'info');
    assert.ok(!logged.some((l) => l.level === 'error' || l.level === 'warn'));
  });

  test('a body that is not JSON, or has no string text, gets 400 and queues nothing', async () => {
    for (const body of ['not json', '[]', '{}', '{"text":5}', '{"text":"   "}', 'null']) {
      const { deps, queued, logged } = harness();
      const response = await handle(fire(body), deps);
      assert.equal(response.statusCode, 400, body);
      assert.equal(queued.length, 0);
      assert.equal(logged.find((l) => l.event === 'hook-refused')?.status, 400, 'the operator can see why a signed request went nowhere');
    }
  });

  test('text over 32 KiB gets 413 and queues nothing', async () => {
    assert.equal(HOOK_TEXT_LIMIT, 32 * 1024);
    const { deps, queued } = harness();
    const response = await handle(fire(JSON.stringify({ text: 'x'.repeat(HOOK_TEXT_LIMIT + 1) })), deps);
    assert.equal(response.statusCode, 413);
    assert.equal(queued.length, 0);
  });

  // The fire rides to the task as a lane message. Any text under the
  // limit fits it, quotes escaped twice over included, so no hook fire is
  // refused at the queue, where no caller hears.
  test('any text under the limit fits on the lane, and is queued', async () => {
    const at = new Date(NOW).toISOString();
    const text = '"'.repeat(HOOK_TEXT_LIMIT);
    assert.ok(fireWeight({ kind: 'hook', hook: HOOK, keyVersion: 1, text, at, repo: REPO }) <= FIRE_BUDGET);
    const { deps, queued } = harness();
    assert.equal((await handle(fire(JSON.stringify({ text })), deps)).statusCode, 202);
    assert.equal(queued.length, 1);
  });

  test('a path under /hooks/ that names no repo and hook gets 404; every other path is a GitHub delivery', async () => {
    const { deps, queued } = harness();
    assert.equal((await handle({ ...fire(TEXT), path: '/hooks/acme/factory' }, deps)).statusCode, 404);
    // A GitHub delivery on the root path, unsigned: GitHub's refusal, as before.
    const github = await handle({ path: '/', headers: {}, body: '{}', isBase64Encoded: false }, deps);
    assert.deepEqual(github, { statusCode: 401, body: 'signature does not match' });
    const none = await handle({ headers: {}, body: '{}', isBase64Encoded: false }, deps);
    assert.equal(none.statusCode, 401);
    assert.equal(queued.length, 0);
  });

  test('a base64 body is verified over its decoded bytes', async () => {
    const { deps, queued } = harness();
    const signed = fire(TEXT);
    const response = await handle({ ...signed, body: Buffer.from(TEXT).toString('base64'), isBase64Encoded: true }, deps);
    assert.equal(response.statusCode, 202);
    assert.equal(queued.length, 1);
  });
});

/**
 * The hook table (dispatch/webhook/hook-table.mjs): the task writes, per
 * repo, the hooks its file lists and each one's key version, and the
 * receiver reads it after the signature, so a revoked key or a removed hook
 * never reaches the queue. A repo with no item yet is queued: the task
 * decides.
 */
describe('handle: the hook table', () => {
  const listed = (hooks: Record<string, number>) => async () => new Map(Object.entries(hooks).map(([name, keyVersion]) => [name, { keyVersion, perHour: 20 }]));

  test('a repo with no item yet is queued, and the read names the repo', async () => {
    const asked: string[] = [];
    const { deps, queued } = harness({ listedHooks: async (repo: string) => { asked.push(repo); return null; } });
    assert.equal((await handle(fire(TEXT), deps)).statusCode, 202);
    assert.equal(queued.length, 1);
    assert.deepEqual(asked, [REPO]);
  });

  test('an equal or a newer key version is queued', async () => {
    for (const version of [2, 3]) {
      const { deps, queued } = harness({ listedHooks: listed({ [HOOK]: 2 }) });
      assert.equal((await handle(fire(TEXT, { version }), deps)).statusCode, 202, `v${version}`);
      assert.equal(queued.length, 1);
    }
  });

  test('a key version older than the item\'s gets 401, queues nothing, and logs hook-key-stale at error', async () => {
    const { deps, queued, logged } = harness({ listedHooks: listed({ [HOOK]: 2 }) });
    const response = await handle(fire(TEXT, { version: 1 }), deps);
    assert.equal(response.statusCode, 401);
    assert.equal(queued.length, 0);
    const line = logged.find((l) => l.event === HOOK_KEY_STALE);
    assert.equal(line?.level, 'error');
    assert.equal(line?.repo, REPO);
    assert.equal(line?.hook, HOOK);
    assert.equal(line?.keyVersion, 1);
  });

  test('a hook the item does not list gets 401, queues nothing, and logs at warn', async () => {
    for (const hooks of [{}, { 'operator-dev': 1 }]) {
      const { deps, queued, logged } = harness({ listedHooks: listed(hooks) });
      const response = await handle(fire(TEXT), deps);
      assert.equal(response.statusCode, 401, JSON.stringify(hooks));
      assert.equal(queued.length, 0);
      const line = logged.find((l) => l.event === 'hook-refused');
      assert.equal(line?.level, 'warn');
      assert.equal(line?.hook, HOOK);
      assert.ok(!logged.some((l) => l.level === 'error'), 'a forgotten caller pages nobody');
    }
  });

  test('a name the item does not hold is not listed, whatever an object would inherit', async () => {
    const { deps, queued } = harness({ listedHooks: listed({}) });
    assert.equal((await handle(fire(TEXT, { hook: 'constructor' }), deps)).statusCode, 401);
    assert.equal(queued.length, 0);
  });

  test('a failed read gets 503 and queues nothing, so the caller retries; it is never taken for a missing item', async () => {
    const { deps, queued, logged } = harness({ listedHooks: async () => { throw new Error('ProvisionedThroughputExceededException'); } });
    const response = await handle(fire(TEXT), deps);
    assert.equal(response.statusCode, 503);
    assert.equal(queued.length, 0);
    const line = logged.find((l) => l.event === 'hook-table-unread');
    assert.equal(line?.level, 'error');
    assert.match(String(line?.error), /ProvisionedThroughputExceededException/);
  });

  test('the table is read only for a signed request, from a listed owner', async () => {
    let reads = 0;
    const counting = { listedHooks: async () => { reads += 1; return null; } };
    const { deps } = harness(counting);
    await handle(fire(TEXT, { header: `v=1,t=${T},sha256=${'0'.repeat(64)}` }), deps);
    await handle(fire(TEXT, { t: T - 3600 }), deps);
    await handle(fire(TEXT, { repo: 'stranger/repo' }), deps);
    assert.equal(reads, 0);
    await handle(fire(TEXT), deps);
    assert.equal(reads, 1);
  });
});

/**
 * The hourly cap: the receiver counts each hook's fires per clock hour in the
 * hook table, and a fire past the hook's `perHour` gets 429, so a leaked key
 * cannot flood the one queue every repo shares.
 */
describe('handle: the hourly cap', () => {
  const counter = (over: Record<string, unknown> = {}) => {
    const counts: Array<{ repo: string, hook: string, at: number, cap: number, signature: string }> = [];
    const { deps, queued, logged } = harness({
      countFire: async (repo: string, hook: string, at: number, cap: number, signature: string): Promise<Counted> => { counts.push({ repo, hook, at, cap, signature }); return 'counted'; },
      ...over,
    });
    return { deps, queued, logged, counts };
  };

  test('a queued fire is counted once, by its signature, against the perHour the hook table\'s item names', async () => {
    const { deps, queued, counts } = counter({ listedHooks: async () => new Map([[HOOK, { keyVersion: 1, perHour: 7 }]]) });
    const request = fire(TEXT);
    assert.equal((await handle(request, deps)).statusCode, 202);
    assert.equal(queued.length, 1);
    const hex = readSignature(request.headers['Governor-Signature'])?.hex;
    assert.deepEqual(counts, [{ repo: REPO, hook: HOOK, at: NOW, cap: 7, signature: hex }]);
  });

  test('an item written before perHour had a ceiling is held to the ceiling, so an hour\'s item never outgrows DynamoDB', async () => {
    const { deps, counts } = counter({ listedHooks: async () => new Map([[HOOK, { keyVersion: 1, perHour: 50_000 }]]) });
    assert.equal((await handle(fire(TEXT), deps)).statusCode, 202);
    assert.equal(counts[0]?.cap, HOOK_PER_HOUR_MAX);
  });

  test('a repo with no item yet is capped at 20', async () => {
    const { deps, counts } = counter();
    assert.equal((await handle(fire(TEXT), deps)).statusCode, 202);
    assert.deepEqual(counts.map((c) => c.cap), [20]);
  });

  test('a fire past the cap gets 429, queues nothing, and logs at warn', async () => {
    const { deps, queued, logged } = counter({ countFire: async (): Promise<Counted> => 'full' });
    const response = await handle(fire(TEXT), deps);
    assert.equal(response.statusCode, 429);
    assert.equal(queued.length, 0);
    const line = logged.find((l) => l.event === 'hook-refused');
    assert.equal(line?.level, 'warn');
    assert.equal(line?.repo, REPO);
    assert.equal(line?.hook, HOOK);
    assert.ok(!logged.some((l) => l.level === 'error'), 'a flood is worth a look, not a page');
  });

  test('a count that fails gets 503 and queues nothing, so the caller retries', async () => {
    const { deps, queued, logged } = counter({ countFire: async (): Promise<Counted> => { throw new Error('ProvisionedThroughputExceededException'); } });
    const response = await handle(fire(TEXT), deps);
    assert.equal(response.statusCode, 503);
    assert.equal(queued.length, 0);
    const line = logged.find((l) => l.event === 'hook-table-uncounted');
    assert.equal(line?.level, 'error');
    assert.match(String(line?.error), /ProvisionedThroughputExceededException/);
  });

  test('only a request that passed the signature and key-version checks is counted', async () => {
    const { deps, counts } = counter({ listedHooks: async () => new Map([[HOOK, { keyVersion: 2, perHour: 20 }]]) });
    await handle(fire(TEXT, { header: `v=2,t=${T},sha256=${'0'.repeat(64)}` }), deps);
    await handle(fire(TEXT, { version: 2, t: T - 3600 }), deps);
    await handle(fire(TEXT, { version: 1 }), deps);
    await handle(fire(TEXT, { hook: 'operator-dev', version: 2 }), deps);
    await handle(fire(TEXT, { repo: 'stranger/repo', version: 2 }), deps);
    assert.deepEqual(counts, []);
    await handle(fire(TEXT, { version: 2 }), deps);
    assert.equal(counts.length, 1);
  });

  // One hour's count as the hook table keeps it: each signature once, and a new one only under the cap.
  const hourOf = (cap: number) => {
    const seen = new Set<string>();
    return {
      seen,
      countFire: async (_repo: string, _hook: string, _at: number, _cap: number, signature: string): Promise<Counted> => {
        if (seen.has(signature)) return 'seen';
        if (seen.size >= cap) return 'full';
        seen.add(signature);
        return 'counted';
      },
    };
  };

  test('the same signed request sent twice in one hour takes one place, and both sends answer 202 with the same deduplication id', async () => {
    const hour = hourOf(20);
    const { deps, queued, logged } = harness({ countFire: hour.countFire });
    const request = fire(TEXT);
    assert.equal((await handle(request, deps)).statusCode, 202);
    assert.equal((await handle(request, deps)).statusCode, 202);
    assert.equal(hour.seen.size, 1);
    assert.equal(queued.length, 2, 'both reach the queue, whose deduplication drops the second');
    assert.equal(queued[0]?.dedupId, queued[1]?.dedupId);
    assert.ok(!logged.some((l) => l.level === 'warn' || l.level === 'error'), 'a resend is not a refusal');
  });

  test('a resend at the cap still answers 202: the hour counted it already', async () => {
    const hour = hourOf(1);
    const { deps } = harness({ countFire: hour.countFire });
    const request = fire(TEXT);
    assert.equal((await handle(request, deps)).statusCode, 202);
    assert.equal((await handle(request, deps)).statusCode, 202);
  });

  test('a request whose send SQS refused, sent again with the same signature, takes no second place', async () => {
    const hour = hourOf(20);
    let refuse = true;
    const { deps, queued } = harness({
      countFire: hour.countFire,
      enqueue: async (message: Record<string, unknown>, dedupId?: string) => {
        if (refuse) throw new Error('ServiceUnavailable');
        queued.push({ message, ...(dedupId === undefined ? {} : { dedupId }) });
        return 'm-1';
      },
    });
    const request = fire(TEXT);
    await assert.rejects(handle(request, deps), /ServiceUnavailable/, 'a refused send leaves as a throw, which the Function URL answers 502');
    await assert.rejects(handle(request, deps), /ServiceUnavailable/);
    refuse = false;
    assert.equal((await handle(request, deps)).statusCode, 202);
    assert.equal(hour.seen.size, 1);
    assert.equal(queued.length, 1);
  });

  test('a new signature past the cap still answers 429', async () => {
    const hour = hourOf(2);
    const { deps, queued } = harness({ countFire: hour.countFire });
    const answers = [];
    for (const text of ['ALARM 1', 'ALARM 2', 'ALARM 3']) answers.push((await handle(fire(JSON.stringify({ text })), deps)).statusCode);
    assert.deepEqual(answers, [202, 202, 429]);
    assert.equal(queued.length, 2);
  });

  test('a flood: 100 fires in ten minutes queue the first 20 and answer 429 to the rest', async () => {
    const hour = new Map<string, Set<string>>();
    let clock = NOW;
    const { deps, queued } = harness({
      now: () => clock,
      countFire: async (repo: string, hook: string, at: number, cap: number, signature: string): Promise<Counted> => {
        const key = `${repo}|${hook}|${Math.floor(at / 3_600_000)}`;
        const seen = hour.get(key) ?? new Set<string>();
        hour.set(key, seen);
        if (seen.has(signature)) return 'seen';
        if (seen.size >= cap) return 'full';
        seen.add(signature);
        return 'counted';
      },
    });
    const answers: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      clock = NOW + i * 6000;
      answers.push((await handle(fire(JSON.stringify({ text: `ALARM ${i}` }), { t: Math.floor(clock / 1000) }), deps)).statusCode);
    }
    assert.equal(queued.length, 20);
    assert.deepEqual(answers.slice(0, 20), Array(20).fill(202));
    assert.deepEqual(answers.slice(20), Array(80).fill(429));
  });
});

describe('the hook table', () => {
  type Sent = { name: string; input: Record<string, any> };
  const client = (answer: (command: Sent) => unknown) => {
    const sent: Sent[] = [];
    return {
      sent,
      send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
        const one = { name: command.constructor.name, input: command.input };
        sent.push(one);
        return answer(one);
      },
    };
  };
  const ITEM = {
    pk: { S: 'hooks#acme/factory' },
    sk: { S: 'listed' },
    at: { S: '2026-09-21T12:00:00.000Z' },
    hooks: { M: { 'operator-prod': { N: '2' }, 'operator-dev': { N: '1' } } },
    perHour: { M: { 'operator-prod': { N: '20' }, 'operator-dev': { N: '5' } } },
  };

  test('one item per repo, read consistently by its key: each listed hook, its key version and its cap', async () => {
    const c = client(() => ({ Item: ITEM }));
    const listed = await hookTable(c as never, 'governor-DispatchHookTable-X').listed(REPO);
    assert.deepEqual(listed && [...listed].sort(), [['operator-dev', { keyVersion: 1, perHour: 5 }], ['operator-prod', { keyVersion: 2, perHour: 20 }]]);
    assert.equal(c.sent[0]?.name, 'GetItemCommand');
    assert.equal(c.sent[0]?.input.TableName, 'governor-DispatchHookTable-X');
    assert.equal(c.sent[0]?.input.ConsistentRead, true);
    assert.deepEqual(c.sent[0]?.input.Key, { pk: { S: 'hooks#acme/factory' }, sk: { S: 'listed' } });
  });

  test('a repo is one item whatever the case its path is written in', async () => {
    const c = client(() => ({}));
    await hookTable(c as never, 'T').listed('Acme/Factory');
    assert.deepEqual(c.sent[0]?.input.Key, { pk: { S: 'hooks#acme/factory' }, sk: { S: 'listed' } });
  });

  test('no item is null; an empty list is a list', async () => {
    assert.equal(await hookTable(client(() => ({})) as never, 'T').listed(REPO), null);
    const empty = await hookTable(client(() => ({ Item: { ...ITEM, hooks: { M: {} } } })) as never, 'T').listed(REPO);
    assert.equal(empty?.size, 0);
  });

  test('an item written before hooks had a cap reads each one as 20', async () => {
    const { perHour: _caps, ...older } = ITEM;
    const listed = await hookTable(client(() => ({ Item: older })) as never, 'T').listed(REPO);
    assert.deepEqual(listed && [...listed].sort(), [['operator-dev', { keyVersion: 1, perHour: 20 }], ['operator-prod', { keyVersion: 2, perHour: 20 }]]);
  });

  test('a malformed cap is a failed read', async () => {
    for (const perHour of [{ S: '20' }, { M: { 'operator-prod': { N: '20' } } }, { M: { 'operator-prod': { N: '0' }, 'operator-dev': { N: '5' } } }, { M: { 'operator-prod': { N: '2.5' }, 'operator-dev': { N: '5' } } }, { M: { 'operator-prod': { S: '20' }, 'operator-dev': { N: '5' } } }]) {
      await assert.rejects(hookTable(client(() => ({ Item: { ...ITEM, perHour } })) as never, 'T').listed(REPO), /malformed/, JSON.stringify(perHour));
    }
  });

  test('a read that fails, or a malformed item, throws: never a missing item', async () => {
    await assert.rejects(hookTable(client(() => { throw new Error('AccessDeniedException'); }) as never, 'T').listed(REPO), /AccessDeniedException/);
    for (const hooks of [undefined, { S: 'operator-prod' }, { M: { 'operator-prod': { S: '2' } } }, { M: { 'operator-prod': { N: '0' } } }, { M: { 'operator-prod': { N: '1.5' } } }]) {
      const item = { ...ITEM, hooks };
      if (hooks === undefined) delete (item as Record<string, unknown>).hooks;
      await assert.rejects(hookTable(client(() => ({ Item: item })) as never, 'T').listed(REPO), /malformed/, JSON.stringify(hooks));
    }
  });

  test('a write puts the repo\'s whole list, unless a later read of the file already stands', async () => {
    const c = client(() => ({}));
    const at = '2026-09-21T12:00:00.000Z';
    assert.equal(await hookTable(c as never, 'T').publish('Acme/Factory', [{ name: 'operator-prod', keyVersion: 2, perHour: 20 }, { name: 'operator-dev', keyVersion: 1, perHour: 5 }], at), true);
    const put = c.sent[0]!;
    assert.equal(put.name, 'PutItemCommand');
    assert.deepEqual(put.input.Item, ITEM);
    assert.equal(put.input.ConditionExpression, 'attribute_not_exists(pk) OR #at <= :at');
    assert.deepEqual(put.input.ExpressionAttributeNames, { '#at': 'at' });
    assert.deepEqual(put.input.ExpressionAttributeValues, { ':at': { S: at } });
    assert.equal('ttl' in put.input.Item, false, 'a repo that stops being served keeps its last item');
  });

  test('a write a later one beat is false; any other failure throws', async () => {
    const beaten = client(() => { throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }); });
    assert.equal(await hookTable(beaten as never, 'T').publish(REPO, [], '2026-09-21T12:00:00.000Z'), false);
    const failing = client(() => { throw new Error('AccessDeniedException'); });
    await assert.rejects(hookTable(failing as never, 'T').publish(REPO, [], '2026-09-21T12:00:00.000Z'), /AccessDeniedException/);
  });

  const SIG = 'a'.repeat(64);
  const refused = (item?: Record<string, unknown>) => client(() => {
    throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException', ...(item === undefined ? {} : { Item: item }) });
  });

  test('a fire is counted in its hook\'s item for the clock hour, with its signature, only while under the cap and new to the hour, and expires when the hour ends', async () => {
    const c = client(() => ({}));
    const at = Date.parse('2026-09-21T12:34:56.789Z');
    assert.equal(await hookTable(c as never, 'T').count('Acme/Factory', HOOK, at, 20, SIG), 'counted');
    const update = c.sent[0]!;
    assert.equal(update.name, 'UpdateItemCommand');
    assert.equal(update.input.TableName, 'T');
    assert.deepEqual(update.input.Key, { pk: { S: 'fires#acme/factory#operator-prod' }, sk: { S: '2026-09-21T12' } });
    assert.equal(update.input.UpdateExpression, 'ADD #fires :one, #signatures :signatures SET #ttl = :ttl');
    assert.equal(update.input.ConditionExpression, '(attribute_not_exists(#fires) OR #fires < :cap) AND NOT contains(#signatures, :signature)');
    assert.deepEqual(update.input.ExpressionAttributeNames, { '#fires': 'fires', '#signatures': 'signatures', '#ttl': 'ttl' });
    assert.deepEqual(update.input.ExpressionAttributeValues, {
      ':one': { N: '1' },
      ':cap': { N: '20' },
      ':signature': { S: SIG },
      ':signatures': { SS: [SIG] },
      ':ttl': { N: String(Date.parse('2026-09-21T13:00:00Z') / 1000) },
    });
    assert.equal(update.input.ReturnValuesOnConditionCheckFailure, 'ALL_OLD', 'a refusal returns the item, to tell a counted signature from a full hour');
  });

  test('a signature the hour already holds is seen, whether or not the hour is full', async () => {
    for (const fires of ['3', '20']) {
      const item = { fires: { N: fires }, signatures: { SS: ['b'.repeat(64), SIG] } };
      assert.equal(await hookTable(refused(item) as never, 'T').count(REPO, HOOK, NOW, 20, SIG), 'seen', fires);
    }
  });

  test('an hour\'s item at the largest cap stays under 7 KB, so a write costs at most 7 units', async () => {
    const c = client(() => ({}));
    await hookTable(c as never, 'T').count(REPO, HOOK, NOW, HOOK_PER_HOUR_MAX, SIG);
    // What one count adds to the set, times the most the set can hold; the key, the count and the ttl are a few dozen bytes more.
    const added = Buffer.byteLength(JSON.stringify(c.sent[0]?.input.ExpressionAttributeValues[':signatures'].SS));
    const bytes = HOOK_PER_HOUR_MAX * added + 'signatures'.length + 200;
    // DynamoDB charges a write by the item's size in whole KB: a count or a 429 in a full hour costs at most 7 write units.
    assert.ok(bytes <= 7 * 1024, `${bytes} bytes`);
  });

  test('a new signature in a full hour is full; any other failure throws', async () => {
    const item = { fires: { N: '20' }, signatures: { SS: ['b'.repeat(64)] } };
    assert.equal(await hookTable(refused(item) as never, 'T').count(REPO, HOOK, NOW, 20, SIG), 'full');
    // An hour counted before signatures were kept holds none.
    assert.equal(await hookTable(refused({ fires: { N: '20' } }) as never, 'T').count(REPO, HOOK, NOW, 20, SIG), 'full');
    assert.equal(await hookTable(refused() as never, 'T').count(REPO, HOOK, NOW, 20, SIG), 'full');
    const failing = client(() => { throw new Error('AccessDeniedException'); });
    await assert.rejects(hookTable(failing as never, 'T').count(REPO, HOOK, NOW, 20, SIG), /AccessDeniedException/);
  });
});

describe('the hook fire', () => {
  const HOOK_FIRE = { kind: 'hook', hook: HOOK, keyVersion: 2, text: 'ALARM', at: '2026-09-21T12:00:00.000Z', repo: REPO };

  test('reads back as built, and needs the hooks switch', () => {
    assert.deepEqual(parseFire(HOOK_FIRE), HOOK_FIRE);
    assert.equal(switchOf(parseFire(HOOK_FIRE)), 'hooks');
  });

  test('carries no prompt, and is refused without a repo, a hook name, a positive key version, text or its time', () => {
    assert.throws(() => parseFire({ ...HOOK_FIRE, prompt: 'Do something else.' }), /prompt/);
    const { repo: _repo, ...unnamed } = HOOK_FIRE;
    assert.throws(() => parseFire(unnamed), /repo/);
    for (const over of [{ hook: 'Operator' }, { hook: '' }, { keyVersion: 0 }, { keyVersion: 1.5 }, { keyVersion: '1' }, { text: '' }, { text: 5 }, { at: 'yesterday' }]) {
      assert.throws(() => parseFire({ ...HOOK_FIRE, ...over }), JSON.stringify(over));
    }
  });
});

describe('the config file\'s hooks', () => {
  const base = JSON.parse(factoryFile(CONFIG_PATH));
  const withHooks = (features: Record<string, boolean>, hooks?: unknown) => JSON.stringify({ ...base, features: { ...base.features, ...features }, ...(hooks === undefined ? { hooks: undefined } : { hooks }) });
  const fault = (text: string) => {
    const read = readConfig(text);
    return read.ok ? null : read.fault;
  };

  test('hooks is a switch, and the factory turns it on with one hook', () => {
    const read = readConfig(factoryFile(CONFIG_PATH));
    assert.ok(read.ok);
    assert.equal(read.config.features.hooks, true);
    assert.equal(read.config.hooks.length, 1);
    assert.ok(configSchema.shape.features.in.shape.hooks);
  });

  test('with the switch on, the file lists at least one hook', () => {
    assert.match(String(fault(withHooks({ hooks: true }, []))), /hooks/);
    assert.match(String(fault(withHooks({ hooks: true }))), /hooks/);
    assert.equal(fault(withHooks({ hooks: false })), null);
  });

  test('a hook may set perHour, a positive whole number up to the most an hour\'s item can hold; a hook without it stays valid', () => {
    const hook = { name: 'operator-prod', prompt: 'Look into the alarm.', keyVersion: 1 };
    assert.equal(fault(withHooks({ hooks: true }, [hook])), null);
    assert.equal(fault(withHooks({ hooks: true }, [{ ...hook, perHour: 5 }])), null);
    assert.equal(fault(withHooks({ hooks: true }, [{ ...hook, perHour: HOOK_PER_HOUR_MAX }])), null);
    for (const perHour of [0, -1, 1.5, '20', null, HOOK_PER_HOUR_MAX + 1]) {
      assert.notEqual(fault(withHooks({ hooks: true }, [{ ...hook, perHour }])), null, JSON.stringify(perHour));
    }
  });

  test('each hook has a URL-safe name unique in the file, a prompt and a positive whole key version', () => {
    const hook = { name: 'operator-prod', prompt: 'Look into the alarm.', keyVersion: 1 };
    assert.equal(fault(withHooks({ hooks: true }, [hook, { ...hook, name: 'operator-dev', prompt: { file: 'ops/alarm.md' } }])), null);
    assert.match(String(fault(withHooks({ hooks: true }, [hook, hook]))), /operator-prod/);
    for (const bad of [{ name: 'Operator' }, { name: 'op prod' }, { name: 'op_prod' }, { name: 'op/prod' }, { name: '' }, { prompt: '' }, { prompt: { file: '../x' } }, { keyVersion: 0 }, { keyVersion: 1.5 }, { keyVersion: '1' }, { keyVersion: 1_000_000_000 }, { perhour: 20 }]) {
      assert.notEqual(fault(withHooks({ hooks: true }, [{ ...hook, ...bad }])), null, JSON.stringify(bad));
    }
    const { keyVersion: _v, ...unversioned } = hook;
    assert.notEqual(fault(withHooks({ hooks: true }, [unversioned])), null);
  });

  test('a hook\'s prompt file is read from the default branch, and a missing one is the file\'s fault', async () => {
    const read = readConfig(withHooks({ hooks: true }, [{ name: 'operator-prod', prompt: { file: 'ops/alarm.md' }, keyVersion: 1 }]));
    assert.ok(read.ok);
    const files: Record<string, string> = { '.claude/skills/pr-review/SKILL.md': factoryFile('.claude/skills/pr-review/SKILL.md'), 'ops/alarm.md': 'Look into the alarm.\n' };
    const resolved = await resolveFiles(read.config, async (path) => files[path] ?? null);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.config.hooks, [{ name: 'operator-prod', prompt: 'Look into the alarm.', keyVersion: 1 }]);
    const missing = await resolveFiles(read.config, async (path) => (path === 'ops/alarm.md' ? null : files[path] ?? null));
    assert.ok(!missing.ok);
    assert.match(missing.fault, /hooks\.operator-prod\.prompt: ops\/alarm\.md/);
  });
});

describe('fitness: a hook fire arrives on its own path, signed with its hook key, and carries data, never a prompt (dispatcher-repos.md)', () => {
  test('an unlisted owner\'s signed hook queues nothing and pages nobody', async () => {
    const { deps, queued, logged } = harness();
    const response = await handle(fire(TEXT, { repo: 'stranger/repo' }), deps);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300);
    assert.deepEqual(queued, []);
    assert.ok(logged.every((l) => l.level === 'info'), JSON.stringify(logged));
  });

  test('a GitHub-signed body on a hook path is not a hook\'s: GitHub\'s key opens nothing there', async () => {
    const { deps, queued } = harness();
    const github = `sha256=${createHmac('sha256', 'whsec_test').update(TEXT).digest('hex')}`;
    const response = await handle({ path: `/hooks/${REPO}/${HOOK}`, headers: { 'x-hub-signature-256': github }, body: TEXT, isBase64Encoded: false }, deps);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(queued, []);
  });

  test('the queued fire holds no prompt: the task reads the hook\'s from the file', async () => {
    const { deps, queued } = harness();
    await handle(fire(JSON.stringify({ text: 'x', prompt: 'Delete everything.' })), deps);
    assert.equal(queued.length, 1);
    assert.equal('prompt' in (queued[0]!.message.fire as Record<string, unknown>), false);
  });
});
