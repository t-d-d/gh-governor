/**
 * The JSON Schema of `.github/dispatch.json` (schema/dispatch.schema.json),
 * exported from `configSchema` by scripts/export-config-schema.mjs. A served
 * repo maps its config file to it in its editor, which then completes key
 * names and flags an unknown key. It covers the file's shape only: the
 * export drops every rule across keys and cannot read a prompt file, so the
 * config check is the full one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, configJsonSchema, schemaText } from '../scripts/export-config-schema.mjs';

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

  test('refuses an unknown key at the top, so a $schema key does not belong in the file', () => {
    assert.equal(configJsonSchema().additionalProperties, false);
  });
});

describe('the README on the schema', () => {
  const readme = read('README.md');

  test('maps the config file to the schema at a pinned commit through json.schemas', () => {
    assert.match(readme, /json\.schemas/);
    assert.match(readme, /\.vscode\/settings\.json/);
    assert.ok(readme.includes(`https://raw.githubusercontent.com/t-d-d/gh-governor/<commit>/${SCHEMA_PATH}`));
  });
});
