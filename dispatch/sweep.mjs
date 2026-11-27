/**
 * The schedule fire's plan: the bare EventBridge fire's sweep, or a fire
 * for a label that picks up at once (dispatch/turn.mjs runs the close that
 * queues unblocked fires, which starts nothing).
 *
 * The bare fire first takes each repo's wait label off the tickets whose
 * `Blocked until:` date has passed (dispatch/waits.mjs), so its sweep sees
 * them freed. It then sweeps each served repo turning pickup on whose
 * interval has passed since its last sweep (dispatch/pickup.mjs), and reads
 * each repo's due periodics (dispatch/periodics.mjs). The periodics launch
 * first, oldest due first, then the ready tickets. Once every launch has
 * run, the plan's `done` records each repo's sweep and writes
 * pickup's heartbeat line.
 */

import { planSchedule, strangerReason } from '../scripts/lib/dispatch-router.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { clearWaitLabels, reportUnreadable } from './waits.mjs';
import { GITHUB_SOURCE } from './deliveries.mjs';
import { duePeriodics, logNotStarted, periodicLaunch, windowOf } from './periodics.mjs';
import { CAP_ZERO_REASON } from './launch-plan.mjs';
import { CONFIG_PATH, runOf, turnsOn } from './repo-config.mjs';
import { byOf, failedLaunchesOf, failedReason, sweepDue, sweepHoursOf } from './pickup.mjs';
import { autoOf, startOf } from './trust.mjs';
import { tellerFor } from './told.mjs';
import { STOPPED_EVENT, releaseStopped } from './stopped.mjs';
import { reportUncounted, reportUnlooked, reportUnstarted, reportUntasked } from './uncounted.mjs';

/**
 * A schedule fire's plan. The bare fire's due periodics go ahead of the
 * tickets, oldest due first: they do not count against the cap, but a cap
 * of 0 starts nothing. Each periodic's `started` moves its record and adds
 * its heartbeat line, for a launch that started or may have.
 *
 * `done` records each repo's sweep and adds pickup's heartbeat line, which
 * the turn writes. The plan's `result` carries `heartbeat`, false until the
 * turn has written a pickup line. Its `unread` is complete once `done` has
 * run: the backlogs, the sweeps, the periodics and the wait labels, in that order.
 *
 * @param {import('./webhook/fire.mjs').Fire & { kind: 'schedule' }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planSweep = async (invocation, ctx) => {
  /** @type {import('./turn.mjs').PlannedLaunch[]} */
  const launches = [];
  /** The served repos whose backlog the bare fire could not read. @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  /** The periodics whose record the bare fire could not read, baseline, or write after a launch. @type {Array<{ repo: string, error: string }>} */
  const periodicsUnread = [];
  /** The wait labels the bare fire could not list or take off. @type {Array<{ repo: string, error: string }>} */
  const waitsUnread = [];
  /** The served repos whose last sweep the bare fire could not read, or whose sweep it could not record. @type {Array<{ repo: string, error: string }>} */
  const sweepsUnread = [];
  /** The repos the bare fire sweeps, each with the time the turn read their last sweep, which it records. @type {Map<string, string>} */
  const swept = new Map();
  /** The repos the bare fire sweeps with a ready ticket the cap cut: like a repo in `leftOver`, its sweep is not recorded. @type {Set<string>} */
  const cut = new Set();
  /** The repos whose planned tickets a failed launch, the launch window or a skip left for the next fire. @type {Set<string>} */
  const leftOver = new Set();
  /** The served repos turning pickup on that the bare fire left out of this sweep: not due, or their last sweep unread. */
  let held = 0;
  // Each repo turning waits on whose file sets `waits.label`: the label
  // comes off each open ticket whose date has passed (dispatch/waits.mjs),
  // before the sweep, so a sweep in this fire sees the freed ticket. The
  // repos are read side by side; each catches its own failures.
  if (ctx.bare) {
    const byRepo = await Promise.all(ctx.served.map(async ({ repo, config }) => {
      const label = config.waits?.label;
      if (!turnsOn(config, 'waits') || label === undefined) return [];
      return (await clearWaitLabels({ reader: await ctx.readerFor(repo), repo, label, now: ctx.now(), log: ctx.log })).unread;
    }));
    waitsUnread.push(...byRepo.flat());
  }
  // Every served repo's ready tickets in one queue; a repo
  // whose file turns pickup off is still swept, and its backlog unread.
  /** @type {import('../scripts/lib/dispatch-router.mjs').Source[]} */
  const sources = [];
  for (const { repo, config } of ctx.served) {
    if (!turnsOn(config, 'pickup')) {
      ctx.log('dispatch-refused', { level: 'info', repo, kind: 'schedule', reason: `${repo}'s ${CONFIG_PATH} does not turn pickup on` });
      continue;
    }
    // The bare fire sweeps a repo once its interval has passed since its
    // last sweep; a fire for a label picks up at once.
    if (ctx.bare) {
      const now = ctx.now();
      const sweepHours = sweepHoursOf(config);
      /** @type {string | null} */
      let last;
      try {
        last = await ctx.state.sweep(repo);
      } catch (error) {
        ctx.log('dispatch-pickup-unread', { level: 'error', repo, error: messageOf(error), reason: 'its last sweep could not be read, so it is not swept this turn' });
        sweepsUnread.push({ repo, error: `pickup sweep: ${messageOf(error)}` });
        held += 1;
        continue;
      }
      if (!sweepDue(last, sweepHours, now)) {
        ctx.log('dispatch-pickup', { level: 'info', repo, outcome: 'not due', last, sweepHours });
        held += 1;
        continue;
      }
      swept.set(repo, new Date(now).toISOString());
      // A claimed ticket whose pickup session ended without a PR, archived
      // by hand or by an earlier sweep, loses its claim (dispatch/stopped.mjs).
      try {
        await releaseStopped({ repo, config, reader: await ctx.readerFor(repo), stopped: ctx.stopped(repo), log: ctx.log, tell: tellerFor(ctx, repo, GITHUB_SOURCE) });
      } catch (error) {
        ctx.log(STOPPED_EVENT, { level: 'error', repo, outcome: 'unread', error: messageOf(error), reason: 'its claimed tickets could not be read; the next sweep looks again' });
      }
    }
    // The tickets whose last launch started nothing inside the hour, held
    // however their ready labels came back. A read that fails refuses the
    // repo's pickup: in the bare fire the other repos go on, and a fire
    // naming its repo throws.
    /** @type {Map<number, string>} */
    let failed;
    try {
      failed = await failedLaunchesOf(ctx.state, repo, ctx.now());
    } catch (error) {
      if (!ctx.bare) throw error;
      ctx.log('dispatch-pickup-unread', { level: 'error', repo, error: messageOf(error), reason: 'its failed-launch records could not be read, so it is not swept this turn' });
      sweepsUnread.push({ repo, error: `pickup failed-launch records: ${messageOf(error)}` });
      swept.delete(repo);
      held += 1;
      continue;
    }
    sources.push({ repo, reader: await ctx.readerFor(repo), labels: config.labels, by: byOf(config), start: startOf(config), prompts: config.prompts, signOff: turnsOn(config, 'signOff'), deployMessages: turnsOn(config, 'deployMessages'), failed });
  }
  // A fire naming its issue plans it alone, through the selection's own
  // checks, from a read of that issue rather than the ready list; the sweep
  // plans the ready list.
  const only = invocation.issue === undefined ? undefined : [invocation.issue];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Seen[]} */
  const seen = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Unreadable[]} */
  const unreadable = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Outsider[]} */
  const outsiders = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Stranger[]} */
  const strangers = [];
  /** @type {import('./start.mjs').Unstarted[]} */
  const unstarted = [];
  /** @type {import('./start.mjs').Unlooked[]} */
  const unlooked = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').HeldFailed[]} */
  const heldFailed = [];
  // In the bare fire one repo's refusal leaves the others to go; a fire
  // naming its repo throws on its own.
  const planned = await planSchedule({
    sources,
    cap: ctx.cap,
    now: ctx.now(),
    unreadable,
    outsiders,
    strangers,
    unstarted,
    unlooked,
    heldFailed,
    ...(only === undefined ? {} : { only, seen }),
    ...(ctx.bare ? { unread, cut } : {}),
  });
  // A `Blocked until:` line governor cannot read holds its ticket, and is
  // said once on the ticket whatever the repo's switches say. Each report
  // catches its own failure, so they run side by side and keep the launch
  // window for the launches.
  // Its comment tells the ticket's spec owner, under pickup.
  await Promise.all(unreadable.map(async ({ repo, issue, value }) => reportUnreadable({ reader: await ctx.readerFor(repo), repo, issue, value, log: ctx.log, tell: tellerFor(ctx, repo, GITHUB_SOURCE) })));
  // A ticket whose author the repo's `trust.task` does not list is not
  // started, and is said at info: it is the repo's own choice. Where a
  // person readied it, it gets governor's one refusal comment, whatever the
  // switches say. Each report catches its own failure.
  for (const stranger of strangers) {
    ctx.log('dispatch-pickup', { level: 'info', repo: stranger.repo, issue: stranger.issue, outcome: 'skipped', reason: strangerReason(stranger) });
  }
  await Promise.all(strangers.map(async (stranger) => reportUntasked({ reader: await ctx.readerFor(stranger.repo), stranger, what: 'readied', ready: ctx.configOf(stranger.repo).labels.ready, start: startOf(ctx.configOf(stranger.repo)), event: 'dispatch-pickup', log: ctx.log })));
  // Ready labels no person with a say added start nothing, and are said at
  // warn, never error: anyone can open an issue, so it must not page
  // anyone. Each ticket gets one comment, whatever the switches say, since
  // it reports a fault. Each report catches its own failure.
  await Promise.all(outsiders.map(async (outsider) => reportUncounted({ reader: await ctx.readerFor(outsider.repo), outsider, log: ctx.log })));
  // A ready label a person outside the repo's trust.start added last starts
  // nothing, said at info with the one refusal comment; an adder governor
  // could not look up counts for nothing this turn, said at warn.
  await Promise.all(unstarted.map(async (u) => reportUnstarted({ reader: await ctx.readerFor(u.repo), unstarted: u, what: 'readied', event: 'dispatch-pickup', log: ctx.log })));
  for (const u of unlooked) reportUnlooked({ unlooked: u, event: 'dispatch-pickup', log: ctx.log });
  // A ticket whose last launch started nothing waits out its hold.
  for (const { repo, issue, until } of heldFailed) ctx.log('dispatch-pickup', { level: 'info', repo, issue, outcome: 'skipped', reason: failedReason(until) });
  if (only !== undefined && planned.length === 0) {
    const why = ctx.cap === 0 ? { outcome: 'not started', reason: CAP_ZERO_REASON } : { outcome: 'not started: not ready, blocked, or held by its Blocked until: line' };
    // A ticket skipped for its author, its ready labels or its failed launch has its own line above.
    const said = new Set([...strangers, ...outsiders, ...unstarted, ...unlooked, ...heldFailed].map((t) => `${t.repo}#${t.issue}`));
    for (const { repo, issue, ...read } of seen) {
      if (said.has(`${repo}#${issue}`)) continue;
      ctx.log('dispatch-pickup', { level: 'info', repo, issue, ...why, reads: [read] });
    }
  }
  for (const { repo, error } of unread) ctx.log('dispatch-backlog-unread', { level: 'error', repo, error });
  // Only when no repo was left out of the sweep: one due repo failing
  // while the others were not due is that repo's fault, not the turn's.
  if (sources.length > 0 && held === 0 && new Set(unread.map((u) => u.repo)).size === sources.length) {
    throw new Error(`no served repo's backlog could be read: ${unread.map((u) => `${u.repo}: ${u.error}`).join('; ')}`);
  }
  for (const { repo, issue, prompt, sessionName } of planned) {
    launches.push({
      repo,
      issue: issue ?? null,
      claim: true,
      holdsRepo: true,
      asked: { prompt, sessionName, ...runOf(ctx.configOf(repo), 'pickup') },
      // A failed launch leaves the repo's tickets for the next fire, so its
      // sweep is not recorded.
      started: async ({ outcome }) => {
        if (outcome === 'failed') leftOver.add(repo);
      },
    });
  }
  // The bare fire's due periodics go ahead of the tickets, oldest due
  // first. They do not count against the cap, but a cap of 0 starts
  // nothing; they share the launch window, and one left unlaunched has
  // no new record, so it stays due for the next fire.
  if (ctx.bare) {
    /** @type {Array<import('./periodics.mjs').Due & { repo: string }>} */
    const due = [];
    // One check of a last run's turn for every served repo, so an expired login is refreshed once a turn.
    for (const { repo, config } of ctx.served) {
      if (!turnsOn(config, 'periodics')) continue;
      const read = await duePeriodics({ repo, periodics: config.periodics, state: ctx.state, now: ctx.now(), log: ctx.log, window: windowOf(await ctx.readerFor(repo), undefined, autoOf(config)), busy: ctx.busy });
      due.push(...read.due.map((d) => ({ ...d, repo })));
      // A cap of 0 starts no periodic. The repo's due periodics get the
      // line an event logs under the cap, and their records stay, so each
      // stays due.
      if (ctx.cap === 0 && read.due.length > 0) logNotStarted(ctx.log, repo, read.due, CAP_ZERO_REASON);
      periodicsUnread.push(...read.unread);
      if (read.beats.length > 0) ctx.beats.push({ repo, beat: { periodics: read.beats } });
    }
    if (ctx.cap > 0) {
      // A periodic's record moves to this fire only for a launch that
      // started or may have, and only over the record the turn read
      // (`periodicLaunch`). A failed launch writes nothing, so the periodic
      // stays due.
      launches.unshift(...due.sort((a, b) => a.due - b.due).map((d) => periodicLaunch({ config: ctx.configOf(d.repo), state: ctx.state, log: ctx.log, beats: ctx.beats, unread: periodicsUnread }, d.repo, d)));
    }
  }

  /** The turn's own fields: the turn sets `heartbeat` once it writes pickup's line. */
  const result = { heartbeat: false };
  /** What failed the turn, filled in by `done`. @type {Array<{ repo: string, error: string }>} */
  const failed = [];
  return {
    launches,
    unread: failed,
    result,
    done: async ({ dispatched, left }) => {
      for (const p of left) if (p.claim) leftOver.add(p.repo);
      /** How many ticket sessions a repo's own launches started. @param {import('./turn.mjs').Dispatched[]} own */
      const startedOf = (own) => own.filter((d) => d.issue !== null && d.outcome !== 'failed').length;
      /** A repo's own launches by pickup: its periodics and tickets. @param {string} repo */
      const pickupOwn = (repo) => dispatched.filter((d) => d.repo === repo);

      // A repo's sweep is recorded once its backlog was read and not every
      // claim or launch failed, as pickup's heartbeat line is: a sweep that
      // started nothing it planned is tried again at the next fire. A sweep
      // that left planned tickets to a failed launch, the launch window or a
      // skip is not recorded either, so the next fire picks them up, not the
      // next interval, and nor is one with a ready ticket the cap cut: the cap
      // limits load, and does not set how often a repo is swept.
      for (const [repo, at] of swept) {
        const own = pickupOwn(repo);
        if (unread.some((u) => u.repo === repo) || (own.length > 0 && own.every((d) => d.outcome === 'failed'))) {
          swept.delete(repo);
          continue;
        }
        if (leftOver.has(repo) || cut.has(repo)) {
          ctx.log('dispatch-pickup', { level: 'info', repo, outcome: 'swept, with tickets left for the next fire, so not recorded', at, started: startedOf(own) });
          continue;
        }
        try {
          const written = await ctx.state.recordSweep(repo, at);
          ctx.log('dispatch-pickup', { level: 'info', repo, outcome: written ? 'swept' : 'swept, and a later sweep was already recorded', at, started: startedOf(own) });
        } catch (error) {
          ctx.log('dispatch-pickup-unrecorded', { level: 'error', repo, error: messageOf(error), reason: 'its sweep could not be recorded, so the next fire sweeps it again' });
          sweepsUnread.push({ repo, error: `pickup sweep: ${messageOf(error)}` });
        }
      }

      // The heartbeat says the sweep ran, runs with nothing to dispatch or
      // nothing left to claim included, unless every claim or launch failed. A
      // fire naming its repo or its issue (one labelled, or one a close left
      // unblocked) is not the sweep: one per label or per merge would keep the
      // heartbeat fresh while the schedule was dead, and the watchdog reads
      // the heartbeat as the schedule's. Each repo whose file turns the
      // heartbeat on and whose backlog this fire swept gets pickup's line,
      // judged on that repo's own claims and launches (another repo's launch
      // going through says nothing of this one's): the loop above has
      // already taken out of `swept` a repo whose backlog was unread or whose
      // every claim or launch failed. `run` writes the line into governor's
      // block with the turn's periodic lines.
      if (ctx.bare) {
        for (const { repo, config } of ctx.served) {
          if (!turnsOn(config, 'heartbeat') || config.heartbeat === undefined || !swept.has(repo)) continue;
          ctx.beats.push({ repo, beat: { pickup: { at: new Date(ctx.now()).toISOString(), started: startedOf(pickupOwn(repo)) } } });
        }
      }
      failed.push(...unread, ...sweepsUnread, ...periodicsUnread, ...waitsUnread);
    },
  };
};
