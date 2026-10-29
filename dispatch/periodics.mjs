/**
 * Periodics: recurring sessions a repo lists in its config file
 * (dispatch/repo-config.mjs), each with a name, a prompt and a day limit.
 *
 * The bare schedule fire reads each periodic's record from the state table
 * ({@link duePeriodics}): the time of its last fire and the session it
 * started. One whose day limit has passed since, or will within the hour
 * ({@link SWEEP_GRACE_MS}), is due, and the turn
 * (dispatch/turn.mjs) starts a session on its prompt, ahead of the tickets,
 * with a line governor writes under it ({@link periodicPrompt}). The turn
 * writes the record only for a launch that started or may have, and only
 * over the record it read, so two turns never both record one fire. The
 * write comes after the launch: it is the one task at a time that keeps two
 * turns from both starting it.
 *
 * With no record, for a new periodic or a lost item, the turn writes now as
 * the baseline and starts nothing: the first run comes one day limit later,
 * and a lost record costs at most one late run, never a burst. A read that
 * fails refuses the periodic for the turn, and is never a missing record.
 */

/** A day, in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far short of its day limit a periodic may be read and still be due:
 * half the schedule's two-hour interval, so the sweep nearest the limit
 * fires it. The record holds the launch's time, minutes after the sweep
 * read it, so the sweep a day limit later reads it a little short. Without
 * this, every run would slip to the sweep after, and the slips add up.
 */
export const SWEEP_GRACE_MS = 60 * 60 * 1000;

/**
 * @typedef {{ at: string, session: string | null, baseline: boolean }} PeriodicRecord
 *   `at`: the last fire's time, or the baseline's. `session`: the session the
 *   fire started, null for an unconfirmed launch or the baseline.
 *   `baseline`: governor wrote it with no record to go on, and started nothing.
 * @typedef {{
 *   periodic: (repo: string, name: string) => Promise<PeriodicRecord | null>,
 *   recordPeriodic: (repo: string, name: string, read: PeriodicRecord | null, record: PeriodicRecord) => Promise<boolean>,
 * }} PeriodicState
 *   A periodic's record, read (null when there is none; a read that fails
 *   throws), and written over the record `read` (none, for null): false
 *   where another record stands.
 * @typedef {{ periodic: import('./repo-config.mjs').Periodic, read: PeriodicRecord, due: number }} Due
 */

/**
 * The line governor writes under a periodic's prompt: when it last fired, or
 * that this is the first run governor knows of. No repo can drop or reword it.
 *
 * @param {PeriodicRecord} read The record the turn read.
 */
export const lastFireLine = (read) => (read.baseline
  ? 'This is the first run of this periodic that governor has a record of.'
  : `This periodic last fired at ${read.at}.`);

/**
 * A due periodic's session prompt: its own, then governor's line.
 *
 * @param {string} prompt
 * @param {PeriodicRecord} read
 */
export const periodicPrompt = (prompt, read) => `${prompt}\n\n${lastFireLine(read)}`;

/**
 * A repo's due periodics, each with the record the turn read and when it
 * came due, and the ones whose record could not be read or baselined. A
 * periodic with no record gets now as its baseline, and is not due.
 *
 * @param {{
 *   repo: string,
 *   periodics: import('./repo-config.mjs').Periodic[],
 *   state: PeriodicState,
 *   now: number,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} args
 * @returns {Promise<{ due: Due[], unread: Array<{ repo: string, error: string }> }>}
 */
export const duePeriodics = async ({ repo, periodics, state, now, log }) => {
  /** @type {Due[]} */
  const due = [];
  /** @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  for (const periodic of periodics) {
    const { name, days } = periodic;
    /** @type {PeriodicRecord | null} */
    let read;
    try {
      read = await state.periodic(repo, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('dispatch-periodic-unread', { level: 'error', repo, periodic: name, error: message, reason: 'its record could not be read, so it is refused this turn' });
      unread.push({ repo, error: `periodic ${name}: ${message}` });
      continue;
    }
    if (read === null) {
      const at = new Date(now).toISOString();
      try {
        const written = await state.recordPeriodic(repo, name, null, { at, session: null, baseline: true });
        log('dispatch-periodic', { repo, periodic: name, outcome: written ? 'baseline' : 'baseline already written', at });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('dispatch-periodic-unrecorded', { level: 'error', repo, periodic: name, error: message, reason: 'its baseline could not be written' });
        unread.push({ repo, error: `periodic ${name}: ${message}` });
      }
      continue;
    }
    const at = Date.parse(read.at);
    if (now - at >= days * DAY_MS - SWEEP_GRACE_MS) due.push({ periodic, read, due: at + days * DAY_MS });
  }
  return { due, unread };
};
