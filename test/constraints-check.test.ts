/**
 * The constraint-file check (scripts/constraints-check.mjs): the caps the
 * constraints README sets, each shown failing on an in-memory repo. The
 * fitness test that runs it over every tracked file is the last block.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkConstraints } from '../scripts/constraints-check.mjs';
import { trackedFiles } from '../scripts/public-repo-scan.mjs';
import { readFileSync } from 'node:fs';

/** A missing constraint file, built from parts so the check of this file finds no citation. */
const GONE = ['gone', 'away'].join('-') + '.md';

const RULES = ['---', 'paths:', '  - "dispatch/**"', '  - "test/**"', '---', 'Invoke the skill.'].join('\n');

const constraint = ({
  relevance = 'Changing the thing: dispatch/thing.mjs',
  decision = 'The thing does one thing.',
  body = ['## Rules', '', '- The thing holds.'],
  judgment = 'Judgment: whether the thing reads well, no check sees.',
}: { relevance?: string, decision?: string, body?: string[], judgment?: string | null } = {}) =>
  ['# Thing', `Relevance: ${relevance}`, `Decision: ${decision}`, '', 'Why: a reason.', '', ...body, '',
    ...(judgment === null ? [] : [judgment]), 'History: Set in #1.', ''].join('\n');

/** The kinds of finding for a repo holding the given files beside the rules file and one code file. */
const kinds = (files: Record<string, string>) => {
  const all: Record<string, string> = { '.claude/rules/constraints.md': RULES, 'dispatch/thing.mjs': 'export {};', ...files };
  return checkConstraints({ files: Object.keys(all), read: (path: string) => all[path]! }).map((f) => f.kind);
};

describe('checkConstraints', () => {
  test('passes a file that keeps every cap', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint() }), []);
  });

  test('reads no rule in the README', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint(), 'docs/constraints/README.md': '# Constraints\n' }), []);
  });

  test('fails a file over 120 lines', () => {
    const body = ['## Rules', '', ...Array.from({ length: 120 }, (_, i) => `- Rule ${i}.`)];
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ body }) }), ['lines']);
  });

  test('fails a Relevance: over 240 characters, a missing one, a second one, and one that names no file glob', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ relevance: `${'x'.repeat(222)}: dispatch/thing.mjs` }) }), ['relevance']);
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint().replace(/^Relevance:.*\n/m, '') }), ['relevance']);
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint().replace(/^(Relevance:.*\n)/m, '$1$1') }), ['relevance']);
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ relevance: 'Changing the thing' }) }), ['relevance']);
  });

  test('fails a Decision: over 160 characters, a missing one and a second one', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ decision: 'x'.repeat(161) }) }), ['decision']);
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint().replace(/^Decision:.*\n/m, '') }), ['decision']);
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint().replace(/^(Decision:.*\n)/m, '$1$1') }), ['decision']);
  });

  test('fails a file no fitness test cites that has no Judgment: line', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ judgment: null }) }), ['uncited']);
  });

  test('passes a file a fitness test cites, with no Judgment: line', () => {
    const t = "describe('fitness: the thing holds (thing.md)', () => {});\n";
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ judgment: null }), 'test/thing.test.ts': t }), []);
  });

  test('a citation outside a fitness describe, or in a file that is not a test, counts for nothing', () => {
    const files = { 'docs/constraints/thing.md': constraint({ judgment: null }) };
    assert.deepEqual(kinds({ ...files, 'test/thing.test.ts': "describe('the thing holds (thing.md)', () => {});\n" }), ['uncited']);
    assert.deepEqual(kinds({ ...files, 'test/helper.ts': "describe('fitness: the thing holds (thing.md)', () => {});\n" }), ['uncited']);
  });

  test('fails a constraint path cited anywhere that does not resolve, full or bare', () => {
    const files = { 'docs/constraints/thing.md': constraint() };
    assert.deepEqual(kinds({ ...files, 'dispatch/x.mjs': `// docs/constraints/${GONE}` }), ['unresolved']);
    assert.deepEqual(kinds({ ...files, 'dispatch/x.mjs': `// (${GONE})` }), ['unresolved']);
    assert.deepEqual(kinds({ ...files, 'docs/x.md': `[rule](constraints/${GONE})` }), ['unresolved']);
    assert.deepEqual(kinds({ ...files, 'docs/x.md': '[rule](constraints/thing.md)' }), []);
    assert.deepEqual(kinds({ ...files, 'docs/x.md': '[skill](../.claude/skills/constraints/SKILL.md)' }), []);
    assert.deepEqual(kinds({ ...files, 'test/x.test.ts': `describe('fitness: a rule (${GONE})', () => {});` }), ['unresolved']);
    assert.deepEqual(kinds({ ...files, 'dispatch/x.mjs': '// docs/constraints/thing.md and (thing.md)' }), []);
  });

  test('reads a test\'s full constraint path as a fixture, not a citation', () => {
    const files = { 'docs/constraints/thing.md': constraint() };
    assert.deepEqual(kinds({ ...files, 'test/x.test.ts': "const f = 'docs/constraints/promotion-gate.md';" }), []);
  });

  test('fails a Relevance: path that matches no tracked file', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ relevance: 'Changing it: dispatch/{thing,gone}.mjs' }) }), ['relevance-path']);
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ relevance: 'Changing it: dispatch/gone/**' }) }), ['relevance-path']);
  });

  test('fails a Relevance: path whose files the rules file\'s paths: list leaves out', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ relevance: 'Changing it: infra/stack.yml' }), 'infra/stack.yml': '' }), ['relevance-tree']);
  });

  test('matches a Relevance: glob\'s stars and braces against tracked files', () => {
    const relevance = 'Changing it: dispatch/**, dispatch/{thing,other}.mjs, dispatch/*.mjs, `test/fixtures/x.json`';
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ relevance }), 'dispatch/other.mjs': '', 'test/fixtures/x.json': '{}' }), []);
  });

  test('fails a file that describes unbuilt work', () => {
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ body: ['## Rules', '', '- The thing is not yet built.'] }) }), ['unbuilt']);
    assert.deepEqual(kinds({ 'docs/constraints/thing.md': constraint({ body: ['## Rules', '', '- The cap lands with the next ticket.'] }) }), ['unbuilt']);
  });
});

describe('fitness: every constraint file keeps the caps the README sets (README.md)', () => {
  test('the repo\'s constraint files pass the check', () => {
    const findings = checkConstraints({ files: trackedFiles(), read: (path: string) => readFileSync(path, 'utf8') });
    assert.deepEqual(findings, []);
  });
});
