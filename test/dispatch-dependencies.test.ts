/**
 * The packages code under dispatch/ imports, and the scripts/ modules it
 * imports, and which of them the root package-lock.json must install at the
 * version dispatch/package-lock.json does.
 *
 * Code under dispatch/ takes a package from dispatch/node_modules when that
 * is installed, and from the root otherwise. The gate installs only the root,
 * with npm ci, so the tests run the root's version. The task image installs
 * dispatch/package-lock.json, and the scripts/lib/ modules dispatch/ imports
 * load their packages from it there too. Where a test runs a package for
 * real, the two versions have to match, or the tests check code the task
 * does not ship.
 *
 * Every third-party package that code imports is on one of the two lists
 * below. A new import fails the test until someone puts it on a list, with
 * the reason.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importClosure, moduleSpecifiers } from './helpers/imports.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Listed = { name: string, reason: string };

/** Packages the tests run for real, so the root must install the version dispatch/ ships. */
const MUST_MATCH: Listed[] = [
  { name: 'zod', reason: 'dispatch/repo-config.mjs builds the config schema with it, and the tests parse configs and export the JSON Schema with the real zod.' },
  { name: 'js-yaml', reason: 'dispatch/labels.mjs reads YAML with it, and the tests run that parse for real.' },
];

/**
 * Packages whose root version may differ from dispatch/'s. A name ending in
 * `/*` covers the whole scope.
 */
const MAY_DIFFER: Listed[] = [
  { name: '@aws-sdk/*', reason: 'the tests replace every AWS client with a fake, and read back only each command\'s class name and the input it was built with, which every version keeps.' },
];

const covers = (entry: string, name: string): boolean =>
  entry.endsWith('/*') ? name.startsWith(entry.slice(0, -1)) : entry === name;

const onList = (list: Listed[], name: string): boolean => list.some(({ name: entry }) => covers(entry, name));

/** The package a bare specifier names: `@scope/pkg/sub` is `@scope/pkg`, `pkg/sub` is `pkg`. Null for a relative path or a node built-in. */
const packageOf = (specifier: string): string | null => {
  if (/^\.{0,2}\//.test(specifier) || isBuiltin(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
};

/** Third-party packages the sources import, each with the first file that imports it. */
const thirdPartyImports = (sources: Record<string, string>): Map<string, string> => {
  const found = new Map<string, string>();
  for (const [file, source] of Object.entries(sources)) {
    for (const spec of moduleSpecifiers(source)) {
      const name = packageOf(spec);
      if (name && !found.has(name)) found.set(name, file);
    }
  }
  return found;
};

/** The imported packages on neither list, as `name (file)`. */
const unlisted = (imports: Map<string, string>): string[] =>
  [...imports].filter(([name]) => !onList(MUST_MATCH, name) && !onList(MAY_DIFFER, name)).map(([name, file]) => `${name} (${file})`);

type Lock = { packages?: Record<string, { version?: string }> };

const versionIn = (lock: Lock, name: string): string | undefined => lock.packages?.[`node_modules/${name}`]?.version;

/** Each must-match package dispatch/ installs at a version the root does not, as `name: root vs dispatch`. */
const mismatches = (root: Lock, dispatch: Lock, names: string[]): string[] =>
  names
    .filter((name) => versionIn(root, name) !== versionIn(dispatch, name))
    .map((name) => `${name}: root ${versionIn(root, name) ?? 'none'}, dispatch/ ${versionIn(dispatch, name) ?? 'none'}`);

const readLock = (path: string): Lock => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Lock;

/** Every module under dispatch/, and every repo module those import, by path from the root. */
const dispatchSources = (): Record<string, string> => {
  const modules: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (/\.m?js$/.test(entry.name)) {
        modules.push(relative(ROOT, path));
      }
    }
  };
  walk(join(ROOT, 'dispatch'));
  return Object.fromEntries([...importClosure(ROOT, ...modules)].map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]));
};

describe('the packages the root and dispatch/ lock files must hold to one version', () => {
  test('the root package-lock.json installs each must-match package at the version dispatch/package-lock.json does', () => {
    const dispatch = readLock('dispatch/package-lock.json');
    for (const { name } of MUST_MATCH) assert.ok(versionIn(dispatch, name), `dispatch/package-lock.json installs no top-level ${name}`);
    assert.deepEqual(
      mismatches(readLock('package-lock.json'), dispatch, MUST_MATCH.map(({ name }) => name)),
      [],
      'set the root version to the one dispatch/package-lock.json resolves, and run npm install',
    );
  });

  test('the check fails when zod or js-yaml differs between the two lock files', () => {
    const lock = (zod: string, yaml: string): Lock => ({ packages: { 'node_modules/zod': { version: zod }, 'node_modules/js-yaml': { version: yaml } } });
    const names = MUST_MATCH.map(({ name }) => name);
    assert.deepEqual(mismatches(lock('4.6.7', '4.3.2'), lock('4.6.7', '4.3.2'), names), []);
    assert.deepEqual(mismatches(lock('4.6.7', '4.3.2'), lock('4.6.8', '4.3.2'), names), ['zod: root 4.6.7, dispatch/ 4.6.8']);
    assert.deepEqual(mismatches(lock('4.6.7', '4.3.2'), lock('4.6.7', '4.4.0'), names), ['js-yaml: root 4.3.2, dispatch/ 4.4.0']);
    assert.deepEqual(mismatches({ packages: {} }, lock('4.6.7', '4.3.2'), ['zod']), ['zod: root none, dispatch/ 4.6.7']);
  });

  test('@aws-sdk/* may differ, because the tests replace every AWS client with a fake', () => {
    assert.ok(!onList(MUST_MATCH, '@aws-sdk/client-dynamodb'));
    assert.ok(onList(MAY_DIFFER, '@aws-sdk/client-dynamodb'));
    assert.match(MAY_DIFFER.find(({ name }) => name === '@aws-sdk/*')?.reason ?? '', /fake/);
  });

  test('every list entry gives its reason', () => {
    for (const { name, reason } of [...MUST_MATCH, ...MAY_DIFFER]) assert.ok(reason.trim().length > 0, `${name} has no reason`);
  });
});

describe('the third-party packages code under dispatch/, and the modules it imports, imports', () => {
  test('each is on the must-match list or the may-differ list', () => {
    const sources = dispatchSources();
    assert.ok(Object.keys(sources).includes('scripts/lib/session-signoff.mjs'), 'the scan does not follow dispatch/ into the scripts/lib/ modules it imports');
    const imports = thirdPartyImports(sources);
    assert.deepEqual(MUST_MATCH.map(({ name }) => name).filter((name) => !imports.has(name)), [], 'a must-match package nothing under dispatch/ imports any more: take it off MUST_MATCH');
    assert.deepEqual(unlisted(imports), [], 'put each package on MUST_MATCH or MAY_DIFFER in test/dispatch-dependencies.test.ts, with the reason');
  });

  test('the check fails on a package on neither list, from any kind of import', () => {
    const imports = thirdPartyImports({
      'dispatch/a.mjs': [
        "import { z } from 'zod';",
        "import yaml from 'js-yaml';",
        "import { SQSClient } from '@aws-sdk/client-sqs';",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        "import { helper } from './helper.mjs';",
        "import 'side-effect';",
        "export { thing } from '@scope/pkg/sub';",
        "const late = await import('lazy/deep/path');",
      ].join('\n'),
    });
    assert.deepEqual(unlisted(imports), ['side-effect (dispatch/a.mjs)', '@scope/pkg (dispatch/a.mjs)', 'lazy (dispatch/a.mjs)']);
  });
});
