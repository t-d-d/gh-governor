#!/usr/bin/env node
/**
 * Point the App's webhook at the stack: the receiver's URL, JSON, the
 * stack's key. Every installation delivers through that one webhook, so a
 * repo is onboarded with no deploy and nobody pastes a URL or a key into the
 * App's settings. The events it subscribes to are set in the App's settings,
 * which the API cannot write; this reads them first and writes nothing while
 * one the receiver routes is unticked, and the deploy's `app-events` check
 * reads them back (scripts/conformance.mjs).
 *
 * Run by .github/workflows/deploy.yml after the apply. Everything arrives
 * in the environment, so neither key sits in an argument list:
 *
 *   APP_ID              the App's id, for its JWT
 *   APP_PRIVATE_KEY     the App's key, for its JWT (`/app/hook/config` takes no other)
 *   WEBHOOK_URL         the stack's WebhookUrl output
 *   WEBHOOK_SECRET      the value of governor/webhook-secret
 *
 * Node built-ins only.
 */

import { isCliEntry } from './lib/cli-entry.mjs';
import { appJwt, githubApi } from './lib/github-app.mjs';
import { dispatchAppEventFindings } from './lib/conformance-app-events.mjs';

/**
 * The App webhook's config as GitHub should hold it. `insecure_ssl: '0'` is
 * the default spelled out: a Function URL has a real certificate.
 *
 * @param {{ url: string, secret: string }} args
 */
export const appHookConfig = ({ url, secret }) => ({ url, content_type: 'json', secret, insecure_ssl: '0' });

/**
 * @typedef {(method: string, path: string, body?: unknown) => Promise<any>} Api
 */

/**
 * @param {{ url: string, secret: string, app: Api, log: (line: string) => void }} args
 *   `app`: calls as the App (its JWT).
 */
export const pointAppHook = async ({ url, secret, app, log }) => {
  if (!url) throw new Error('WEBHOOK_URL is empty: the stack has no receiver to point the hook at');
  if (!secret) throw new Error('WEBHOOK_SECRET is empty: a hook with no key verifies nothing');
  /** @type {{ slug?: string, events?: unknown }} */
  const self = await app('GET', '/app');
  const slug = String(self?.slug ?? 'the App');
  const [unticked] = dispatchAppEventFindings({ slug, events: Array.isArray(self?.events) ? self.events.map(String) : [] });
  if (unticked !== undefined) throw new Error(`${unticked}. Nothing was written.`);
  await app('PATCH', '/app/hook/config', appHookConfig({ url, secret }));
  log(`Pointed the ${slug} webhook at ${url}`);
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  const env = process.env;
  try {
    if (!env.APP_ID || !env.APP_PRIVATE_KEY) throw new Error('APP_ID and APP_PRIVATE_KEY are not both set');
    await pointAppHook({
      url: env.WEBHOOK_URL ?? '',
      secret: env.WEBHOOK_SECRET ?? '',
      app: githubApi({ token: appJwt({ appId: env.APP_ID, privateKeyPem: env.APP_PRIVATE_KEY }) }),
      log: console.log,
    });
  } catch (error) {
    console.error(`::error::${/** @type {Error} */ (error).message}`);
    process.exit(1);
  }
}
