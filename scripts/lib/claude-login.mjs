/**
 * A stored claude.ai login, as the Claude Code CLI (2.1.282) keeps it, and
 * what tells it apart from a `claude setup-token` grant.
 *
 * Both shapes sit under one `claudeAiOauth` key. A login, the thing `/login`
 * or `claude auth login` writes, carries an access token, a refresh token,
 * their expiries and the scopes the sign-in granted, among them
 * `user:sessions:claude_code`. A setup-token carries an access token with
 * `user:inference` alone and no refresh token; the session-create endpoint
 * answers it with 403, which is how the first hosted-dispatch spike ended.
 * So the one check that matters before storing anything is the
 * session scope beside a refresh token, and `parseLogin` is that check.
 *
 * Where the CLI keeps the login depends on the platform and on
 * CLAUDE_CONFIG_DIR. On Linux it is `<config dir>/.credentials.json`. On
 * macOS it is a keychain item whose service name the CLI derives from the
 * config dir when that variable is set: the constant name with the first
 * eight hex digits of sha256(dir) appended, the dir in NFC form
 * (`LNe()` in the binary). Without the variable the name has no suffix and
 * is the operator's own login, which nothing here touches.
 *
 * Node built-ins only, on purpose: the mint script runs on a laptop and in
 * CloudShell from a bare checkout, with no `npm ci`.
 */

import { createHash } from 'node:crypto';

/** The scope a login carries and a setup-token does not. */
export const SESSION_SCOPE = 'user:sessions:claude_code';

/** The service name the CLI gives its keychain item with no config dir set. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * The macOS keychain service name for a login stored under `configDir`.
 *
 * @param {string} configDir Absolute path, as given to CLAUDE_CONFIG_DIR.
 * @returns {string}
 */
export const keychainServiceName = (configDir) =>
  `${KEYCHAIN_SERVICE}-${createHash('sha256')
    .update(configDir.normalize('NFC'))
    .digest('hex')
    .slice(0, 8)}`;

/**
 * The keychain account name the CLI stores under: the `USER` variable when it
 * is a plain identifier, else a fixed fallback (`M5()` in the binary).
 *
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} [username] `os.userInfo().username`, tried after `USER`.
 * @returns {string}
 */
export const keychainAccount = (env, username) => {
  const name = env.USER || username || '';
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
};

/**
 * @typedef {{
 *   accessToken: string,
 *   refreshToken: string,
 *   expiresAt?: number,
 *   refreshTokenExpiresAt?: number,
 *   scopes: string[],
 *   [key: string]: unknown,
 * }} ClaudeAiOauth
 *
 * @typedef {{ claudeAiOauth: ClaudeAiOauth, [key: string]: unknown }} StoredLogin
 */

/**
 * Parse the text of a credentials file and say whether it is a login.
 *
 * @param {string} text
 * @returns {{ ok: true, login: StoredLogin } | { ok: false, reason: string }}
 */
export const parseLogin = (text) => {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not an object' };
  const oauth = /** @type {{ claudeAiOauth?: unknown }} */ (parsed).claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return { ok: false, reason: 'no claudeAiOauth entry' };
  const { accessToken, refreshToken, scopes } = /** @type {Record<string, unknown>} */ (oauth);
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, reason: 'no access token' };
  }
  // The CLI writes "" for a refresh token the server refused (invalid_grant),
  // so an empty string is a dead login, not a login with a quirk.
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    return { ok: false, reason: 'no refresh token: a setup-token, or a login the server has already refused' };
  }
  if (!Array.isArray(scopes) || !scopes.includes(SESSION_SCOPE)) {
    return { ok: false, reason: `scopes lack ${SESSION_SCOPE}: a setup-token, not a login` };
  }
  return { ok: true, login: /** @type {StoredLogin} */ (parsed) };
};

/**
 * The account a login belongs to: the two ids the CLI keeps in
 * `.claude.json`'s `oauthAccount`. The CLI resolves the org UUID for a cloud
 * call from CLAUDE_CODE_ORGANIZATION_UUID, then `oauthAccount`, then a
 * profile fetch whose failure it reports without its cause, so a
 * login carried off its machine carries these with it. Never the email
 * address beside them: no log or secret needs it.
 *
 * @typedef {{ accountUuid: string, organizationUuid: string }} LoginAccount
 */

/**
 * The two ids out of an `oauthAccount`-shaped value, or null when either is
 * missing or empty.
 *
 * @param {unknown} value
 * @returns {LoginAccount | null}
 */
const accountOf = (value) => {
  if (!value || typeof value !== 'object') return null;
  const { accountUuid, organizationUuid } = /** @type {Record<string, unknown>} */ (value);
  if (typeof accountUuid !== 'string' || accountUuid === '') return null;
  if (typeof organizationUuid !== 'string' || organizationUuid === '') return null;
  return { accountUuid, organizationUuid };
};

/**
 * The account ids in the text of a `.claude.json`, and nothing else from it.
 *
 * @param {string} text
 * @returns {{ ok: true, account: LoginAccount } | { ok: false, reason: string }}
 */
export const accountFromConfig = (text) => {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  const account = parsed && typeof parsed === 'object' ? /** @type {{ oauthAccount?: unknown }} */ (parsed).oauthAccount : undefined;
  if (!account || typeof account !== 'object') return { ok: false, reason: 'no oauthAccount entry' };
  const ids = accountOf(account);
  if (ids === null) return { ok: false, reason: 'oauthAccount lacks accountUuid or organizationUuid' };
  return { ok: true, account: ids };
};

/**
 * The stored secret: one record per login, the CLI's credentials text
 * verbatim beside the account it belongs to. Verbatim because the turn spots
 * a refresh by comparing the text on disk to the text it restored.
 *
 * With no account there is nothing to put beside the credentials, so the
 * secret stays the credentials text alone: the shape a dispatcher image from
 * before the record reads, which keeps a rollback working until a login
 * carrying the ids is minted.
 *
 * @param {string} credentials
 * @param {LoginAccount | null} account
 * @returns {string}
 */
export const storedLogin = (credentials, account) =>
  account === null ? credentials : JSON.stringify({ credentials, account });

/**
 * The credentials text and the account out of a stored secret. A secret
 * minted before the record is the credentials text alone, and has no
 * account: the CLI then looks the org up as it always did.
 *
 * @param {string} text
 * @returns {{ credentials: string, account: LoginAccount | null }}
 */
export const readStoredLogin = (text) => {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { credentials: text, account: null };
  }
  const record = parsed && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : {};
  if (typeof record.credentials !== 'string') return { credentials: text, account: null };
  return { credentials: record.credentials, account: accountOf(record.account) };
};

/** @param {unknown} ms */
const dateOrNull = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms) : null);

/**
 * When the two tokens expire. A refresh rotates both tokens and moves the
 * access expiry, but the refresh expiry stays where the mint set it, about
 * 14 days on: past it the CLI's refresh gets `invalid_grant` and the login
 * is dead however often it was used. Re-mint before it.
 *
 * @param {StoredLogin} login
 * @returns {{ accessExpiresAt: Date | null, refreshExpiresAt: Date | null }}
 */
export const loginExpiry = (login) => ({
  accessExpiresAt: dateOrNull(login.claudeAiOauth.expiresAt),
  refreshExpiresAt: dateOrNull(login.claudeAiOauth.refreshTokenExpiresAt),
});

/** How long before the refresh expiry each dispatcher turn warns that the login needs a re-mint. */
export const LOGIN_EXPIRY_WARNING_MS = 3 * 86_400_000;

/**
 * The refresh expiry, when it falls within LOGIN_EXPIRY_WARNING_MS of `now`
 * (or has passed); null when it is further out or unknown.
 *
 * @param {StoredLogin} login
 * @param {number} now
 * @returns {Date | null}
 */
export const refreshExpiring = (login, now) => {
  const { refreshExpiresAt } = loginExpiry(login);
  return refreshExpiresAt !== null && refreshExpiresAt.getTime() - now <= LOGIN_EXPIRY_WARNING_MS ? refreshExpiresAt : null;
};

/**
 * One line for the operator: the scopes and both expiries.
 *
 * @param {StoredLogin} login
 * @returns {string}
 */
export const describeLogin = (login) => {
  const { accessExpiresAt, refreshExpiresAt } = loginExpiry(login);
  const iso = (/** @type {Date | null} */ d) => (d ? d.toISOString() : 'unknown');
  return [
    `scopes ${login.claudeAiOauth.scopes.join(' ')}`,
    `access token expires ${iso(accessExpiresAt)}`,
    `refresh token expires ${iso(refreshExpiresAt)}`,
  ].join('; ');
};
