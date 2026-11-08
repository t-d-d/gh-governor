#!/usr/bin/env node
/**
 * Export the JSON Schema of a served repo's `.github/governor.json` from
 * `configSchema` (dispatch/repo-config.mjs), and write it to
 * schema/governor.schema.json, with a reference page for people,
 * docs/config-reference.md, built from the same descriptions. A repo names that file at a pinned commit in
 * its config file's `$schema` key, and an editor then describes each key,
 * completes key names and flags an unknown key while the file is written.
 *
 *   node scripts/export-config-schema.mjs
 *
 * It calls the schema's own `toJSONSchema`, zod's `z.toJSONSchema`, so the
 * export uses the zod `configSchema` was built with. The export keeps the
 * file's shape and drops every `refine`, so a rule across keys, such as a
 * claim label that is also a ready label, is not in it, and it cannot read
 * a prompt file. The config check
 * (checker/config-check.mjs) is the full check. test/config-schema.test.ts
 * fails when either committed file differs from a fresh export.
 */

import { writeFileSync } from 'node:fs';
import { configSchema } from '../dispatch/repo-config.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** Where the schema is committed, from the repo's root. */
export const SCHEMA_PATH = 'schema/governor.schema.json';

/** Where the reference page is committed, from the repo's root. */
export const REFERENCE_PATH = 'docs/config-reference.md';

const DESCRIPTION = [
  'The shape of governor\'s config file, .github/governor.json, for an editor to complete and check keys while the file is written.',
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

/**
 * @typedef {{
 *   type?: string, description?: string, default?: unknown, enum?: unknown[],
 *   minimum?: number, maximum?: number, exclusiveMinimum?: number,
 *   properties?: Record<string, SchemaNode>, required?: string[],
 *   items?: SchemaNode, additionalProperties?: SchemaNode | boolean, anyOf?: SchemaNode[],
 * }} SchemaNode
 */

/**
 * Whether a node is a prompt: text, or an object holding only `file`.
 *
 * @param {SchemaNode} node
 */
const isTextOrFile = (node) => node.anyOf?.length === 2
  && node.anyOf[0]?.type === 'string'
  && Object.keys(node.anyOf[1]?.properties ?? {}).join() === 'file';

/** @param {unknown[]} values */
const listed = (values) => values.map((v) => `\`${String(v)}\``).join(', ');

/**
 * A node's type, in words, for the reference's Type column.
 *
 * @param {SchemaNode} node
 * @returns {string}
 */
const typeOf = (node) => {
  if (isTextOrFile(node)) return 'text, or `{ "file": "<path>" }`';
  if (node.anyOf !== undefined) return node.anyOf.map(typeOf).join(', or ');
  if (node.enum !== undefined) return `one of ${listed(node.enum)}`;
  if (node.type === 'array' && node.items?.enum !== undefined) return `list of any of ${listed(node.items.enum)}`;
  // A list whose items take one of several shapes: "list of string, or object" would read as a list or an object.
  if (node.type === 'array' && node.items?.anyOf !== undefined && !isTextOrFile(node.items)) return `list, each ${typeOf(node.items)}`;
  if (node.type === 'array') return `list of ${node.items === undefined ? 'values' : typeOf(node.items)}`;
  if (node.type === 'object') {
    if (node.properties === undefined && typeof node.additionalProperties === 'object') return `object of ${typeOf(node.additionalProperties)}, keyed by name`;
    return node.properties === undefined ? 'object' : `object (${Object.keys(node.properties).map((k) => `\`${k}\``).join(', ')})`;
  }
  if (node.type === 'integer' || node.type === 'number') {
    const low = node.minimum ?? (node.exclusiveMinimum === undefined ? undefined : node.exclusiveMinimum + 1);
    // zod writes the largest safe integer as the bound of a whole number with no limit of its own.
    const high = node.maximum === undefined || node.maximum >= Number.MAX_SAFE_INTEGER ? undefined : node.maximum;
    if (low !== undefined && high !== undefined) return `whole number, ${low} to ${high}`;
    if (low !== undefined) return `whole number, at least ${low}`;
    return 'whole number';
  }
  return node.type ?? 'any';
};

/**
 * Text with each `<` outside a code span written `&lt;`, so GitHub shows a
 * placeholder such as `<path>` rather than reading it as an HTML tag and
 * dropping it. Inside a code span the entity would show as written, so
 * spans are left alone.
 *
 * @param {string} text
 */
const prose = (text) => text.split(/(`[^`]*`)/).map((part, i) => (i % 2 === 1 ? part : part.replaceAll('<', '&lt;'))).join('');

/** A table cell: one line, with no bar to end it early. @param {string} text */
const cell = (text) => prose(text.replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|'));

/**
 * The rows below a node: each key's path, type, default and description.
 * A keyed entry's name is `<name>`, a list's item `[]`. A prompt's `file`
 * is left out, since the page says once what a prompt holds.
 *
 * @param {SchemaNode} node
 * @param {string} at
 * @returns {string[]}
 */
const rows = (node, at) => {
  if (isTextOrFile(node)) return [];
  /** @type {string[]} */
  const out = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = `${at}.${key}`;
    const type = typeOf(child) + ((node.required ?? []).includes(key) ? ', required' : '');
    const fallback = child.default === undefined ? '' : `\`${JSON.stringify(child.default)}\``;
    out.push(`| \`${path}\` | ${cell(type)} | ${cell(fallback)} | ${cell(child.description ?? '')} |`, ...rows(child, path));
  }
  if (typeof node.additionalProperties === 'object' && node.additionalProperties.properties !== undefined) out.push(...rows(node.additionalProperties, `${at}.<name>`));
  if (node.items !== undefined) out.push(...rows(node.items, `${at}[]`));
  for (const option of node.anyOf ?? []) out.push(...rows(option, at));
  return out;
};

/**
 * The reference page's text: one heading per top-level key, with its
 * description and a table of every key below it.
 *
 * @returns {string}
 */
export const referenceText = () => {
  const schema = /** @type {SchemaNode} */ (configJsonSchema());
  const textOrFile = Object.values(schema.properties ?? {}).flatMap((n) => Object.values(n.properties ?? {})).find(isTextOrFile);
  const fileNote = textOrFile?.anyOf?.[1]?.properties?.file?.description ?? '';
  const lines = [
    '# Config reference',
    '',
    `Every key of a served repo's \`.github/governor.json\`. Generated by \`node scripts/export-config-schema.mjs\` from \`configSchema\` in [dispatch/repo-config.mjs](../dispatch/repo-config.mjs), the schema governor reads the file with, so edit a description there, not here. [The JSON Schema](../${SCHEMA_PATH}) an editor reads holds the same descriptions. [Serving a repo](serving-a-repo.md) says how a repo opts in.`,
    '',
    `A section turns its feature on unless it sets \`"enabled": false\`, and a feature with no section is off. A prompt is text, or \`{ "file": "<path>" }\`. ${fileNote}`,
    '',
    'This page covers the shape only. Governor also refuses a file that breaks a rule across keys, such as a claim label that is also a ready label, and the config check runs every rule.',
  ];
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    lines.push('', `## \`${key}\``, '', prose(node.description ?? ''));
    const below = rows(node, key);
    if (below.length > 0) lines.push('', '| Key | Type | Default | What it holds |', '|---|---|---|---|', ...below);
  }
  return `${lines.join('\n')}\n`;
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  writeFileSync(new URL(`../${SCHEMA_PATH}`, import.meta.url), schemaText());
  writeFileSync(new URL(`../${REFERENCE_PATH}`, import.meta.url), referenceText());
  console.log(`wrote ${SCHEMA_PATH} and ${REFERENCE_PATH}`);
}
