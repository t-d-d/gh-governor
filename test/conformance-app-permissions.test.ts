/**
 * The read-back on the App's permissions, and on what each installation on a
 * listed owner has accepted. The owner sets both by hand: the App's in its
 * settings, an installation's by accepting a change. A permission missing
 * from either shows only as a 403 where governor uses it, and on a public
 * repo a read works without it, so the gap stays hidden until a private repo
 * needs it. So the deploy reads them back (scripts/conformance.mjs); what is
 * pure (the verdicts, the reads, and what the deploy hands the check) is
 * pinned here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { runsScript } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';
import { APP_PERMISSIONS } from '../dispatch/webhook/route.mjs';
import {
  INSTALLATION_VARS,
  appPermissionFindings,
  checkAppPermissions,
  checkInstallationPermissions,
  installationPermissionFindings,
} from '../scripts/lib/conformance-app-permissions.mjs';
import { APP_SLUG_VAR } from '../scripts/lib/conformance-app-events.mjs';
import { CHECKS, runAll } from '../scripts/conformance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_YML = resolve(repoRoot, '.github/workflows/deploy.yml');
const SELF_HOSTING = resolve(repoRoot, 'docs/self-hosting.md');

/** Every permission governor uses, at exactly its level. */
const exact = (): Record<string, string> => Object.fromEntries(APP_PERMISSIONS.map((p) => [p.key, p.level]));

describe('app-permissions — the list', () => {
  test('names each permission governor uses at its level', () => {
    assert.deepEqual(exact(), {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      actions: 'read',
      checks: 'write',
      statuses: 'read',
      metadata: 'read',
    });
  });
});

describe('app-permissions — the App\'s verdict', () => {
  test('an App holding every permission at its level reports nothing', () => {
    assert.deepEqual(appPermissionFindings({ slug: 'governor-app', permissions: exact() }), []);
  });

  test('a level above the one needed passes, and a permission governor does not use changes nothing', () => {
    const higher = { ...exact(), actions: 'write', statuses: 'write', metadata: 'admin', administration: 'read' };
    assert.deepEqual(appPermissionFindings({ slug: 'governor-app', permissions: higher }), []);
  });

  test('a permission the App lacks is a finding naming it', () => {
    const { checks: _checks, ...rest } = exact();
    const findings = appPermissionFindings({ slug: 'governor-app', permissions: rest });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, /governor-app/);
    assert.match(findings[0]!, /Checks \(write\)/);
  });

  test('a permission below its level is a finding naming it and the level it holds', () => {
    const findings = appPermissionFindings({ slug: 'governor-app', permissions: { ...exact(), checks: 'read', issues: 'read' } });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, /Issues \(write, holds read\)/);
    assert.match(findings[0]!, /Checks \(write, holds read\)/);
    assert.doesNotMatch(findings[0]!, /Contents/);
  });

  test('an App GitHub does not answer for is a finding', () => {
    assert.equal(appPermissionFindings({ slug: 'governor-app', permissions: undefined }).length, 1);
  });
});

describe('app-permissions — each installation\'s verdict', () => {
  const owners = ['acme', 'Widgets'];

  test('installations on listed owners that accepted every permission report nothing', () => {
    const installations = [
      { id: 11, account: 'acme', permissions: exact() },
      { id: 12, account: 'widgets', permissions: { ...exact(), actions: 'write' } },
    ];
    assert.deepEqual(installationPermissionFindings({ owners, installations }), []);
  });

  test('an installation on a listed owner that has not accepted a permission fails, naming the account and the permission', () => {
    const installations = [
      { id: 11, account: 'acme', permissions: exact() },
      { id: 12, account: 'widgets', permissions: { ...exact(), checks: 'read' } },
    ];
    const findings = installationPermissionFindings({ owners, installations });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, /\bwidgets\b/);
    assert.match(findings[0]!, /Checks \(write, holds read\)/);
    assert.doesNotMatch(findings[0]!, /\bacme\b/);
  });

  test('an installation on an owner not on the list does not fail the check', () => {
    const installations = [
      { id: 11, account: 'acme', permissions: exact() },
      { id: 13, account: 'stranger', permissions: { metadata: 'read' } },
    ];
    assert.deepEqual(installationPermissionFindings({ owners, installations }), []);
  });

  test('every finding is written without an em dash', () => {
    const findings = [
      ...appPermissionFindings({ slug: 'governor-app', permissions: undefined }),
      ...appPermissionFindings({ slug: 'governor-app', permissions: {} }),
      ...installationPermissionFindings({ owners, installations: [{ id: 11, account: 'acme', permissions: {} }] }),
    ];
    assert.equal(findings.length, 3);
    for (const finding of findings) assert.ok(!finding.includes('—'), finding);
  });
});

describe('app-permissions — the run', () => {
  // An id no other part of a line could hold by chance.
  const ID = 97531;
  const installations = [
    { id: ID, account: 'acme', permissions: { ...exact(), checks: 'read' } },
    { id: ID + 2, account: 'stranger', permissions: {} },
  ];
  const env = { [APP_SLUG_VAR]: 'governor-app', APP_ID: '42', APP_PRIVATE_KEY: 'pem', GOVERNOR_OWNERS: 'acme' };
  const faked = () => CHECKS.map((c) => {
    if (c.id === 'app-permissions') return { ...c, run: (o: { env: Record<string, string | undefined> }) => checkAppPermissions({ ...o, readPermissions: async () => exact() }) };
    if (c.id === 'installation-permissions') return { ...c, run: (o: { env: Record<string, string | undefined> }) => checkInstallationPermissions({ ...o, readInstallations: async () => installations }) };
    return null;
  }).filter((c) => c !== null);

  test('the runner holds both checks, each by the variables it reads', () => {
    const ids = Object.fromEntries(CHECKS.map((c) => [c.id, c.env]));
    assert.deepEqual(ids['app-permissions'], [APP_SLUG_VAR]);
    assert.deepEqual(ids['installation-permissions'], [...INSTALLATION_VARS]);
    assert.deepEqual([...INSTALLATION_VARS], ['APP_ID', 'APP_PRIVATE_KEY', 'GOVERNOR_OWNERS']);
  });

  test('prints the App\'s permissions, fails on an installation\'s gap, and no line holds an installation id', async () => {
    const lines: string[] = [];
    const code = await runAll(env, { checks: faked(), log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.ok(lines.includes('ok app-permissions'));
    assert.ok(lines.some((l) => /governor-app holds: .*checks write/.test(l)), 'the App\'s permissions are said out loud');
    assert.ok(lines.includes('FAIL installation-permissions'));
    assert.ok(lines.some((l) => /acme/.test(l) && /Checks/.test(l)));
    assert.ok(!lines.some((l) => /stranger/.test(l)), 'an unlisted owner\'s installation is not read out');
    for (const line of lines) assert.doesNotMatch(line, new RegExp(`${ID}|${ID + 2}`), line);
  });

  test('the default App read is GitHub\'s public App endpoint, under a timeout', async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ slug: 'governor-app', permissions: exact() }), { status: 200 });
    }) as typeof fetch;
    try {
      assert.deepEqual((await checkAppPermissions({ env })).findings, []);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(seen.map((s) => s.url), ['https://api.github.com/apps/governor-app']);
    assert.ok(seen[0]!.init?.signal instanceof AbortSignal, 'the read carries a timeout');
  });

  test('the default installations read lists them as the App, page by page, and a failed read names no installation id', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; auth: string; signal: unknown }> = [];
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: ID + i, account: { login: i === 0 ? 'acme' : `other${i}` }, permissions: exact() }));
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: String((init?.headers as Record<string, string>)?.authorization ?? ''), signal: init?.signal });
      return new Response(JSON.stringify(url.endsWith('&page=1') ? page(100) : page(1)), { status: 200 });
    }) as typeof fetch;
    try {
      const outcome = await checkInstallationPermissions({ env: { ...env, APP_PRIVATE_KEY: pem } });
      assert.deepEqual(outcome.findings, []);
      for (const line of outcome.notes ?? []) assert.doesNotMatch(line, new RegExp(String(ID)), line);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(seen.map((s) => s.url), [
      'https://api.github.com/app/installations?per_page=100&page=1',
      'https://api.github.com/app/installations?per_page=100&page=2',
    ]);
    for (const s of seen) assert.match(s.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, 'the read is the App\'s own JWT');
    for (const s of seen) assert.ok(s.signal instanceof AbortSignal, 'each page read carries a timeout');
  });

  test('a listed owner with no installation is said out loud, and fails nothing', async () => {
    const outcome = await checkInstallationPermissions({
      env: { ...env, GOVERNOR_OWNERS: 'acme, Widgets' },
      readInstallations: async () => [{ id: ID, account: 'acme', permissions: exact() }],
    });
    assert.deepEqual(outcome.findings, []);
    assert.ok((outcome.notes ?? []).some((l) => /acme accepted/.test(l)));
    assert.ok((outcome.notes ?? []).some((l) => /no installation on Widgets/.test(l)), 'the owner with no installation is named');
  });
});

describe('app-permissions — what the deploy hands the check', () => {
  test('the read-back step names the App, the owners, and reads the App key into the environment', () => {
    const { workflow } = loadWorkflow(DEPLOY_YML);
    const steps = workflow.jobs?.deploy?.steps ?? [];
    const read = steps.find(runsScript('scripts/conformance.mjs'));
    assert.ok(read);
    assert.equal(read.env?.[APP_SLUG_VAR], '${{ vars.APP_SLUG }}');
    assert.equal(read.env?.['GOVERNOR_OWNERS'], '${{ vars.GOVERNOR_OWNERS }}');
    const lines: string[] = (read.run ?? '').split('\n');
    assert.ok(lines.some((l) => /get-secret-value --secret-id governor\/github-app/.test(l)), 'the key is the one the deploy points the webhook with');
    const mask = lines.findIndex((l) => /echo "::add-mask::\$\{line\}"/.test(l));
    assert.ok(mask >= 0 && mask < lines.findIndex((l) => /conformance\.mjs/.test(l)), 'the key is masked before the script runs');
    assert.ok(lines.some((l) => /^\s*export\b.*\bAPP_ID\b.*\bAPP_PRIVATE_KEY\b/.test(l)), 'the key reaches the script through the environment');
    for (const line of lines) {
      assert.doesNotMatch(line, /echo "(?!::add-mask::).*APP_PRIVATE_KEY|conformance\.mjs\s+\S/, 'the key never reaches an argument list or the log');
    }
  });
});

describe('app-permissions — docs/self-hosting.md', () => {
  const LEVEL_WORDS: Record<string, string> = { read: 'Read', write: 'Read and write' };
  const doc = readFileSync(SELF_HOSTING, 'utf8');
  const section = doc.slice(doc.indexOf('**Repository permissions**'), doc.indexOf('**Subscribe to events**'));
  const listed = [...section.matchAll(/^\s*- \*\*([^*]+)\*\*: (Read and write|Read)\b/gm)].map((m) => [m[1], m[2]]);

  test('lists each permission in the code\'s list at its level, and no other', () => {
    assert.ok(section.length > 0, 'the section is where the test looks for it');
    assert.deepEqual(
      listed.slice().sort(),
      APP_PERMISSIONS.map((p) => [p.name, LEVEL_WORDS[p.level]]).sort(),
    );
  });
});
