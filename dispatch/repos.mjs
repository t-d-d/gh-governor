/**
 * Which repos the dispatcher serves: a repo an account on the
 * stack's owner list installed the dispatcher's App on, whose default
 * branch carries a config file that reads valid (dispatch/repo-config.mjs).
 *
 * The bare schedule fire lists the App's installations on listed owners and
 * keeps the repos whose file reads valid ({@link servedRepos}); a fire that
 * names its repo reads that one repo ({@link repoServed}). A listing or a
 * token mint that fails refuses the turn. A contents read that fails refuses
 * that repo's part of the turn, and is never taken for a missing file. No
 * file is `not served`, at info. A file that fails its schema, or names an
 * environment no one environment in the login's list has, is an alarmed
 * `dispatch-config-invalid` naming the repo and the fault. An environment
 * list read that fails refuses the repo's part as a failed contents read does.
 * So does a prompt file's read; a prompt file that is
 * missing or empty is `dispatch-config-invalid`, naming the key and path.
 */

import { CONFIG_PATH, environmentFrom, namesEnvironment, readConfig, resolveFiles } from './repo-config.mjs';
import { ownerListed } from './webhook/fire.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/** The event an invalid config file logs; its own alarm pages on it (infra/governor.cfn.yml). */
export const CONFIG_INVALID = 'dispatch-config-invalid';

/**
 * @typedef {{ repo: string, token: string, config: import('./repo-config.mjs').RepoConfig }} Served
 *
 * @typedef {{
 *   owners: readonly string[],
 *   token: (repo: string) => Promise<string>,
 *   config: (repo: string, token: string, path?: string) => Promise<string | null>,
 *   environments: () => Promise<unknown>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} Reads
 *   `token`: an installation token for the repo; a mint that fails throws.
 *   `config`: the config file's text on the repo's default branch, or the
 *   text of the file at `path` beside it (a prompt file), null
 *   when GitHub says it is not there; any other failure throws.
 *   `environments`: the login's cloud environment list, parsed, read only
 *   for a file that names its environment; a read that fails throws.
 */

/** Whether `account` is on the owner list: the receiver's own test (webhook/fire.mjs). */
export { ownerListed };

/**
 * One repo's file, read and judged: served, not served, or unread (the
 * error, and what could not be read, for the caller to refuse on).
 *
 * @param {Reads} reads
 * @param {string} repo
 * @returns {Promise<{ served: Served } | { notServed: true } | { unread: string, what: string }>}
 */
const judge = async ({ token: mint, config, environments, log }, repo) => {
  const token = await mint(repo);
  /** @type {string | null} */
  let text;
  try {
    text = await config(repo, token);
  } catch (error) {
    log('dispatch-config-unread', { level: 'error', repo, error: messageOf(error) });
    return { unread: messageOf(error), what: `${repo}'s ${CONFIG_PATH}` };
  }
  if (text === null) {
    log('dispatch-not-served', { level: 'info', repo, reason: `no ${CONFIG_PATH} on its default branch` });
    return { notServed: true };
  }
  const parsed = readConfig(text);
  if (!parsed.ok) {
    log(CONFIG_INVALID, { level: 'error', repo, fault: parsed.fault });
    return { notServed: true };
  }
  /** @type {Awaited<ReturnType<typeof resolveFiles>>} */
  let read;
  try {
    read = await resolveFiles(parsed.config, (path) => config(repo, token, path).catch((error) => { throw new Error(`${path}: ${messageOf(error)}`); }));
  } catch (error) {
    log('dispatch-config-unread', { level: 'error', repo, error: messageOf(error) });
    return { unread: messageOf(error), what: `a prompt file ${CONFIG_PATH} names in ${repo}` };
  }
  if (!read.ok) {
    log(CONFIG_INVALID, { level: 'error', repo, fault: read.fault });
    return { notServed: true };
  }
  const { environment } = read.config;
  if (!namesEnvironment(environment)) return { served: { repo, token, config: read.config } };
  /** @type {ReturnType<typeof environmentFrom>} */
  let resolved;
  try {
    resolved = environmentFrom(environment, await environments());
  } catch (error) {
    log('dispatch-environments-unread', { level: 'error', repo, error: messageOf(error) });
    return { unread: messageOf(error), what: `the login's cloud environment list for ${repo}` };
  }
  if ('fault' in resolved) {
    log(CONFIG_INVALID, { level: 'error', repo, fault: `environment: ${resolved.fault}` });
    return { notServed: true };
  }
  return { served: { repo, token, config: { ...read.config, environment: resolved.id } } };
};

/**
 * Every served repo, for the bare schedule fire, and the repos whose file
 * could not be read.
 *
 * @param {Reads & { installations: () => Promise<Array<{ account: string, repos: string[] }>> }} reads
 * @returns {Promise<{ served: Served[], unread: Array<{ repo: string, error: string }> }>}
 */
export const servedRepos = async (reads) => {
  /** @type {Served[]} */
  const served = [];
  /** @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  for (const { account, repos } of await reads.installations()) {
    if (!ownerListed(reads.owners, account)) {
      reads.log('dispatch-not-served', { level: 'info', account, reason: 'the account is not on the owner list' });
      continue;
    }
    for (const repo of repos) {
      const judged = await judge(reads, repo);
      if ('served' in judged) served.push(judged.served);
      else if ('unread' in judged) unread.push({ repo, error: judged.unread });
    }
  }
  return { served, unread };
};

/**
 * The repo a fire names, when it is served; null when it is not. A read
 * that fails throws: the turn refuses.
 *
 * @param {Reads & { repo: string }} reads
 * @returns {Promise<Served | null>}
 */
export const repoServed = async (reads) => {
  const owner = reads.repo.split('/')[0] ?? '';
  if (!ownerListed(reads.owners, owner)) {
    reads.log('dispatch-not-served', { level: 'info', repo: reads.repo, reason: 'its owner is not on the owner list' });
    return null;
  }
  const judged = await judge(reads, reads.repo);
  if ('unread' in judged) throw new Error(`could not read ${judged.what}: ${judged.unread}`);
  return 'served' in judged ? judged.served : null;
};
