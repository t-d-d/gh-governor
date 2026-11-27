/**
 * Periodics: recurring sessions a repo lists in its config file
 * (dispatch/repo-config.mjs), each with a name, a prompt, at least one
 * limit and optionally a minimum gap. A limit is a time limit in days or
 * hours, or a count of events. The file holds its limits in `when`;
 * `toConfig` reads them into the time limit and the counts this module
 * takes. Below, "day limit" means the time limit in either unit.
 *
 * The bare schedule fire reads each periodic's record from the state table
 * ({@link duePeriodics}): the time of its last fire and the session it
 * started. One whose day limit has passed since, or will within the hour
 * ({@link SWEEP_GRACE_MS}), is due, and so is one whose count of an event
 * since then has reached its number. The turn starts a session on its
 * prompt, ahead of the tickets (`planSweep`, dispatch/sweep.mjs),
 * with lines governor writes under it ({@link periodicPrompt}). The turn
 * writes the record only for a launch that started or may have, and only
 * over the record it read, so two turns never both record one fire. The
 * write comes after the launch: it is the one task at a time that keeps two
 * turns from both starting it.
 *
 * What a count counts is a measure, one entry in the measures table
 * (dispatch/webhook/measures.mjs), such as a merge into the default
 * branch. An event a measure wakes on queues a `periodics` fire naming it,
 * whose planner (dispatch/periodics-fire.mjs) reads that measure's count
 * since each periodic's last fire afresh from GitHub ({@link windowOf}). A
 * check reads each measure's list once, from the oldest last fire among
 * the periodics it reads, and each limit counts the rows after its own
 * last fire ({@link sharedWindow}). The sweep and
 * that planner each hand `launchPlan` (dispatch/launch-plan.mjs) their due
 * periodics, each turned into a launch by {@link periodicLaunch}. Governor
 * keeps no running total, so a lost webhook only delays a fire to the next
 * event or sweep. A periodic never fires inside its minimum gap; a count
 * reached there fires on the first event or sweep after it.
 *
 * A periodic never overlaps itself. One that comes due while the session its
 * last fire started is in the middle of a turn is held ({@link Busy}): the
 * turn starts nothing and logs the fire held, naming that session, and
 * writes nothing, so its count keeps growing from the fire before and the
 * first check after that turn ends fires it. An open session
 * between turns does not hold it: the fire starts a new session and leaves
 * the old one as it is, whether or not it signed off or was archived. A
 * periodic's time limit and counts are its only clock, and its fire is never sent
 * to the old session as a message, as a hook's is. A record with no
 * session, from an unconfirmed launch, holds nothing. A session that cannot
 * be read refuses the periodic for the turn, and is never taken for an idle
 * one.
 *
 * A day limit is a plain timer: it runs from the last fire, whatever the
 * counts counted, and starts a session even where every window is empty.
 * The lines under the prompt then say none, and the repo's prompt decides
 * what the session does. A periodic with no day limit comes due only when
 * a count is reached.
 *
 * With no record, for a new periodic or a lost item, the turn writes now as
 * the baseline and starts nothing: the first run comes one day limit later,
 * or once a count since the baseline is reached, and a lost record costs at most one late run, never a burst. The baseline
 * writes the periodic's heartbeat line where it has none, so the repo can
 * see governor has read it, and each sweep sends that line again until the
 * first fire, in case the write failed. A read that
 * fails refuses the periodic for the turn, and is never a missing record;
 * so does a window that cannot be read, which is never an empty one.
 */

import { MEASURES, measureNames, measureOf } from './webhook/measures.mjs';
import { AUTO } from './trust.mjs';
import { FILES_LISTED, globMatches } from './checklist.mjs';
import { runOf, turnsOn } from './repo-config.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/** An hour, in milliseconds. */
export const HOUR_MS = 60 * 60 * 1000;

/** A day, in milliseconds. */
export const DAY_MS = 24 * HOUR_MS;

/**
 * How far short of its day limit a periodic may be read and still be due:
 * half the schedule's hourly interval, so the sweep nearest the limit
 * fires it. The record holds the launch's time, minutes after the sweep
 * read it, so the sweep a day limit later reads it a little short. Without
 * this, every run would slip to the sweep after, and the slips add up. A
 * grace of a whole interval could fire it at the sweep before the limit,
 * whenever that sweep's turn ran later after its fire than the last launch
 * did after its own, and the runs would creep earlier instead.
 */
export const SWEEP_GRACE_MS = HOUR_MS / 2;

/**
 * How many of one kind's items a prompt lists before it says how many more:
 * the prompt is one argument to the CLI, which a busy month's titles would
 * outgrow.
 */
export const LISTED_MAX = 100;

/**
 * The most a files record's list may take, in bytes of its JSON: under a
 * state table item's 400 KB with room for its key. A list past it is kept
 * as the cut-short mark alone, which counts as a match, and the check that
 * reads it from GitHub counts it the same way, so a later check counts as
 * this one did.
 */
export const FILES_RECORD_MAX_BYTES = 350_000;

/**
 * @typedef {import('./webhook/fire.mjs').Count} Count
 * @typedef {{ at: string, session: string | null, baseline: boolean }} PeriodicRecord
 *   `at`: the last fire's time, or the baseline's. `session`: the session the
 *   fire started, null for an unconfirmed launch or the baseline.
 *   `baseline`: governor wrote it with no record to go on, and started nothing.
 *   A record written before governor dropped its "nothing to do" fire may
 *   still carry `nothing` and `lastRun`. The state table's reader leaves
 *   them out, so it reads as a last fire at its `at` that started no
 *   session.
 * @typedef {{
 *   periodic: (repo: string, name: string) => Promise<PeriodicRecord | null>,
 *   recordPeriodic: (repo: string, name: string, read: PeriodicRecord | null, record: PeriodicRecord) => Promise<boolean>,
 * }} PeriodicState
 *   A periodic's record, read (null when there is none; a read that fails
 *   throws), and written over the record `read` (none, for null): false
 *   where another record stands.
 * @typedef {{ files: Array<{ filename: string, previous?: string, additions: number, deletions: number }>, cut: boolean }} FilesRecord
 *   What a merged pull request changed: each file's path, the path a rename
 *   left, and its lines added and deleted. `cut`: the list is not whole,
 *   since GitHub listed the most it lists or the list was too large to keep.
 * @typedef {{
 *   mergedFiles: (repo: string, number: number) => Promise<FilesRecord | null>,
 *   recordMergedFiles: (repo: string, number: number, record: FilesRecord) => Promise<void>,
 * }} FilesState
 *   A merged pull request's files record, read (null when there is none; a
 *   read that fails throws), and written over whatever stands.
 * @typedef {{ read: (number: number) => Promise<FilesRecord | null>, write: (number: number, record: FilesRecord) => Promise<void> }} KeptFiles
 *   One repo's files records, as a check reads and writes them.
 * @typedef {import('./webhook/measures.mjs').Counted} Counted One item a measure counted, and when it happened.
 * @typedef {(kind: Count, since: string) => Promise<Counted[]>} Window
 *   What of `kind` happened after `since`, oldest first, read afresh; a read
 *   that fails throws.
 * @typedef {(session: string) => Promise<boolean>} Busy
 *   Whether the session a record names (its URL) is in the middle of a turn:
 *   still there, not archived, and not idle. A read that fails throws.
 * @typedef {Readonly<Record<string, readonly string[]>>} Filters What a limit's
 *   object form set beside `count`, each by its name in its measure's entry.
 * @typedef {(kind: Count, rows: Counted[], filters: Filters) => Promise<Counted[]>} Narrow
 *   The rows a limit with filters counts, in their order; a read that fails throws.
 * @typedef {Partial<Record<Count, Counted[]>>} Windows
 * @typedef {{ periodic: import('./repo-config.mjs').Periodic, read: PeriodicRecord, due: number, by: import('./heartbeat.mjs').Limit, windows?: Windows, asOf?: string }} Due
 *   `by`: the limit that brought it due, its time limit or the first count
 *   that reached its number.
 *   `windows`: what each of its counts counted, for one that has counts.
 *   `asOf`: then the time the windows were read from, which its fire
 *   records in place of the launch's, so whatever lands between the read and
 *   the launch is in the next window rather than neither.
 */

/**
 * A repo's windows, read through its reader, each by its measure's own
 * read (dispatch/webhook/measures.mjs). The default branch is `base` where
 * the fire names it, else read once for the turn.
 *
 * @param {import('./webhook/measures.mjs').WindowReader} reader
 * @param {string} [base]
 * @param {readonly string[]} [auto] The repo's `trust.auto` (dispatch/trust.mjs):
 *   an issue is counted and listed only where it lets its author in. A
 *   merge is not judged.
 * @returns {Window}
 */
export const windowOf = (reader, base, auto = AUTO) => {
  /** @type {Promise<string> | null} */
  let branch = base === undefined ? null : Promise.resolve(base);
  const context = { branch: () => (branch ??= reader.defaultBranch()), auto };
  return async (kind, since) => {
    const measure = measureOf(kind);
    if (measure === undefined) throw new Error(`no measure is named ${kind}`);
    return measure.read(reader, since, context);
  };
};

/**
 * How a check narrows a limit's rows by its filters, each by its
 * measure's own (dispatch/webhook/measures.mjs). A pull request's files
 * are read at most once for the check, however many limits ask for them,
 * and a read that fails throws for each limit that asks. The rows stay
 * those the shared list holds (`sharedWindow`): only the count narrows.
 *
 * With `kept`, the state table's files record, a pull request's files are
 * read from its record first, and from GitHub only where it has none,
 * then written to it. A record read that fails throws, as a files read
 * does: it is never taken for a missing record.
 *
 * @param {{ pullFiles: (number: number) => Promise<Array<import('../scripts/lib/github-app.mjs').FileRow>> }} reader
 * @param {KeptFiles} [kept]
 * @returns {Narrow}
 */
export const narrowOf = (reader, kept) => {
  /** @type {Map<number, Promise<import('./webhook/measures.mjs').ChangedFiles>>} */
  const files = new Map();
  /** @param {number} number @returns {Promise<FilesRecord>} */
  const read = async (number) => {
    const held = kept === undefined ? null : await kept.read(number);
    if (held !== null) return held;
    const rows = await reader.pullFiles(number);
    const listed = rows.map((f) => ({ filename: f.filename, ...(f.previous === undefined ? {} : { previous: f.previous }), additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
    // A list too large to keep is the cut-short mark alone, here as in the table.
    /** @type {FilesRecord} */
    const record = Buffer.byteLength(JSON.stringify(listed)) > FILES_RECORD_MAX_BYTES
      ? { files: [], cut: true }
      : { files: listed, cut: rows.length >= FILES_LISTED };
    if (kept !== undefined) await kept.write(number, record);
    return record;
  };
  /** @type {import('./webhook/measures.mjs').FilterContext} */
  const context = {
    files: (number) => {
      let got = files.get(number);
      if (got === undefined) {
        got = read(number);
        files.set(number, got);
      }
      return got;
    },
    globMatches,
  };
  return async (kind, rows, filters) => {
    let kept = rows;
    for (const [name, values] of Object.entries(filters)) {
      const filter = measureOf(kind)?.filters[name];
      if (filter === undefined) throw new Error(`${kind} takes no filter named ${name}`);
      /** @type {Counted[]} */
      const next = [];
      // One at a time: a busy window would otherwise send every files read at once.
      for (const row of kept) if (await filter.keep(row, values, context)) next.push(row);
      kept = next;
    }
    return kept;
  };
};

/**
 * The files record of one repo in the state table, as `narrowOf` reads it.
 * A write that fails is logged at warn and lets the check go on: the files
 * were read, and a missing record costs one read on a later check.
 *
 * @param {FilesState} state
 * @param {string} repo
 * @param {(event: string, context?: Record<string, unknown>) => void} log
 * @returns {KeptFiles}
 */
export const keptFilesOf = (state, repo, log) => ({
  read: (number) => state.mergedFiles(repo, number),
  write: async (number, record) => {
    try {
      await state.recordMergedFiles(repo, number, record);
    } catch (error) {
      log('dispatch-files-unrecorded', { level: 'warn', repo, pr: number, error: messageOf(error), reason: 'the merge\'s files were read but not kept: a later check reads them again' });
    }
  },
});

/** @type {Narrow} */
const noNarrow = async (kind, rows, filters) => {
  if (Object.keys(filters).length > 0) throw new Error(`no reader for ${kind}'s filters was given`);
  return rows;
};

/**
 * A periodic's filters on one of its counts; none where its file set none.
 *
 * @param {import('./repo-config.mjs').Periodic} periodic
 * @param {Count} kind
 * @returns {Filters}
 */
const filtersOn = (periodic, kind) => periodic.filters?.[kind] ?? {};

/**
 * One check's windows: each measure's list read once, from the oldest of
 * the times `oldest` gives for it, and each read after a later time taken
 * as the rows after that time. A read that fails throws for every window
 * it would have served.
 *
 * @param {Window} window
 * @param {(kind: Count) => Promise<string | undefined>} oldest The oldest last fire among the periodics that will read `kind`.
 * @returns {Window}
 */
export const sharedWindow = (window, oldest) => {
  /** @type {Map<Count, Promise<{ since: string, rows: Counted[] }>>} */
  const lists = new Map();
  return async (kind, since) => {
    let list = lists.get(kind);
    if (list === undefined) {
      list = (async () => {
        const from = await oldest(kind);
        const start = from !== undefined && Date.parse(from) < Date.parse(since) ? from : since;
        return { since: start, rows: await window(kind, start) };
      })();
      lists.set(kind, list);
    }
    const { since: start, rows } = await list;
    if (since === start) return rows;
    const after = Date.parse(since);
    // A time before the list's start is never asked for: the oldest covers
    // every periodic that reads it. Were it, the list could not hold its rows.
    if (after < Date.parse(start)) return window(kind, since);
    return rows.filter((row) => Date.parse(row.at) > after);
  };
};

/**
 * The line governor writes under a periodic's prompt: when it last fired,
 * or that this is the first run governor knows of. No repo can drop or
 * reword it.
 *
 * @param {PeriodicRecord} read The record the turn read.
 */
const lastFireLine = (read) => (read.baseline ? 'This is the first run of this periodic that governor has a record of.' : `This periodic last fired at ${read.at}.`);

/**
 * One kind's window, as the prompt lists it: its heading names what its
 * filters kept.
 *
 * @param {Count} kind
 * @param {Counted[]} items
 * @param {string} since
 * @param {Filters} filters
 */
const windowLines = (kind, items, since, filters) => {
  const measure = measureOf(kind);
  const named = Object.entries(filters).flatMap(([name, values]) => {
    const filter = measure?.filters[name];
    return filter === undefined ? [] : [filter.heading(values)];
  });
  const head = `${[measure?.heading ?? kind, ...named].join(' ')} since ${since}: ${items.length === 0 ? 'none' : items.length}`;
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
 * @param {import('./repo-config.mjs').Periodic['filters']} [filters] Its counts' filters, which the lines name.
 */
export const periodicPrompt = (prompt, read, windows = {}, filters = {}) => [
  prompt,
  lastFireLine(read),
  ...measureNames().flatMap((kind) => {
    const items = windows[kind];
    return items === undefined ? [] : [windowLines(kind, items, read.at, filters[kind] ?? {})];
  }),
].join('\n\n');

/**
 * A periodic's counts, as `[kind, number]` pairs.
 *
 * @param {import('./repo-config.mjs').Periodic} periodic
 * @returns {Array<[Count, number]>}
 */
const countsOf = (periodic) => measureNames().flatMap((kind) => {
  const n = periodic.counts?.[kind];
  return n === undefined ? [] : [/** @type {[Count, number]} */ ([kind, n])];
});

/**
 * The measures a repo's limits name, in the measures table's order: each
 * one some periodic's `when` holds, and none where the file turns periodics
 * off. The task writes them into the receiver's hook-table item
 * (dispatch/webhook/hook-table.mjs), and the receiver queues a `periodics`
 * fire only for an event that wakes one of them (route.mjs).
 *
 * @param {import('./repo-config.mjs').RepoConfig} config
 * @returns {string[]}
 */
export const limitedMeasures = (config) => (turnsOn(config, 'periodics')
  ? measureNames().filter((kind) => config.periodics.some((periodic) => periodic.counts?.[/** @type {Count} */ (kind)] !== undefined))
  : []);

/**
 * For each filter that wakes its measure (dispatch/webhook/measures.mjs),
 * as one does on a label change, the measures a repo's limits with that
 * filter name, in the measures table's order; empty for each where the file turns
 * periodics off. The task writes them into the receiver's hook-table item
 * beside {@link limitedMeasures}, and the receiver queues a `periodics`
 * fire a filter woke only for a measure listed under that filter
 * (route.mjs).
 *
 * @param {import('./repo-config.mjs').RepoConfig} config
 * @returns {Record<string, string[]>}
 */
export const filteredMeasures = (config) => {
  const limited = limitedMeasures(config);
  /** @type {Record<string, string[]>} */
  const filtered = {};
  for (const measure of MEASURES) {
    for (const [name, filter] of Object.entries(measure.filters)) {
      if (filter.wakes === undefined) continue;
      filtered[name] ??= [];
      const named = limited.includes(measure.name) && config.periodics.some((periodic) => filtersOn(periodic, /** @type {Count} */ (measure.name))[name] !== undefined);
      if (named) filtered[name].push(measure.name);
    }
  }
  return filtered;
};

/**
 * A periodic's time limit: how long after its last fire it comes due, and
 * the limit as its heartbeat line names it, in the unit its file gives;
 * null for a periodic with counts alone.
 *
 * @param {import('./repo-config.mjs').Periodic} periodic
 * @returns {{ ms: number, by: import('./heartbeat.mjs').Limit } | null}
 */
const timeLimitOf = ({ days, hours }) => {
  if (hours !== undefined) return { ms: hours * HOUR_MS, by: { hours } };
  if (days !== undefined) return { ms: days * DAY_MS, by: { days } };
  return null;
};

/**
 * Whether a periodic is inside its minimum gap since its last fire. A
 * baseline fired nothing, so it opens no gap.
 *
 * @param {import('./repo-config.mjs').Periodic} periodic
 * @param {PeriodicRecord} read
 * @param {number} now
 */
const inGap = (periodic, read, now) => periodic.gapHours !== undefined && !read.baseline && now - Date.parse(read.at) < periodic.gapHours * HOUR_MS;

/**
 * A repo's due periodics, each with the record the turn read, when it came
 * due, and what its counts counted; and the ones whose record or window
 * could not be read, or whose baseline could not be written. A periodic with
 * no record gets now as its baseline, and is not due.
 *
 * On the sweep (`event` undefined), every periodic is read against its day
 * limit, where it has one, and its counts. On an event's turn, only the periodics that count
 * `event` are read, and only against that count, so the event's turn starts
 * nothing the sweep would not; the rest of its counts are read for the
 * prompt once it is due. A due periodic whose last run is `busy`, in the
 * middle of a turn, is held, and is not due. A held fire and a baseline this
 * turn wrote come back as the heartbeat lines they change
 * (dispatch/heartbeat.mjs): a held one keeps the busy run's start and names
 * its session, and a baseline's says it has not fired yet, which the block
 * takes only where it has no line for the periodic. The sweep sends a
 * baseline's line again on every read until the first fire.
 *
 * @param {{
 *   repo: string,
 *   periodics: import('./repo-config.mjs').Periodic[],
 *   state: PeriodicState,
 *   now: number,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   window?: Window,
 *   narrow?: Narrow,
 *   busy?: Busy,
 *   event?: Count,
 * }} args
 * @returns {Promise<{ due: Due[], unread: Array<{ repo: string, error: string }>, beats: import('./heartbeat.mjs').PeriodicChange[] }>}
 */
export const duePeriodics = async ({ repo, periodics, state, now, log, window = noWindow, narrow = noNarrow, busy = noBusy, event }) => {
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
      if (!(await busy(read.session))) return false;
    } catch (error) {
      refuse(name, error, 'its last run\'s session could not be read, so it is refused this turn');
      return true;
    }
    log('dispatch-periodic', { repo, periodic: name, outcome: 'held', session: read.session, at: read.at, reason: 'its last run\'s session is in the middle of a turn' });
    beats.push({ name, at: read.at, session: read.session, state: 'held' });
    return true;
  };
  const considered = periodics.filter((periodic) => event === undefined || countsOf(periodic).some(([kind]) => kind === event));
  // Every record first, so each measure's list is read once, from the
  // oldest last fire among the periodics that count it.
  /** @type {Array<{ read: PeriodicRecord | null } | { error: unknown }>} */
  const records = [];
  for (const { name } of considered) {
    try {
      records.push({ read: await state.periodic(repo, name) });
    } catch (error) {
      records.push({ error });
    }
  }
  /** @param {Count} kind */
  // On an event's turn, a measure other than the event's is read only by
  // the periodics the event brings due, so only they set where its list starts.
  const oldest = async (/** @type {Count} */ kind) => {
    /** @type {string | undefined} */
    let from;
    for (const [i, periodic] of considered.entries()) {
      const record = records[i];
      const read = record !== undefined && 'read' in record ? record.read : null;
      const counts = countsOf(periodic);
      if (read === null || inGap(periodic, read, now) || !counts.some(([k]) => k === kind)) continue;
      if (event !== undefined && kind !== event) {
        const n = counts.find(([k]) => k === event)?.[1] ?? Infinity;
        const reached = await counted(periodic, event, read.at).then((rows) => rows.length >= n, () => false);
        if (!reached) continue;
      }
      if (from === undefined || Date.parse(read.at) < Date.parse(from)) from = read.at;
    }
    return from;
  };
  /** @type {Window} */
  const shared = sharedWindow(window, oldest);
  /**
   * What one of a periodic's counts counts: the shared list's rows after
   * its last fire, narrowed by that count's filters.
   *
   * @param {import('./repo-config.mjs').Periodic} periodic
   * @param {Count} kind
   * @param {string} since
   */
  const counted = async (periodic, kind, since) => {
    const rows = await shared(kind, since);
    const filters = filtersOn(periodic, kind);
    return Object.keys(filters).length === 0 ? rows : narrow(kind, rows, filters);
  };
  for (const [i, periodic] of considered.entries()) {
    const { name } = periodic;
    const time = timeLimitOf(periodic);
    const counts = countsOf(periodic);
    const record = /** @type {{ read: PeriodicRecord | null } | { error: unknown }} */ (records[i]);
    if ('error' in record) {
      refuse(name, record.error, 'its record could not be read, so it is refused this turn');
      continue;
    }
    const { read } = record;
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
    // A baseline's line, again on each sweep until the first fire: the turn
    // that wrote the baseline may have failed to write the line. The block
    // takes it only where the periodic has none, and a fire later in the turn
    // replaces it.
    if (event === undefined && read.baseline) beats.push({ name, at: read.at, session: null, state: 'not fired' });
    if (inGap(periodic, read, now)) {
      log('dispatch-periodic', { repo, periodic: name, outcome: 'inside its gap', at: read.at, gapHours: periodic.gapHours });
      continue;
    }
    const at = Date.parse(read.at);
    const dayDue = time !== null && event === undefined && now - at >= time.ms - SWEEP_GRACE_MS;
    if (counts.length === 0) {
      if (time === null) throw new Error(`periodic ${name} names no limit: the schema refuses a when with none`);
      if (dayDue && !(await held(name, read))) due.push({ periodic, read, due: at + time.ms, by: time.by });
      continue;
    }
    /** @type {Windows} */
    const windows = {};
    let reached = false;
    /** @type {[Count, number] | undefined} */
    let by;
    try {
      for (const [kind] of counts.filter(([kind]) => event === undefined || kind === event)) windows[kind] = await counted(periodic, kind, read.at);
      reached = counts.some(([kind, n]) => (windows[kind]?.length ?? 0) >= n);
      by = counts.find(([kind, n]) => (windows[kind]?.length ?? 0) >= n);
      if (!reached && !dayDue) continue;
      for (const [kind] of counts) windows[kind] ??= await counted(periodic, kind, read.at);
    } catch (error) {
      refuse(name, error, 'what it counts could not be read, so it is refused this turn');
      continue;
    }
    if (await held(name, read)) continue;
    // Reached by a count, or else by the day limit, even on empty windows:
    // the lines under the prompt then say none.
    const limit = time === null ? now : at + time.ms;
    const brought = by === undefined ? /** @type {{ by: import('./heartbeat.mjs').Limit }} */ (time).by : { count: by[0], number: by[1] };
    due.push({ periodic, read, due: reached ? Math.min(limit, now) : limit, by: brought, windows, asOf: new Date(now).toISOString() });
  }
  return { due, unread, beats };
};

/** @type {Busy} */
const noBusy = async (session) => {
  throw new Error(`no reader for ${session} was given`);
};

/** @type {Window} */
const noWindow = async (kind) => {
  throw new Error(`no reader for ${kind} was given`);
};

/**
 * A periodic's connectors as its launch carries them: none where it names none.
 *
 * @param {{ connectors?: string[] }} periodic
 * @returns {{ connectors?: string[] }}
 */
export const connectorsOf = (periodic) => (periodic.connectors === undefined ? {} : { connectors: periodic.connectors });

/**
 * Log the `dispatch-periodic` `not started` line for a repo's due periodics
 * a fire leaves unstarted, the one that came due first listed first, as
 * they would have launched. Their records stay, so each stays due. The
 * event path and the bare fire both log through it.
 *
 * @param {(event: string, context?: Record<string, unknown>) => void} log
 * @param {string} repo
 * @param {Due[]} due
 * @param {string} reason
 */
export const logNotStarted = (log, repo, due, reason) => {
  log('dispatch-periodic', { repo, periodics: [...due].sort((a, b) => a.due - b.due).map((d) => d.periodic.name), outcome: 'not started', reason });
};

/**
 * Move a periodic's record to a launch that started, or may have, over the
 * record the turn read. A record that moved since the read is left and
 * logged; a write that failed is returned, since the next fire may start
 * the periodic again, and the turn fails on it.
 *
 * @param {{ state: Pick<PeriodicState, 'recordPeriodic'>, log: (event: string, context?: Record<string, unknown>) => void }} deps
 * @param {string} repo
 * @param {{ name: string, read: PeriodicRecord }} periodic
 * @param {string} at
 * @param {string | null} sessionUrl
 * @returns {Promise<{ repo: string, error: string } | null>}
 */
export const recordFire = async ({ state, log }, repo, { name, read }, at, sessionUrl) => {
  try {
    if (await state.recordPeriodic(repo, name, read, { at, session: sessionUrl, baseline: false })) {
      log('dispatch-periodic', { repo, periodic: name, outcome: 'recorded', at, sessionUrl });
    } else {
      log('dispatch-periodic-unrecorded', { level: 'error', repo, periodic: name, sessionUrl, reason: `its record moved since this turn read it (last fire ${read.at}): another turn fired it too` });
    }
    return null;
  } catch (error) {
    log('dispatch-periodic-unrecorded', { level: 'error', repo, periodic: name, sessionUrl, error: messageOf(error), reason: 'its record could not be written, so the next fire may start it again' });
    return { repo, error: `periodic ${name}: its record could not be written: ${messageOf(error)}` };
  }
};

/**
 * A due periodic as the launch plan starts it (`launchPlan`,
 * dispatch/launch-plan.mjs): the one way the sweep (dispatch/sweep.mjs)
 * and the periodics fire (dispatch/periodics-fire.mjs) turn a due periodic
 * into a launch. Its prompt carries governor's lines, it runs on its own
 * model and effort, then the file's, and it names its connectors, so one
 * that names any starts as a routine run. A failed launch holds the repo:
 * its later periodics wait for the next fire. Its record moves to the fire
 * only for a launch that started or may have, and only over the record the
 * turn read; a write that failed goes into `unread`, which fails the turn.
 * A launch that moved the record adds the periodic's heartbeat line to
 * `beats`.
 *
 * @param {{
 *   config: import('./repo-config.mjs').RepoConfig,
 *   state: Pick<PeriodicState, 'recordPeriodic'>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   beats: import('./turn.mjs').RepoBeat[],
 *   unread: Array<{ repo: string, error: string }>,
 * }} deps
 * @param {string} repo
 * @param {Due} due
 * @returns {import('./turn.mjs').PlannedLaunch}
 */
export const periodicLaunch = ({ config, state, log, beats, unread }, repo, { periodic, read, by, windows, asOf }) => ({
  repo,
  issue: null,
  claim: false,
  holdsRepo: true,
  periodic: periodic.name,
  asked: { prompt: periodicPrompt(periodic.prompt, read, windows, periodic.filters), sessionName: periodic.name, ...runOf(config, 'periodics', periodic), ...connectorsOf(periodic) },
  started: async ({ outcome, sessionUrl }, firedAt) => {
    if (outcome === 'failed') return;
    const at = asOf ?? firedAt;
    const unrecorded = await recordFire({ state, log }, repo, { name: periodic.name, read }, at, sessionUrl);
    if (unrecorded !== null) unread.push(unrecorded);
    beats.push({ repo, beat: { periodics: [{ name: periodic.name, at, by, session: sessionUrl, state: 'open' }] } });
  },
});
