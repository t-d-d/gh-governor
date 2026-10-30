#!/usr/bin/env node
/**
 * Mint one hook's key and set up its caller: read the stack's hook secret and
 * its `WebhookUrl` output with the operator's AWS identity, derive the key for
 * a repo, a hook and a key version (dispatch/webhook/hook.mjs), and build the
 * hook's full URL.
 *
 *   node scripts/hook-key.mjs --repo <owner/repo> --hook <name> [--version <n>]
 *     [--env <environment>] [--key-name <name>] [--url-name <name>]
 *     [--profile <aws profile>] [--stack governor]
 *
 * Without `--version`, the version is the hook's `keyVersion` in the repo's
 * config file on its default branch, so a new hook's config change merges
 * first. With `--env`, it saves the key as a secret and the URL as a variable
 * in that environment of the repo, which must exist, and never shows the key.
 * Without it, stdout is `v<version>.<hex key>` and nothing else, and stderr
 * has the URL and the two commands that save both values. The caller needs the
 * version for its header's `v=`, and the hex digits, as text, to sign with.
 *
 * Run it once per hook, and again after raising the hook's `keyVersion`. It
 * needs Node, the aws CLI with access to the stack, and the gh CLI logged in
 * as someone who may read the repo and, for `--env`, set its secrets.
 */

import { spawnSync } from 'node:child_process';
import { parseArgs as nodeParseArgs } from 'node:util';
import { HOOK_NAME, REPO_NAME } from '../dispatch/webhook/fire.mjs';
import { hookKey } from '../dispatch/webhook/hook.mjs';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { URL_OUTPUT, readWebhookUrl, urlUnder } from './lib/conformance-webhook-url.mjs';

/** The secret the stack generates (infra/governor.cfn.yml, HookSecret). */
export const HOOK_SECRET_ID = 'governor/hook-secret';
/** The stack read when `--stack` is unset, as in scripts/run-turn.mjs. */
export const DEFAULT_STACK = 'governor';
export const DEFAULT_KEY_NAME = 'GOVERNOR_HOOK_KEY';
export const DEFAULT_URL_NAME = 'GOVERNOR_HOOK_URL';

/** The environments API's largest page. */
const PER_PAGE = 100;

/**
 * @typedef {{
 *   repo: string, hook: string, version?: number, profile?: string, stack?: string, env?: string,
 *   keyName: string, urlName: string,
 * }} Args
 * @typedef {{
 *   aws: (argv: string[]) => string,
 *   gh: (argv: string[], input?: string) => string,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 * }} Io
 *   `aws` and `gh` answer the CLI's stdout and throw with its message when
 *   the call fails. `gh` takes `input` on stdin.
 */

/**
 * A secret or variable name GitHub takes: letters, digits and underscores,
 * not starting with a digit or with `GITHUB_`, in any case.
 *
 * @param {string} flag
 * @param {string} name
 */
const githubName = (flag, name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^GITHUB_/i.test(name)) {
    throw new Error(`${flag} is a name GitHub takes: letters, digits and underscores, not starting with a digit or GITHUB_`);
  }
  return name;
};

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export const parseArgs = (argv) => {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      repo: { type: 'string' }, hook: { type: 'string' }, version: { type: 'string' }, profile: { type: 'string' },
      stack: { type: 'string' }, env: { type: 'string' }, 'key-name': { type: 'string' }, 'url-name': { type: 'string' },
    },
  });
  if (!REPO_NAME.test(values.repo ?? '')) throw new Error('--repo is the served repo, as owner/repo');
  if (!HOOK_NAME.test(values.hook ?? '')) throw new Error('--hook is the hook\'s name in the repo\'s config file: lower-case letters, digits and hyphens');
  if (values.version !== undefined && !/^[1-9][0-9]{0,8}$/.test(values.version)) throw new Error('--version is the hook\'s keyVersion, a positive whole number');
  if (values.env !== undefined && values.env.trim() === '') throw new Error('--env is the name of an environment of the repo');
  return {
    repo: /** @type {string} */ (values.repo),
    hook: /** @type {string} */ (values.hook),
    ...(values.version === undefined ? {} : { version: Number(values.version) }),
    ...(values.profile ? { profile: values.profile } : {}),
    ...(values.stack ? { stack: values.stack } : {}),
    ...(values.env === undefined ? {} : { env: values.env }),
    keyName: githubName('--key-name', values['key-name'] ?? DEFAULT_KEY_NAME),
    urlName: githubName('--url-name', values['url-name'] ?? DEFAULT_URL_NAME),
  };
};

/**
 * The line a caller stores: `v<version>.<hex key>`.
 *
 * @param {{ repo: string, hook: string, version: number, profile?: string }} args
 * @param {(secretId: string, profile: string | undefined) => string} readSecret
 */
export const keyLine = (args, readSecret) => {
  const secret = readSecret(HOOK_SECRET_ID, args.profile).trim();
  if (secret === '') throw new Error(`${HOOK_SECRET_ID} is empty`);
  return `v${args.version}.${hookKey(secret, args.repo, args.hook, args.version)}`;
};

/**
 * The hook's full URL under the stack's `WebhookUrl`.
 *
 * @param {string} base
 * @param {string} repo
 * @param {string} hook
 */
export const hookUrl = (base, repo, hook) => urlUnder(base, `hooks/${repo}/${hook}`);

/**
 * The hook's `keyVersion` in the repo's config file on its default branch.
 *
 * @param {Args} args
 * @param {Io['gh']} gh
 * @returns {number}
 */
const configuredVersion = ({ repo, hook }, gh) => {
  const refuse = (/** @type {string} */ why) => new Error(
    `cannot read hook ${hook}'s keyVersion for ${repo}: ${why}. A new hook's config change must merge to the default branch first, or pass --version`,
  );
  let text;
  try {
    // No ref: the contents API reads the default branch.
    text = gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${CONFIG_PATH}`]);
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
    if (/HTTP 404/.test(message)) throw refuse(`${repo} has no ${CONFIG_PATH} on its default branch, or gh cannot see the repo`);
    throw new Error(`gh could not read ${CONFIG_PATH} from ${repo} for hook ${hook}: ${message}`);
  }
  const read = readConfig(text);
  if (!read.ok) throw refuse(`${CONFIG_PATH} is invalid (${read.fault})`);
  if (read.config.features.hooks !== true) throw refuse(`${CONFIG_PATH} turns hooks off`);
  const listed = read.config.hooks.find((h) => h.name === hook);
  if (listed === undefined) throw refuse(`${CONFIG_PATH} lists no hook named ${hook}`);
  return listed.keyVersion;
};

/**
 * Every environment name the repo has, page by page.
 *
 * @param {string} repo
 * @param {Io['gh']} gh
 * @returns {string[]}
 */
const environmentsOf = (repo, gh) => {
  /** @type {string[]} */
  const names = [];
  for (let page = 1; ; page += 1) {
    const { total_count: total, environments = [] } = JSON.parse(gh(['api', `repos/${repo}/environments?per_page=${PER_PAGE}&page=${page}`]));
    names.push(...environments.map((/** @type {{ name: string }} */ e) => e.name));
    if (environments.length === 0 || names.length >= total) return names;
  }
};

/**
 * A word a POSIX shell reads back as itself.
 *
 * @param {string} word
 */
const shellWord = (word) => (/^[A-Za-z0-9_./:@=,+-]+$/.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`);

/**
 * The two commands that save the key and the URL, for an owner who runs them
 * by hand. The secret's run repeats the flags this one was given. Its key goes
 * to a shell variable and from there to gh's stdin through printf, a shell
 * builtin, so the key is in no command line. A plain pipe would start gh even
 * when the run fails, and gh would save the empty stdin over a working key.
 * The parentheses make it a subshell, so the variable ends with the command
 * and does not stay in, or overwrite a `key` of, the owner's shell.
 *
 * @param {Args} args
 * @param {string} url
 * @returns {string[]}
 */
export const saveCommands = (args, url) => {
  const run = ['node', 'scripts/hook-key.mjs', '--repo', args.repo, '--hook', args.hook,
    ...(args.version === undefined ? [] : ['--version', String(args.version)]),
    ...(args.profile ? ['--profile', args.profile] : []),
    ...(args.stack ? ['--stack', args.stack] : []),
  ].map(shellWord).join(' ');
  const scope = `--repo ${shellWord(args.repo)} --env <environment>`;
  return [
    `(key="$(${run})" && printf '%s' "$key" | gh secret set ${args.keyName} ${scope})`,
    `gh variable set ${args.urlName} ${scope} --body ${shellWord(url)}`,
  ];
};

/**
 * One run: the key and the URL, then either both printed as above or both
 * saved to `--env`.
 *
 * @param {Args} args
 * @param {Io} io
 */
export const run = (args, io) => {
  const stack = args.stack ?? DEFAULT_STACK;
  const base = readWebhookUrl(stack, args.profile, io.aws);
  if (base === undefined) throw new Error(`stack ${stack} has no ${URL_OUTPUT} output, so there is no URL for the hook`);
  const url = hookUrl(base, args.repo, args.hook);
  const version = args.version ?? configuredVersion(args, io.gh);
  if (args.env !== undefined) {
    // GitHub matches an environment's name in any case. Checked before the
    // hook secret is read, so a run that can write nothing never reads it.
    const wanted = args.env.toLowerCase();
    const names = environmentsOf(args.repo, io.gh);
    if (!names.some((name) => name.toLowerCase() === wanted)) {
      throw new Error(`${args.repo} has no environment named ${args.env}, and this script creates none. `
        + (names.length === 0 ? `${args.repo} has no environments.` : `Its environments: ${names.join(', ')}.`));
    }
  }
  const key = keyLine({ repo: args.repo, hook: args.hook, version, ...(args.profile ? { profile: args.profile } : {}) }, (secretId, profile) => io.aws([
    'secretsmanager', 'get-secret-value', '--secret-id', secretId, '--query', 'SecretString', '--output', 'text',
    ...(profile ? ['--profile', profile] : []),
  ]));

  if (args.env === undefined) {
    io.out(key);
    io.err(`The hook's URL: ${url}`);
    io.err('Save the key and the URL in the caller\'s environment:');
    for (const command of saveCommands(args, url)) io.err(`  ${command}`);
    return;
  }

  const scope = ['--repo', args.repo, '--env', args.env];
  io.gh(['secret', 'set', args.keyName, ...scope], key);
  try {
    io.gh(['variable', 'set', args.urlName, ...scope, '--body', url]);
  } catch (error) {
    throw new Error(`${args.repo}'s ${args.env} environment now holds the secret ${args.keyName}, but saving the variable ${args.urlName} failed: ${/** @type {Error} */ (error).message}`);
  }
  io.out(`${args.repo}, environment ${args.env}:`);
  io.out(`  secret ${args.keyName}: the hook's key, version ${version}`);
  io.out(`  variable ${args.urlName}: ${url}`);
};

/**
 * Runs a CLI and answers its stdout, throwing with its stderr on failure.
 *
 * @param {string} cli
 * @param {string[]} argv
 * @param {string} [input]
 */
const runCli = (cli, argv, input) => {
  const done = spawnSync(cli, argv, { encoding: 'utf8', input: input ?? '', stdio: ['pipe', 'pipe', 'pipe'] });
  if (done.error) throw new Error(`${cli} could not run: ${done.error.message}`);
  if (done.status !== 0) throw new Error(`${cli} ${argv.slice(0, 2).join(' ')} failed: ${String(done.stderr ?? '').trim()}`);
  return String(done.stdout);
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  try {
    run(parseArgs(process.argv.slice(2)), {
      aws: (argv) => runCli('aws', argv),
      gh: (argv, input) => runCli('gh', argv, input),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
}
