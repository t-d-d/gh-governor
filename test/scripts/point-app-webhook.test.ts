/**
 * scripts/point-app-webhook.mjs: the deploy points the App's webhook, the one
 * every installation delivers through, at the stack's receiver with the
 * stack's key. The GitHub API is injected; what is pinned is the config it
 * writes, that it writes nothing while the App misses an event the receiver
 * routes, and that the key never reaches a log line.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appHookConfig, pointAppHook } from '../../scripts/point-app-webhook.mjs';
import { HOOK_EVENTS } from '../../dispatch/webhook/route.mjs';

const URL = 'https://abc.lambda-url.us-east-1.on.aws/';
const SECRET = 'whsec_0123456789';

type Call = { method: string; path: string; body?: unknown };

const fakeApp = (events: readonly string[] = HOOK_EVENTS) => {
  const calls: Call[] = [];
  const app = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/app') return { slug: 'governor-app', events: [...events] };
    if (method === 'PATCH' && path === '/app/hook/config') return { url: URL, content_type: 'json', insecure_ssl: '0' };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { app, calls };
};

describe('appHookConfig', () => {
  test('is the receiver\'s URL, JSON, the stack\'s key, and TLS checked', () => {
    assert.deepEqual(appHookConfig({ url: URL, secret: SECRET }), { url: URL, content_type: 'json', secret: SECRET, insecure_ssl: '0' });
  });
});

describe('pointAppHook', () => {
  test('reads the App\'s events, then writes its webhook\'s config as the App', async () => {
    const { app, calls } = fakeApp();
    await pointAppHook({ url: URL, secret: SECRET, app, log: () => {} });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /app', 'PATCH /app/hook/config']);
    assert.deepEqual(calls[1]!.body, appHookConfig({ url: URL, secret: SECRET }));
  });

  // The events are ticked by hand in the App's settings: a webhook pointed
  // while one is unticked looks healthy and never hears that event.
  test('refuses before writing anything while the App misses an event the receiver routes', async () => {
    const { app, calls } = fakeApp(HOOK_EVENTS.filter((e) => e !== 'workflow_run'));
    await assert.rejects(pointAppHook({ url: URL, secret: SECRET, app, log: () => {} }), /workflow_run/);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /app']);
  });

  test('never prints the key', async () => {
    const { app } = fakeApp();
    const lines: string[] = [];
    await pointAppHook({ url: URL, secret: SECRET, app, log: (l) => lines.push(l) });
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => !l.includes(SECRET)), lines.join('\n'));
  });

  test('refuses an empty URL or key rather than pointing the App at a hook that can never verify', async () => {
    const { app, calls } = fakeApp();
    await assert.rejects(pointAppHook({ url: '', secret: SECRET, app, log: () => {} }), /url/i);
    await assert.rejects(pointAppHook({ url: URL, secret: '', app, log: () => {} }), /secret/i);
    assert.deepEqual(calls, []);
  });
});

describe('the command', () => {
  test('refuses to run without the App\'s id and key, before any call', () => {
    const { APP_ID: _id, APP_PRIVATE_KEY: _key, ...env } = process.env;
    const run = spawnSync(process.execPath, ['scripts/point-app-webhook.mjs'], {
      env: { ...env, WEBHOOK_URL: URL, WEBHOOK_SECRET: SECRET },
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr + run.stdout, /APP_ID and APP_PRIVATE_KEY are not both set/);
  });
});
