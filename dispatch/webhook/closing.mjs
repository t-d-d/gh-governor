/**
 * GitHub's closing-keyword grammar, kept once: a closing keyword and a
 * reference, `#N`, `owner/repo#N` or an issue's URL, after a colon or a
 * space. The receiver reads it from here (dispatch/webhook/mention.mjs),
 * and so does the task's PR body grammar (`closedBy`, dispatch/pr-body.mjs),
 * so the two cannot drift apart. It lives under dispatch/webhook/ because
 * the receiver is packaged from that folder alone.
 *
 * Group 1 is the repository an issue URL names, group 2 the one
 * `owner/repo#N` names, and group 3 the issue number.
 */
export const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:\s*|\s+)(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)?#)(\d+)\b/gi;

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
export const withoutQuietComments = (body) => body.replace(HTML_COMMENT, (c) => (HAS_CLOSING.test(c) ? c : c.replace(/[^\n]/g, ' ')));

/**
 * Each issue number a body's closing references name, whatever repository
 * they name, once each, its quiet comments blanked as `closedBy` blanks
 * them.
 *
 * @param {unknown} body
 * @returns {Set<string>}
 */
export const closingNumbers = (body) => new Set([...withoutQuietComments(String(body ?? '')).matchAll(CLOSING)].map((m) => String(m[3])));
