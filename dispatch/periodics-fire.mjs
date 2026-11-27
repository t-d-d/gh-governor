/**
 * A periodics fire: an event a periodic counts, a merge into the default
 * branch, an issue opened or an issue closed, in the fire's repo
 * (dispatch/webhook/fire.mjs). Its planner reads the repo's periodics that
 * count that event, each only against that count (`duePeriodics`,
 * dispatch/periodics.mjs), and hands `launchPlan` (dispatch/launch-plan.mjs)
 * the due ones, oldest due first, each turned into a launch as the sweep
 * turns its own (`periodicLaunch`). So a periodic an event brings due
 * starts inside the launch plan's window, under its launch budget and its
 * handling of a failed launch, as a ticket's session does.
 */

import { messageOf } from '../scripts/lib/error-message.mjs';
import { duePeriodics, logNotStarted, narrowOf, periodicLaunch, windowOf } from './periodics.mjs';
import { CAP_ZERO_REASON } from './launch-plan.mjs';
import { fireRepoOf } from './repos.mjs';
import { autoOf } from './trust.mjs';

/**
 * Why a due periodic the plan left unstarted waits: the launch window ran
 * out, or an earlier launch in the repo started nothing.
 */
export const LEFT_REASON = 'the launch window ran out, or an earlier launch in the repo started nothing: each stays due for the next event or sweep';

/**
 * A periodics fire's plan. A periodic that does not count the fire's event
 * is not read. A read that fails refuses the periodic it was for, through
 * the plan's `unread`, which fails the turn, and is never taken for an
 * empty window or a missing record; a repo whose reader cannot be built
 * refuses them all the same way, and the turn's sign-off sweep still runs.
 * A periodic does not count against `DispatchCap`, but a cap of 0 starts
 * none: they are logged `not started` and their records stay. One the
 * launch window or a failed launch left is logged `not started` too, and
 * stays due.
 *
 * @param {import('./webhook/fire.mjs').PeriodicsFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planPeriodics = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const config = ctx.configOf(repo);
  /** @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  /** @type {Awaited<ReturnType<typeof duePeriodics>>} */
  let read;
  try {
    const reader = await ctx.readerFor(repo);
    const window = windowOf(reader, invocation.base, autoOf(config));
    read = await duePeriodics({ repo, periodics: config.periodics ?? [], state: ctx.state, now: ctx.now(), log: ctx.log, window, narrow: narrowOf(reader), busy: ctx.busy, event: invocation.counted });
  } catch (error) {
    ctx.log('dispatch-periodic-unread', { level: 'error', repo, counted: invocation.counted, error: messageOf(error), reason: 'the periodics could not be checked: they wait for the next event or sweep' });
    return { launches: [], unread: [{ repo, error: `periodics: ${messageOf(error)}` }] };
  }
  unread.push(...read.unread);
  if (read.beats.length > 0) ctx.beats.push({ repo, beat: { periodics: read.beats } });
  if (read.due.length === 0) return { launches: [], unread };
  if (ctx.cap === 0) {
    logNotStarted(ctx.log, repo, read.due, CAP_ZERO_REASON);
    return { launches: [], unread };
  }
  const ordered = [...read.due].sort((a, b) => a.due - b.due);
  const deps = { config, state: ctx.state, log: ctx.log, beats: ctx.beats, unread };
  const launches = ordered.map((due) => ({ due, launch: periodicLaunch(deps, repo, due) }));
  return {
    launches: launches.map((l) => l.launch),
    unread,
    done: async ({ left }) => {
      const unstarted = launches.filter((l) => left.includes(l.launch)).map((l) => l.due);
      if (unstarted.length > 0) logNotStarted(ctx.log, repo, unstarted, LEFT_REASON);
    },
  };
};
