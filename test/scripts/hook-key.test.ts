/**
 * The owner's key script (scripts/hook-key.mjs): one hook's key, derived from
 * the stack's hook secret read with the operator's AWS identity, the hook's
 * full URL from the stack's WebhookUrl output, and both either printed or
 * saved to an environment of the served repo. The aws and gh calls are fakes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOOK_SECRET_ID, hookUrl, keyLine, parseArgs, run } from '../../scripts/hook-key.mjs';
import { hookKey } from '../../dispatch/webhook/hook.mjs';
import { CONFIG_PATH } from '../../dispatch/repo-config.mjs';

const FACTORY_CONFIG = readFileSync(new URL('../fixtures/factory/.github/dispatch.json', import.meta.url), 'utf8');
const BASE = 'https://abc123.lambda-url.us-east-1.on.aws/';
const URL_OPERATOR_PROD = `${BASE}hooks/acme/factory/operator-prod`;
const SECRET = 'hook-secret-test';

type Call = { argv: string[], input?: string };

/**
 * Fakes for aws and gh. `gh` answers by the call: the config file, the
 * environment pages, and the two writes. A handler may throw, as gh does on a
 * failed call.
 */
const fakes = (o: {
  outputs?: Array<{ OutputKey: string, OutputValue: string }> | null,
  config?: string | Error,
  pages?: string[][],
  failSet?: string,
} = {}) => {
  const aws: Call[] = [];
  const gh: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const pages = o.pages ?? [['dev', 'prod']];
  const total = pages.flat().length;
  return {
    aws, gh, out, err,
    io: {
      aws: (argv: string[]) => {
        aws.push({ argv });
        if (argv[0] === 'secretsmanager') return `${SECRET}\n`;
        if (argv[0] === 'cloudformation') {
          const outputs = o.outputs === undefined ? [{ OutputKey: 'WebhookUrl', OutputValue: BASE }] : o.outputs;
          const query = argv[argv.indexOf('--query') + 1] ?? '';
          const key = /OutputKey=='([A-Za-z]+)'/.exec(query)?.[1];
          return JSON.stringify(outputs === null ? null : outputs.filter((x) => x.OutputKey === key).map((x) => x.OutputValue));
        }
        throw new Error(`unexpected aws ${argv.join(' ')}`);
      },
      gh: (argv: string[], input?: string) => {
        gh.push({ argv, ...(input === undefined ? {} : { input }) });
        if (argv[0] === 'api' && argv.some((a) => a.endsWith(`/contents/${CONFIG_PATH}`))) {
          const config = o.config ?? FACTORY_CONFIG;
          if (config instanceof Error) throw config;
          return config;
        }
        const envPath = argv.find((a) => a.startsWith('repos/') && a.includes('/environments'));
        if (argv[0] === 'api' && envPath) {
          const page = Number(new URL(envPath, 'https://x/').searchParams.get('page') ?? '1');
          const names = pages[page - 1] ?? [];
          return JSON.stringify({ total_count: total, environments: names.map((name) => ({ name })) });
        }
        if ((argv[0] === 'secret' || argv[0] === 'variable') && argv[1] === 'set') {
          if (o.failSet === argv[0]) throw new Error('HTTP 403: Resource not accessible by integration');
          return '';
        }
        throw new Error(`unexpected gh ${argv.join(' ')}`);
      },
      out: (line: string) => { out.push(line); },
      err: (line: string) => { err.push(line); },
    },
  };
};

const keyOf = (version: number) => `v${version}.${hookKey(SECRET, 'acme/factory', 'operator-prod', version)}`;

describe('scripts/hook-key.mjs', () => {
  test('reads the repo and the hook; the version, profile, stack, environment and names are optional', () => {
    assert.deepEqual(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod']), {
      repo: 'acme/factory', hook: 'operator-prod', keyName: 'GOVERNOR_HOOK_KEY', urlName: 'GOVERNOR_HOOK_URL',
    });
    assert.deepEqual(parseArgs([
      '--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '2', '--profile', 'ops',
      '--stack', 'governor-test', '--env', 'prod', '--key-name', 'ALARM_KEY', '--url-name', 'ALARM_URL',
    ]), {
      repo: 'acme/factory', hook: 'operator-prod', version: 2, profile: 'ops', stack: 'governor-test', env: 'prod',
      keyName: 'ALARM_KEY', urlName: 'ALARM_URL',
    });
  });

  test('refuses a repo, hook or version the receiver would not take', () => {
    for (const argv of [
      ['--hook', 'operator-prod'],
      ['--repo', 'factory', '--hook', 'operator-prod'],
      ['--repo', 'acme/factory'],
      ['--repo', 'acme/factory', '--hook', 'Operator'],
      ['--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '0'],
      ['--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '1.5'],
    ]) assert.throws(() => parseArgs(argv), argv.join(' '));
  });

  test('refuses a secret or variable name GitHub would refuse', () => {
    for (const name of ['HOOK-KEY', 'HOOK KEY', '1HOOK', 'GITHUB_HOOK', 'github_hook', '']) {
      for (const flag of ['--key-name', '--url-name']) {
        assert.throws(() => parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', flag, name]), /letters, digits and underscores/, `${flag} ${name}`);
      }
    }
    assert.equal(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--key-name', '_hook_key2']).keyName, '_hook_key2');
  });

  test('prints v<version>.<hex key>, the key derived from the stack\'s hook secret', () => {
    const reads: Array<{ id: string, profile: string | undefined }> = [];
    const line = keyLine({ repo: 'acme/factory', hook: 'operator-prod', version: 3, profile: 'ops' }, (id, profile) => {
      reads.push({ id, profile });
      return `${SECRET}\n`;
    });
    assert.equal(HOOK_SECRET_ID, 'governor/hook-secret');
    assert.deepEqual(reads, [{ id: 'governor/hook-secret', profile: 'ops' }]);
    assert.equal(line, `v3.${hookKey(SECRET, 'acme/factory', 'operator-prod', 3)}`);
    assert.match(line, /^v3\.[0-9a-f]{64}$/);
  });

  test('an empty secret is refused, not a key', () => {
    assert.throws(() => keyLine({ repo: 'acme/factory', hook: 'operator-prod', version: 1 }, () => ''), /empty/);
  });

  test('the hook\'s full URL has exactly one slash before hooks', () => {
    for (const base of ['https://abc123.lambda-url.us-east-1.on.aws', BASE, `${BASE}/`]) {
      assert.equal(hookUrl(base, 'acme/factory', 'operator-prod'), URL_OPERATOR_PROD, base);
    }
  });

  describe('the stack\'s WebhookUrl', () => {
    test('is read from the governor stack, with the identity that reads the secret', () => {
      const f = fakes();
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--profile', 'ops']), f.io);
      assert.equal(f.aws.length, 2);
      for (const { argv } of f.aws) assert.deepEqual(argv.slice(-2), ['--profile', 'ops'], argv.join(' '));
      const describe = f.aws.find((c) => c.argv[0] === 'cloudformation')!.argv;
      assert.equal(describe[describe.indexOf('--stack-name') + 1], 'governor');
      assert.ok(f.err.some((l) => l.includes(URL_OPERATOR_PROD)), f.err.join('\n'));
    });

    test('is read from the stack --stack names', () => {
      const f = fakes();
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--stack', 'governor-test']), f.io);
      const describe = f.aws.find((c) => c.argv[0] === 'cloudformation')!.argv;
      assert.equal(describe[describe.indexOf('--stack-name') + 1], 'governor-test');
      assert.equal(describe.includes('--profile'), false);
    });

    test('a stack with no WebhookUrl output fails the run, naming the stack and the output', () => {
      for (const outputs of [null, [], [{ OutputKey: 'Other', OutputValue: 'x' }]]) {
        const f = fakes({ outputs });
        assert.throws(() => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--stack', 'governor-test']), f.io), /governor-test.*WebhookUrl/);
        assert.deepEqual(f.out, []);
      }
    });
  });

  describe('the key version', () => {
    test('without --version, is the named hook\'s keyVersion in the config file on the default branch', () => {
      const f = fakes({ config: FACTORY_CONFIG.replace('"keyVersion": 1', '"keyVersion": 4') });
      assert.notEqual(FACTORY_CONFIG, FACTORY_CONFIG.replace('"keyVersion": 1', '"keyVersion": 4'));
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod']), f.io);
      assert.deepEqual(f.out, [keyOf(4)]);
      const read = f.gh.find((c) => c.argv.some((a) => a.endsWith(CONFIG_PATH)))!.argv;
      assert.ok(read.includes(`repos/acme/factory/contents/${CONFIG_PATH}`), read.join(' '));
      assert.equal(read.some((a) => a.includes('ref=')), false, 'no ref: the default branch');
    });

    test('with --version, no config file is read and the flag is used', () => {
      const f = fakes({ config: new Error('must not be read') });
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '7']), f.io);
      assert.deepEqual(f.out, [keyOf(7)]);
      assert.deepEqual(f.gh, []);
    });

    const noVersion = (config: string | Error) => {
      const f = fakes({ config });
      assert.throws(
        () => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod']), f.io),
        (e: Error) => /acme\/factory/.test(e.message) && /operator-prod/.test(e.message) && /merge/.test(e.message),
      );
      assert.deepEqual(f.out, []);
    };

    test('a missing config file fails the run, naming the repo and the hook', () => {
      noVersion(new Error('gh: Not Found (HTTP 404)'));
      const f = fakes({ config: new Error('gh: Not Found (HTTP 404)') });
      assert.throws(() => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod']), f.io), /cannot see/, 'a private repo gh cannot read answers 404 too');
    });

    test('an invalid config file fails the run', () => {
      noVersion('{ not json');
      noVersion(JSON.stringify({ environment: 'factory' }));
    });

    test('a config file with hooks off fails the run', () => {
      const config = JSON.parse(FACTORY_CONFIG);
      config.features.hooks = false;
      noVersion(JSON.stringify(config));
    });

    test('a config file listing no hook of that name fails the run', () => {
      noVersion(FACTORY_CONFIG.replace('"operator-prod"', '"operator-dev"'));
    });

    test('a read that fails for another reason fails the run with gh\'s message', () => {
      const f = fakes({ config: new Error('gh: Bad credentials (HTTP 401)') });
      assert.throws(() => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod']), f.io), /Bad credentials/);
    });
  });

  describe('without --env', () => {
    test('stdout is the one key line; stderr has the URL and the two commands that save both values', () => {
      const f = fakes();
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod']), f.io);
      assert.deepEqual(f.out, [keyOf(1)]);
      const err = f.err.join('\n');
      assert.ok(err.includes(URL_OPERATOR_PROD));
      assert.ok(err.includes('node scripts/hook-key.mjs --repo acme/factory --hook operator-prod | gh secret set GOVERNOR_HOOK_KEY --repo acme/factory --env <environment>'), err);
      assert.ok(err.includes(`gh variable set GOVERNOR_HOOK_URL --repo acme/factory --env <environment> --body ${URL_OPERATOR_PROD}`), err);
      assert.equal(err.includes(keyOf(1).slice(3)), false, 'the key is not on stderr');
      assert.equal(f.gh.some((c) => c.argv[0] !== 'api'), false, 'nothing is written');
    });

    test('the printed secret command repeats the flags the run was given, and uses the names given', () => {
      const f = fakes();
      run(parseArgs([
        '--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '2', '--profile', 'ops', '--stack', 'governor-test',
        '--key-name', 'ALARM_KEY', '--url-name', 'ALARM_URL',
      ]), f.io);
      const err = f.err.join('\n');
      assert.ok(err.includes('node scripts/hook-key.mjs --repo acme/factory --hook operator-prod --version 2 --profile ops --stack governor-test | gh secret set ALARM_KEY --repo acme/factory --env <environment>'), err);
      assert.ok(err.includes(`gh variable set ALARM_URL --repo acme/factory --env <environment> --body ${URL_OPERATOR_PROD}`), err);
    });
  });

  describe('with --env', () => {
    test('saves the key on stdin and the URL to the named environment, and prints no key', () => {
      const f = fakes();
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'prod']), f.io);
      const writes = f.gh.filter((c) => c.argv[0] !== 'api');
      assert.deepEqual(writes, [
        { argv: ['secret', 'set', 'GOVERNOR_HOOK_KEY', '--repo', 'acme/factory', '--env', 'prod'], input: keyOf(1) },
        { argv: ['variable', 'set', 'GOVERNOR_HOOK_URL', '--repo', 'acme/factory', '--env', 'prod', '--body', URL_OPERATOR_PROD] },
      ]);
      for (const { argv } of f.gh) assert.equal(argv.some((a) => a.includes(keyOf(1).slice(3))), false, 'the key is in no argument list');
      const said = [...f.out, ...f.err].join('\n');
      assert.equal(said.includes(keyOf(1).slice(3)), false, 'the key is not printed');
      for (const part of ['acme/factory', 'prod', 'GOVERNOR_HOOK_KEY', 'GOVERNOR_HOOK_URL', URL_OPERATOR_PROD]) assert.ok(said.includes(part), part);
    });

    test('uses the names --key-name and --url-name give', () => {
      const f = fakes();
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'prod', '--key-name', 'ALARM_KEY', '--url-name', 'ALARM_URL']), f.io);
      const writes = f.gh.filter((c) => c.argv[0] !== 'api').map((c) => c.argv.slice(0, 3).join(' '));
      assert.deepEqual(writes, ['secret set ALARM_KEY', 'variable set ALARM_URL']);
    });

    test('reads every page of the repo\'s environments', () => {
      const first = Array.from({ length: 100 }, (_, i) => `stage-${i}`);
      const f = fakes({ pages: [first, ['prod']] });
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'prod']), f.io);
      const listed = f.gh.filter((c) => c.argv.some((a) => a.includes('/environments')));
      assert.equal(listed.length, 2);
      assert.ok(listed.every((c) => c.argv.some((a) => a.startsWith('repos/acme/factory/environments'))));
      assert.equal(f.gh.filter((c) => c.argv[0] === 'secret').length, 1);
    });

    test('an environment that does not exist fails the run, lists the names that do, and writes nothing', () => {
      const f = fakes({ pages: [['dev', 'staging']] });
      assert.throws(
        () => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'prod']), f.io),
        (e: Error) => /prod/.test(e.message) && /dev, staging/.test(e.message),
      );
      assert.deepEqual(f.gh.filter((c) => c.argv[0] !== 'api'), []);
      assert.deepEqual(f.out, []);
      assert.equal(f.aws.some((c) => c.argv[0] === 'secretsmanager'), false, 'the hook secret is not read for a run that writes nothing');
    });

    test('matches the environment\'s name in any case, as GitHub does', () => {
      const f = fakes({ pages: [['dev', 'prod']] });
      run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'Prod']), f.io);
      assert.deepEqual(f.gh.filter((c) => c.argv[0] !== 'api').map((c) => c.argv[0]), ['secret', 'variable']);
    });

    test('a repo with no environments fails the run and writes nothing', () => {
      const f = fakes({ pages: [] });
      assert.throws(() => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'prod']), f.io), /no environments/);
      assert.deepEqual(f.gh.filter((c) => c.argv[0] !== 'api'), []);
    });

    test('a failed gh call fails the run with gh\'s message', () => {
      for (const failSet of ['secret', 'variable']) {
        const f = fakes({ failSet });
        assert.throws(() => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'prod']), f.io), /Resource not accessible/);
      }
    });

    test('a variable write that fails after the secret saved says the secret is saved', () => {
      const f = fakes({ failSet: 'variable' });
      assert.throws(() => run(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--env', 'prod']), f.io), /holds the secret GOVERNOR_HOOK_KEY.*GOVERNOR_HOOK_URL failed/);
    });
  });
});
