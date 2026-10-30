#!/usr/bin/env node
/**
 * Export the JSON Schema of a served repo's `.github/dispatch.json` from
 * `configSchema` (dispatch/repo-config.mjs), and write it to
 * schema/dispatch.schema.json. A repo maps its config file to that file at a
 * pinned commit in its editor, which then completes key names and flags an
 * unknown key while the file is written.
 *
 *   node scripts/export-config-schema.mjs
 *
 * It calls the schema's own `toJSONSchema`, zod's `z.toJSONSchema`, so the
 * export uses the zod `configSchema` was built with. The export keeps the
 * file's shape and drops every `refine`, so a rule across keys, such as a
 * claim label that is also a ready label, is not in it, and it cannot read
 * a prompt file. The config check
 * (checker/config-check.mjs) is the full check. test/config-schema.test.ts
 * fails when the committed file differs from a fresh export.
 */

import { writeFileSync } from 'node:fs';
import { configSchema } from '../dispatch/repo-config.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** Where the schema is committed, from the repo's root. */
export const SCHEMA_PATH = 'schema/dispatch.schema.json';

const DESCRIPTION = [
  'The shape of governor\'s config file, .github/dispatch.json, for an editor to complete and check keys while the file is written.',
  'It covers the shape only: it leaves out the rules across keys and the checks on a prompt\'s text or a prompt file\'s path, and cannot read prompt files, so a file it accepts can still be refused.',
  'The config check, the reusable workflow .github/workflows/config-check.yml in t-d-d/gh-governor, is the full check.',
].join(' ');

/**
 * The schema of the file governor reads, `configSchema` as its input, with a
 * title and the description above.
 *
 * @returns {Record<string, unknown>}
 */
export const configJsonSchema = () => {
  const { $schema, ...rest } = configSchema.toJSONSchema({ io: 'input' });
  return { $schema, title: 'governor config file', description: DESCRIPTION, ...rest };
};

/** The committed file's text: the schema, two-space indented, with a closing newline. */
export const schemaText = () => `${JSON.stringify(configJsonSchema(), null, 2)}\n`;

if (isCliEntry(import.meta.url, process.argv[1])) {
  writeFileSync(new URL(`../${SCHEMA_PATH}`, import.meta.url), schemaText());
  console.log(`wrote ${SCHEMA_PATH}`);
}
