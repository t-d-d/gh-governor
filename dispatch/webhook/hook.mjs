/**
 * Hooks at the receiver: what a hook request is, and how its signature is
 * checked.
 *
 * An outside system fires a hook in a served repo's config file with
 * `POST /hooks/<owner>/<repo>/<hook>` on the receiver's Function URL, a JSON
 * body holding `text`, and a `Governor-Signature` header. Governor stores no
 * hook key: each is derived from the one stack secret, `governor/hook-secret`
 * ({@link hookKey}), and the owner mints it with scripts/hook-key.mjs. The
 * caller signs a timestamp and the raw body with it ({@link hookSignature}),
 * so the key never travels, a stranger's post gets 401, and a replay is
 * either outside the clock window or carries the same signature, which is
 * the fire's deduplication id on the queue. The clock window is 5 seconds
 * shorter than the queue's deduplication window, so a replay slower than the
 * first request to reach the queue still falls inside it.
 *
 * The receiver reads no config file. What it knows of a repo's hooks is the
 * repo's item in the hook table, which the task writes as it reads the file
 * (hook-table.mjs). The task still checks every fire against the file
 * (dispatch/hooks.mjs).
 *
 * Pure, and a leaf beside fire.mjs: the Lambda packages dispatch/webhook/
 * whole, and the key script imports it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HOOK_NAME, REPO_NAME } from './fire.mjs';

/** The header a hook request carries its signature in, as Lambda lower-cases it. */
export const HOOK_HEADER = 'governor-signature';

/** The most of the caller's text a fire takes, in bytes of UTF-8. */
export const HOOK_TEXT_LIMIT = 32 * 1024;

/** How long the queue drops a duplicate fire after the first send: an SQS FIFO queue's fixed interval. */
export const HOOK_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * How far a signature's `t` may be ahead of the receiver's clock, and how far
 * behind it. A request is valid for the sum of the two, so the sum stays at
 * least the receiver's timeout (20 seconds, `governor-webhook` in
 * infra/governor.cfn.yml) under {@link HOOK_DEDUP_WINDOW_MS}. The queue's
 * window runs from the first send, not from the clock check, and between the
 * two the receiver reads and writes the hook table and sends, each call
 * retried by the SDK. Nothing reaches the queue once the receiver stops, so
 * that margin covers the slowest replay. Then every replay of a valid
 * request lands inside the queue's window and is dropped.
 */
export const HOOK_CLOCK_AHEAD_MS = 30 * 1000;
export const HOOK_CLOCK_BEHIND_MS = 4 * 60 * 1000 + 10 * 1000;

const PREFIX = '/hooks/';
const OWNER = /^[A-Za-z0-9-]+$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The repo and hook a request's path names: undefined for a path that is not
 * under `/hooks/` (a GitHub delivery's), null for one under it that names no
 * repo and hook.
 *
 * @param {string | undefined} path
 * @returns {{ repo: string, hook: string } | null | undefined}
 */
export const hookPath = (path) => {
  if (typeof path !== 'string' || !path.startsWith(PREFIX)) return undefined;
  const parts = path.slice(PREFIX.length).split('/');
  if (parts.length !== 3) return null;
  const [owner, name, hook] = /** @type {[string, string, string]} */ (parts);
  const repo = `${owner}/${name}`;
  if (!OWNER.test(owner) || !NAME.test(name) || !REPO_NAME.test(repo) || !HOOK_NAME.test(hook)) return null;
  return { repo, hook };
};

/**
 * One hook's key: the HMAC-SHA256 of `<owner>/<repo>|<hook>|v<version>`
 * under the stack's hook secret, as hex. Raising a hook's `keyVersion` in the
 * file moves it to a new key; rotating the secret moves every hook's.
 *
 * @param {string} secret The stack's `governor/hook-secret`.
 * @param {string} repo
 * @param {string} hook
 * @param {number} version
 */
export const hookKey = (secret, repo, hook, version) =>
  createHmac('sha256', secret).update(`${repo}|${hook}|v${version}`).digest('hex');

/**
 * The signature's hex over `body` at `t`: the HMAC-SHA256 of `<t>.<body>`,
 * keyed with the hook key's hex digits as text.
 *
 * @param {string} key
 * @param {number} t
 * @param {string | Buffer} body
 */
const signed = (key, t, body) => createHmac('sha256', key).update(`${t}.`).update(body).digest();

/**
 * The `Governor-Signature` header a caller sends: `v=<version>,t=<unix
 * seconds>,sha256=<hex>`.
 *
 * @param {{ key: string, version: number, t: number, body: string | Buffer }} args
 */
export const hookSignature = ({ key, version, t, body }) => `v=${version},t=${t},sha256=${signed(key, t, body).toString('hex')}`;

const HEADER = /^v=([1-9][0-9]{0,8}),t=([0-9]{1,12}),sha256=([0-9a-f]{64})$/;

/**
 * A `Governor-Signature` header, read: the key version, the time and the
 * hex, or null for anything not of that exact shape.
 *
 * @param {string | undefined} header
 * @returns {{ version: number, t: number, hex: string } | null}
 */
export const readSignature = (header) => {
  const found = HEADER.exec(String(header ?? ''));
  if (found === null) return null;
  return { version: Number(found[1]), t: Number(found[2]), hex: /** @type {string} */ (found[3]) };
};

/**
 * Whether `hex` is the signature of `body` at `t` under the key for `repo`,
 * `hook` and `version`. A constant-time compare, so a wrong signature costs
 * the same as a right one.
 *
 * @param {string} secret
 * @param {{ repo: string, hook: string }} target
 * @param {{ version: number, t: number, hex: string }} signature
 * @param {Buffer} body
 */
export const verifyHook = (secret, { repo, hook }, { version, t, hex }, body) => {
  const expected = signed(hookKey(secret, repo, hook, version), t, body);
  const given = Buffer.from(hex, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
};
