/**
 * What a stored claude.ai login IS, as the CLI (2.1.282) keeps it, and the
 * one thing that tells it apart from a `claude setup-token` grant.
 *
 * Both shapes live under `claudeAiOauth`. A login carries a refresh token and
 * the `user:sessions:claude_code` scope; a setup-token carries neither, and
 * the session-create endpoint answers it with 403. The keychain
 * service name is the CLI's own derivation, pinned here by vector so a
 * change in the CLI shows up as a red test and not as a mint that uploads
 * nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountFromConfig,
  keychainAccount,
  keychainServiceName,
  loginExpiry,
  parseLogin,
  readStoredLogin,
  SESSION_SCOPE,
  storedLogin,
} from '../../scripts/lib/claude-login.mjs';

const login = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-access',
      refreshToken: 'sk-ant-ort01-refresh',
      expiresAt: 1790400000000,
      refreshTokenExpiresAt: 1793000000000,
      scopes: ['user:profile', 'user:inference', SESSION_SCOPE],
      ...over,
    },
  });

describe('keychainServiceName', () => {
  // `Claude Code-credentials-` + the first 8 hex of sha256(dir), the CLI's
  // `LNe()` for a directory named by CLAUDE_CONFIG_DIR.
  test('suffixes the CLI service name with a hash of the config dir', () => {
    assert.equal(keychainServiceName('/Users/operator/.governor-mint-login-4242'), 'Claude Code-credentials-132ca47e');
    assert.equal(keychainServiceName('/home/operator/.governor-mint-login-4242'), 'Claude Code-credentials-510fca3c');
  });

  test('hashes the NFC form, as the CLI does', () => {
    const composed = '/Users/operator/café';
    const decomposed = '/Users/operator/café';
    assert.equal(keychainServiceName(decomposed), keychainServiceName(composed));
  });
});

describe('keychainAccount', () => {
  // The CLI's `M5()`: USER, then the OS username, and a fixed name for
  // anything that is not a plain identifier.
  test('is USER when it is a plain identifier', () => {
    assert.equal(keychainAccount({ USER: 'operator' }, 'other'), 'operator');
  });

  test('is the OS username when USER is unset', () => {
    assert.equal(keychainAccount({}, 'ann.o'), 'ann.o');
  });

  test('is the fixed fallback for a name with a space, or no name at all', () => {
    assert.equal(keychainAccount({ USER: 'Ann O' }, 'operator'), 'claude-code-user');
    assert.equal(keychainAccount({}, undefined), 'claude-code-user');
  });
});

describe('parseLogin', () => {
  test('accepts a login with both tokens and the session scope', () => {
    const result = parseLogin(login());
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.login.claudeAiOauth.accessToken, 'sk-ant-oat01-access');
  });

  test('refuses a setup-token: no session scope', () => {
    const result = parseLogin(login({ scopes: ['user:inference'] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, new RegExp(SESSION_SCOPE));
  });

  test('refuses a login with no refresh token: it cannot renew itself', () => {
    const result = parseLogin(login({ refreshToken: undefined }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /refresh/);
  });

  test('refuses an empty access token and a dead refresh token alike', () => {
    assert.equal(parseLogin(login({ accessToken: '' })).ok, false);
    // The CLI writes "" for a refresh token the server refused (invalid_grant).
    assert.equal(parseLogin(login({ refreshToken: '' })).ok, false);
  });

  test('refuses what is not a login at all', () => {
    assert.equal(parseLogin('').ok, false);
    assert.equal(parseLogin('{}').ok, false);
    assert.equal(parseLogin('not json').ok, false);
    assert.equal(parseLogin('{"claudeAiOauth":null}').ok, false);
  });
});

describe('loginExpiry', () => {
  test('reads both expiries as dates', () => {
    const result = parseLogin(login());
    assert.ok(result.ok);
    const { accessExpiresAt, refreshExpiresAt } = loginExpiry(result.login);
    assert.equal(accessExpiresAt?.toISOString(), '2026-09-26T05:20:00.000Z');
    assert.equal(refreshExpiresAt?.toISOString(), '2026-10-26T07:33:20.000Z');
  });

  test('a login without a refresh expiry has none, rather than a bogus one', () => {
    const result = parseLogin(login({ refreshTokenExpiresAt: undefined }));
    assert.ok(result.ok);
    assert.equal(loginExpiry(result.login).refreshExpiresAt, null);
  });
});

/**
 * The CLI keeps the signed-in account beside the login, in `.claude.json`'s
 * `oauthAccount`, and resolves the org UUID for a cloud call from it when
 * CLAUDE_CODE_ORGANIZATION_UUID is unset; with neither it fetches the
 * profile, a call whose failure it reports without its cause.
 */
describe('accountFromConfig', () => {
  const ACCOUNT = { accountUuid: 'acc-1', organizationUuid: 'org-1' };

  test('takes the two ids and nothing else: no email address', () => {
    const config = JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { ...ACCOUNT, emailAddress: 'owner@example.com', displayName: 'Owner', organizationName: 'Acme' },
    });
    assert.deepEqual(accountFromConfig(config), { ok: true, account: ACCOUNT });
  });

  test('says why when the ids are not there', () => {
    for (const text of ['not json', '{}', JSON.stringify({ oauthAccount: { accountUuid: 'acc-1' } }), JSON.stringify({ oauthAccount: { ...ACCOUNT, organizationUuid: '' } })]) {
      const result = accountFromConfig(text);
      assert.equal(result.ok, false, text);
      if (!result.ok) assert.ok(result.reason.length > 0);
    }
  });
});

/**
 * The secret holds one record per login: the CLI's credentials text,
 * verbatim, and the account it belongs to. The turn compares the text on
 * disk to the text it restored to spot a refresh, so the ids ride beside it
 * and never inside it.
 */
describe('storedLogin and readStoredLogin', () => {
  const ACCOUNT = { accountUuid: 'acc-1', organizationUuid: 'org-1' };

  test('round-trip the credentials byte for byte, and the account', () => {
    const credentials = `${login()}\n`;
    assert.deepEqual(readStoredLogin(storedLogin(credentials, ACCOUNT)), { credentials, account: ACCOUNT });
  });

  test('a record without an account reads back with none', () => {
    assert.deepEqual(readStoredLogin(storedLogin(login(), null)), { credentials: login(), account: null });
  });

  test('a secret minted before the record is the credentials alone, with no account', () => {
    assert.deepEqual(readStoredLogin(login()), { credentials: login(), account: null });
    assert.deepEqual(readStoredLogin('not json'), { credentials: 'not json', account: null });
  });
});
