/**
 * What the GitHub client does for a task that keeps a repo's token and
 * files: a token GitHub refuses is renewed and the call sent once more, and
 * a file read sends the ETag it holds, using its text on a 304. The client
 * is faked at `fetch`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { githubApi, githubReader, installationGrant } from '../../scripts/lib/github-app.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

type Sent = { url: string, method: string, auth: string, ifNoneMatch: string | null };

/** A fetch that answers each call with the next of `answers`, and records what it was sent. */
const scripted = (answers: Array<() => Response>) => {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization') ?? '', ifNoneMatch: headers.get('if-none-match') });
    const next = answers[sent.length - 1];
    if (next === undefined) throw new Error(`no answer for call ${sent.length}`);
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
};

const json = (body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const status = (code: number) => () => new Response(code === 304 ? null : '{"message":"Bad credentials"}', { status: code, statusText: 'Refused' });
const file = (text: string, etag: string) => json({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') }, { etag });

describe('installationGrant', () => {
  test('answers the token and when GitHub says it expires', async () => {
    const { fetch } = scripted([json({ id: 7 }), json({ token: 'ghs_a', expires_at: '2026-11-27T13:00:00Z' })]);
    assert.deepEqual(await installationGrant({ appId: '1', privateKeyPem: PEM, repo: 'acme/factory', fetch }), { token: 'ghs_a', expiresAt: Date.parse('2026-11-27T13:00:00Z') });
  });

  test('a grant naming no expiry reads as expired, so it is never kept', async () => {
    const { fetch } = scripted([json({ id: 7 }), json({ token: 'ghs_a' })]);
    assert.deepEqual(await installationGrant({ appId: '1', privateKeyPem: PEM, repo: 'acme/factory', fetch }), { token: 'ghs_a', expiresAt: 0 });
  });
});

describe('a token GitHub refuses', () => {
  test('is renewed, and the call is sent once more with the new token', async () => {
    const { fetch, sent } = scripted([status(401), json([{ id: 1 }]), json([{ id: 2 }])]);
    const stale: string[] = [];
    const api = githubApi({ token: 'ghs_old', fetch, sleep: async () => {}, renew: async (token: string) => { stale.push(token); return 'ghs_new'; } });
    assert.deepEqual(await api('GET', '/repos/acme/factory/hooks'), [{ id: 1 }]);
    assert.deepEqual(stale, ['ghs_old']);
    assert.deepEqual(sent.map((s) => s.auth), ['Bearer ghs_old', 'Bearer ghs_new']);
    assert.deepEqual(await api('GET', '/repos/acme/factory/pulls'), [{ id: 2 }]);
    assert.equal(sent[2]?.auth, 'Bearer ghs_new', 'the client keeps the renewed token');
  });

  test('a write is sent once more too: GitHub refused it before it acted', async () => {
    const { fetch, sent } = scripted([status(401), json({ id: 3 })]);
    const api = githubApi({ token: 'ghs_old', fetch, renew: async () => 'ghs_new' });
    assert.deepEqual(await api('POST', '/repos/acme/factory/issues/1/comments', { body: 'x' }), { id: 3 });
    assert.deepEqual(sent.map((s) => `${s.method} ${s.auth}`), ['POST Bearer ghs_old', 'POST Bearer ghs_new']);
  });

  test('a second refusal is not renewed again', async () => {
    const { fetch, sent } = scripted([status(401), status(401)]);
    let renewed = 0;
    const api = githubApi({ token: 'ghs_old', fetch, renew: async () => { renewed += 1; return 'ghs_new'; } });
    await assert.rejects(api('GET', '/repos/acme/factory/hooks'), (e: { status?: number }) => e.status === 401);
    assert.equal(renewed, 1);
    assert.equal(sent.length, 2);
  });

  test('a renewal that fails throws GitHub\'s refusal, not the mint\'s answer', async () => {
    const { fetch } = scripted([status(401)]);
    const mintRefused = Object.assign(new Error('GET /repos/acme/factory/installation failed: 404'), { status: 404 });
    const api = githubApi({ token: 'ghs_old', fetch, renew: async () => { throw mintRefused; } });
    await assert.rejects(api('GET', '/repos/acme/factory/hooks'), (e: { status?: number, cause?: unknown }) => e.status === 401 && e.cause === mintRefused);
  });

  test('a file read whose renewal fails is refused, not read as no file', async () => {
    const { fetch } = scripted([status(401)]);
    const renew = async () => { throw Object.assign(new Error('installation not found'), { status: 404 }); };
    await assert.rejects(githubReader({ token: 'ghs_old', repo: 'acme/factory', fetch, renew }).configFile(), (e: { status?: number }) => e.status === 401);
  });

  test('a turn whose resends are spent sends a refused call once, as every other', async () => {
    const { fetch, sent } = scripted([status(401)]);
    let renewed = 0;
    const api = githubApi({ token: 'ghs_old', fetch, resends: { spent: true }, renew: async () => { renewed += 1; return 'ghs_new'; } });
    await assert.rejects(api('GET', '/repos/acme/factory/hooks'), (e: { status?: number }) => e.status === 401);
    assert.equal(renewed, 0);
    assert.equal(sent.length, 1);
  });

  test('a call refused after its client renewed is sent again under the new token, with no second renewal', async () => {
    const sent: string[] = [];
    let refusals = 0;
    const fetch = (async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      sent.push(auth);
      if (auth !== 'Bearer ghs_old') return json({ ok: true })();
      // The second call's refusal arrives after the first call renewed.
      refusals += 1;
      if (refusals > 1) await new Promise((r) => setTimeout(r, 20));
      return status(401)();
    }) as unknown as typeof globalThis.fetch;
    const stale: string[] = [];
    const api = githubApi({ token: 'ghs_old', fetch, renew: async (token: string) => { stale.push(token); return 'ghs_new'; } });
    assert.deepEqual(await Promise.all([api('GET', '/repos/acme/factory/hooks'), api('GET', '/repos/acme/factory/pulls')]), [{ ok: true }, { ok: true }]);
    assert.deepEqual(stale, ['ghs_old']);
    assert.deepEqual(sent, ['Bearer ghs_old', 'Bearer ghs_old', 'Bearer ghs_new', 'Bearer ghs_new']);
  });

  test('a client with no way to renew is refused as before', async () => {
    const { fetch, sent } = scripted([status(401)]);
    await assert.rejects(githubApi({ token: 'ghs_old', fetch })('GET', '/repos/acme/factory/hooks'), (e: { status?: number }) => e.status === 401);
    assert.equal(sent.length, 1);
  });
});

describe('a file read with the ETag the task holds', () => {
  const path = 'https://api.github.com/repos/acme/factory/contents/.github/governor.json';
  const memory = () => {
    const held = new Map<string, { etag: string, text: string }>();
    const answered: number[] = [];
    return {
      held,
      answered,
      files: {
        held: (repo: string, at: string) => held.get(`${repo}:${at}`),
        keep: (repo: string, at: string, kept: { etag: string, text: string }) => { held.set(`${repo}:${at}`, kept); },
        answered: (code: 200 | 304) => { answered.push(code); },
      },
    };
  };

  test('the first read sends no ETag, and keeps the text and the ETag GitHub answered', async () => {
    const m = memory();
    const { fetch, sent } = scripted([file('{"a":1}', 'W/"e1"')]);
    assert.equal(await githubReader({ token: 't', repo: 'acme/factory', fetch, files: m.files }).configFile(), '{"a":1}');
    assert.equal(sent[0]?.url, path);
    assert.equal(sent[0]?.ifNoneMatch, null);
    assert.deepEqual(m.held.get('acme/factory:.github/governor.json'), { etag: 'W/"e1"', text: '{"a":1}' });
    assert.deepEqual(m.answered, [200]);
  });

  test('a later read sends the ETag, and a 304 answers the text it holds', async () => {
    const m = memory();
    m.held.set('acme/factory:docs/review.md', { etag: 'W/"e1"', text: '# Review' });
    const { fetch, sent } = scripted([status(304)]);
    assert.equal(await githubReader({ token: 't', repo: 'acme/factory', fetch, files: m.files }).configFile('docs/review.md'), '# Review');
    assert.equal(sent[0]?.ifNoneMatch, 'W/"e1"');
    assert.deepEqual(m.answered, [304]);
  });

  test('a file that changed is read in full, and its new text and ETag replace the old', async () => {
    const m = memory();
    m.held.set('acme/factory:.github/governor.json', { etag: 'W/"e1"', text: '{"a":1}' });
    const { fetch } = scripted([file('{"a":2}', 'W/"e2"')]);
    assert.equal(await githubReader({ token: 't', repo: 'acme/factory', fetch, files: m.files }).configFile(), '{"a":2}');
    assert.deepEqual(m.held.get('acme/factory:.github/governor.json'), { etag: 'W/"e2"', text: '{"a":2}' });
    assert.deepEqual(m.answered, [200]);
  });

  test('a file GitHub no longer has is still no file', async () => {
    const m = memory();
    m.held.set('acme/factory:.github/governor.json', { etag: 'W/"e1"', text: '{"a":1}' });
    const { fetch } = scripted([() => new Response('{"message":"Not Found"}', { status: 404, statusText: 'Not Found' })]);
    assert.equal(await githubReader({ token: 't', repo: 'acme/factory', fetch, files: m.files }).configFile(), null);
  });
});
