#!/usr/bin/env node
/**
 * The constraint-file check (docs/constraints/README.md). It reads every
 * tracked file and refuses, in each constraint file (docs/constraints/*.md
 * but the README):
 *
 *   - lines:          a file over 120 lines;
 *   - relevance:      a `Relevance:` that is not exactly one line of at most
 *                     240 characters, after the label, naming at least one
 *                     file glob;
 *   - relevance-path: a `Relevance:` path that matches no tracked file;
 *   - relevance-tree: a `Relevance:` path matching a file the `paths:` list
 *                     of .claude/rules/constraints.md leaves out;
 *   - decision:       a `Decision:` that is not exactly one line of at most
 *                     160 characters, after the label;
 *   - uncited:        a file no `fitness:` describe in a test cites, with no
 *                     `Judgment:` line;
 *   - unbuilt:        a file that describes unbuilt work;
 *
 * and, in every tracked file:
 *
 *   - unresolved:     a cited constraint file that does not exist. A
 *                     `constraints/<name>.md` path, full or relative, is a
 *                     citation outside test/, where a test's paths are
 *                     fixtures; a bare
 *                     hyphenated `<name>.md` is one everywhere, and resolves
 *                     to any tracked file of that name.
 *
 * `npm run constraints` prints each finding and exits 1 on any.
 */

import { readFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { trackedFiles } from './public-repo-scan.mjs';

/** @typedef {{ path: string, kind: string, text: string }} Finding */

export const MAX_LINES = 120;
export const MAX_RELEVANCE = 240;
export const MAX_DECISION = 160;
const RULES_FILE = '.claude/rules/constraints.md';
const UNBUILT = /not yet built|lands with/i;

const isConstraint = (/** @type {string} */ path) =>
  /^docs\/constraints\/[^/]+\.md$/.test(path) && path !== 'docs/constraints/README.md';
const isTest = (/** @type {string} */ path) => /^test\/.+\.test\.ts$/.test(path);
const basename = (/** @type {string} */ path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Every glob `{a,b}` braces spell out.
 *
 * @param {string} glob
 * @returns {string[]}
 */
export const expandBraces = (glob) => {
  const brace = /\{([^{}]*)\}/.exec(glob);
  if (!brace) return [glob];
  return (brace[1] ?? '').split(',').flatMap((alt) =>
    expandBraces(glob.slice(0, brace.index) + alt + glob.slice(brace.index + brace[0].length)));
};

/**
 * A glob's regex, `**` across folders and `*` within one.
 *
 * @param {string} glob - With no braces.
 */
const globRegex = (glob) => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};

const matches = (/** @type {string} */ glob, /** @type {string} */ path) => expandBraces(glob).some((g) => globRegex(g).test(path));

/**
 * The file globs a `Relevance:` line names: each word holding a `/`, or a
 * bare file name, with backticks and trailing punctuation taken off.
 *
 * @param {string} line
 */
export const relevanceGlobs = (line) =>
  line.split(/\s+/)
    .map((word) => word.replace(/^[`(]+/, '').replace(/[`),.;:]+$/, ''))
    .filter((word) => word.includes('/') || /^[\w.-]+\.(?:json|ya?ml|mjs|js|ts|md)$/.test(word));

/** @param {string} text */
const rulesPaths = (text) => [...text.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1] ?? '');

/**
 * Every finding in the repo.
 *
 * @param {{ files?: string[], read?: (path: string) => string }} [io]
 * @returns {Finding[]}
 */
export const checkConstraints = ({ files = trackedFiles(), read = (path) => readFileSync(path, 'utf8') } = {}) => {
  /** @type {Finding[]} */
  const findings = [];
  const add = (/** @type {string} */ path, /** @type {string} */ kind, /** @type {string} */ text) => findings.push({ path, kind, text });
  const names = new Set(files.map(basename));
  const known = new Set(files);
  const paths = files.includes(RULES_FILE) ? rulesPaths(read(RULES_FILE)) : [];

  /** @type {Set<string>} */
  const cited = new Set();
  for (const path of files) {
    if (/\.(?:png|jpe?g|gif|ico|woff2?|pdf)$/i.test(path)) continue;
    const text = read(path);
    for (const line of text.split('\n')) {
      if (isTest(path) && line.includes('describe(') && line.includes('fitness:')) {
        for (const m of line.matchAll(/[\w-]+\.md/g)) cited.add(m[0]);
      }
      if (!isTest(path) && !path.startsWith('test/')) {
        for (const m of line.matchAll(/(?<![\w./-])(?:docs\/)?constraints\/([\w.-]+\.md)/g)) {
          if (!known.has(`docs/constraints/${m[1]}`)) add(path, 'unresolved', m[0]);
        }
      }
      for (const m of line.matchAll(/(?<![\w/.-])([a-z0-9]+(?:-[a-z0-9]+)+\.md)\b/g)) {
        if (!names.has(m[1] ?? '')) add(path, 'unresolved', m[0]);
      }
    }
  }

  for (const path of files.filter(isConstraint)) {
    const lines = read(path).replace(/\n$/, '').split('\n');
    if (lines.length > MAX_LINES) add(path, 'lines', `${lines.length} lines, over ${MAX_LINES}`);

    const relevance = lines.filter((l) => l.startsWith('Relevance:'));
    const relevanceText = relevance.length === 1 ? String(relevance[0]).slice('Relevance:'.length).trim() : '';
    const globs = relevanceGlobs(relevanceText).flatMap(expandBraces);
    if (relevance.length !== 1) add(path, 'relevance', `${relevance.length} Relevance: lines, not one`);
    else if (relevanceText.length > MAX_RELEVANCE) add(path, 'relevance', `Relevance: is ${relevanceText.length} characters, over ${MAX_RELEVANCE}`);
    else if (globs.length === 0) add(path, 'relevance', 'Relevance: names no file glob');
    for (const glob of globs) {
      const hits = files.filter((f) => matches(glob, f));
      if (hits.length === 0) add(path, 'relevance-path', `${glob} matches no tracked file`);
      const outside = hits.filter((f) => !paths.some((p) => matches(p, f)));
      if (outside.length > 0) add(path, 'relevance-tree', `${glob} matches ${outside.join(', ')}, which ${RULES_FILE} leaves out`);
    }

    const decision = lines.filter((l) => l.startsWith('Decision:'));
    const decisionText = decision.length === 1 ? String(decision[0]).slice('Decision:'.length).trim() : '';
    if (decision.length !== 1) add(path, 'decision', `${decision.length} Decision: lines, not one`);
    else if (decisionText.length > MAX_DECISION) add(path, 'decision', `Decision: is ${decisionText.length} characters, over ${MAX_DECISION}`);

    if (!cited.has(basename(path)) && !lines.some((l) => l.startsWith('Judgment:'))) {
      add(path, 'uncited', 'no fitness: test cites it, and it has no Judgment: line');
    }
    const unbuilt = lines.find((l) => UNBUILT.test(l));
    if (unbuilt) add(path, 'unbuilt', unbuilt.trim());
  }
  return findings;
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  const findings = checkConstraints();
  for (const f of findings) console.error(`${f.path}: ${f.kind}: ${f.text}`);
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s): see docs/constraints/README.md`);
    process.exit(1);
  }
  console.log('constraints check: no finding');
}
