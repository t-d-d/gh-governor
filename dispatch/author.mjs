/**
 * The author of a session's unsigned post, under `sessionRules` (PRD #599,
 * "Nudges").
 *
 * Every session posts as the operator's login, so governor reads a post's
 * signature, the session link above the Claude Code footer, to know which
 * session wrote it. A post that ends in the footer and names no session
 * (`unsignedPost`) could be any session's. Governor looks for its author
 * among the login's sessions:
 *
 * 1. The candidates are the live sessions working in the post's repo
 *    (`reposOf`, as the sign-off sweep reads them), updated at or after
 *    {@link AUTHOR_BEFORE_MS} before the post.
 * 2. Each candidate's events are read, as the sweep reads them, from
 *    {@link AUTHOR_BEFORE_MS} before the post to {@link AUTHOR_AFTER_MS}
 *    after it, for a tool call that posted to the post's issue or PR
 *    ({@link postedTo}). Where the call's input carries the text, its
 *    words must hold the post's first words. Both windows are anchored on
 *    the post's time, from the payload, so a fire run late finds the same
 *    author.
 * 3. **One match**, every other candidate read and ruled out: that session
 *    is told once to edit its post to add its link, with the rules
 *    ({@link nudgeText}).
 * 4. **Undecided**, where two candidates posted there or a candidate's
 *    events could not be read: each candidate not ruled out is told once
 *    the post may be its own ({@link maybeText}).
 * 5. **All ruled out**: the author is most likely a person, or a session
 *    governor cannot list. Nobody is told.
 *
 * The search runs in the turn that relays the post to its roles (a
 * message fire, dispatch/turn.mjs, or a ticket fire,
 * dispatch/ticket-fire.mjs), before it relays: a role that wrote the post
 * is not relayed it, and the relay drops its `UNSIGNED` line. Where the
 * sessions list cannot be read, the relay keeps the line. A post no role
 * hears queues an `author` fire of its own ({@link planAuthor}).
 *
 * Each message is a correction, so it goes once to a session for each kind
 * (`unsigned`, `unsigned-maybe`), recorded as `told#<session id>` /
 * `<kind>` before it is sent. Text read from a session's events is never
 * logged: the log names sessions, counts and reasons that quote no event.
 */

import { z } from 'zod';
import { GITHUB_SOURCE } from './deliveries.mjs';
import { SESSION_RULES } from './session-rules.mjs';
import { fireRepoOf } from './repos.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { archived, reposOf } from '../scripts/lib/session-branch.mjs';
import { EVENTS_PAGE } from '../scripts/lib/session-signoff.mjs';
import { wordsOf } from './webhook/fire.mjs';
import { UNSIGNED } from './webhook/mention.mjs';
import { sameSession, sessionId } from './webhook/subscribe.mjs';

/** The log event for a search for an unsigned post's author. */
export const AUTHOR = 'dispatch-author';

/** How long before the post a candidate's update, and the events read, may start. */
export const AUTHOR_BEFORE_MS = 10 * 60 * 1000;

/** How long after the post the events read run: the call's own event may land after the post. */
export const AUTHOR_AFTER_MS = 60 * 1000;

/** How many pages of a candidate's events, newest first, are read to reach the window. */
export const AUTHOR_PAGES = 5;

/**
 * @typedef {import('./webhook/fire.mjs').UnsignedPost} UnsignedPost
 * @typedef {'unsigned' | 'unsigned-maybe'} Correction
 * @typedef {(session: string, kind: Correction) => Promise<boolean>} TellOnce
 *   Put the record that `session` was told of `kind`, only where none
 *   stands: true where this put it. A put that fails rejects.
 * @typedef {{ searched: false, reason: string }
 *   | { searched: true, author: string | null, maybe: string[], candidates: number, unread: number }} Found
 *   `searched: false`: the sessions list could not be read, so the relay
 *   keeps its `UNSIGNED` line. Otherwise `author` is the one session found,
 *   `maybe` the candidates not ruled out where the search could not decide,
 *   and both empty where every candidate was ruled out.
 * @typedef {(on: number, post: UnsignedPost) => Promise<Found>} FindAuthor
 * @typedef {(call: { name?: string | undefined, input?: unknown }, repo: string, on: number) => { text: string | null } | null} Match
 *   Whether a tool call made the act searched for on `repo`'s issue or PR
 *   `on`, and the text its input carries: {@link postedTo} for a post.
 * @typedef {(event: string, context?: Record<string, unknown>) => void} Log
 */

/** A list row's id, `cse_…`, the session's URL `session_…`. */
const CSE_ID = /^cse_([A-Za-z0-9]+)$/;

/** An assistant message's content, where a tool call is a `tool_use` block. */
const ASSISTANT = z.object({ message: z.object({ content: z.array(z.looseObject({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })) }) });

/** The keys a GitHub tool's input names an issue or a PR by. */
export const NUMBER_KEYS = ['issue_number', 'issueNumber', 'pull_number', 'pullNumber', 'number'];

/** `text` with a regular expression's special characters escaped. @param {string} text */
export const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a `gh` command's `-R` / `--repo`, where it names one, is `repo`.
 *
 * @param {string} command
 * @param {string} repo `owner/name`
 */
export const repoNamedIn = (command, repo) => {
  const named = /(?:\s-R|--repo)[=\s]+["']?([^\s"']+)/.exec(command)?.[1]?.toLowerCase();
  return named === undefined || named === repo.toLowerCase() || named.endsWith(`/${repo.toLowerCase()}`);
};

/**
 * Whether a `gh api` command reads: `-X GET` with fields sends them as a query.
 *
 * @param {string} command
 */
export const readsOnly = (command) => /\s(?:-X|--method)[\s=]*["']?GET\b/i.test(command);

/**
 * The body a shell command that writes to GitHub carries: `{ text }`, the
 * command itself where it carries the body inline (`body=`, `--body`,
 * `-b`, a here document), `{ text: null }` where the shell expands it or it
 * is read from a file or stdin, and null where it carries none.
 *
 * @param {string} command
 * @returns {{ text: string | null } | null}
 */
export const shellBody = (command) => {
  // A body the shell expands, from a variable or a command, is not in the command's text.
  if (/(?:body=|--body[=\s]+|\s-b\s+)["']?\$/.test(command)) return { text: null };
  if (/body=(?!@)|--body[=\s]|\s-b\s|<</.test(command)) return { text: command };
  // A body read from a file or stdin.
  if (/body=@|--body-file[=\s]|--input[=\s]|\s-F\s+(?![\w[\]]+=)/.test(command)) return { text: null };
  return null;
};

/**
 * Whether a tool call posted to `repo`'s issue or PR `on`, and the text its
 * input carries, if any: `{ text }`, with `text` null where the input names
 * the target but not the post's text (a body read from a file), or null
 * where the call did not post there.
 *
 * - A shell command posts there where it writes (`gh api` with a field or
 *   `--input`, a method other than GET, or `gh issue comment` / `gh pr
 *   comment` / `gh pr review`) to `repos/<repo>/issues/<on>` or
 *   `repos/<repo>/pulls/<on>`, or names `on` to the `gh` subcommand. A
 *   command that carries a body inline (`body=`, `--body`, `-b`, a here
 *   document) carries the text, unless the shell expands it (`$`). One
 *   that reads its body from a file or stdin carries none. A write with no
 *   body at all, a label or an approval, posted no comment.
 * - Any other tool posts there where its input names the repo's owner and
 *   name and `on` by one of {@link NUMBER_KEYS}, and its name does not read
 *   (`get`, `list`, `search`, `read`). Its `body`, where it has one, is the
 *   text. Without one, only a review or comment tool may have posted.
 *
 * @param {{ name?: string | undefined, input?: unknown }} call
 * @param {string} repo `owner/name`
 * @param {number} on
 * @returns {{ text: string | null } | null}
 */
export const postedTo = (call, repo, on) => {
  const input = /** @type {Record<string, unknown> | null} */ (call.input !== null && typeof call.input === 'object' ? call.input : null);
  if (input === null) return null;
  const [owner = '', name = ''] = repo.toLowerCase().split('/');
  if (typeof input.command === 'string') {
    const command = input.command;
    const path = new RegExp(`repos/(?:${escaped(owner)}/${escaped(name)}|\\{owner\\}/\\{repo\\})/(?:issues|pulls)/${on}(?![0-9])`, 'i');
    const cli = new RegExp(`\\bgh\\s+(?:issue\\s+comment|pr\\s+comment|pr\\s+review)\\s+#?${on}(?![0-9])`);
    const viaCli = cli.test(command) && repoNamedIn(command, repo);
    const writes = !readsOnly(command) && (/\s(?:-[fFd]|--field|--raw-field|--input|--data)[\s=]/.test(command) || /\s(?:-X|--method)[\s=]*["']?(?:POST|PATCH|PUT)\b/i.test(command));
    if (!viaCli && !(path.test(command) && writes)) return null;
    // A write that carries no body, such as a label or an approval, posted no comment.
    return shellBody(command);
  }
  const tool = String(call.name ?? '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  if (/(?:^|_)(?:get|list|search|read)(?:_|$)/i.test(tool)) return null;
  if (String(input.owner ?? '').toLowerCase() !== owner || String(input.repo ?? '').toLowerCase() !== name) return null;
  if (!NUMBER_KEYS.some((key) => Number(input[key]) === on)) return null;
  if (typeof input.body === 'string') return { text: input.body };
  // A review submitted without a body may post the one its pending review holds;
  // any other write without one, such as a merge or a label, posted no comment.
  return /review|comment/i.test(tool) ? { text: null } : null;
};

/**
 * Whether `text` holds `words`, a post's first words: its own words, read
 * as {@link wordsOf} reads them, run in that order somewhere in it.
 *
 * @param {string} text
 * @param {string} words
 */
const holds = (text, words) => words === '' || [text, unescaped(text)].some((t) => ` ${wordsOf(t).join(' ')} `.includes(` ${words} `));

/**
 * `text` with JSON's string escapes read, as a body sent as JSON (`gh api
 * --input`) carries its newlines and quotes: `\n` would otherwise glue its
 * `n` to the next word.
 *
 * @param {string} text
 */
const unescaped = (text) => text
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  .replace(/\\[nrtbf]/g, ' ');

/**
 * What one candidate's events say of the post: `posted`, a call in the
 * window posted to it and, where it carries text, the post's words;
 * `clear`, none did; `unreadable`, with a reason that quotes no event,
 * where the events could not be read back to the window.
 *
 * `match` names the act searched for, a post by default.
 *
 * @param {{ events: (id: string, cursor?: string) => Promise<unknown>, id: string, repo: string, on: number, post: UnsignedPost, match?: Match }} args
 * @returns {Promise<{ read: 'posted' | 'clear' } | { read: 'unreadable', reason: string }>}
 */
export const readCandidate = async ({ events, id, repo, on, post, match = postedTo }) => {
  const at = Date.parse(post.at);
  const from = at - AUTHOR_BEFORE_MS;
  const to = at + AUTHOR_AFTER_MS;
  /** The `created_at` of the oldest event read, in ms. */
  let oldest = Infinity;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string | undefined} */
  let cursor;
  for (let pages = 1; pages <= AUTHOR_PAGES; pages += 1) {
    let answer;
    try {
      answer = await events(id, cursor);
    } catch (error) {
      return { read: 'unreadable', reason: `the events read failed: ${messageOf(error).slice(0, 200)}` };
    }
    const page = EVENTS_PAGE.safeParse(answer);
    if (!page.success) return { read: 'unreadable', reason: `the events page is outside the schema at ${page.error.issues[0]?.path.join('.') || '(root)'}` };
    const data = page.data.data;
    if (pages > 1 && data.some((event) => typeof event.event_id === 'string' && seen.has(event.event_id))) return { read: 'unreadable', reason: `page ${pages} repeated events already read` };
    for (const event of data) {
      if (typeof event.event_id === 'string') seen.add(event.event_id);
      const when = Date.parse(String(event.created_at ?? ''));
      if (Number.isNaN(when)) continue;
      if (pages > 1 && when > oldest) return { read: 'unreadable', reason: `page ${pages} holds events newer than the page before` };
      oldest = Math.min(oldest, when);
      if (when < from || when > to) continue;
      const message = ASSISTANT.safeParse(event.payload);
      if (!message.success) continue;
      for (const block of message.data.message.content) {
        if (block.type !== 'tool_use') continue;
        const posted = match(block, repo, on);
        if (posted !== null && (posted.text === null || holds(posted.text, post.words))) return { read: 'posted' };
      }
    }
    if (oldest < from) return { read: 'clear' };
    cursor = page.data.next_cursor || undefined;
    // The session's first event: there is nothing older to read.
    if (cursor === undefined || data.length === 0) return { read: 'clear' };
  }
  return { read: 'unreadable', reason: `the window lies past the newest ${AUTHOR_PAGES} pages of events` };
};

/**
 * The live sessions on the login that may have written a post in `repo` at
 * `at`: unarchived, working in `repo` (`reposOf`), and updated at or after
 * {@link AUTHOR_BEFORE_MS} before it. A row that does not say when it was
 * updated is left out. Each as its `cse_…` id and its claude.ai/code URL.
 *
 * @param {readonly unknown[]} rows
 * @param {string} repo
 * @param {number} at
 * @returns {Array<{ id: string, session: string }>}
 */
export const candidatesOf = (rows, repo, at) => rows.flatMap((row) => {
  const r = /** @type {any} */ (row);
  const id = typeof r?.id === 'string' ? CSE_ID.exec(r.id)?.[1] : undefined;
  if (id === undefined || archived(r) || !reposOf(r).includes(repo.toLowerCase())) return [];
  const updated = Date.parse(String(r.updated_at ?? ''));
  if (Number.isNaN(updated) || updated < at - AUTHOR_BEFORE_MS) return [];
  return [{ id: `cse_${id}`, session: `https://claude.ai/code/session_${id}` }];
});

/**
 * Search the login's sessions for the author of `post` on `repo`'s issue
 * or PR `on` (see the module's head). A list that cannot be read is
 * `searched: false`; a candidate whose events cannot be read is not ruled
 * out. Logs nothing. `match` names the act searched for, a post by
 * default; `skip` names sessions already ruled out, which are no
 * candidates.
 *
 * @param {{ list: () => Promise<readonly unknown[]>, events: (id: string, cursor?: string) => Promise<unknown>, repo: string, on: number, post: UnsignedPost, match?: Match, skip?: readonly string[] }} args
 * @returns {Promise<Found>}
 */
export const searchAuthor = async ({ list, events, repo, on, post, match = postedTo, skip = [] }) => {
  /** @type {readonly unknown[]} */
  let rows;
  try {
    rows = await list();
  } catch (error) {
    return { searched: false, reason: `the sessions list could not be read: ${messageOf(error).slice(0, 200)}` };
  }
  const candidates = candidatesOf(rows, repo, Date.parse(post.at)).filter(({ session }) => !skip.some((s) => sameSession(s, session)));
  /** @type {string[]} */
  const posted = [];
  /** @type {string[]} */
  const unread = [];
  // Each candidate's events are read side by side.
  const reads = await Promise.all(candidates.map(({ id }) => readCandidate({ events, id, repo, on, post, match })));
  candidates.forEach(({ session }, i) => {
    const read = reads[i]?.read;
    if (read === 'posted') posted.push(session);
    else if (read === 'unreadable') unread.push(session);
  });
  const author = posted.length === 1 && unread.length === 0 ? posted[0] ?? null : null;
  return { searched: true, author, maybe: author === null ? [...posted, ...unread] : [], candidates: candidates.length, unread: unread.length };
};

/**
 * The message to the session found to have written an unsigned post, with
 * the rules under it.
 *
 * @param {number} on
 * @param {string} url the post's page
 */
export const nudgeText = (on, url) => [
  `Your post on #${on} (${url}) ends in the Claude Code footer and names no session, so governor had to search for who wrote it, and found this session.`,
  "Edit the post to add this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer, and sign every post from now on.",
  '',
  SESSION_RULES,
].join('\n');

/**
 * The message to a session that may have written an unsigned post, where
 * the search could not decide.
 *
 * @param {number} on
 * @param {string} url the post's page
 */
export const maybeText = (on, url) => [
  `A post on #${on} (${url}) ends in the Claude Code footer and names no session. Governor searched the sessions working in this repo and could not tell which wrote it: it may be yours.`,
  "If you wrote it, edit it to add this session's link alone on the line just above the Claude Code footer, and sign every post from now on. If you did not, there is nothing to do.",
  '',
  SESSION_RULES,
].join('\n');

/**
 * Tell what a search found: the author its nudge, or each session not
 * ruled out that the post may be its own, each once ({@link TellOnce}). A
 * record that cannot be put is logged at error and sends nothing to that
 * session. A send the cap holds back logs nothing more here. Returns each
 * delivery sent. Logs one {@link AUTHOR} line for the search, naming
 * sessions and counts, never text.
 *
 * @param {{
 *   repo: string,
 *   on: number,
 *   post: UnsignedPost,
 *   found: Found,
 *   tellOnce: TellOnce,
 *   deliveries: Pick<import('./deliveries.mjs').Deliveries, 'deliver'>,
 *   log: Log,
 * }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery[]>}
 */
export const tellAuthor = ({ repo, on, post, found, tellOnce, deliveries, log }) => tellFound({
  event: AUTHOR,
  at: { repo, on, post: post.at },
  found,
  nudge: { kind: 'unsigned', text: nudgeText(on, post.url) },
  maybe: { kind: 'unsigned-maybe', text: maybeText(on, post.url) },
  tellOnce: /** @type {(session: string, kind: string) => Promise<boolean>} */ (tellOnce),
  deliveries,
  log,
});

/**
 * Tell what a search found, as {@link tellAuthor} does, with the kinds and
 * texts of the act searched for: `nudge` to the one session found, `maybe`
 * to each candidate not ruled out. Logs `event` lines that name sessions
 * and counts, never text.
 *
 * @param {{
 *   event: string,
 *   at: Record<string, unknown>,
 *   found: Found,
 *   nudge: { kind: string, text: string },
 *   maybe: { kind: string, text: string },
 *   tellOnce: (session: string, kind: string) => Promise<boolean>,
 *   deliveries: Pick<import('./deliveries.mjs').Deliveries, 'deliver'>,
 *   log: Log,
 * }} args `at`: what the log lines say the search was of, its `on` the
 *   issue or PR the corrections are about.
 * @returns {Promise<import('./deliveries.mjs').Delivery[]>}
 */
export const tellFound = async ({ event, at, found, nudge, maybe, tellOnce, deliveries, log }) => {
  const on = Number(at.on);
  if (!found.searched) {
    log(event, { ...at, level: 'warn', outcome: 'not searched', reason: found.reason });
    return [];
  }
  const counts = { candidates: found.candidates, unread: found.unread };
  if (found.author === null && found.maybe.length === 0) {
    log(event, { ...at, ...counts, outcome: 'nobody told', reason: 'every candidate was ruled out: most likely a person, or a session governor cannot list' });
    return [];
  }
  /** @type {Array<{ session: string, kind: string, text: string }>} */
  const tells = found.author !== null
    ? [{ session: found.author, ...nudge }]
    : found.maybe.map((session) => ({ session, ...maybe }));
  log(event, { ...at, ...counts, outcome: found.author !== null ? 'author found' : 'undecided', sessions: tells.map((t) => sessionId(t.session)) });
  /** @type {import('./deliveries.mjs').Delivery[]} */
  const sent = [];
  for (const { session, kind, text } of tells) {
    const about = { ...at, session: sessionId(session), kind };
    let first = false;
    try {
      first = await tellOnce(session, kind);
    } catch (error) {
      log(event, { ...about, level: 'error', outcome: 'not told', error: messageOf(error), reason: 'the record that it was told could not be put' });
      continue;
    }
    if (!first) {
      log(event, { ...about, outcome: 'not told', reason: 'it was told of this before' });
      continue;
    }
    const told = await deliveries.deliver({ session }, text, { source: GITHUB_SOURCE, kind: 'correction', on: [on] });
    sent.push(told);
    if (told.capped !== true) log(event, { ...about, outcome: told.ok ? 'told' : told.refused ? 'its session is archived' : 'not told', ...(told.ok || told.refused ? {} : { level: 'error', error: told.error }) });
  }
  return sent;
};

/**
 * A relayed text without its `UNSIGNED` line, where the search ran: the
 * author, or the candidates, are told by {@link tellAuthor} instead. Where
 * it did not run, the text as it came.
 *
 * @param {string} text
 * @param {Found | null} found
 */
export const relayedText = (text, found) => {
  const line = `\n\n${UNSIGNED}`;
  return found?.searched === true && text.endsWith(line) ? text.slice(0, -line.length) : text;
};

/**
 * Whether `session` is the author a search found: a role that wrote the
 * post is not relayed its own post.
 *
 * @param {Found | null} found
 * @param {string} session
 */
export const wroteIt = (found, session) => found?.searched === true && found.author !== null && sameSession(found.author, session);

/**
 * An `author` fire: a session's unsigned post on issue or PR `on` that no
 * role hears. The search runs and its result is told ({@link tellAuthor}).
 * Its answer is a send that faulted where one did, so the turn fails on
 * it, else the last delivery.
 *
 * @param {import('./webhook/fire.mjs').AuthorFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planAuthor = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { on, post } = invocation;
  const found = await ctx.findAuthor(on, post);
  /** @type {import('./deliveries.mjs').Delivery[]} */
  let sent = [];
  let loginStored = false;
  try {
    sent = await tellAuthor({ repo, on, post, found, tellOnce: (session, kind) => ctx.state.recordTold(session, kind), deliveries: ctx.delivery(), log: ctx.log });
  } finally {
    loginStored = await ctx.storeLogin();
  }
  const messaged = sent.find((d) => !d.ok && !d.refused && d.capped !== true) ?? sent.at(-1) ?? null;
  return { answer: { kind: invocation.kind, messaged, dispatched: [], loginStored } };
};
