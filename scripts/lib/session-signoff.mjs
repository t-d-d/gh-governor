/**
 * A session signing off, and the dispatcher archiving it
 * (docs/constraints/session-signoff.md).
 *
 * A cloud session cannot archive itself unattended. The archive tool
 * (`mcp__Claude_Code_Remote__archive_session`) is one of the claude.ai
 * connectors, and those reach a session only on a turn the operator typed
 * in the app: a session the dispatcher started, and every turn a dispatcher
 * message or a background task wakes, has none of them. So a session that
 * is finished says so in words, as the last line of its reply, and the
 * operator reads the same line in the notification:
 *
 *     Signing off.
 *
 * A dispatcher turn sweeps the login's sessions (`sweepSignoffs`): each idle,
 * unarchived session in a served repo is a candidate, and the sweep reads its
 * last reply from its own events over the sessions API (`readReply`). It
 * archives each candidate whose reply signs off, through the API the CLI
 * itself archives with, under the stored login. No session writes anything
 * for this, so a served repo needs no hook and no credential, and a prompt
 * after the sign-off is the session's newest reply, not a stale record.
 *
 * A session's last sign-off is nearly always its reply to a dispatcher
 * message. So a turn that messaged sessions first waits for their replies
 * while the fire lane is empty (`awaitReplies`), and the sign-off is
 * archived by the turn that asked for it rather than the next one.
 *
 * A local session (the CLI, or the desktop app with Remote Control on) is
 * swept the same way while Remote Control lists it. One without Remote
 * Control is out of reach: the Stop hook asks it to archive itself.
 */

import { z } from 'zod';
import { parseLogin } from './claude-login.mjs';
import { messageOf } from './error-message.mjs';
import { archived, newestFirst, reposOf } from './session-branch.mjs';

/** The last line of a reply that signs the session off. */
export const SIGN_OFF = 'Signing off.';

/**
 * Whether a reply signs the session off: its last non-empty line, emphasis
 * stripped, starts SIGN_OFF's words followed by `.`, `:`, `!` or nothing.
 * A served repo's own hook that reads a reply for the sign-off should use
 * the same rule.
 *
 * @param {string} reply
 */
export const signsOff = (reply) => {
  const last = reply.split('\n').map((line) => line.trim()).filter((line) => line !== '').at(-1);
  if (last === undefined) return false;
  const bare = last.replace(/^[*_`]+|[*_`]+$/g, '').trim();
  const words = SIGN_OFF.slice(0, -1);
  const next = bare.charAt(words.length);
  return bare.startsWith(words) && (next === '' || '.:!'.includes(next));
};

/**
 * A page of a session's events (`GET /v1/code/sessions/cse_<id>/events`),
 * as the deployed dispatcher reads it: the newest, newest first.
 * Each event carries its `event_type` and a `payload`, the stream message
 * with its own `type`. Only the kinds the reply is read from are held to a
 * shape.
 */
const EVENTS_PAGE = z.object({ data: z.array(z.record(z.string(), z.unknown())), next_cursor: z.string().nullish() });
/** An error result (`error_max_turns`, …) carries no `result`: it reads as empty. */
const RESULT_PAYLOAD = z.object({ result: z.string().optional() });
/** A user message: a person's prompt, or tool results handed back mid-turn. */
const USER_PAYLOAD = z.object({ message: z.object({ content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]) }) });
const ASSISTANT_PAYLOAD = z.object({
  message: z.object({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })) }),
});

/**
 * Where an answer left the schema: each issue's path and zod's message,
 * which names types, never values, so no session text reaches the log.
 *
 * @param {z.ZodError} error
 */
const outside = (error) => `outside the schema: ${error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;

/**
 * A payload's own `type`, if it is an object carrying one.
 *
 * @param {unknown} payload
 */
const typeOf = (payload) => {
  const typed = payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload).type : undefined;
  return typeof typed === 'string' ? typed : undefined;
};

/**
 * An event's payload and its kind: the payload's own `type`, else the
 * event's `event_type`.
 *
 * @param {Record<string, unknown>} event
 * @returns {{ kind: string | null, payload: unknown }}
 */
const kindOf = ({ event_type: type, payload }) => ({ kind: typeOf(payload) ?? (typeof type === 'string' ? type : null), payload });

/**
 * What a page of events holds, without its text: how many, the count of
 * each `event_type` and payload `type` pair, and the first and last
 * `created_at`. Enough to say why no reply was found on it.
 *
 * @param {Array<Record<string, unknown>>} data
 */
const pageShape = (data) => {
  /** @type {Map<string, number>} */
  const kinds = new Map();
  const name = (/** @type {unknown} */ v, /** @type {string} */ none) => (typeof v === 'string' ? v.slice(0, 40) : none);
  for (const event of data) {
    const kind = `${name(event.event_type, '(no event_type)')}/${name(typeOf(event.payload), '?')}`;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const at = (/** @type {Record<string, unknown> | undefined} */ event) => (typeof event?.created_at === 'string' || typeof event?.created_at === 'number' ? String(event.created_at).slice(0, 40) : '?');
  const counted = [...kinds].sort(([x], [y]) => x.localeCompare(y)).map(([k, n]) => `${k} ${n}`).join(', ');
  return `${data.length} events: ${counted || 'none'}; created_at ${at(data[0])} to ${at(data.at(-1))}`;
};

/**
 * Whether an event is a person's prompt: a user message that is not tool
 * results handed back mid-turn.
 *
 * @param {{ kind: string | null, payload: unknown }} event
 */
const prompts = ({ kind, payload }) => {
  if (kind !== 'user') return false;
  const user = USER_PAYLOAD.safeParse(payload);
  return user.success && (typeof user.data.message.content === 'string' || !user.data.message.content.some((block) => block.type === 'tool_result'));
};

/**
 * Whether a session's last reply, read from a page of its events, signs it
 * off. The reply is the newest `result` event's text; where that is empty,
 * as on every Remote Control session, it is the text of the nearest
 * assistant message before it in the same turn (after the result or prompt before
 * it). A person's prompt newer than that result reads as not signed off:
 * the result is no longer the last word. An answer outside the schema, or a
 * page without the reply on it, is
 * unreadable, and the reason quotes none of the session's text.
 *
 * @param {unknown} answer
 * @returns {{ signedOff: boolean } | { unreadable: string }}
 */
export const replyDecision = (answer) => {
  const page = EVENTS_PAGE.safeParse(answer);
  if (!page.success) return { unreadable: outside(page.error) };
  const decided = decide(page.data.data);
  if (!('more' in decided)) return decided;
  return { unreadable: decided.more === 'result' ? `no result event on the newest page (${pageShape(page.data.data)})` : `${EMPTY} on the page` };
};

/** Why a reply read empty, short of the page it would be on. */
const EMPTY = 'the last result is empty and no assistant text precedes it in its turn';

/**
 * `replyDecision` over events read newest first, or `more` where the reply
 * may lie on an older page: no `result` on them (`'result'`), or an empty
 * one whose turn runs past the oldest of them (`'text'`).
 *
 * @param {Array<Record<string, unknown>>} data
 * @returns {{ signedOff: boolean } | { unreadable: string } | { more: 'result' | 'text' }}
 */
const decide = (data) => {
  const events = data.map(kindOf);
  const last = events.findIndex((event) => event.kind === 'result');
  if (last === -1) return { more: 'result' };
  // A prompt after the newest result has not been answered: whatever that
  // result said is not the session's last word, though the worker may not
  // have started on it and the row still read idle.
  if (events.slice(0, last).some(prompts)) return { signedOff: false };
  const result = RESULT_PAYLOAD.safeParse(events[last]?.payload);
  if (!result.success) return { unreadable: outside(result.error) };
  const text = result.data.result ?? '';
  if (text.trim() !== '') return { signedOff: signsOff(text) };
  for (const event of events.slice(last + 1)) {
    // The turn before ends at its own result: its text is not this turn's reply.
    if (event.kind === 'result') return { unreadable: EMPTY };
    // A prompt opened this turn: what precedes it is a turn that may have
    // ended with no result (interrupted). Tool results are mid-turn.
    if (event.kind === 'user') {
      if (prompts(event)) return { unreadable: EMPTY };
      continue;
    }
    if (event.kind !== 'assistant') continue;
    const message = ASSISTANT_PAYLOAD.safeParse(event.payload);
    if (!message.success) return { unreadable: outside(message.error) };
    const said = message.data.message.content.flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : [])).join('\n');
    if (said.trim() !== '') return { signedOff: signsOff(said) };
  }
  return { more: 'text' };
};

/**
 * A session's last reply, read a page of its events at a time.
 * After its last `result`, a session idle for days logs state and control
 * events (`active_goal`, `control_request`, …) that can fill the newest
 * page. So where the reply is not on the events read so far, the next read
 * is the page the last one's `next_cursor` names (`events(id, token,
 * cursor)`), up to SIGNOFF_PAGES pages. A page with no `next_cursor`, or an
 * empty page, is the start of the session. A page that is not the one
 * before, holding an event already read or one newer than the oldest read,
 * is unreadable: the endpoint ignored the cursor first sent, `before_id`,
 * and answered the newest page again.
 * Returns the decision and every event read, newest first. A read that
 * fails throws.
 *
 * @param {Events} events
 * @param {string} id `cse_…`
 * @param {string} token
 * @returns {Promise<{ read: { signedOff: boolean } | { unreadable: string }, data: Array<Record<string, unknown>> }>}
 */
export const readReply = async (events, id, token) => {
  /** @type {Array<Record<string, unknown>>} */
  const data = [];
  /** @param {string} unreadable */
  const fail = (unreadable) => ({ read: { unreadable }, data });
  /** The read reached the session's oldest event. @param {string} missing */
  const started = (missing) => fail(missing === 'result' ? `no result in the session's whole history (${pageShape(data)})` : `${EMPTY} back to the start of the session`);
  /** What the events read so far lack: their result, or its turn's text. */
  let missing = 'result';
  /** The `next_cursor` of the page before; undefined for the newest page. @type {string | undefined} */
  let cursor;
  for (let pages = 1; ; pages += 1) {
    const oldest = data.at(-1);
    const page = EVENTS_PAGE.safeParse(await events(id, token, cursor));
    if (!page.success) return fail(outside(page.error));
    const older = page.data.data;
    if (oldest !== undefined) {
      if (older.length === 0) return started(missing);
      const seen = new Set(data.map((event) => event.event_id).filter((eventId) => typeof eventId === 'string'));
      const repeated = older.filter((event) => typeof event.event_id === 'string' && seen.has(event.event_id)).length;
      if (repeated > 0) return fail(`the page before ${data.length} events did not read back: ${repeated} of its ${older.length} events were already read`);
      const newest = Date.parse(String(older[0]?.created_at));
      const floor = Date.parse(String(oldest.created_at));
      if (newest > floor) return fail(`the page before ${data.length} events did not read back: its newest event, created_at ${String(older[0]?.created_at).slice(0, 40)}, is newer than the oldest read, ${String(oldest.created_at).slice(0, 40)}`);
    }
    data.push(...older);
    const decided = decide(data);
    if (!('more' in decided)) return { read: decided, data };
    missing = decided.more;
    if (oldest === undefined && older.length === 0) return fail(`no result event on the newest page (${pageShape(data)})`);
    cursor = page.data.next_cursor || undefined;
    if (cursor === undefined) return started(missing);
    if (pages >= SIGNOFF_PAGES) return fail(decided.more === 'result' ? `no result in the newest ${pages} pages (${pageShape(data)})` : `${EMPTY} in the newest ${pages} pages`);
  }
};

/**
 * When the newest `result` on a page of events was written, in ms; null on a
 * page outside the schema, with no result, or with no `created_at` that
 * parses. A reply to a message is a result written after it.
 *
 * @param {unknown} answer
 * @returns {number | null}
 */
const resultAt = (answer) => {
  const page = EVENTS_PAGE.safeParse(answer);
  if (!page.success) return null;
  const result = page.data.data.find((event) => kindOf(event).kind === 'result');
  const at = Date.parse(String(result?.created_at ?? ''));
  return Number.isNaN(at) ? null : at;
};

/**
 * How long the sweep keeps reading candidates, most recently updated first.
 * The ones it does not reach wait for the next turn: idle sessions that never
 * sign off, mostly, since a sign-off is its session's last update.
 */
export const SIGNOFF_WINDOW_MS = 60 * 1000;

/**
 * How far into a turn the sweep may still start. Past it, the sweep waits
 * for the next turn: this, plus the window, plus the last candidate's
 * SIGNOFF_PAGES reads, lookup and archive, each bounded by
 * ARCHIVE_TIMEOUT_MS, stays under dispatch/cli.mjs's DEADLINE_MS.
 */
export const SIGNOFF_LATEST_START_MS = 10 * 60 * 1000;

/**
 * How long a turn that messaged sessions waits, on a quiet lane, for their
 * replies before it sweeps, and how often it looks. The wait is cut short to
 * end one look before SIGNOFF_LATEST_START_MS, so a late turn waits less,
 * and the reads of its last look still leave the sweep to run.
 */
export const SIGNOFF_REPLY_WAIT_MS = 3 * 60 * 1000;
export const SIGNOFF_REPLY_POLL_MS = 15 * 1000;

/**
 * Whether the sessions API reads a session between turns. The answer the
 * deployed sweep read (2026-10-17) says so in `worker_status`
 * (`idle`, beside `status: active`, `status_bucket: completed`); the rows
 * read on 2026-09-27 said `session_status: SESSION_STATUS_IDLE`. A row carrying
 * `worker_status` is read by it alone, so a stale `session_status` never
 * archives a busy worker. Anything else, or neither, is not idle.
 *
 * @param {Record<string, unknown>} row
 */
const idle = (row) => ('worker_status' in row ? row.worker_status === 'idle' : row.session_status === 'SESSION_STATUS_IDLE');

/**
 * How many pages of a candidate's events the sweep reads, newest first,
 * looking for its reply. Each read is bounded by ARCHIVE_TIMEOUT_MS, and
 * every one of them fits SIGNOFF_WINDOW_MS. A session that logged state and
 * control events after its last result reached the fourth page.
 */
export const SIGNOFF_PAGES = 5;

/** How long one archive call may take (realDeps' timeout on the request). */
export const ARCHIVE_TIMEOUT_MS = 10 * 1000;

/** An access token this close to its expiry is treated as expired. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/** A list row's id: the API's `cse_…`, the session's URL `session_…`. */
const CSE_ID = /^cse_([A-Za-z0-9]+)$/;

/**
 * @typedef {(request: { session: string, token: string }) => Promise<{ status: number, body: string }>} Archive
 *
 * @typedef {(token: string) => Promise<unknown[]>} ListSessions
 *   Every row of the login's sessions list under `token`
 *   (`sessionRows`, scripts/lib/session-branch.mjs). A refusal throws.
 *
 * @typedef {(id: string, token: string) => Promise<{ row: unknown, from: 'list' | 'record' }>} Lookup
 *   The sessions API's row for one session (`cse_…`) under `token`, parsed,
 *   carrying its `worker_status`, and whether it came from the sessions list
 *   or the session's own record; the row is null for a session the API does
 *   not have. Any other refusal throws.
 *
 * @typedef {(id: string, token: string, cursor?: string) => Promise<unknown>} Events
 *   A page of one session's events (`cse_…`) under `token`, parsed, newest
 *   first: the newest, or with `cursor` (a page's `next_cursor`) the page
 *   older than that one. Any refusal throws, and its message carries no
 *   session text.
 *
 * @typedef {{ waiting: () => Promise<number> }} Fires
 *   The dispatcher's fire lane: how many fires are on it, queued or in
 *   flight. A read that fails throws.
 *
 * @typedef {{
 *   archived: string[],
 *   kept: Array<{ session: string, error: string }>,
 *   unsigned: number,
 *   deferred: number,
 *   skipped: string | null,
 * }} Sweep
 */

/**
 * The access token a login holds, unless it is not a login or its token
 * has expired: the reason, then.
 *
 * @param {string | null} login
 * @param {number} now
 * @returns {{ token: string } | { reason: string }}
 */
export const accessToken = (login, now) => {
  const parsed = login === null ? null : parseLogin(login);
  if (parsed === null || !parsed.ok) return { reason: `no login${parsed === null ? '' : `: ${parsed.reason}`}` };
  const { accessToken: token, expiresAt } = parsed.login.claudeAiOauth;
  if (typeof expiresAt === 'number' && expiresAt - EXPIRY_MARGIN_MS <= now) {
    return { reason: 'the access token has expired; the next turn that runs the CLI refreshes it' };
  }
  return { token };
};

/**
 * Archive the sessions that signed off.
 *
 * The candidates are the login's idle, unarchived sessions in a served repo
 * (`repos`), the repo read from the row's `config` (`reposOf`),
 * read most recently updated first until SIGNOFF_WINDOW_MS runs out. Each
 * candidate's last reply is read from its events (`readReply`, back up to
 * SIGNOFF_PAGES pages), and one that signs off is archived: the row is read afresh first (`lookup`), after
 * the events, so a prompt that landed during that read keeps the session. A
 * 2xx or a 409 (already archived) is archived, a 404 is gone; any other
 * answer is kept, and the next sweep reads the session again. A candidate in
 * `woken` (this turn messaged it, at the time it maps to) whose newest result
 * is not newer than the message is left for a later turn: its reply has not
 * landed. An events read that fails, or an answer outside the schema,
 * archives nothing. Each candidate logs one `dispatch-signoff` line naming
 * the session and the decision, never the reply's text, and the sweep ends
 * with one line counting the rows listed, its candidates, and of them those
 * archived, not signed off, kept and deferred, and the rows each test turned
 * away. The access token is
 * the one the turn leaves on disk, which the CLI has refreshed if the turn
 * ran it; an expired one sweeps nothing. Nothing here throws: a sweep that
 * cannot run says why in `skipped`.
 *
 * @param {{
 *   archive: Archive,
 *   login: string | null,
 *   started: number,
 *   now: () => number,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   woken?: ReadonlyMap<string, number>,
 *   repos: readonly string[],
 *   list: ListSessions,
 *   lookup: Lookup,
 *   events: Events,
 * }} args
 * @returns {Promise<Sweep>}
 */
export const sweepSignoffs = async ({ archive, login, started, now, log, woken = new Map(), repos, list, lookup, events }) => {
  /** @type {Sweep} */
  const sweep = { archived: [], kept: [], unsigned: 0, deferred: 0, skipped: null };
  /** @param {string} reason */
  const skip = (reason) => {
    log('dispatch-signoff', { skipped: reason });
    return { ...sweep, skipped: reason };
  };
  if (now() - started > SIGNOFF_LATEST_START_MS) return skip(`too late in the turn: past ${SIGNOFF_LATEST_START_MS} ms`);
  const usable = accessToken(login, now());
  if ('reason' in usable) return skip(usable.reason);
  const { token } = usable;
  const served = new Set(repos.map((repo) => repo.toLowerCase()));
  /** @type {string[]} */
  let candidates;
  /** @type {unknown[]} */
  let listed;
  /** How many rows each test turned away. */
  const turnedAway = { id: 0, archived: 0, busy: 0, unnamed: 0, unserved: 0 };
  /** @param {keyof typeof turnedAway} test */
  const away = (test) => {
    turnedAway[test] += 1;
    return false;
  };
  try {
    listed = await list(token);
    candidates = listed
      .filter((row) => {
        const id = /** @type {any} */ (row)?.id;
        if (typeof id !== 'string' || !CSE_ID.test(id)) return away('id');
        if (archived(row)) return away('archived');
        if (!idle(/** @type {Record<string, unknown>} */ (row))) return away('busy');
        const named = reposOf(row);
        if (named.length === 0) return away('unnamed');
        return named.some((repo) => served.has(repo)) || away('unserved');
      })
      .sort(newestFirst)
      .map((row) => /** @type {any} */ (row).id);
  } catch (error) {
    return skip(`could not list the sessions: ${messageOf(error)}`);
  }
  const windowStart = now();
  for (const [i, id] of candidates.entries()) {
    if (now() - windowStart > SIGNOFF_WINDOW_MS) {
      sweep.deferred += candidates.length - i;
      log('dispatch-signoff', { unread: candidates.length - i, reason: `out of time: past ${SIGNOFF_WINDOW_MS} ms` });
      break;
    }
    const session = `session_${CSE_ID.exec(id)?.[1]}`;
    /** @type {unknown} */
    let page;
    /** @type {{ signedOff: boolean } | { unreadable: string }} */
    let read;
    try {
      const replied = await readReply(events, id, token);
      read = replied.read;
      page = { data: replied.data };
    } catch (error) {
      read = { unreadable: `could not read the events: ${messageOf(error)}` };
    }
    if ('unreadable' in read) {
      log('dispatch-signoff', { session, decision: 'unreadable', archived: false, reason: read.unreadable });
      sweep.kept.push({ session, error: read.unreadable });
      continue;
    }
    const sent = woken.get(session);
    const at = resultAt(page);
    if (sent !== undefined && (at === null || at <= sent)) {
      sweep.deferred += 1;
      log('dispatch-signoff', { session, deferred: true, reason: 'woken by this turn: its reply has not landed' });
      continue;
    }
    if (!read.signedOff) {
      sweep.unsigned += 1;
      log('dispatch-signoff', { session, decision: 'not signed off' });
      continue;
    }
    const outcome = await archiveOne(session, id, { archive, lookup, token, log });
    if (outcome === 'archived') sweep.archived.push(session);
    if (typeof outcome === 'object') sweep.kept.push({ session, error: outcome.error });
  }
  log('dispatch-signoff', {
    listed: listed.length,
    candidates: candidates.length,
    archived: sweep.archived.length,
    unsigned: sweep.unsigned,
    kept: sweep.kept.length,
    deferred: sweep.deferred,
    turnedAway,
  });
  return sweep;
};

/**
 * Wait, on a quiet lane, for the replies to this turn's messages.
 *
 * A session's last sign-off is nearly always its reply to a dispatcher
 * message, which lands after the turn that sent it would have swept. So a
 * turn that messaged sessions, finding no fire on the lane, reads their
 * events every SIGNOFF_REPLY_POLL_MS for up to SIGNOFF_REPLY_WAIT_MS, and
 * stops when each one's newest result is newer than its message, or a fire
 * is queued. The task deleted its own fire as it took it
 * (dispatch/lane.mjs), so any count on the lane is a fire waiting for this
 * task's next turn: a busy lane is never slowed.
 * The wait ends one look before SIGNOFF_LATEST_START_MS, so the sweep after
 * it still runs, and it does not start with a login the sweep could not use
 * (`accessToken`). A lane or an events read that fails ends it too. Nothing
 * here throws.
 *
 * @param {{
 *   fires: Fires | undefined,
 *   woken: ReadonlyMap<string, number>,
 *   login: string | null,
 *   started: number,
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   events: Events,
 * }} args
 * @returns {Promise<void>}
 */
export const awaitReplies = async ({ fires, woken, login, started, now, sleep, log, events }) => {
  if (woken.size === 0 || fires === undefined) return;
  const usable = accessToken(login, now());
  if ('reason' in usable) {
    log('dispatch-signoff-wait', { waitedMs: 0, ended: `the sweep cannot run: ${usable.reason}` });
    return;
  }
  const { token } = usable;
  const from = now();
  const until = Math.min(from + SIGNOFF_REPLY_WAIT_MS, started + SIGNOFF_LATEST_START_MS - SIGNOFF_REPLY_POLL_MS);
  /** @type {string[]} */
  let pending = [...woken.keys()];
  for (let polls = 0; ; polls += 1) {
    /** @type {string | null} */
    let ended = null;
    try {
      if (await fires.waiting() > 0) ended = 'a fire is queued';
    } catch (error) {
      log('dispatch-signoff-wait', { waitedMs: now() - from, error: `could not read the fire lane: ${messageOf(error)}` });
      return;
    }
    if (ended === null) {
      /** @type {string[]} */
      const still = [];
      for (const session of pending) {
        const sent = /** @type {number} */ (woken.get(session));
        try {
          const at = resultAt(await events(`cse_${session.slice('session_'.length)}`, token));
          if (at === null || at <= sent) still.push(session);
        } catch (error) {
          log('dispatch-signoff-wait', { waitedMs: now() - from, error: `could not read the events of ${session}: ${messageOf(error)}` });
          return;
        }
      }
      pending = still;
      if (pending.length === 0) ended = 'every session replied';
      else if (polls >= SIGNOFF_REPLY_WAIT_MS / SIGNOFF_REPLY_POLL_MS || now() + SIGNOFF_REPLY_POLL_MS > until) ended = 'out of time';
    }
    if (ended !== null) {
      log('dispatch-signoff-wait', { waitedMs: now() - from, polls, ended, pending });
      return;
    }
    await sleep(SIGNOFF_REPLY_POLL_MS);
  }
};

/**
 * One archive: 'archived', 'gone', or the error that keeps the session for
 * the next sweep. The sessions API's row for the session (`Lookup`) goes
 * first: only an idle session is archived.
 *
 * @param {string} session `session_…`
 * @param {string} id `cse_…`
 * @param {{ archive: Archive, lookup: Lookup, token: string, log: (event: string, context?: Record<string, unknown>) => void }} args
 * @returns {Promise<'archived' | 'gone' | { error: string }>}
 */
const archiveOne = async (session, id, { archive, lookup, token, log }) => {
  /** @type {string} */
  let error;
  try {
    const { row, from } = await lookup(id, token);
    if (row === null) {
      log('dispatch-signoff', { session, decision: 'signed off', archived: false, reason: 'no such session' });
      return 'gone';
    }
    if (archived(row)) {
      log('dispatch-signoff', { session, decision: 'signed off', archived: false, reason: 'already archived' });
      return 'gone';
    }
    if (typeof row !== 'object' || !idle(/** @type {Record<string, unknown>} */ (row))) {
      // What each status field read, and where the row came from, so a
      // refusal shows what the API sent. Any key spelling, any value shape,
      // each cut short. No other value: a record's `config` holds the
      // session's prompt.
      /** @type {string} */
      let carried;
      if (typeof row === 'object') {
        const statuses = Object.entries(row)
          .filter(([k]) => /status/i.test(k))
          .map(([k, v]) => `${k}: ${(typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).slice(0, 100)}`);
        carried = `has ${Object.keys(row).join(', ')}${statuses.length > 0 ? `; ${statuses.join(', ')}` : ''}`;
      } else {
        carried = `is ${typeof row}`;
      }
      const source = from === 'list' ? 'the sessions list' : "the session's record";
      throw new Error(`the session is not idle (the API's answer, from ${source}, ${carried}): it may be at work`);
    }
    const { status: answered, body } = await archive({ session, token });
    if ((answered >= 200 && answered < 300) || answered === 409) {
      log('dispatch-signoff', { session, decision: 'signed off', archived: true, status: answered });
      return 'archived';
    }
    if (answered === 404) {
      log('dispatch-signoff', { session, decision: 'signed off', archived: false, status: answered, reason: 'no such session' });
      return 'gone';
    }
    error = `${answered}: ${body.slice(0, 300)}`;
  } catch (thrown) {
    error = messageOf(thrown);
  }
  log('dispatch-signoff', { session, decision: 'signed off', archived: false, error });
  return { error };
};
