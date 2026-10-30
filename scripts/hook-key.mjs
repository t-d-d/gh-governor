#!/usr/bin/env node
/**
 * Mint one hook's key: read the stack's hook secret with the operator's AWS
 * identity, derive the key for a repo, a hook and a key version
 * (dispatch/webhook/hook.mjs), and print it as the one value a caller stores.
 *
 *   node scripts/hook-key.mjs --repo <owner/repo> --hook <name> --version <n> [--profile <aws profile>]
 *
 * It prints `v<version>.<hex key>` and nothing else: the caller needs the
 * version for its header's `v=`, and the hex digits, as text, to sign with.
 * Run it once per hook, and again after raising the hook's `keyVersion` in
 * the repo's config file. Node built-ins and the aws CLI only.
 */

import { spawnSync } from 'node:child_process';
import { parseArgs as nodeParseArgs } from 'node:util';
import { HOOK_NAME, REPO_NAME } from '../dispatch/webhook/fire.mjs';
import { hookKey } from '../dispatch/webhook/hook.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The secret the stack generates (infra/governor.cfn.yml, HookSecret). */
export const HOOK_SECRET_ID = 'governor/hook-secret';

/** @typedef {{ repo: string, hook: string, version: number, profile?: string }} Args */

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export const parseArgs = (argv) => {
  const { values } = nodeParseArgs({
    args: argv,
    options: { repo: { type: 'string' }, hook: { type: 'string' }, version: { type: 'string' }, profile: { type: 'string' } },
  });
  if (!REPO_NAME.test(values.repo ?? '')) throw new Error('--repo is the served repo, as owner/repo');
  if (!HOOK_NAME.test(values.hook ?? '')) throw new Error('--hook is the hook\'s name in the repo\'s config file: lower-case letters, digits and hyphens');
  if (!/^[1-9][0-9]{0,8}$/.test(values.version ?? '')) throw new Error('--version is the hook\'s keyVersion, a positive whole number');
  return {
    repo: /** @type {string} */ (values.repo),
    hook: /** @type {string} */ (values.hook),
    version: Number(values.version),
    ...(values.profile ? { profile: values.profile } : {}),
  };
};

/**
 * The line a caller stores: `v<version>.<hex key>`.
 *
 * @param {Args} args
 * @param {(secretId: string, profile: string | undefined) => string} readSecret
 */
export const keyLine = (args, readSecret) => {
  const secret = readSecret(HOOK_SECRET_ID, args.profile).trim();
  if (secret === '') throw new Error(`${HOOK_SECRET_ID} is empty`);
  return `v${args.version}.${hookKey(secret, args.repo, args.hook, args.version)}`;
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  try {
    console.log(keyLine(parseArgs(process.argv.slice(2)), (secretId, profile) => {
      const read = spawnSync('aws', [
        'secretsmanager', 'get-secret-value', '--secret-id', secretId, '--query', 'SecretString', '--output', 'text',
        ...(profile ? ['--profile', profile] : []),
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (read.status !== 0) throw new Error(`aws secretsmanager get-secret-value ${secretId} failed: ${String(read.stderr ?? '').trim()}`);
      return String(read.stdout);
    }));
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
}
