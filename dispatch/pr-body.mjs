/**
 * The PR body's grammar, as the dispatcher reads it: the tickets a body
 * closes (its top `Closes #N` lines, and any closing reference below them),
 * the owners its Verification table and Left for later name, and the marker
 * and digest a PR review's comment ends with.
 *
 * Pure and config-free: the review (dispatch/review.mjs), the conflict
 * turn (dispatch/conflicts.mjs) and the coverage plan
 * (dispatch/coverage.mjs) import it, none of them the human-only list.
 */

import { createHash } from 'node:crypto';
import { REVIEW_MARKER } from './webhook/review-comment.mjs';

/**
 * @typedef {import('../scripts/lib/github-app.mjs').ThreadRow} ThreadRow
 */

/** A Markdown heading: its level and text. */
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * The lines of each section whose heading matches, down to the next
 * heading at its level or above.
 *
 * @param {string} body
 * @param {RegExp} title
 * @returns {string[]}
 */
const sectionLines = (body, title) => {
  /** @type {string[]} */
  const lines = [];
  let level = 0;
  for (const line of body.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) {
      const depth = /** @type {string} */ (heading[1]).length;
      if (title.test(/** @type {string} */ (heading[2]))) { level = depth; continue; }
      if (level > 0 && depth <= level) level = 0;
    }
    if (level > 0) lines.push(line);
  }
  return lines;
};

/** @param {string} text @returns {number[]} */
const numbersIn = (text) => [...text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1]));

/** @param {string} row */
const cells = (row) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());

const SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_OWNER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?[*_`]*#(\d+)\b/;

/**
 * The tickets a PR body names as owners, once each, in order: every number
 * in the `Green at` cells of the Verification section's tables, and the
 * number each Left for later line opens with. A table with no `Green at`
 * column (receipts) names no owner, nor does the "Beyond the ticket" table,
 * which gates nothing (the skill's test 5). A number elsewhere, a PR a row
 * builds on, is context, not an owner.
 *
 * @param {string} body
 * @returns {{ verification: number[], later: number[] }}
 */
export const namedOwners = (body) => {
  /** @type {number[]} */
  const verification = [];
  /** @type {number | null} The owner column of the table being read, -1 for none; null between tables. */
  let column = null;
  let beyond = false;
  for (const line of sectionLines(body, /^verification\b/i)) {
    if (!line.trim().startsWith('|')) {
      column = null;
      if (/beyond the ticket/i.test(line)) beyond = true;
      else if (HEADING.test(line)) beyond = false;
      continue;
    }
    const row = cells(line);
    if (column === null) {
      column = beyond ? -1 : row.findIndex((c) => /green at/i.test(c));
      continue;
    }
    if (column === -1 || SEPARATOR.test(line.trim())) continue;
    verification.push(...numbersIn(row[column] ?? ''));
  }
  const later = sectionLines(body, /^left for later\b/i).flatMap((line) => {
    const found = LIST_OWNER.exec(line);
    return found ? [Number(found[1])] : [];
  });
  return { verification: [...new Set(verification)], later: [...new Set(later)] };
};

const MARKER = /<!-- governor:pr-review ([0-9a-f]{40}) ([0-9a-f]{64}) -->/;

/** The marker a review's comment ends with. @param {string} headSha @param {string} bodySha */
export const reviewMarker = (headSha, bodySha) => `${REVIEW_MARKER}${headSha} ${bodySha} -->`;

/** The body as the marker names it. @param {string} body */
export const bodyDigest = (body) => createHash('sha256').update(body).digest('hex');

/**
 * The newest review on the thread: the last comment the dispatcher's own
 * App posted carrying a marker, with what it named and its text without the
 * marker. A person's or another bot's comment carrying a marker is not one:
 * a held pass there would merge unjudged.
 *
 * @param {ThreadRow[]} thread Oldest first.
 * @returns {{ id: number, headSha: string, bodySha: string, text: string } | null}
 */
export const lastReview = (thread) => {
  for (const row of [...thread].reverse()) {
    if (!row.ours) continue;
    const found = MARKER.exec(row.body);
    if (found) return { id: row.id, headSha: /** @type {string} */ (found[1]), bodySha: /** @type {string} */ (found[2]), text: row.body.replace(MARKER, '').trim() };
  }
  return null;
};

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:\s*|\s+)(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)?#)(\d+)\b/gi;
/** What may sit before a top line's first reference: a list marker. */
const LIST_MARKER = /^[ \t]*(?:[-*+][ \t]+)?$/;
/** What may sit between two references of one line, and after the last. */
const BETWEEN = /^\s*[,;.&]?\s*(?:and\s+)?$/i;
const AFTER = /^[\s.,;]*$/;
/** An HTML comment, to the end where unclosed: it renders as nothing. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|(?![\s\S]))/g;
/** Whether text holds a closing reference at all. */
const HAS_CLOSING = new RegExp(CLOSING.source, 'i');

/**
 * The body with each HTML comment that holds no closing reference blanked,
 * its newlines kept: a PR template's comments, or a subscribe line, render
 * as nothing, so they neither end the top nor sit on a line's text. One
 * holding a closing reference stays, read like any text.
 *
 * @param {string} body
 */
const withoutQuietComments = (body) => body.replace(HTML_COMMENT, (c) => (HAS_CLOSING.test(c) ? c : c.replace(/[^\n]/g, ' ')));

/**
 * Whether a line is nothing but its closing references: at most a list
 * marker before them, punctuation or "and" between, punctuation after.
 *
 * @param {string} line
 * @param {RegExpMatchArray[]} matches The line's `CLOSING` matches, at least one.
 */
const onlyReferences = (line, matches) => {
  let end = 0;
  for (const [i, m] of matches.entries()) {
    const index = /** @type {number} */ (m.index);
    if (!(i === 0 ? LIST_MARKER : BETWEEN).test(line.slice(end, index))) return false;
    end = index + m[0].length;
  }
  return AFTER.test(line.slice(end));
};

/**
 * Each closing reference GitHub reads in a body, in order, with whether it
 * is on one of the body's top `Closes #N` lines: `#N`, a colon after the
 * keyword included, and this repository's issue by its URL or
 * `owner/repo#N`, which GitHub closes too. Another repository's issue is
 * none of this one's: `foreignClosings` reads those. Code is read like the rest: nothing says GitHub
 * skips a reference in it.
 *
 * The top is the body's opening lines, blank lines and HTML comments
 * holding no closing reference aside (`withoutQuietComments`), each holding
 * nothing but closing references (`onlyReferences`). It ends at the first
 * line holding anything else, and every reference from that line on is
 * below it.
 *
 * @param {string} body
 * @param {string} [repo] This repository, `owner/repo`; without it only `#N` counts.
 * @returns {Array<{ number: number, text: string, top: boolean }>}
 */
const closingReferences = (body, repo) => everyClosing(body).filter((r) => r.slug === undefined || r.slug.toLowerCase() === repo?.toLowerCase());

/**
 * Every closing reference in a body, whatever repository it names: `slug`
 * is the `owner/repo` it names, undefined for a bare `#N`.
 *
 * @param {string} body
 * @returns {Array<{ slug: string | undefined, number: number, text: string, top: boolean }>}
 */
const everyClosing = (body) => {
  /** @type {Array<{ slug: string | undefined, number: number, text: string, top: boolean }>} */
  const refs = [];
  let inTop = true;
  for (const line of withoutQuietComments(body).split('\n')) {
    const matches = [...line.matchAll(CLOSING)];
    const top = inTop && matches.length > 0 && onlyReferences(line, matches);
    if (!top && line.trim() !== '') inTop = false;
    for (const m of matches) refs.push({ slug: m[1] ?? m[2], number: Number(m[3]), text: m[0], top });
  }
  return refs;
};

/**
 * The tickets a body closes: each its top `Closes #N` lines name, once
 * each, in order. A closing reference below them is `proseClosings`'.
 *
 * @param {string} body
 * @param {string} [repo] This repository, `owner/repo`; without it only `#N` counts.
 * @returns {number[]}
 */
export const closingTickets = (body, repo) => [...new Set(closingReferences(body, repo).filter((r) => r.top).map((r) => r.number))];

/**
 * Every issue a body closes as GitHub reads it, at the top or not, once
 * each, in order.
 *
 * @param {string} body
 * @param {string} [repo] This repository, `owner/repo`; without it only `#N` counts.
 * @returns {number[]}
 */
export const closedBy = (body, repo) => [...new Set(closingReferences(body, repo).map((r) => r.number))];

/**
 * The closing references below a body's top `Closes #N` lines, once each by
 * issue, as written: "#12 fixed #11" in prose. GitHub closes them all
 * the same, so each is an edit to ask for, even one naming a
 * ticket the top closes too.
 *
 * @param {string} body
 * @param {string} [repo] This repository, `owner/repo`; without it only `#N` counts.
 * @returns {Array<{ number: number, text: string }>}
 */
export const proseClosings = (body, repo) => {
  const seen = new Set();
  return closingReferences(body, repo).flatMap(({ number, text, top }) => {
    if (top || seen.has(number)) return [];
    seen.add(number);
    return [{ number, text }];
  });
};

/**
 * The closing references to another repository's issue, at the top or
 * below it, once each by issue, as written. GitHub closes them when the PR
 * merges, but a PR closes tickets in its own repo only: the review cannot
 * read another repo's ticket, nor would this repo's deploy labels speak
 * for it.
 *
 * @param {string} body
 * @param {string} [repo] This repository, `owner/repo`; without it none is read as another's.
 * @returns {Array<{ repo: string, number: number, text: string }>}
 */
export const foreignClosings = (body, repo) => {
  if (repo === undefined) return [];
  const seen = new Set();
  return everyClosing(body).flatMap(({ slug, number, text }) => {
    if (slug === undefined || slug.toLowerCase() === repo.toLowerCase()) return [];
    const key = `${slug.toLowerCase()}#${number}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ repo: slug, number, text }];
  });
};
