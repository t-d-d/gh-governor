/**
 * The JSON Schema of `.github/dispatch.json` (schema/dispatch.schema.json),
 * exported from `configSchema` by scripts/export-config-schema.mjs. A served
 * repo names it in its file's `$schema` key, and an editor then completes key
 * names, describes each key and flags an unknown one. It covers the file's
 * shape only: the export drops every rule across keys and cannot read a
 * prompt file, so the config check is the full one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, configJsonSchema, schemaText } from '../scripts/export-config-schema.mjs';
import { readConfig } from '../dispatch/repo-config.mjs';

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

  test('knows a top-level $schema key, and still refuses any other unknown key at the top', () => {
    const schema = configJsonSchema() as { additionalProperties?: unknown, properties: Record<string, { type?: unknown }> };
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.$schema?.type, 'string');
  });
});

describe('a $schema key in the config file', () => {
  const fixture = JSON.parse(read('test/fixtures/factory/.github/dispatch.json')) as Record<string, unknown>;
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
    const labels = { ...(fixture.labels as Record<string, unknown>), $schema: url };
    const got = readConfig(JSON.stringify({ ...fixture, labels }));
    assert.equal(got.ok, false);
    assert.match(got.ok ? '' : got.fault, /labels/);
    const periodics = (fixture.periodics as Record<string, unknown>[]).map((p) => ({ ...p, $schema: url }));
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
    assert.deepEqual(configJsonSchema().required, ['environment', 'labels', 'features']);
  });
});

describe('the README on the schema', () => {
  const readme = read('README.md');

  test('names the schema at a pinned commit in the file\'s $schema key, with no editor settings', () => {
    assert.ok(readme.includes(`"$schema": "https://raw.githubusercontent.com/t-d-d/gh-governor/<commit>/${SCHEMA_PATH}"`));
    assert.doesNotMatch(readme, /\.vscode\/settings\.json/);
    assert.doesNotMatch(readme, /json\.schemas/);
  });

  test('names $schema as the exception to an unknown key being a fault', () => {
    assert.match(readme, /An unknown key anywhere is a fault, except a top-level `\$schema`/);
  });

  type Node = { description?: string, properties?: Record<string, Node>, items?: Node };
  /** The exported schema's node at a dotted path, through objects' properties. */
  const nodeAt = (path: string) => path.split('.').reduce<Node | undefined>((node, key) => node?.properties?.[key], configJsonSchema() as Node);

  /** The rows of the README table whose header row starts `| <first> |`: each row's key and last cell. */
  const tableRows = (first: string) => {
    const lines = readme.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`| ${first} |`));
    assert.notEqual(start, -1, `the README has a table headed ${first}`);
    const rows: Array<{ key: string, cell: string }> = [];
    for (const line of lines.slice(start + 2)) {
      if (!line.startsWith('|')) break;
      const cells = line.slice(1, -1).split(' | ').map((c) => c.trim());
      const key = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1];
      assert.ok(key !== undefined, `a key in backticks opens the row: ${line}`);
      rows.push({ key, cell: cells.at(-1) ?? '' });
    }
    return rows;
  };

  test('the key table says what each key\'s description says, and lists every top-level key', () => {
    const rows = tableRows('Key');
    assert.ok(rows.length > 10);
    for (const { key, cell } of rows) assert.equal(cell, nodeAt(key)?.description, `README's row for ${key}`);
    const tops = new Set(rows.map((r) => r.key.split('.')[0]));
    const unlisted = Object.keys((configJsonSchema() as Node).properties ?? {}).filter((k) => !tops.has(k));
    assert.deepEqual(unlisted, [], 'give each top-level key a row in the README\'s key table');
  });

  test('the switch table says what each switch\'s description says, and lists every switch', () => {
    const rows = tableRows('Switch');
    for (const { key, cell } of rows) assert.equal(cell, nodeAt(`features.${key}`)?.description, `README's row for ${key}`);
    const listed = Object.entries(nodeAt('features')?.properties ?? {}).filter(([, n]) => !(n as { deprecated?: boolean }).deprecated).map(([k]) => k);
    assert.deepEqual(rows.map((r) => r.key), listed);
  });
});
