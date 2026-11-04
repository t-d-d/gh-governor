// app-permissions and installation-permissions: the repository permissions
// the App holds, and those each installation on a listed owner has accepted,
// against the ones governor uses (APP_PERMISSIONS, dispatch/webhook/route.mjs).
//
// The owner sets the App's permissions by hand in its settings, and each
// installation accepts a change by hand, so the App can hold a permission an
// installation has not accepted yet. Either gap shows only as a 403 where
// governor uses it, and on a public repo GitHub serves the reads anyway, so a
// missing read stays hidden until a private repo needs it.
//
// The App's permissions come from GitHub's public App endpoint, which answers
// with no credential. The installations come from `/app/installations`, read
// as the App with the key the deploy points the webhook with. The deploy's
// log is public, so an installation is named by its account and its id is
// never printed (docs/constraints/public-repo.md).

import { APP_PERMISSIONS } from '../../dispatch/webhook/route.mjs';
import { ownersOf } from '../../dispatch/webhook/fire.mjs';
import { APP_SLUG_VAR } from './conformance-app-events.mjs';
import { appJwt, githubApi } from './github-app.mjs';

/** What the installations check reads; the deploy's read-back step sets each. */
export const INSTALLATION_VARS = Object.freeze(['APP_ID', 'APP_PRIVATE_KEY', 'GOVERNOR_OWNERS']);

const READ_TIMEOUT_MS = 30_000;

/** @type {Readonly<Record<string, number>>} */
const RANK = Object.freeze({ read: 1, write: 2, admin: 3 });

/**
 * @typedef {Readonly<Record<string, string>>} Permissions GitHub's
 *   `permissions` object: a permission's key to its level.
 * @typedef {{ id: number, account: string, permissions: Permissions }} Installation
 *   `id` is read only to be left out of every line printed.
 */

/**
 * Each permission governor uses that `held` lacks or holds below its level,
 * as `Name (level)` or `Name (level, holds lower)`. A higher level passes.
 *
 * @param {Permissions} held
 * @param {typeof APP_PERMISSIONS} needed
 * @returns {string[]}
 */
const gaps = (held, needed) => needed.flatMap(({ key, name, level }) => {
  const has = held[key];
  if ((RANK[has ?? ''] ?? 0) >= (RANK[level] ?? 0)) return [];
  return [has ? `${name} (${level}, holds ${has})` : `${name} (${level})`];
});

/**
 * The finding on the App's own permissions.
 *
 * @param {{ slug: string, permissions: Permissions | undefined, needed?: typeof APP_PERMISSIONS }} sides
 *   `permissions` is undefined when GitHub answers for no such App.
 * @returns {string[]}
 */
export function appPermissionFindings({ slug, permissions, needed = APP_PERMISSIONS }) {
  if (permissions === undefined) {
    return [`GitHub answers for no App ${slug}, so none of its permissions could be read`];
  }
  const missing = gaps(permissions, needed);
  if (missing.length === 0) return [];
  return [
    `the ${slug} App does not hold ${missing.join(', ')}, which governor uses `
    + '(APP_PERMISSIONS, dispatch/webhook/route.mjs), so governor gets a 403 where it needs them. '
    + 'Grant them under the App\'s settings, Permissions & events, then accept them on each installation',
  ];
}

/**
 * The findings on each installation on a listed owner, one per installation
 * with a gap, naming it by its account. An installation on an owner not on
 * the list is not governor's to serve, and fails nothing.
 *
 * @param {{ owners: readonly string[], installations: readonly Installation[], needed?: typeof APP_PERMISSIONS }} sides
 * @returns {string[]}
 */
export function installationPermissionFindings({ owners, installations, needed = APP_PERMISSIONS }) {
  return listedOnly(owners, installations).flatMap(({ account, permissions }) => {
    const missing = gaps(permissions, needed);
    if (missing.length === 0) return [];
    return [
      `the installation on ${account} has not accepted ${missing.join(', ')}, so governor gets a 403 in its repos. `
      + `Accept the App's permissions in ${account}'s settings, under Applications`,
    ];
  });
}

/**
 * @param {readonly string[]} owners
 * @param {readonly Installation[]} installations
 */
const listedOnly = (owners, installations) => {
  const listed = owners.map((o) => o.toLowerCase());
  return installations.filter((i) => listed.includes(i.account.toLowerCase()));
};

/** @param {Permissions} permissions */
const said = (permissions) => Object.entries(permissions).map(([k, v]) => `${k} ${v}`).sort().join(', ') || '(none)';

/**
 * The permissions GitHub says the App holds, or undefined for no such App.
 *
 * @param {string} slug
 * @returns {Promise<Permissions | undefined>}
 */
async function readAppPermissions(slug) {
  const response = await fetch(`https://api.github.com/apps/${encodeURIComponent(slug)}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET /apps/${slug} failed: ${response.status} ${response.statusText}`);
  const body = /** @type {{ permissions?: unknown }} */ (await response.json());
  return permissionsOf(body.permissions);
}

/**
 * @param {unknown} raw
 * @returns {Permissions}
 */
const permissionsOf = (raw) => (raw && typeof raw === 'object'
  ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]))
  : {});

/**
 * Every installation of the App, as the App. A failed read throws with its
 * path, which carries no installation id.
 *
 * @param {{ appId: string, privateKeyPem: string }} key
 * @returns {Promise<Installation[]>}
 */
async function readInstallations({ appId, privateKeyPem }) {
  const app = githubApi({ token: appJwt({ appId, privateKeyPem }) });
  /** @type {Installation[]} */
  const out = [];
  for (let page = 1; ; page += 1) {
    /** @type {any[]} */
    const batch = await app('GET', `/app/installations?per_page=100&page=${page}`);
    for (const row of batch) {
      out.push({ id: Number(row?.id), account: String(row?.account?.login ?? ''), permissions: permissionsOf(row?.permissions) });
    }
    if (batch.length < 100) return out;
  }
}

/**
 * The runner reports it not applicable, and never calls it, while
 * GOVERNOR_APP_SLUG is unset.
 *
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   readPermissions?: typeof readAppPermissions,
 * }} options - `env` from the runner; the io from this member's own tests.
 * @returns {Promise<import('../conformance.mjs').CheckOutcome>}
 */
export async function checkAppPermissions({ env, ...io }) {
  const slug = /** @type {string} */ (env[APP_SLUG_VAR]);
  const permissions = await (io.readPermissions ?? readAppPermissions)(slug);
  return {
    findings: appPermissionFindings({ slug, permissions }),
    // Said out loud on every run, finding or not.
    notes: [`${slug} holds: ${permissions === undefined ? '(no such App)' : said(permissions)}`],
  };
}

/**
 * The runner reports it not applicable, and never calls it, while any of
 * INSTALLATION_VARS is unset.
 *
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   readInstallations?: typeof readInstallations,
 * }} options - `env` from the runner; the io from this member's own tests.
 * @returns {Promise<import('../conformance.mjs').CheckOutcome>}
 */
export async function checkInstallationPermissions({ env, ...io }) {
  const owners = ownersOf(env.GOVERNOR_OWNERS);
  const installations = await (io.readInstallations ?? readInstallations)({
    appId: String(env.APP_ID),
    privateKeyPem: String(env.APP_PRIVATE_KEY),
  });
  const listed = listedOnly(owners, installations);
  return {
    findings: installationPermissionFindings({ owners, installations }),
    // Each listed installation by its account, never its id: the log is public.
    notes: listed.length === 0
      ? [`no installation on ${owners.join(', ')}`]
      : listed.map((i) => `${i.account} accepted: ${said(i.permissions)}`),
  };
}
