#!/usr/bin/env node
/**
 * The public-repo scan (docs/constraints/public-repo.md). It reads every
 * tracked file, and every tracked file's path, and refuses:
 *
 *   - name:          the name of the private repo governor was extracted
 *                    from, in any case. The service shares the repo's
 *                    name, and a doc (the README, or Markdown under docs/)
 *                    may name the service, bare, and link its site;
 *   - repo:          the private repo itself, in every file: its
 *                    `owner/name` path, which its GitHub URL holds too,
 *                    in any case;
 *   - account:       a twelve-digit AWS account id, AWS's documented
 *                    example 123456789012 aside;
 *   - claude-id:     a claude.ai environment or session id (`env_`,
 *                    `session_` or `cse_` and twenty or more letters and
 *                    digits; a fake in a test is shorter);
 *   - installation:  a GitHub App installation id (seven or more digits
 *                    beside the word installation);
 *   - issue-number:  an issue or pull request reference of four or more
 *                    digits (`#` or `/issues/` or `/pull/` and the number), which
 *                    would point at another repo's numbers. A `#` and
 *                    digits followed by a letter, such as a hex colour,
 *                    is not a reference.
 *
 * No file is exempt, this one included, so the old name is built from parts
 * below. `npm run scan` prints each finding and exits 1 on any.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';

const OLD_HOME = new RegExp(['pod', 'stow'].join(''), 'i');

/** A doc may name the service: the README, or Markdown under docs/. */
const isDoc = (/** @type {string} */ path) => path === 'README.md' || /^docs\/.+\.md$/.test(path);

/**
 * In a doc, the name is refused unless it stands bare: joined to a word, a
 * variable, a marker or an issue (`-`, `_`, `:` or `#`) it names the old
 * code or the repo, not the service. Its site, the name and `.com`, passes.
 */
const NOT_BARE = new RegExp(`(?<=[A-Za-z0-9_-])${OLD_HOME.source}|${OLD_HOME.source}(?=[A-Za-z0-9_:#-])`, 'gi');

/** @type {Array<{ kind: string, pattern: RegExp, allow?: (match: string) => boolean, inDoc?: RegExp }>} */
const RULES = [
  { kind: 'name', pattern: new RegExp(OLD_HOME.source, 'gi'), inDoc: NOT_BARE },
  { kind: 'repo', pattern: new RegExp(`[A-Za-z0-9_.-]+/${OLD_HOME.source}(?![A-Za-z0-9_-])`, 'gi') },
  { kind: 'account', pattern: /(?<![0-9])[0-9]{12}(?![0-9])/g, allow: (match) => match === '123456789012' },
  { kind: 'claude-id', pattern: /\b(?:env|session|cse)_[A-Za-z0-9]{20,}/g },
  { kind: 'installation', pattern: /installations?\b[^\n]{0,40}?(?<![0-9])[0-9]{7,}(?![0-9])/gi },
  { kind: 'issue-number', pattern: /#[0-9]{4,}(?![0-9A-Za-z])|\/(?:issues|pull)\/[0-9]{4,}(?![0-9])/g },
];

/** The rules for a doc: each rule's `inDoc` pattern in place of its own. */
const DOC_RULES = RULES.map((rule) => (rule.inDoc ? { ...rule, pattern: rule.inDoc } : rule));

/** @typedef {{ path: string, line: number, kind: string, text: string }} Finding */

/**
 * The findings in one file's text, and in its path (reported at line 0).
 *
 * @param {string} path
 * @param {string} text
 * @returns {Finding[]}
 */
export const scanText = (path, text) => {
  /** @type {Finding[]} */
  const findings = [];
  if (OLD_HOME.test(path)) findings.push({ path, line: 0, kind: 'name', text: path });
  const rules = isDoc(path) ? DOC_RULES : RULES;
  text.split('\n').forEach((content, index) => {
    for (const { kind, pattern, allow } of rules) {
      for (const match of content.matchAll(pattern)) {
        if (allow?.(match[0])) continue;
        findings.push({ path, line: index + 1, kind, text: match[0] });
      }
    }
  });
  return findings;
};

/** @param {string} cwd @param {string[]} args */
const gitFiles = (cwd, args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);

/**
 * Every file in the working tree that git tracks or would track: committed,
 * staged and new. A tracked file deleted but not yet staged has nothing left
 * to publish, so it is left out rather than read.
 *
 * @param {string} [cwd] - The repo root.
 */
export const trackedFiles = (cwd = process.cwd()) => {
  const deleted = new Set(gitFiles(cwd, ['--deleted']));
  return gitFiles(cwd, ['--cached', '--others', '--exclude-standard']).filter((path) => !deleted.has(path));
};

/**
 * Every finding in the repo.
 *
 * @param {{ files?: string[], read?: (path: string) => string }} [io]
 * @returns {Finding[]}
 */
export const scanRepo = ({ files = trackedFiles(), read = (path) => readFileSync(path, 'utf8') } = {}) =>
  files.flatMap((path) => scanText(path, read(path)));

if (isCliEntry(import.meta.url, process.argv[1])) {
  const findings = scanRepo();
  for (const f of findings) console.error(`${f.path}:${f.line}: ${f.kind}: ${f.text}`);
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s): see docs/constraints/public-repo.md`);
    process.exit(1);
  }
  console.log('public-repo scan: no finding');
}
