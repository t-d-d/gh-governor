/**
 * What a task keeps from one turn to the next: each repo's installation
 * token, and each config and prompt file with the ETag GitHub answered.
 * Every turn still asks GitHub for each file. GitHub is faked at `fetch`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TOKEN_LEFT_MS, taskMemory } from '../dispatch/task-memory.mjs';
import { taskGithub } from '../dispatch/turn.mjs';
import { DEADLINE_MS } from '../dispatch/cli.mjs';
import { repoServed } from '../dispatch/repos.mjs';
import { CONFIG_PATH } from '../dispatch/repo-config.mjs';
import { turnResends } from '../scripts/lib/github-app.mjs';
import { factoryFile } from './helpers/factory.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const HOUR = 60 * 60 * 1000;
const ENVIRONMENTS = JSON.parse(readFileSync('test/fixtures/environment-providers.json', 'utf8'));

describe('taskMemory', () => {
  const grants = (now: () => number) => {
    let minted = 0;
    const mint = async () => { minted += 1; return { token: `ghs_${minted}`, expiresAt: now() + HOUR }; };
    return { mint, count: () => minted };
  };

  test('two asks for one repo\'s token mint one', async () => {
    const memory = taskMemory({ now: () => 0 });
    const g = grants(() => 0);
    assert.equal(await memory.token('acme/factory', g.mint), 'ghs_1');
    assert.equal(await memory.token('acme/factory', g.mint), 'ghs_1');
    assert.equal(g.count(), 1);
  });

  test('each repo has its own token', async () => {
    const memory = taskMemory({ now: () => 0 });
    const g = grants(() => 0);
    await memory.token('acme/factory', g.mint);
    await memory.token('acme/other', g.mint);
    assert.equal(g.count(), 2);
  });

  test('a token close to its expiry is minted again', async () => {
    let clock = 0;
    const memory = taskMemory({ now: () => clock });
    const g = grants(() => clock);
    await memory.token('acme/factory', g.mint);
    clock = HOUR - TOKEN_LEFT_MS - 1;
    assert.equal(await memory.token('acme/factory', g.mint), 'ghs_1', 'still has more than TOKEN_LEFT_MS to run');
    clock = HOUR - TOKEN_LEFT_MS;
    assert.equal(await memory.token('acme/factory', g.mint), 'ghs_2');
    assert.equal(g.count(), 2);
  });

  // A turn runs up to its deadline on the token it took at its start.
  test('a kept token outlives the turn that takes it', () => {
    assert.ok(TOKEN_LEFT_MS > DEADLINE_MS);
  });

  test('a refused token is minted again, once, however many clients held it', async () => {
    const memory = taskMemory({ now: () => 0 });
    const g = grants(() => 0);
    await memory.token('acme/factory', g.mint);
    assert.equal(await memory.renew('acme/factory', 'ghs_1', g.mint), 'ghs_2');
    assert.equal(await memory.renew('acme/factory', 'ghs_1', g.mint), 'ghs_2', 'a second client holding the refused token takes the new one');
    assert.equal(await memory.token('acme/factory', g.mint), 'ghs_2');
    assert.equal(g.count(), 2);
  });

  test('clients that ask at once for a token none is kept for mint one', async () => {
    const memory = taskMemory({ now: () => 0 });
    const g = grants(() => 0);
    const slow = async () => { await new Promise((r) => setTimeout(r, 5)); return g.mint(); };
    assert.deepEqual(await Promise.all([memory.token('acme/factory', slow), memory.token('acme/factory', slow)]), ['ghs_1', 'ghs_1']);
    assert.equal(g.count(), 1);
  });

  test('clients refused the same token at once mint one new token between them', async () => {
    const memory = taskMemory({ now: () => 0 });
    const g = grants(() => 0);
    await memory.token('acme/factory', g.mint);
    const slow = async () => { await new Promise((r) => setTimeout(r, 5)); return g.mint(); };
    assert.deepEqual(await Promise.all([memory.renew('acme/factory', 'ghs_1', slow), memory.renew('acme/factory', 'ghs_1', slow)]), ['ghs_2', 'ghs_2']);
    assert.equal(g.count(), 2);
  });

  test('a mint that fails is not kept', async () => {
    const memory = taskMemory({ now: () => 0 });
    await assert.rejects(memory.token('acme/factory', async () => { throw new Error('503'); }), /503/);
    const g = grants(() => 0);
    assert.equal(await memory.token('acme/factory', g.mint), 'ghs_1');
  });

  test('a new task holds nothing from the last one', async () => {
    const last = taskMemory({ now: () => 0 });
    await last.token('acme/factory', grants(() => 0).mint);
    last.keep('acme/factory', CONFIG_PATH, { etag: 'W/"e1"', text: '{}' });
    const next = taskMemory({ now: () => 0 });
    assert.equal(next.held('acme/factory', CONFIG_PATH), undefined);
    const g = grants(() => 0);
    await next.token('acme/factory', g.mint);
    assert.equal(g.count(), 1);
  });

  test('a file is held by its repo and path', () => {
    const memory = taskMemory({ now: () => 0 });
    memory.keep('acme/factory', CONFIG_PATH, { etag: 'W/"e1"', text: '{}' });
    assert.deepEqual(memory.held('acme/factory', CONFIG_PATH), { etag: 'W/"e1"', text: '{}' });
    assert.equal(memory.held('acme/other', CONFIG_PATH), undefined);
    assert.equal(memory.held('acme/factory', 'docs/review.md'), undefined);
  });
});

/**
 * A fake GitHub holding the factory's default branch: it mints tokens, and
 * answers a contents read 304 where the ETag sent matches the file's.
 */
const fakeGithub = (files: Record<string, string>) => {
  const minted: string[] = [];
  const answered: string[] = [];
  const refused = new Set<string>();
  const etagOf = (text: string) => `W/"${Buffer.from(text).toString('base64url').slice(-12)}"`;
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const { pathname } = new URL(url);
    if (pathname === '/repos/acme/factory/installation') return Response.json({ id: 7 });
    if (pathname === '/app/installations/7/access_tokens') {
      const token = `ghs_${minted.length + 1}`;
      minted.push(token);
      return Response.json({ token, expires_at: new Date(Date.now() + HOUR).toISOString() });
    }
    if (refused.has(auth)) return new Response('{"message":"Bad credentials"}', { status: 401, statusText: 'Unauthorized' });
    const path = decodeURIComponent(pathname.replace('/repos/acme/factory/contents/', ''));
    const text = files[path];
    if (text === undefined) return new Response('{"message":"Not Found"}', { status: 404, statusText: 'Not Found' });
    if (headers.get('if-none-match') === etagOf(text)) {
      answered.push(`304 ${path}`);
      return new Response(null, { status: 304 });
    }
    answered.push(`200 ${path}`);
    return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') }, { headers: { etag: etagOf(text) } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, minted, answered, refused };
};

const FACTORY_PATHS = [CONFIG_PATH, '.claude/skills/pr-review/SKILL.md', '.github/issue-review/triage.md', '.github/issue-review/bug.md'];
const factoryFiles = () => Object.fromEntries(FACTORY_PATHS.map((path) => [path, factoryFile(path)]));

describe('a task\'s turns for one repo', () => {
  const turn = (memory: ReturnType<typeof taskMemory>, fetch: typeof globalThis.fetch) =>
    taskGithub({ memory, appKey: async () => ({ appId: '1', privateKeyPem: PEM }), log: () => {}, resends: turnResends(), fetch, sleep: async () => {} });
  const served = (g: ReturnType<typeof turn>) => repoServed({
    owners: ['acme'],
    repo: 'acme/factory',
    token: g.githubToken,
    config: g.configFile,
    environments: async () => ENVIRONMENTS,
    log: () => {},
  });

  test('mint one token, and use each file GitHub answers 304 for from memory, with the same result as a full read', async () => {
    const github = fakeGithub(factoryFiles());
    const memory = taskMemory({ now: Date.now });
    const first = turn(memory, github.fetch);
    const full = await served(first);
    assert.ok(full);
    assert.deepEqual(first.fileReads(), { notModified: 0, read: FACTORY_PATHS.length });

    const second = turn(memory, github.fetch);
    const kept = await served(second);
    assert.deepEqual(kept, full);
    assert.deepEqual(second.fileReads(), { notModified: FACTORY_PATHS.length, read: 0 });
    assert.deepEqual(github.minted, ['ghs_1']);
    assert.equal(github.answered.length, FACTORY_PATHS.length * 2, 'every turn still asks GitHub for every file');
  });

  test('a file that changed between turns is read in full by the second, which acts on the new text', async () => {
    const files = factoryFiles();
    const github = fakeGithub(files);
    const memory = taskMemory({ now: Date.now });
    const before = await served(turn(memory, github.fetch));
    assert.equal(before?.config.features.heartbeat, true);
    const config = JSON.parse(files[CONFIG_PATH]!);
    files[CONFIG_PATH] = JSON.stringify({ ...config, heartbeat: { ...config.heartbeat, enabled: false } });
    const second = turn(memory, github.fetch);
    const after = await served(second);
    assert.equal(after?.config.features.heartbeat, false);
    assert.deepEqual(second.fileReads(), { notModified: FACTORY_PATHS.length - 1, read: 1 });
  });

  test('a token GitHub refuses is minted again, and the read sent once more', async () => {
    const github = fakeGithub(factoryFiles());
    const memory = taskMemory({ now: Date.now });
    await served(turn(memory, github.fetch));
    github.refused.add('Bearer ghs_1');
    const kept = await served(turn(memory, github.fetch));
    assert.ok(kept);
    assert.deepEqual(github.minted, ['ghs_1', 'ghs_2']);
    const third = turn(memory, github.fetch);
    assert.equal(await third.githubToken('acme/factory'), 'ghs_2', 'the next turn takes the new token');
  });

  test('a new task holds nothing from the last one', async () => {
    const github = fakeGithub(factoryFiles());
    await served(turn(taskMemory({ now: Date.now }), github.fetch));
    const fresh = turn(taskMemory({ now: Date.now }), github.fetch);
    await served(fresh);
    assert.deepEqual(github.minted, ['ghs_1', 'ghs_2']);
    assert.deepEqual(fresh.fileReads(), { notModified: 0, read: FACTORY_PATHS.length });
  });
});
