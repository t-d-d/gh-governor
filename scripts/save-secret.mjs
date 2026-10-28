#!/usr/bin/env node
/**
 * Save the App key or the drop-box writer into the secret the bootstrap
 * stack created for it (infra/bootstrap.cfn.yml). The operator runs it once
 * per value, and again to rotate one; the claude.ai login has its own
 * script, scripts/mint-claude-login.mjs.
 *
 *   node scripts/save-secret.mjs github-app --app-id <id> --file <app.pem> [--profile <aws profile>]
 *   node scripts/save-secret.mjs session-log-writer --file <writer.txt> [--profile <aws profile>]
 *
 * The value is read from a file and handed to the aws CLI as a file, so it
 * never sits in an argument list or the shell's history. The file the CLI
 * reads is removed whether the write succeeded or not. Node built-ins only.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs as nodeParseArgs } from 'node:util';
import { isCliEntry } from './lib/cli-entry.mjs';

/** Each secret this script writes, by the name it is given on the command line. */
export const SECRETS = Object.freeze({
  'github-app': 'governor/github-app',
  'session-log-writer': 'governor/session-log-writer',
});

/** @typedef {{ kind: keyof typeof SECRETS, file: string, appId?: string, profile?: string }} Args */

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export const parseArgs = (argv) => {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    allowPositionals: true,
    options: { file: { type: 'string' }, 'app-id': { type: 'string' }, profile: { type: 'string' } },
  });
  const [kind] = positionals;
  if (kind !== 'github-app' && kind !== 'session-log-writer') throw new Error('name the secret: github-app or session-log-writer');
  if (!values.file) throw new Error('--file names the file holding the value');
  if (kind === 'github-app' && !/^[1-9][0-9]*$/.test(values['app-id'] ?? '')) throw new Error('--app-id is the App\'s numeric ID');
  return {
    kind,
    file: values.file,
    ...(kind === 'github-app' ? { appId: values['app-id'] } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
  };
};

/**
 * @typedef {object} Io
 * @property {(path: string) => string} readFile
 * @property {(text: string) => string} writeTemp - Writes `text` to a file only this user reads, and returns its path.
 * @property {(path: string) => void} remove
 * @property {(secretId: string, file: string, profile: string | undefined) => { status: number | null, stderr?: unknown }} put
 * @property {(line: string) => void} log
 */

/**
 * The secret's text as the task reads it.
 *
 * @param {Args} args
 * @param {string} text - The file's contents.
 */
const secretString = (args, text) => {
  if (args.kind === 'github-app') {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error(`${args.file} is not a PEM private key`);
    return JSON.stringify({ appId: args.appId, privateKey: text });
  }
  const writer = text.trim();
  if (!writer) throw new Error(`${args.file} is empty`);
  // The turn reads any other shape as no writer and ships nothing
  // (dispatch/turn.mjs, `transcript`).
  if (!/^[0-9a-f]{32,}$/.test(writer)) throw new Error(`${args.file} is not a drop-box writer: it holds 32 or more lowercase hex digits`);
  return writer;
};

/**
 * @param {Args} args
 * @param {Io} io
 */
export const saveSecret = (args, io) => {
  const secretId = SECRETS[args.kind];
  const value = secretString(args, io.readFile(args.file));
  const file = io.writeTemp(value);
  try {
    const exit = io.put(secretId, file, args.profile);
    if (exit.status !== 0) throw new Error(`aws secretsmanager put-secret-value ${secretId} failed: ${String(exit.stderr ?? '').trim()}`);
  } finally {
    io.remove(file);
  }
  io.log(`Saved ${args.kind} into ${secretId}.`);
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  try {
    saveSecret(parseArgs(process.argv.slice(2)), {
      readFile: (path) => readFileSync(path, 'utf8'),
      writeTemp: (text) => {
        const path = join(mkdtempSync(join(tmpdir(), 'governor-secret-')), 'value');
        writeFileSync(path, text, { mode: 0o600 });
        return path;
      },
      remove: (path) => rmSync(join(path, '..'), { recursive: true, force: true }),
      put: (secretId, file, profile) => spawnSync('aws', [
        'secretsmanager', 'put-secret-value', '--secret-id', secretId, '--secret-string', `file://${file}`,
        ...(profile ? ['--profile', profile] : []),
      ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }),
      log: console.log,
    });
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
}
