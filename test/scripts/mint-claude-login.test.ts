/**
 * The mint script hands a fresh claude.ai login to a GitHub secret without
 * touching the login the operator's own machine holds.
 *
 * The CLI (2.1.282) keeps its login under CLAUDE_CONFIG_DIR — the
 * `.credentials.json` there on Linux, a keychain item whose service name is
 * suffixed with a hash of that directory on macOS — so a throwaway directory
 * is a throwaway login. Every I/O the script does is injected, because the
 * real ones are an interactive `claude auth login`, the macOS keychain and
 * `gh secret set`, none of which a merge-gate test may reach.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { awsArgs, loginEnv, mintClaudeLogin, parseArgs } from '../../scripts/mint-claude-login.mjs';
import { keychainServiceName, storedLogin } from '../../scripts/lib/claude-login.mjs';

const HOME = '/home/operator';

/** A login as `/login` stores it: both tokens and the session scope. */
const LOGIN = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-access',
    refreshToken: 'sk-ant-ort01-refresh',
    expiresAt: 1790400000000,
    refreshTokenExpiresAt: 1793000000000,
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
    subscriptionType: 'max',
  },
});

/** What `claude setup-token` leaves: no refresh token, inference only. */
const SETUP_TOKEN = JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-ant-oat01-inference', scopes: ['user:inference'] },
});

/** The `.claude.json` the sign-in leaves in the config dir: the account, email and all. */
const ACCOUNT = { accountUuid: 'acc-4242', organizationUuid: 'org-4242' };
const CONFIG = JSON.stringify({
  hasCompletedOnboarding: true,
  oauthAccount: { ...ACCOUNT, emailAddress: 'owner@example.com', displayName: 'Owner', organizationName: 'Acme' },
});

/** What the secret holds after a mint: the credentials verbatim, and the ids. */
const RECORD = storedLogin(LOGIN, ACCOUNT);

/** A file read: `.claude.json` is the config, anything else the credentials. */
const fileAt = (path: unknown) => (String(path).endsWith('/.claude.json') ? CONFIG : LOGIN);

type Call = { name: string; args: unknown[] };

/** Every dependency, recording what it was called with; each can be overridden. */
const harness = (over: Record<string, unknown> = {}) => {
  const calls: Call[] = [];
  const record = (name: string, result: unknown = { status: 0 }) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return typeof result === 'function' ? (result as (...a: unknown[]) => unknown)(...args) : result;
    };
  const deps = {
    platform: 'linux',
    home: HOME,
    pid: 4242,
    env: { USER: 'operator', PATH: '/usr/bin' },
    mkdir: record('mkdir'),
    login: record('login', { status: 0 }),
    readFile: record('readFile', fileAt),
    readKeychain: record('readKeychain', LOGIN),
    storeSecret: record('storeSecret', { status: 0 }),
    whoAmI: record('whoAmI', { status: 0, stdout: 'arn:aws:iam::123456789012:user/operator-cli\n' }),
    describeSecret: record('describeSecret', { status: 0 }),
    storeSecretsManager: record('storeSecretsManager', { status: 0 }),
    writeFile: record('writeFile'),
    rm: record('rm'),
    deleteKeychain: record('deleteKeychain', { status: 0 }),
    log: () => {},
    ...over,
  };
  return { deps, calls };
};

const named = (calls: Call[], name: string) => calls.filter((c) => c.name === name);

/** The first call by that name, which the test expects to exist. */
const first = (calls: Call[], name: string): Call => {
  const call = named(calls, name)[0];
  assert.ok(call, `no call to ${name}`);
  return call;
};

describe('parseArgs', () => {
  test('defaults to the dispatcher\'s Secrets Manager secret', () => {
    assert.deepEqual(parseArgs([]), { secret: 'governor/claude-login', to: 'secretsmanager' });
  });

  test('--to github targets the repository secret the spike used, in the repo --repo names', () => {
    assert.deepEqual(parseArgs(['--to', 'github', '--repo', 'acme/x']), { repo: 'acme/x', secret: 'CLAUDE_LOGIN_JSON', to: 'github' });
  });

  // No repo is a default.
  test('--to github without --repo is refused', () => {
    assert.throws(() => parseArgs(['--to', 'github']), /--to github needs --repo/);
  });

  test('reads --repo and --secret', () => {
    assert.deepEqual(parseArgs(['--to', 'github', '--repo', 'acme/x', '--secret', 'S']), { repo: 'acme/x', secret: 'S', to: 'github' });
  });

  test('refuses a target it does not know', () => {
    assert.throws(() => parseArgs(['--to', 'vault']), /--to takes/);
  });

  test('--profile names the AWS profile the aws calls run under', () => {
    assert.equal(parseArgs(['--profile', 'admin']).profile, 'admin');
    assert.equal('profile' in parseArgs([]), false);
  });
});

describe('awsArgs', () => {
  test('appends the profile to every aws call when one was given, and nothing otherwise', () => {
    assert.deepEqual(awsArgs(['sts', 'get-caller-identity'], 'admin'), ['sts', 'get-caller-identity', '--profile', 'admin']);
    assert.deepEqual(awsArgs(['sts', 'get-caller-identity'], undefined), ['sts', 'get-caller-identity']);
  });
});

describe('loginEnv', () => {
  test('points the CLI at the throwaway dir and keeps the rest of the environment', () => {
    const env = loginEnv({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: `${HOME}/.claude` }, '/tmp/mint');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/mint');
    assert.equal(env.PATH, '/usr/bin');
  });

  /**
   * The CLI (2.1.282, `LNe()` and `pw()`) lets CLAUDE_SECURESTORAGE_CONFIG_DIR
   * override CLAUDE_CONFIG_DIR for where the login is stored and how the
   * keychain item is named, and an empty value means the DEFAULT store. A
   * `claude` session exports it to its children, so a mint run from inside
   * one would sign in over the operator's own login and read back nothing.
   */
  test('drops CLAUDE_SECURESTORAGE_CONFIG_DIR, which would override the throwaway dir', () => {
    for (const value of ['', `${HOME}/.claude`]) {
      const env = loginEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: value }, '/tmp/mint');
      assert.equal('CLAUDE_SECURESTORAGE_CONFIG_DIR' in env, false, JSON.stringify(env));
    }
  });
});

describe('mintClaudeLogin — on Linux', () => {
  test('a GitHub mint naming no repo is refused before the sign-in', async () => {
    const { deps, calls } = harness();
    const result = await mintClaudeLogin({ secret: 'S', to: 'github' }, deps as never);
    assert.deepEqual(result, { ok: false, err: '--to github needs --repo owner/name: the repo whose secret it sets' });
    assert.equal(named(calls, 'login').length, 0);
  });

  test('logs in under a throwaway config dir, never the default one', async () => {
    const { deps, calls } = harness();
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, true, JSON.stringify(result));
    const login = first(calls, 'login');
    const configDir = login.args[0] as string;
    assert.ok(configDir.startsWith(`${HOME}/.governor-mint-login-`), configDir);
    assert.notEqual(configDir, `${HOME}/.claude`);
    assert.deepEqual(first(calls, 'mkdir').args[0], configDir);
    // Read back from that directory, not from ~/.claude.
    assert.deepEqual(first(calls, 'readFile').args, [`${configDir}/.credentials.json`]);
    assert.equal(named(calls, 'readKeychain').length, 0);
  });

  test('stores the login verbatim in the named secret of the named repo', async () => {
    const { deps, calls } = harness();
    await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x', '--secret', 'S']), deps as never);
    assert.deepEqual(first(calls, 'storeSecret').args, ['S', 'acme/x', RECORD]);
  });

  test('stores the account and org ids from the config dir beside the login, and no email', async () => {
    const { deps, calls } = harness();
    await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    const configDir = first(calls, 'login').args[0] as string;
    assert.ok(named(calls, 'readFile').some((c) => c.args[0] === `${configDir}/.claude.json`));
    const text = first(calls, 'storeSecret').args[2] as string;
    assert.deepEqual(JSON.parse(text), { credentials: LOGIN, account: ACCOUNT });
    assert.doesNotMatch(text, /@|owner/);
  });

  /**
   * The ids spare the task a profile fetch per call; without them it still
   * works, looking the org up as before. So a sign-in that left no ids is
   * stored, and the operator is told what that costs.
   */
  test('a config dir with no ids stores the login as the CLI wrote it, and the summary says what is missing', async () => {
    const { deps, calls } = harness({
      readFile: (path: string) => {
        if (path.endsWith('/.claude.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return LOGIN;
      },
    });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, true, JSON.stringify(result));
    // The shape an image from before the record reads.
    assert.equal(first(calls, 'storeSecret').args[2], LOGIN);
    if (result.ok) assert.match(result.summary, /no account ids/);
  });

  test('removes the throwaway directory afterwards', async () => {
    const { deps, calls } = harness();
    await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    const configDir = first(calls, 'login').args[0];
    assert.deepEqual(first(calls, 'rm').args, [configDir]);
    assert.ok(calls.findIndex((c) => c.name === 'rm') > calls.findIndex((c) => c.name === 'storeSecret'));
  });

  test('reports what was minted: the scopes and both expiries', async () => {
    const { deps } = harness();
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.summary, /user:sessions:claude_code/);
      // LOGIN's expiresAt and refreshTokenExpiresAt, each by its own label.
      assert.match(result.summary, /access token expires 2026-09-26T05:20:00\.000Z/);
      assert.match(result.summary, /refresh token expires 2026-10-26T07:33:20\.000Z/);
    }
  });
});

describe('mintClaudeLogin — on macOS', () => {
  test('reads the login back from the keychain item the CLI names for that dir', async () => {
    const { deps, calls } = harness({ platform: 'darwin' });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, true, JSON.stringify(result));
    const configDir = first(calls, 'login').args[0] as string;
    assert.deepEqual(first(calls, 'readKeychain').args, [keychainServiceName(configDir), 'operator']);
    assert.ok(!named(calls, 'readFile').some((c) => String(c.args[0]).endsWith('.credentials.json')));
  });

  test('deletes that keychain item afterwards, and only that one', async () => {
    const { deps, calls } = harness({ platform: 'darwin' });
    await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    const configDir = first(calls, 'login').args[0] as string;
    assert.deepEqual(first(calls, 'deleteKeychain').args, [keychainServiceName(configDir), 'operator']);
  });

  /**
   * The CLI falls back to `<config dir>/.credentials.json` when the keychain
   * refuses the write (locked, no login keychain over ssh). A login that
   * landed there is still a login.
   */
  test('falls back to the credentials file when the keychain holds nothing', async () => {
    const { deps, calls } = harness({ platform: 'darwin', readKeychain: () => null });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, true, JSON.stringify(result));
    const configDir = first(calls, 'login').args[0] as string;
    assert.deepEqual(first(calls, 'readFile').args, [`${configDir}/.credentials.json`]);
  });

  test('a keychain item that will not delete is reported: a live login would stay behind', async () => {
    const lines: string[] = [];
    const { deps } = harness({
      platform: 'darwin',
      deleteKeychain: () => ({ status: 1 }),
      log: (line: string) => lines.push(line),
    });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, true);
    assert.ok(lines.some((l) => /keychain/i.test(l) && /delete/i.test(l)), JSON.stringify(lines));
  });
});

describe('mintClaudeLogin — to Secrets Manager', () => {
  test('writes the login to a file in the throwaway dir and hands the file to the aws CLI', async () => {
    const { deps, calls } = harness();
    const result = await mintClaudeLogin(parseArgs([]), deps as never);
    assert.equal(result.ok, true, JSON.stringify(result));
    const configDir = first(calls, 'login').args[0] as string;
    const written = first(calls, 'writeFile');
    assert.equal(written.args[0], `${configDir}/login.json`);
    assert.equal(written.args[1], RECORD);
    assert.deepEqual(first(calls, 'storeSecretsManager').args, ['governor/claude-login', `${configDir}/login.json`]);
    assert.equal(named(calls, 'storeSecret').length, 0, 'gh was called for a Secrets Manager mint');
    if (result.ok) assert.match(result.summary, /Secrets Manager/);
  });

  test('the file goes with the throwaway dir, after the store', async () => {
    const { deps, calls } = harness();
    await mintClaudeLogin(parseArgs([]), deps as never);
    assert.ok(calls.findIndex((c) => c.name === 'rm') > calls.findIndex((c) => c.name === 'storeSecretsManager'));
  });

  test('a refused put is reported with the CLI\'s own words', async () => {
    const { deps } = harness({ storeSecretsManager: () => ({ status: 254, stderr: 'AccessDeniedException' }) });
    const result = await mintClaudeLogin(parseArgs([]), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.err, /AccessDeniedException/);
  });

  /**
   * The put is the last step, after an interactive sign-in. An identity
   * that cannot reach the secret (the operator's everyday CLI user, run
   * 2026-09-25: `user/operator-cli is not authorized to perform:
   * secretsmanager:PutSecretValue`) is found out before the browser opens,
   * and told which role to assume.
   */
  test('checks that the shell\'s AWS identity can reach the secret before starting a sign-in', async () => {
    const lines: string[] = [];
    const { deps, calls } = harness({ log: (line: string) => lines.push(line) });
    const result = await mintClaudeLogin(parseArgs([]), deps as never);
    assert.equal(result.ok, true, JSON.stringify(result));
    const order = calls.map((c) => c.name);
    assert.ok(order.indexOf('describeSecret') < order.indexOf('login'), order.join(' > '));
    assert.deepEqual(first(calls, 'describeSecret').args, ['governor/claude-login']);
    assert.ok(lines.some((l) => /user\/operator-cli/.test(l) && /admin/.test(l)), JSON.stringify(lines));
  });

  test('an identity that cannot reach the secret is refused before the sign-in, and told to assume the admin role', async () => {
    const { deps, calls } = harness({
      describeSecret: () => ({ status: 254, stderr: 'An error occurred (AccessDeniedException) when calling the DescribeSecret operation' }),
    });
    const result = await mintClaudeLogin(parseArgs([]), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.err, /user\/operator-cli/);
      assert.match(result.err, /admin/);
      assert.match(result.err, /AccessDeniedException/);
    }
    assert.equal(named(calls, 'login').length, 0, 'a sign-in was started for an identity that cannot store it');
  });

  test('no AWS identity at all is refused the same way', async () => {
    const { deps, calls } = harness({ whoAmI: () => ({ status: 253, stderr: 'Unable to locate credentials' }) });
    const result = await mintClaudeLogin(parseArgs([]), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.err, /Unable to locate credentials/);
    assert.equal(named(calls, 'login').length, 0);
  });

  /**
   * The remedy names what the operator did not do. One who already passed
   * `--profile admin` and still cannot reach the secret (an SSO session that
   * expired, say) is not told to pass it again; they are told the profile
   * they gave is the problem.
   */
  test('a refusal under a named profile blames that profile, not the missing flag', async () => {
    const lines: string[] = [];
    const { deps } = harness({
      whoAmI: () => ({ status: 255, stderr: 'Error loading SSO Token: Token for admin does not exist' }),
      log: (line: string) => lines.push(line),
    });
    const result = await mintClaudeLogin(parseArgs(['--profile', 'admin']), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.err, /SSO Token/);
      assert.match(result.err, /--profile admin/);
      assert.doesNotMatch(result.err, /re-run with --profile/);
    }

    const reach = harness({
      describeSecret: () => ({ status: 254, stderr: 'AccessDeniedException' }),
      log: (line: string) => lines.push(line),
    });
    const refused = await mintClaudeLogin(parseArgs(['--profile', 'ops']), reach.deps as never);
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.match(refused.err, /--profile ops/);
      assert.doesNotMatch(refused.err, /re-run with --profile/);
    }

    const ok = harness({ log: (line: string) => lines.push(line) });
    await mintClaudeLogin(parseArgs(['--profile', 'admin']), ok.deps as never);
    assert.ok(lines.some((l) => /Storing as/.test(l) && /--profile admin/.test(l)), JSON.stringify(lines));
    assert.ok(!lines.some((l) => /re-run with --profile/.test(l)), JSON.stringify(lines));
  });

  test('a GitHub mint asks nothing of AWS', async () => {
    const { deps, calls } = harness();
    await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(named(calls, 'whoAmI').length + named(calls, 'describeSecret').length, 0);
  });
});

describe('mintClaudeLogin — refusals', () => {
  test('a login that did not complete stores nothing and still cleans up', async () => {
    const { deps, calls } = harness({ login: () => ({ status: 1 }) });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, false);
    assert.equal(named(calls, 'storeSecret').length, 0);
    assert.equal(named(calls, 'rm').length, 1);
  });

  test('a claude that could not be spawned says so, not "exited null"', async () => {
    const { deps } = harness({
      login: () => ({ status: null, error: new Error('spawnSync claude ENOENT') }),
    });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.err, /ENOENT/);
  });

  test('a gh that could not be spawned says so', async () => {
    const { deps } = harness({
      storeSecret: () => ({ status: null, error: new Error('spawnSync gh ENOENT') }),
    });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.err, /ENOENT/);
  });

  test('a setup-token is refused: no refresh token, no session scope', async () => {
    const { deps, calls } = harness({ readFile: () => SETUP_TOKEN });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.err, /user:sessions:claude_code|refresh/);
    assert.equal(named(calls, 'storeSecret').length, 0);
    assert.equal(named(calls, 'rm').length, 1);
  });

  test('a failed secret write is reported, and the directory is still removed', async () => {
    const { deps, calls } = harness({ storeSecret: () => ({ status: 1, stderr: 'gh: not logged in' }) });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.err, /not logged in/);
    assert.equal(named(calls, 'rm').length, 1);
  });

  test('a missing login file on Linux is the login not having written one', async () => {
    const { deps, calls } = harness({
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    const result = await mintClaudeLogin(parseArgs(['--to', 'github', '--repo', 'acme/x']), deps as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.err, /no login/i);
    assert.equal(named(calls, 'storeSecret').length, 0);
  });
});
