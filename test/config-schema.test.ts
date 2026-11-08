/**
 * The JSON Schema of `.github/governor.json` (schema/governor.schema.json),
 * exported from `configSchema` by scripts/export-config-schema.mjs. A served
 * repo names it in its file's `$schema` key, and an editor then completes key
 * names, describes each key and flags an unknown one. It covers the file's
 * shape only: the export drops every rule across keys and cannot read a
 * prompt file, so the config check is the full one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { REFERENCE_PATH, SCHEMA_PATH, configJsonSchema, referenceText, schemaText } from '../scripts/export-config-schema.mjs';
import { readConfig } from '../dispatch/repo-config.mjs';
import { shippingJob } from '../dispatch/webhook/fire.mjs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the config file\'s JSON Schema', () => {
  test('the committed file is a fresh export of configSchema', () => {
    assert.equal(read(SCHEMA_PATH), schemaText(), 'run node scripts/export-config-schema.mjs and commit the result');
  });

  test('its description says it covers the shape only, and names the config check', () => {
    const { description } = configJsonSchema();
    assert.match(String(description), /shape/);
    assert.match(String(description), /config check/);
  });

  test('every property, at every depth, carries a description', () => {
    const missing: string[] = [];
    const walk = (node: unknown, at: string) => {
      if (node === null || typeof node !== 'object') return;
      const { properties } = node as { properties?: Record<string, unknown> };
      if (properties !== undefined && typeof properties === 'object') {
        for (const [key, child] of Object.entries(properties)) {
          const { description } = child as { description?: unknown };
          if (typeof description !== 'string' || description.trim() === '') missing.push(`${at}.${key}`);
        }
      }
      for (const [key, child] of Object.entries(node)) walk(child, key === 'properties' ? at : `${at}/${key}`);
    };
    walk(configJsonSchema(), '$');
    assert.deepEqual(missing, [], 'give each a description with .meta() in dispatch/repo-config.mjs');
  });

  test('documents the prReview section\'s requireChecks', () => {
    const schema = configJsonSchema() as { properties: { prReview: { properties: Record<string, { description?: unknown, type?: unknown }> } } };
    const listed = schema.properties.prReview.properties.requireChecks;
    assert.equal(listed?.type, 'array');
    assert.match(String(listed?.description), /check/);
  });

  test('knows a top-level $schema key, and still refuses any other unknown key at the top', () => {
    const schema = configJsonSchema() as { additionalProperties?: unknown, properties: Record<string, { type?: unknown }> };
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.$schema?.type, 'string');
  });
});

describe('a $schema key in the config file', () => {
  const fixture = JSON.parse(read('test/fixtures/factory/.github/governor.json')) as Record<string, unknown>;
  const url = `https://raw.githubusercontent.com/t-d-d/gh-governor/0123456789abcdef0123456789abcdef01234567/${SCHEMA_PATH}`;

  test('is ignored: readConfig reads the same config with and without it', () => {
    const { $schema: _drop, ...without } = fixture;
    const bare = readConfig(JSON.stringify(without));
    const named = readConfig(JSON.stringify({ $schema: url, ...without }));
    assert.equal(bare.ok, true);
    assert.deepEqual(named, bare);
  });

  test('is a string', () => {
    const got = readConfig(JSON.stringify({ ...fixture, $schema: 7 }));
    assert.equal(got.ok, false);
    assert.match(got.ok ? '' : got.fault, /\$schema/);
  });

  test('is refused below the top, as any unknown key is', () => {
    const pickup = { ...(fixture.pickup as Record<string, unknown>), $schema: url };
    const got = readConfig(JSON.stringify({ ...fixture, pickup }));
    assert.equal(got.ok, false);
    assert.match(got.ok ? '' : got.fault, /pickup/);
    const { sessions } = fixture.periodics as { sessions: Record<string, Record<string, unknown>> };
    const periodics = { sessions: Object.fromEntries(Object.entries(sessions).map(([name, p]) => [name, { ...p, $schema: url }])) };
    assert.equal(readConfig(JSON.stringify({ ...fixture, periodics })).ok, false);
  });

  test('leaves every other unknown key at the top a fault', () => {
    const got = readConfig(JSON.stringify({ ...fixture, $schemas: url }));
    assert.equal(got.ok, false);
    assert.match(got.ok ? '' : got.fault, /\$schemas/);
  });

  test('requires no key that has a default, so a file leaving one out is not flagged', () => {
    type Node = { properties?: Record<string, Node & { default?: unknown }>, required?: string[], [key: string]: unknown };
    const defaultedRequired: string[] = [];
    const walk = (node: unknown, at: string) => {
      if (node === null || typeof node !== 'object') return;
      const { properties, required = [] } = node as Node;
      for (const [key, child] of Object.entries(properties ?? {})) {
        if ('default' in child && required.includes(key)) defaultedRequired.push(`${at}.${key}`);
      }
      for (const [key, child] of Object.entries(node)) walk(child, `${at}.${key}`);
    };
    walk(configJsonSchema(), '$');
    assert.deepEqual(defaultedRequired, []);
    assert.deepEqual(configJsonSchema().required, ['environment']);
  });
});

describe('the generated config reference', () => {
  test('the committed docs/config-reference.md is a fresh export of configSchema', () => {
    assert.equal(read(REFERENCE_PATH), referenceText(), 'run node scripts/export-config-schema.mjs and commit the result');
  });

  type Node = { description?: string, properties?: Record<string, Node>, items?: Node, additionalProperties?: Node | boolean, anyOf?: Node[] };
  /** Every key path below the top, as the reference writes it: `<name>` for a keyed entry, `[]` for a list's item. */
  const paths = (node: Node, at: string[]): string[][] => {
    const out: string[][] = [];
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const isFile = key === 'file' && at.length > 0 && Object.keys(node.properties ?? {}).length === 1;
      if (isFile) continue;
      out.push([...at, key], ...paths(child, [...at, key]));
    }
    if (typeof node.additionalProperties === 'object' && node.additionalProperties.properties !== undefined) out.push(...paths(node.additionalProperties, [...at, '<name>']));
    if (node.items !== undefined) out.push(...paths(node.items, [...at, '[]']));
    for (const option of node.anyOf ?? []) out.push(...paths(option, at));
    return out;
  };

  test('gives each top-level key a heading with its description, and every key below it a row with its description', () => {
    const text = referenceText();
    const schema = configJsonSchema() as Node;
    for (const [key, node] of Object.entries(schema.properties ?? {})) {
      assert.ok(text.includes(`\n## \`${key}\`\n\n${node.description}\n`), `a heading and description for ${key}`);
      for (const path of paths(node, [key])) {
        const shown = path.join('.').replaceAll('.[]', '[]');
        assert.ok(text.includes(`| \`${shown}\` |`), `a row for ${shown}`);
      }
    }
  });

  test('says it is generated, and from where', () => {
    assert.match(referenceText(), /Generated by `node scripts\/export-config-schema\.mjs` from `configSchema` in \[dispatch\/repo-config\.mjs\]/);
  });

  test('writes no raw angle bracket outside a code span, which GitHub would read as an HTML tag and drop', () => {
    for (const line of referenceText().split('\n')) {
      assert.doesNotMatch(line.replace(/`[^`]*`/g, ''), /</, `a raw < in: ${line.slice(0, 120)}`);
    }
  });

  test('says a list whose items take one of several shapes is a list of either shape, not a list or an object', () => {
    const row = referenceText().split('\n').find((line) => line.startsWith('| `prReview.requireChecks` |'));
    assert.match(row ?? '', /^\| `prReview\.requireChecks` \| list, each string, or object \(`name`, `app`\) \|/);
  });

  test('says the shipping job\'s `at <sha>` is in lower case, since an upper-case one is not read and the run\'s head ships instead', () => {
    const upper = 'A'.repeat(40);
    assert.equal(shippingJob(`Deploy at ${upper} · deployed: live`)?.commit, undefined);
    assert.equal(shippingJob(`Deploy at ${upper.toLowerCase()} · deployed: live`)?.commit, upper.toLowerCase());
    assert.match(referenceText(), /`at <sha>`, the whole 40-character commit in lower case,/);
  });

  test('every link into it from docs/ names a heading it has', () => {
    const anchors = new Set([...referenceText().matchAll(/^## `([^`]+)`$/gm)].map((m) => (m[1] ?? '').toLowerCase().replace(/[^a-z0-9 _-]/g, '').replaceAll(' ', '-')));
    const docs = readdirSync(new URL('../docs/', import.meta.url)).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`);
    for (const doc of [...docs, 'README.md']) {
      for (const [, anchor] of read(doc).matchAll(/config-reference\.md#([\w-]+)/g)) assert.ok(anchors.has(anchor ?? ''), `${doc} links #${anchor}`);
    }
  });
});

describe('docs/serving-a-repo.md, the guide to opting in', () => {
  const guide = read('docs/serving-a-repo.md');

  test('is under 150 lines', () => {
    assert.ok(guide.split('\n').length < 150, `${guide.split('\n').length} lines`);
  });

  test('keeps no key table of its own, and points at the generated reference', () => {
    assert.doesNotMatch(guide, /^\| Key \|/m);
    assert.doesNotMatch(guide, /^\| Section \|/m);
    assert.match(guide, /\]\(config-reference\.md\)/);
  });

  test('names the schema at a pinned commit in the file\'s $schema key, with no editor settings', () => {
    assert.ok(guide.includes(`"$schema": "https://raw.githubusercontent.com/t-d-d/gh-governor/<commit>/${SCHEMA_PATH}"`));
    assert.doesNotMatch(guide, /\.vscode\/settings\.json/);
    assert.doesNotMatch(guide, /json\.schemas/);
  });

  test('names $schema as the exception to an unknown key being a fault', () => {
    assert.match(guide, /An unknown key anywhere is a fault, except a top-level `\$schema`/);
  });
});
