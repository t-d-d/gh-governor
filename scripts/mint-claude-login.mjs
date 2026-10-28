#!/usr/bin/env node
/**
 * Mint a fresh claude.ai login and put it where the dispatcher reads it,
 * without touching the login this machine already holds.
 *
 * Why a login and not a token: creating a Claude Code cloud session needs the
 * `user:sessions:claude_code` scope and a refresh token, which a sign-in
 * grants and `claude setup-token` does not. The default target is the dispatcher task's
 * Secrets Manager secret (infra/governor.cfn.yml), written with the aws CLI
 * under whatever credentials the shell holds; `--to github` puts it in a
 * GitHub Actions secret instead, for a workflow that runs the CLI itself.
 *
 * How it keeps its hands off your own login: the CLI keeps a login under
 * CLAUDE_CONFIG_DIR, and with that variable set it also namespaces the macOS
 * keychain item (scripts/lib/claude-login.mjs). So the sign-in runs under a
 * throwaway directory, the login is read back from there, stored, and the
 * directory and its keychain item are removed. The default `~/.claude` and
 * its keychain item are never read or written.
 *
 * What is stored is one record: the credentials text verbatim, and the
 * account and org UUIDs the sign-in left in that directory's `.claude.json`
 * (`storedLogin`, scripts/lib/claude-login.mjs). The task hands the org to
 * every CLI call it spawns, so none depends on the CLI's profile fetch.
 * Not the email address beside them in that file.
 *
 * What you do: run it, follow the sign-in it starts (a browser on a laptop; a
 * URL to open and a code to paste anywhere else), and read the one line it
 * prints at the end. It needs `claude`, `gh` (signed in, with access to the
 * repository) and, on macOS, `security`. Node built-ins only, so it runs from
 * a bare checkout, CloudShell included.
 *
 *   node scripts/mint-claude-login.mjs --profile admin       # Secrets Manager, governor/claude-login
 *   node scripts/mint-claude-login.mjs --to github --repo <owner/name>   # that repo's CLAUDE_LOGIN_JSON secret
 *   [--secret <id or name>] [--profile <aws profile>]
 *
 * A Secrets Manager mint first names the AWS identity the shell holds and
 * checks it can reach the secret, and stops there if it cannot: the put is
 * the last step, and an everyday CLI user that may not write the secret
 * would otherwise be found out only after the sign-in.
 *
 * It never logs the login out: the CLI's logout is local in this build, but
 * a revoke would kill the copy just stored, so the local copy is deleted
 * instead. Nothing here refreshes the token either; the next refresh is the
 * workflow's, and it rotates the stored refresh token, so run this again
 * only when the workflow reports a dead login.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs as nodeParseArgs } from 'node:util';
import { isCliEntry } from './lib/cli-entry.mjs';
import { accountFromConfig, describeLogin, keychainAccount, keychainServiceName, parseLogin, storedLogin } from './lib/claude-login.mjs';
import { messageOf } from './lib/error-message.mjs';

/**
 * What `spawnSync` hands back: `error` is set, and `status` null, when the
 * program could not be run at all (not on PATH, say).
 *
 * @typedef {{ status: number | null, stdout?: unknown, stderr?: unknown, error?: Error }} Exit
 *
 * @typedef {{
 *   platform: string,
 *   home: string,
 *   pid: number,
 *   env: Record<string, string | undefined>,
 *   username?: string | undefined,
 *   mkdir: (dir: string) => void,
 *   login: (configDir: string) => Exit,
 *   readFile: (path: string) => string,
 *   readKeychain: (service: string, account: string) => string | null,
 *   storeSecret: (name: string, repo: string, text: string) => Exit,
 *   whoAmI: () => Exit,
 *   describeSecret: (secretId: string) => Exit,
 *   storeSecretsManager: (secretId: string, file: string) => Exit,
 *   writeFile: (path: string, text: string) => void,
 *   rm: (dir: string) => void,
 *   deleteKeychain: (service: string, account: string) => Exit,
 *   log: (line: string) => void,
 * }} Deps
 *
 * @typedef {{ ok: true, summary: string } | { ok: false, err: string }} MintResult
 */

/** Where the login goes: a GitHub Actions secret, or the dispatcher's Secrets Manager secret. */
const TARGETS = /** @type {const} */ ({
  github: { defaultSecret: 'CLAUDE_LOGIN_JSON' },
  secretsmanager: { defaultSecret: 'governor/claude-login' },
});

/**
 * @typedef {keyof typeof TARGETS} Target
 * @typedef {{ repo?: string, secret: string, to: Target, profile?: string }} Args
 *   `repo`: the repo whose Actions secret a GitHub mint sets; a GitHub mint needs one.
 */

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export const parseArgs = (argv) => {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      secret: { type: 'string' },
      to: { type: 'string', default: 'secretsmanager' },
      profile: { type: 'string' },
    },
  });
  const to = String(values.to);
  if (!Object.hasOwn(TARGETS, to)) throw new Error(`--to takes ${Object.keys(TARGETS).join(' or ')}, not ${to}`);
  const target = /** @type {Target} */ (to);
  if (target === 'github' && values.repo === undefined) throw new Error('--to github needs --repo owner/name: the repo whose secret it sets');
  return {
    ...(values.repo === undefined ? {} : { repo: values.repo }),
    secret: values.secret ?? TARGETS[target].defaultSecret,
    to: target,
    ...(values.profile === undefined ? {} : { profile: values.profile }),
  };
};

/**
 * An aws CLI argument list under the named profile, when one was given.
 * `--profile admin` is what the operator types elsewhere; AWS_PROFILE in the
 * environment works as well and needs nothing here.
 *
 * @param {string[]} argv
 * @param {string | undefined} profile
 * @returns {string[]}
 */
export const awsArgs = (argv, profile) => (profile === undefined ? argv : [...argv, '--profile', profile]);

/**
 * The environment the sign-in runs under: the caller's, pointed at the
 * throwaway dir. CLAUDE_SECURESTORAGE_CONFIG_DIR is dropped because the CLI
 * (`LNe()`, `pw()`) lets it override CLAUDE_CONFIG_DIR for where the login is
 * stored and how the keychain item is named, and an EMPTY value means the
 * default store. A `claude` session exports it to its children, so a mint run
 * from inside one would otherwise sign in over the operator's own login.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} configDir
 * @returns {Record<string, string | undefined>}
 */
export const loginEnv = (env, configDir) => {
  /** @type {Record<string, string | undefined>} */
  const child = { ...env, CLAUDE_CONFIG_DIR: configDir };
  delete child.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  return child;
};

/**
 * Why a program's exit could not be read as success: its own status, or the
 * reason it never ran.
 *
 * @param {Exit} exit
 */
const exitReason = (exit) =>
  exit.error ? `could not be run: ${messageOf(exit.error)}` : `exited ${exit.status}`;

/**
 * Sign in under a throwaway config dir, read the login back, store it, clean up.
 *
 * @param {Args} args
 * @param {Deps} deps
 * @returns {Promise<MintResult>}
 */
export const mintClaudeLogin = async ({ repo, secret, to, profile }, deps) => {
  const configDir = join(deps.home, `.governor-mint-login-${deps.pid}`);
  const onMac = deps.platform === 'darwin';
  const service = keychainServiceName(configDir);
  const account = keychainAccount(deps.env, deps.username);
  if (to === 'github' && repo === undefined) return { ok: false, err: '--to github needs --repo owner/name: the repo whose secret it sets' };

  if (to === 'secretsmanager') {
    // The put is the last step, after an interactive sign-in. An identity
    // that cannot reach the secret is found out here, before the browser
    // opens: the operator's everyday CLI user is not the one that may write
    // it, the admin profile is. DescribeSecret is the cheapest read that
    // names the secret; an identity that can describe but not write is still
    // caught by the put, after the sign-in.
    //
    // The remedy names what was not done: the flag when none was given, the
    // profile behind the flag when one was.
    const remedy =
      profile === undefined
        ? `re-run with --profile admin, or as an identity that may write ${secret}`
        : `re-run once --profile ${profile} is an identity that may write ${secret}`;
    const who = deps.whoAmI();
    if (who.status !== 0) {
      const stderr = String(who.stderr ?? '').trim();
      return { ok: false, err: `aws sts get-caller-identity failed: ${stderr || exitReason(who)}; ${remedy}; nothing was minted` };
    }
    const identity = String(who.stdout ?? '').trim();
    const reach = deps.describeSecret(secret);
    if (reach.status !== 0) {
      const stderr = String(reach.stderr ?? '').trim();
      return { ok: false, err: `${identity} cannot reach ${secret}: ${stderr || exitReason(reach)}; ${remedy}; nothing was minted` };
    }
    deps.log(`Storing as ${identity}${profile === undefined ? '' : ` (--profile ${profile})`}. If that identity may not write ${secret}, stop now and ${remedy}.`);
  }

  deps.mkdir(configDir);
  try {
    deps.log(`Signing in under ${configDir}. The login in ~/.claude is not touched.`);
    const signIn = deps.login(configDir);
    if (signIn.status !== 0) {
      return { ok: false, err: `claude auth login ${exitReason(signIn)}; nothing was stored` };
    }

    // The keychain on macOS, else the file; the CLI falls back to the file
    // when the keychain refuses the write (locked, none over ssh), so a Mac
    // reads both before concluding nothing was written.
    const item = onMac ? deps.readKeychain(service, account)?.trim() : undefined;
    /** @type {string} */
    let text;
    if (item) {
      text = item;
    } else {
      const path = join(configDir, '.credentials.json');
      try {
        text = deps.readFile(path);
      } catch (err) {
        const where = onMac ? `the keychain under "${service}" for ${account}, or ${path}` : path;
        return { ok: false, err: `no login written to ${where} (${messageOf(err)}); nothing was stored` };
      }
    }

    const parsed = parseLogin(text);
    if (!parsed.ok) return { ok: false, err: `refusing to store what was minted: ${parsed.reason}` };

    // The ids spare the task a lookup per call; without them it still
    // works, looking the org up as before, so their absence is reported,
    // not fatal.
    const configPath = join(configDir, '.claude.json');
    /** @type {ReturnType<typeof accountFromConfig>} */
    let found;
    try {
      found = accountFromConfig(deps.readFile(configPath));
    } catch (err) {
      found = { ok: false, reason: `${configPath} unreadable (${messageOf(err)})` };
    }
    const record = storedLogin(text, found.ok ? found.account : null);
    const minted = `${describeLogin(parsed.login)}; ${
      found.ok ? 'account and org ids stored' : `no account ids (${found.reason}): the task will look the org up on every call`
    }`;

    if (to === 'secretsmanager') {
      // The aws CLI reads the value from a file, so the login never sits in
      // an argument list; the file lives in the throwaway dir, removed below.
      const file = join(configDir, 'login.json');
      deps.writeFile(file, record);
      const stored = deps.storeSecretsManager(secret, file);
      if (stored.status !== 0) {
        const stderr = String(stored.stderr ?? '').trim();
        return { ok: false, err: `aws secretsmanager put-secret-value ${secret} failed: ${stderr || exitReason(stored)}` };
      }
      return { ok: true, summary: `${secret} in Secrets Manager set: ${minted}` };
    }
    // A GitHub mint names its repo: checked before the sign-in.
    const stored = deps.storeSecret(secret, /** @type {string} */ (repo), record);
    if (stored.status !== 0) {
      const stderr = String(stored.stderr ?? '').trim();
      return { ok: false, err: `gh secret set ${secret} failed: ${stderr || exitReason(stored)}` };
    }
    return { ok: true, summary: `${secret} on ${repo} set: ${minted}` };
  } finally {
    deps.rm(configDir);
    if (onMac && deps.deleteKeychain(service, account).status !== 0) {
      // Not fatal, but not silent: what stays behind is a live login.
      deps.log(
        `could not delete the keychain item "${service}" for ${account}; remove it by hand (Keychain Access, or security delete-generic-password -s "${service}")`,
      );
    }
  }
};

/**
 * @param {string | undefined} profile
 * @returns {Deps}
 */
const realDeps = (profile) => ({
  platform: process.platform,
  home: homedir(),
  pid: process.pid,
  env: process.env,
  username: (() => {
    try {
      return userInfo().username;
    } catch {
      return undefined;
    }
  })(),
  mkdir: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
  login: (configDir) =>
    spawnSync('claude', ['auth', 'login'], { stdio: 'inherit', env: loginEnv(process.env, configDir) }),
  readFile: (path) => readFileSync(path, 'utf8'),
  readKeychain: (service, account) => {
    const r = spawnSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
    });
    return r.status === 0 ? r.stdout : null;
  },
  storeSecret: (name, repo, text) =>
    spawnSync('gh', ['secret', 'set', name, '--repo', repo], { input: text, encoding: 'utf8' }),
  whoAmI: () =>
    spawnSync('aws', awsArgs(['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'], profile), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  describeSecret: (secretId) =>
    spawnSync('aws', awsArgs(['secretsmanager', 'describe-secret', '--secret-id', secretId], profile), {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    }),
  storeSecretsManager: (secretId, file) =>
    spawnSync(
      'aws',
      awsArgs(['secretsmanager', 'put-secret-value', '--secret-id', secretId, '--secret-string', `file://${file}`], profile),
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
    ),
  writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  rm: (dir) => rmSync(dir, { recursive: true, force: true }),
  deleteKeychain: (service, account) =>
    spawnSync('security', ['delete-generic-password', '-s', service, '-a', account], { stdio: 'ignore' }),
  log: (line) => console.error(line),
});

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const result = await mintClaudeLogin(args, realDeps(args.profile));
  if (result.ok) {
    console.log(result.summary);
    return 0;
  }
  console.error(`❌ ${result.err}`);
  return 1;
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  process.exit(await main());
}
