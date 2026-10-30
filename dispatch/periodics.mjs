/**
 * Periodics: recurring sessions a repo lists in its config file
 * (dispatch/repo-config.mjs), each with a name, a prompt and a day limit,
 * and optionally counts of events and a minimum gap.
 *
 * The bare schedule fire reads each periodic's record from the state table
 * ({@link duePeriodics}): the time of its last fire and the session it
 * started. One whose day limit has passed since, or will within the hour
 * ({@link SWEEP_GRACE_MS}), is due, and so is one whose count of an event
 * since then has reached its number. The turn
 * (dispatch/turn.mjs) starts a session on its prompt, ahead of the tickets,
 * with lines governor writes under it ({@link periodicPrompt}). The turn
 * writes the record only for a launch that started or may have, and only
 * over the record it read, so two turns never both record one fire. The
 * write comes after the launch: it is the one task at a time that keeps two
 * turns from both starting it.
 *
 * A merge into the default branch, an issue opened or an issue closed is
 * counted when it happens: the fire for it carries the kind (`COUNTS`,
 * dispatch/webhook/fire.mjs), and the turn reads that kind's count since
 * each periodic's last fire afresh from GitHub ({@link windowOf}). Governor
 * keeps no running total, so a lost webhook only delays a fire to the next
 * event or sweep. A periodic never fires inside its minimum gap; a count
 * reached there fires on the first event or sweep after it.
 *
 * A periodic never overlaps itself. One that comes due while the session its
 * last fire started is still open is held ({@link Open}): the turn starts
 * nothing and logs the fire held, naming that session, and writes nothing,
 * so its count keeps growing from the fire before and the first check after
 * the run ends fires it. A day limit on empty windows is held the same
 * way: its nothing-to-do record names no session, so it would let the next
 * count start a second run over the open one. A run is finished once its
 * session is archived, whether by the sign-off sweep or by hand, or no
 * longer exists; a record
 * with no session, from an unconfirmed launch, is a finished run. A session
 * that cannot be read refuses the periodic for the turn, and is never a
 * finished run.
 *
 * At its day limit, a periodic with counts whose window is empty starts no
 * session: governor records "nothing to do" as its fire, so its next day
 * limit counts from then. A periodic with only a day limit always starts.
 *
 * With no record, for a new periodic or a lost item, the turn writes now as
 * the baseline and starts nothing: the first run comes one day limit later,
 * and a lost record costs at most one late run, never a burst. The baseline
 * writes the periodic's heartbeat line where it has none, so the repo can
 * see governor has read it. A read that
 * fails refuses the periodic for the turn, and is never a missing record;
 * so does a window that cannot be read, which is never an empty one.
 */

import { COUNTS } from './webhook/fire.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/** An hour, in milliseconds. */
export const HOUR_MS = 60 * 60 * 1000;

/** A day, in milliseconds. */
export const DAY_MS = 24 * HOUR_MS;

/**
 * How far short of its day limit a periodic may be read and still be due:
 * half the schedule's two-hour interval, so the sweep nearest the limit
 * fires it. The record holds the launch's time, minutes after the sweep
 * read it, so the sweep a day limit later reads it a little short. Without
 * this, every run would slip to the sweep after, and the slips add up.
 */
export const SWEEP_GRACE_MS = HOUR_MS;

/**
 * How many of one kind's items a prompt lists before it says how many more:
 * the prompt is one argument to the CLI, which a busy month's titles would
 * outgrow.
 */
export const LISTED_MAX = 100;

/**
 * @typedef {import('./webhook/fire.mjs').Count} Count
 * @typedef {{ at: string, session: string | null, baseline: boolean, nothing?: true, lastRun?: string }} PeriodicRecord
 *   `at`: the last fire's time, or the baseline's. `session`: the session the
 *   fire started, null for an unconfirmed launch, the baseline or nothing to do.
 *   `baseline`: governor wrote it with no record to go on, and started nothing.
 *   `nothing`: the day limit came due on empty windows, and started nothing;
 *   `lastRun` then keeps the time of the last fire that ran, if any, which
 *   the minimum gap runs from.
 * @typedef {{
 *   periodic: (repo: string, name: string) => Promise<PeriodicRecord | null>,
 *   recordPeriodic: (repo: string, name: string, read: PeriodicRecord | null, record: PeriodicRecord) => Promise<boolean>,
 * }} PeriodicState
 *   A periodic's record, read (null when there is none; a read that fails
 *   throws), and written over the record `read` (none, for null): false
 *   where another record stands.
 * @typedef {{ number: number, title: string, at: string }} Counted One merge or issue, and when it was merged, opened or closed.
 * @typedef {(kind: Count, since: string) => Promise<Counted[]>} Window
 *   What of `kind` happened after `since`, oldest first, read afresh; a read
 *   that fails throws.
 * @typedef {(session: string) => Promise<boolean>} Open
 *   Whether the session a record names (its URL) is still open: not archived,
 *   and still there. A read that fails throws.
 * @typedef {Partial<Record<Count, Counted[]>>} Windows
 * @typedef {{ periodic: import('./repo-config.mjs').Periodic, read: PeriodicRecord, due: number, by: import('./heartbeat.mjs').Limit, windows?: Windows, asOf?: string }} Due
 *   `by`: the limit that brought it due, its day limit or the first count
 *   that reached its number.
 *   `windows`: what each of its counts counted, for one that has counts.
 *   `asOf`: then the time the windows were read from, which its fire
 *   records in place of the launch's, so whatever lands between the read and
 *   the launch is in the next window rather than neither.
 */

/** What the prompt calls each kind. */
const COUNTED_AS = /** @type {Record<Count, string>} */ ({
  merges: 'Pull requests merged into the default branch',
  issuesOpened: 'Issues opened',
  issuesClosed: 'Issues closed',
});

/**
 * A repo's windows, read through its reader. Merges are counted by their
 * merge time into the default branch, `base` where the fire names it, else
 * read once. Never by comparing commits: that stops at 250, and a busy week
 * passes it.
 *
 * @param {{
 *   defaultBranch: () => Promise<string>,
 *   mergedSince: (base: string, since: string) => Promise<Counted[]>,
 *   issuesOpenedSince: (since: string) => Promise<Counted[]>,
 *   issuesClosedSince: (since: string) => Promise<Counted[]>,
 * }} reader
 * @param {string} [base]
 * @returns {Window}
 */
export const windowOf = (reader, base) => {
  /** @type {Promise<string> | null} */
  let branch = base === undefined ? null : Promise.resolve(base);
  return async (kind, since) => {
    if (kind === 'merges') return reader.mergedSince(await (branch ??= reader.defaultBranch()), since);
    return kind === 'issuesOpened' ? reader.issuesOpenedSince(since) : reader.issuesClosedSince(since);
  };
};

/**
 * The line governor writes under a periodic's prompt: when it last fired,
 * that its last day limit found nothing to do, or that this is the first run
 * governor knows of. No repo can drop or reword it.
 *
 * @param {PeriodicRecord} read The record the turn read.
 */
export const lastFireLine = (read) => {
  if (read.baseline) return 'This is the first run of this periodic that governor has a record of.';
  if (read.nothing === true) return `This periodic last came due at ${read.at} with nothing to do, so it did not run then.`;
  return `This periodic last fired at ${read.at}.`;
};

/**
 * One kind's window, as the prompt lists it.
 *
 * @param {Count} kind
 * @param {Counted[]} items
 * @param {string} since
 */
const windowLines = (kind, items, since) => {
  const head = `${COUNTED_AS[kind]} since ${since}: ${items.length === 0 ? 'none' : items.length}`;
  const listed = items.slice(0, LISTED_MAX).map((i) => `- #${i.number} ${i.title.replace(/\s+/g, ' ').trim()}`);
  const more = items.length > LISTED_MAX ? [`- and ${items.length - LISTED_MAX} more`] : [];
  return [head, ...listed, ...more].join('\n');
};

/**
 * A due periodic's session prompt: its own, then governor's line, then what
 * each of its counts counted since the record's time.
 *
 * @param {string} prompt
 * @param {PeriodicRecord} read
 * @param {Windows} [windows]
 */
export const periodicPrompt = (prompt, read, windows = {}) => [
  prompt,
  lastFireLine(read),
  ...COUNTS.flatMap((kind) => {
    const items = windows[kind];
    return items === undefined ? [] : [windowLines(kind, items, read.at)];
  }),
].join('\n\n');

/**
 * A periodic's counts, as `[kind, number]` pairs.
 *
 * @param {import('./repo-config.mjs').Periodic} periodic
 * @returns {Array<[Count, number]>}
 */
const countsOf = (periodic) => COUNTS.flatMap((kind) => {
  const n = periodic.counts?.[kind];
  return n === undefined ? [] : [/** @type {[Count, number]} */ ([kind, n])];
});

/**
 * The time of the last fire that ran, if the record knows one: a baseline
 * ran nothing, and a day limit with nothing to do keeps the run before it.
 *
 * @param {PeriodicRecord} read
 * @returns {string | undefined}
 */
const lastRunOf = (read) => (read.baseline ? undefined : read.nothing === true ? read.lastRun : read.at);

/**
 * Whether a periodic is inside its minimum gap since its last run.
 *
 * @param {import('./repo-config.mjs').Periodic} periodic
 * @param {PeriodicRecord} read
 * @param {number} now
 */
const inGap = (periodic, read, now) => {
  const ran = lastRunOf(read);
  return periodic.gapHours !== undefined && ran !== undefined && now - Date.parse(ran) < periodic.gapHours * HOUR_MS;
};

/**
 * A repo's due periodics, each with the record the turn read, when it came
 * due, and what its counts counted; and the ones whose record or window
 * could not be read, or whose baseline could not be written. A periodic with
 * no record gets now as its baseline, and is not due.
 *
 * On the sweep (`event` undefined), every periodic is read against its day
 * limit and its counts. On an event's turn, only the periodics that count
 * `event` are read, and only against that count, so the event's turn starts
 * nothing the sweep would not; the rest of its counts are read for the
 * prompt once it is due. A due periodic whose last run is still `open` is
 * held, and is not due. A held fire, a nothing-to-do and a baseline this
 * turn wrote come back as the heartbeat lines they change
 * (dispatch/heartbeat.mjs): a held one keeps the open run's start and names
 * its session, and a baseline's says it has not fired yet, which the block
 * takes only where it has no line for the periodic.
 *
 * @param {{
 *   repo: string,
 *   periodics: import('./repo-config.mjs').Periodic[],
 *   state: PeriodicState,
 *   now: number,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   window?: Window,
 *   open?: Open,
 *   event?: Count,
 * }} args
 * @returns {Promise<{ due: Due[], unread: Array<{ repo: string, error: string }>, beats: import('./heartbeat.mjs').PeriodicChange[] }>}
 */
export const duePeriodics = async ({ repo, periodics, state, now, log, window = noWindow, open = noOpen, event }) => {
  /** @type {Due[]} */
  const due = [];
  /** @type {import('./heartbeat.mjs').PeriodicChange[]} */
  const beats = [];
  /** @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  /** @param {string} name @param {unknown} error @param {string} reason */
  const refuse = (name, error, reason) => {
    const message = messageOf(error);
    log('dispatch-periodic-unread', { level: 'error', repo, periodic: name, error: message, reason });
    unread.push({ repo, error: `periodic ${name}: ${message}` });
  };
  /**
   * Whether a due periodic is held for its last run: logged, or refused
   * where the session cannot be read.
   *
   * @param {string} name
   * @param {PeriodicRecord} read
   */
  const held = async (name, read) => {
    if (read.session === null) return false;
    try {
      if (!(await open(read.session))) return false;
    } catch (error) {
      refuse(name, error, 'its last run\'s session could not be read, so it is refused this turn');
      return true;
    }
    log('dispatch-periodic', { repo, periodic: name, outcome: 'held', session: read.session, at: read.at, reason: 'its last run\'s session is still open' });
    beats.push({ name, at: read.at, session: read.session, state: 'held' });
    return true;
  };
  for (const periodic of periodics) {
    const { name, days } = periodic;
    const counts = countsOf(periodic);
    if (event !== undefined && !counts.some(([kind]) => kind === event)) continue;
    /** @type {PeriodicRecord | null} */
    let read;
    try {
      read = await state.periodic(repo, name);
    } catch (error) {
      refuse(name, error, 'its record could not be read, so it is refused this turn');
      continue;
    }
    if (read === null) {
      const at = new Date(now).toISOString();
      try {
        const written = await state.recordPeriodic(repo, name, null, { at, session: null, baseline: true });
        log('dispatch-periodic', { repo, periodic: name, outcome: written ? 'baseline' : 'baseline already written', at });
        if (written) beats.push({ name, at, session: null, state: 'not fired' });
      } catch (error) {
        const message = messageOf(error);
        log('dispatch-periodic-unrecorded', { level: 'error', repo, periodic: name, error: message, reason: 'its baseline could not be written' });
        unread.push({ repo, error: `periodic ${name}: ${message}` });
      }
      continue;
    }
    if (inGap(periodic, read, now)) {
      log('dispatch-periodic', { repo, periodic: name, outcome: 'inside its gap', at: read.at, gapHours: periodic.gapHours });
      continue;
    }
    const at = Date.parse(read.at);
    const limit = at + days * DAY_MS;
    const dayDue = event === undefined && now - at >= days * DAY_MS - SWEEP_GRACE_MS;
    if (counts.length === 0) {
      if (dayDue && !(await held(name, read))) due.push({ periodic, read, due: limit, by: { days } });
      continue;
    }
    /** @type {Windows} */
    const windows = {};
    let reached = false;
    /** @type {[Count, number] | undefined} */
    let by;
    try {
      for (const [kind] of counts.filter(([kind]) => event === undefined || kind === event)) windows[kind] = await window(kind, read.at);
      reached = counts.some(([kind, n]) => (windows[kind]?.length ?? 0) >= n);
      by = counts.find(([kind, n]) => (windows[kind]?.length ?? 0) >= n);
      if (!reached && !dayDue) continue;
      for (const [kind] of counts) windows[kind] ??= await window(kind, read.at);
    } catch (error) {
      refuse(name, error, 'what it counts could not be read, so it is refused this turn');
      continue;
    }
    // Held before a nothing-to-do too: its record names no session, so the
    // next count would start a second run over the open one.
    if (await held(name, read)) continue;
    if (!reached && Object.values(windows).every((items) => items.length === 0)) {
      // The day limit came due on empty windows: nothing to review, and the
      // next day limit counts from now.
      const ran = lastRunOf(read);
      const record = { at: new Date(now).toISOString(), session: null, baseline: false, nothing: /** @type {const} */ (true), ...(ran === undefined ? {} : { lastRun: ran }) };
      try {
        const written = await state.recordPeriodic(repo, name, read, record);
        log('dispatch-periodic', { repo, periodic: name, outcome: written ? 'nothing to do' : 'nothing to do, and its record moved since the read', at: record.at });
        if (written) beats.push({ name, at: record.at, by: { days }, session: null, state: 'nothing to do' });
      } catch (error) {
        const message = messageOf(error);
        log('dispatch-periodic-unrecorded', { level: 'error', repo, periodic: name, error: message, reason: 'its nothing-to-do could not be written, so the next fire reads its windows again' });
        unread.push({ repo, error: `periodic ${name}: ${message}` });
      }
      continue;
    }
    due.push({ periodic, read, due: reached ? Math.min(limit, now) : limit, by: by === undefined ? { days } : { count: by[0], number: by[1] }, windows, asOf: new Date(now).toISOString() });
  }
  return { due, unread, beats };
};

/** @type {Open} */
const noOpen = async (session) => {
  throw new Error(`no reader for ${session} was given`);
};

/** @type {Window} */
const noWindow = async (kind) => {
  throw new Error(`no reader for ${kind} was given`);
};
