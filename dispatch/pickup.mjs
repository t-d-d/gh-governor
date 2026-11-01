/**
 * Pickup's sweep: how often the bare schedule fire reads a served repo's
 * ready tickets. A ready label, and a close that leaves a ready ticket
 * unblocked (dispatch/unblocked.mjs), pick up at once, each on its own
 * fire; the sweep is what catches a ticket whose event was lost. A ready
 * label added to a ticket before the repo's next turn writes it to the
 * receiver's hook table waits for it too.
 *
 * A repo's config file may set the interval in whole hours (`pickup`,
 * dispatch/repo-config.mjs), two when unset. The bare fire sweeps a repo
 * once its interval has passed since that repo's last sweep
 * ({@link sweepDue}), and records the sweep in the state table under
 * `pickup#<repo>` (`dynamoState`, dispatch/turn.mjs). The clock's tick is the
 * stack's `ScheduleExpression`, which the file cannot see, so the turn
 * applies the floor: the first fire at or after the interval sweeps, and an
 * interval shorter than the tick sweeps at every fire. A missing record, for
 * a new repo or a lost item, means sweep now; a read that fails refuses the
 * repo's sweep for the turn.
 *
 * A sweep that leaves a ready ticket unstarted is not recorded, so the next
 * fire sweeps the repo again: a failed launch, the launch window, or the
 * stack's `DispatchCap` cutting it in favour of another repo's older tickets.
 * The cap limits load; it does not set how often a repo is swept.
 */

import { HOUR_MS } from './periodics.mjs';

/** The interval, in whole hours, for a file that sets none: the clock's own tick. */
export const SWEEP_HOURS = 2;

/**
 * How far short of its interval a repo's last sweep may be and the fire
 * still sweep it. The record holds the time its turn ran, which can lag its
 * fire by a turn's deadline when the fire waited behind another turn, so the
 * next fire on the clock can read the interval a little short. Without this,
 * such a repo would skip a whole tick.
 */
export const SWEEP_SLACK_MS = 30 * 60 * 1000;

/**
 * @typedef {{
 *   sweep: (repo: string) => Promise<string | null>,
 *   recordSweep: (repo: string, at: string) => Promise<boolean>,
 * }} PickupState
 *   A repo's last sweep's time: read (null when there is none; a read that
 *   fails throws), and written unless a later one stands (false then).
 */

/**
 * A repo's sweep interval, in whole hours.
 *
 * @param {{ pickup?: { sweepHours?: number } }} config
 */
export const sweepHoursOf = (config) => config.pickup?.sweepHours ?? SWEEP_HOURS;

/**
 * Whether a repo whose last sweep was at `last` (null for none) is due a
 * sweep at `now`, on an interval of `hours`.
 *
 * @param {string | null} last
 * @param {number} hours
 * @param {number} now
 */
export const sweepDue = (last, hours, now) => last === null || now - Date.parse(last) >= hours * HOUR_MS - SWEEP_SLACK_MS;
