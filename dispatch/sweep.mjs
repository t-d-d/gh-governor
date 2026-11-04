/**
 * The schedule fire's plan: the bare EventBridge fire's sweep, or a fire
 * for a label that picks up at once (dispatch/turn.mjs runs the close that
 * queues unblocked fires, which starts nothing).
 *
 * The bare fire reads each repo's ended waits first (dispatch/waits.mjs),
 * since a ticket linked to the wait ticket loses the link there. It then
 * sweeps each served repo turning pickup on whose interval has passed since
 * its last sweep (dispatch/pickup.mjs), and reads each repo's due periodics
 * (dispatch/periodics.mjs). The periodics launch first, oldest due first,
 * then the ready tickets, then the ended waits' spec sessions. An ended
 * wait whose ticket names its owner asks that session in the spec
 * session's place, with the spec session as the fallback. Once every
 * launch has run, the plan's `done` records each repo's sweep and writes
 * pickup's heartbeat line.
 */

import { DEFAULT_MODEL, sessionName as ticketSessionName } from '../scripts/lib/dispatch-prompt.mjs';
import { planSchedule, strangerReason } from '../scripts/lib/dispatch-router.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { WAIT_RELATIVE, endedWaits, repairRelative, reportUnreadable, waitLinks, waitOwnerMessage, waitSpecPrompt } from './waits.mjs';
import { GITHUB_SOURCE } from './deliveries.mjs';
import { ownerOutcome } from './unblocked.mjs';
import { connectorsOf, duePeriodics, logNotStarted, periodicPrompt, recordFire, windowOf } from './periodics.mjs';
import { CAP_ZERO_REASON } from './launch-plan.mjs';
import { dispatchMarker } from './webhook/fire.mjs';
import { CONFIG_PATH, turnsOn } from './repo-config.mjs';
import { stampLastRun, writeHeartbeatIssue } from './heartbeat.mjs';
import { byOf, sweepDue, sweepHoursOf } from './pickup.mjs';
import { reportUncounted } from './uncounted.mjs';

/** A fallback outcome that started the spec session, or handed the message on. */
const WENT = new Set(['dispatched', 'unconfirmed', 'forwarded']);

/** A fallback outcome that was a launch. */
const LAUNCHED = new Set(['dispatched', 'unconfirmed', 'failed']);

/**
 * An ended wait's spec work, as a planned launch: its spec session, or,
 * where its ticket's body names its owner, a message asking that session to
 * rewrite its own spec, with the spec session as the fallback where
 * `withFallback`. The message runs in the launch loop, so the launch window
 * and a repo skip hold it as they hold a launch (dispatch/launch-plan.mjs).
 *
 * The item goes once the spec session started, the owner took the message,
 * or the message was forwarded. An owner that took it gets a dispatch marker
 * naming it, as a spec session's launch leaves one, so the claimed row finds
 * the session that builds and the sweep stays off the ticket. A send that
 * failed, not refused, keeps the item and fails the turn through `unread`;
 * a refusal with no fallback, or a fallback that started nothing, keeps
 * the item for the next fire.
 *
 * @param {import('./turn.mjs').TurnContext} ctx
 * @param {{ repo: string, config: import('./repo-config.mjs').RepoConfig, wait: import('./waits.mjs').WaitSpec, withFallback: boolean, unread: Array<{ repo: string, error: string }> }} args
 * @returns {import('./turn.mjs').PlannedLaunch}
 */
const waitLaunch = (ctx, { repo, config, wait, withFallback, unread }) => {
  const { issue, title, until, read, owner } = wait;
  const asked = { prompt: waitSpecPrompt({ issue, title, until, labels: config.labels, prompts: config.prompts }), sessionName: ticketSessionName(issue, title), model: DEFAULT_MODEL };
  /** Delete the item over the date the turn read. @param {Record<string, unknown>} context */
  const drop = async (context) => {
    const dropped = await ctx.state.dropWait(repo, issue, read);
    ctx.log('dispatch-wait', { repo, issue, read, ...context, item: dropped ? 'dropped' : 'not dropped: it changed since it was read' });
  };
  if (owner === null) {
    return {
      repo,
      issue,
      claim: false,
      holdsRepo: true,
      asked,
      // An ended wait's item goes once its spec session started or may
      // have: a failed launch leaves it, so the next fire tries again.
      started: async ({ outcome }) => {
        if (outcome === 'failed') return;
        try {
          await drop({ outcome: 'spec session started' });
        } catch (error) {
          ctx.log('dispatch-wait-unhandled', { level: 'error', repo, issue, read, error: messageOf(error), reason: 'its spec session started and its item stays: the next fire finds the session\'s dispatch marker and deletes it' });
          unread.push({ repo, error: `wait #${issue}: ${messageOf(error)}` });
        }
      },
    };
  }
  return {
    repo,
    issue,
    claim: false,
    holdsRepo: true,
    asked,
    ask: async () => {
      /** @type {import('./deliveries.mjs').Delivery | null} */
      let told = null;
      try {
        const fallback = withFallback ? { prompt: asked.prompt, sessionName: asked.sessionName, issue } : undefined;
        told = await ctx.delivery(repo).deliver({ session: owner }, waitOwnerMessage({ issue, until, labels: config.labels, prompts: config.prompts }), { source: GITHUB_SOURCE, on: [issue], fallback });
        const outcome = ownerOutcome(told, 'the spec session is past DispatchCap: left for the next fire');
        if (told.ok) await (await ctx.readerFor(repo)).comment(issue, dispatchMarker({ at: new Date(ctx.now()).toISOString(), sessionUrl: owner }));
        if (told.ok || (told.fallback !== null && WENT.has(told.fallback.outcome))) {
          await drop({ owner, outcome });
        } else {
          ctx.log('dispatch-wait', { repo, issue, read, owner, outcome, item: 'kept for the next fire' });
          if (!told.refused) unread.push({ repo, error: `wait #${issue}: ${outcome}${told.error === null ? '' : `: ${told.error}`}` });
        }
      } catch (error) {
        ctx.log('dispatch-wait-unhandled', { level: 'error', repo, issue, read, owner, error: messageOf(error), reason: 'its owner could not be asked, marked or its item deleted, so the next fire tries again' });
        unread.push({ repo, error: `wait #${issue}: ${messageOf(error)}` });
      }
      const fell = told?.fallback ?? null;
      return fell !== null && LAUNCHED.has(fell.outcome) ? { outcome: /** @type {import('./deliveries.mjs').LaunchOutcome} */ (fell.outcome), sessionUrl: fell.sessionUrl } : null;
    },
  };
};

/**
 * A schedule fire's plan. The bare fire's due periodics go ahead of the
 * tickets, oldest due first: they do not count against the cap, but a cap
 * of 0 starts nothing. Each periodic's `started` moves its record and adds
 * its heartbeat line, for a launch that started or may have. The ended
 * waits' spec sessions go after the tickets, unclaimed, at most DispatchCap
 * of them, and each one's `started` deletes its item once its session
 * started or may have.
 *
 * `done` records each repo's sweep and writes pickup's heartbeat line. The
 * plan's `result` carries `heartbeat`, true once `done` stamped a
 * `last-run:` line in some repo. Its `unread` is complete once `done` has
 * run: the backlogs, the sweeps, the periodics and the waits, in that order.
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
  /** The ended waits the bare fire could not read or act on, and the items it could not delete after a spec session started. @type {Array<{ repo: string, error: string }>} */
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
  /** The bare fire's ended waits, by repo, read before its sweep. @type {Array<{ repo: string, config: import('./repo-config.mjs').RepoConfig, ended: Awaited<ReturnType<typeof endedWaits>> }>} */
  const endedByRepo = [];
  // Each repo turning waits on: the waits whose date has passed
  // (dispatch/waits.mjs), read before the sweep, since a ticket linked to
  // the repo's wait ticket loses the link here, and pickup holds a ticket
  // while its dependency summary counts an open blocker. The comments go
  // now; the spec sessions join the plan after the tickets, below.
  if (ctx.bare) {
    for (const { repo, config } of ctx.served) {
      if (!turnsOn(config, 'waits')) continue;
      const reader = await ctx.readerFor(repo);
      const links = waitLinks({ reader, repo, board: config.waits?.issue, log: ctx.log });
      const ended = await endedWaits({ reader, state: ctx.state, repo, labels: config.labels, spec: turnsOn(config, 'unblocked'), now: ctx.now(), log: ctx.log, ...(links === undefined ? {} : { links, blocking: reader.blocking }) });
      waitsUnread.push(...ended.unread);
      endedByRepo.push({ repo, config, ended });
    }
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
    }
    sources.push({ repo, reader: await ctx.readerFor(repo), labels: config.labels, by: byOf(config), prompts: config.prompts });
  }
  // A fire naming its issue plans it alone, through the selection's own
  // checks, from a read of that issue rather than the ready list; the sweep
  // plans the ready list.
  const only = invocation.issue === undefined ? undefined : [invocation.issue];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Seen[]} */
  const seen = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Unreadable[]} */
  const unreadable = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Relative[]} */
  const relative = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Outsider[]} */
  const outsiders = [];
  /** @type {import('../scripts/lib/dispatch-router.mjs').Stranger[]} */
  const strangers = [];
  // In the bare fire one repo's refusal leaves the others to go; a fire
  // naming its repo throws on its own.
  const planned = await planSchedule({
    sources,
    cap: ctx.cap,
    now: ctx.now(),
    unreadable,
    outsiders,
    strangers,
    ...(only === undefined ? {} : { only, seen }),
    ...(ctx.bare ? { unread, cut, relative } : {}),
  });
  // A `Blocked until:` line governor cannot read holds its ticket, and is
  // said once on the ticket whatever the repo's switches say. Each report
  // catches its own failure, so they run side by side and keep the launch
  // window for the launches.
  await Promise.all(unreadable.map(async ({ repo, issue, value }) => reportUnreadable({ reader: await ctx.readerFor(repo), repo, issue, value, log: ctx.log })));
  // A relative line on a ready ticket, in a repo pickup sweeps: the sweep
  // leaves it to an open blocker's close, or settles it, whatever the
  // repo's other switches say, or says once that it cannot. A failure is
  // logged and left for the next sweep: the ticket stays held.
  await Promise.all(relative.map(async (report) => {
    const { repo, issue, after } = report;
    try {
      await repairRelative({ ...report, reader: await ctx.readerFor(repo), link: false, prompts: ctx.configOf(repo).prompts, now: ctx.now(), log: ctx.log });
    } catch (error) {
      ctx.log(WAIT_RELATIVE, { level: 'error', repo, issue, after, error: messageOf(error), reason: 'the ticket stays held, and the next sweep tries again' });
    }
  }));
  // A ticket whose author the repo's `pickup.by` does not list is not
  // started, and is said at info: it is the repo's own choice.
  for (const stranger of strangers) {
    ctx.log('dispatch-pickup', { level: 'info', repo: stranger.repo, issue: stranger.issue, outcome: 'skipped', reason: strangerReason(stranger) });
  }
  // Ready labels no person with a say added start nothing, and are said at
  // warn, never error: anyone can open an issue, so it must not page
  // anyone. Each ticket gets one comment, whatever the switches say, since
  // it reports a fault. Each report catches its own failure.
  await Promise.all(outsiders.map(async (outsider) => reportUncounted({ reader: await ctx.readerFor(outsider.repo), outsider, log: ctx.log })));
  if (only !== undefined && planned.length === 0) {
    const why = ctx.cap === 0 ? { outcome: 'not started', reason: CAP_ZERO_REASON } : { outcome: 'not started: not ready, blocked, held by its Blocked until: line, or dispatched inside the window' };
    // A ticket skipped for its author, or for its ready labels, has its own line above.
    const said = new Set([...strangers, ...outsiders].map((t) => `${t.repo}#${t.issue}`));
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
      asked: { prompt, sessionName, model: DEFAULT_MODEL },
      // A failed launch leaves the repo's tickets for the next fire, so its
      // sweep is not recorded.
      started: async ({ outcome }) => {
        if (outcome === 'failed') leftOver.add(repo);
      },
    });
  }
  /** The tickets whose launch is an ended wait's spec session, `repo#issue`: none of pickup's. */
  const waitSpecs = new Set();
  // The bare fire's due periodics go ahead of the tickets, oldest due
  // first. They do not count against the cap, but a cap of 0 starts
  // nothing; they share the launch window, and one left unlaunched has
  // no new record, so it stays due for the next fire.
  if (ctx.bare) {
    /** @type {Array<import('./periodics.mjs').Due & { repo: string }>} */
    const due = [];
    // One open check for every served repo, so an expired login is refreshed once a turn.
    for (const { repo, config } of ctx.served) {
      if (!turnsOn(config, 'periodics')) continue;
      const read = await duePeriodics({ repo, periodics: config.periodics, state: ctx.state, now: ctx.now(), log: ctx.log, window: windowOf(await ctx.readerFor(repo)), open: ctx.open });
      due.push(...read.due.map((d) => ({ ...d, repo })));
      // A cap of 0 starts no periodic. The repo's due periodics get the
      // line an event logs under the cap, and their records stay, so each
      // stays due.
      if (ctx.cap === 0 && read.due.length > 0) logNotStarted(ctx.log, repo, read.due, CAP_ZERO_REASON);
      periodicsUnread.push(...read.unread);
      if (read.beats.length > 0) ctx.beats.push({ repo, beat: { periodics: read.beats } });
    }
    if (ctx.cap > 0) {
      launches.unshift(...due.sort((a, b) => a.due - b.due).map(({ repo, periodic, read, by, windows, asOf }) => ({
        repo,
        issue: null,
        claim: false,
        holdsRepo: true,
        periodic: periodic.name,
        asked: { prompt: periodicPrompt(periodic.prompt, read, windows), sessionName: periodic.name, model: DEFAULT_MODEL, ...connectorsOf(periodic) },
        // A periodic's record moves to this fire only for a launch that
        // started or may have, and only over the record the turn read. A
        // failed launch writes nothing, so the periodic stays due.
        /** @type {NonNullable<import('./turn.mjs').PlannedLaunch['started']>} */
        started: async ({ outcome, sessionUrl }, firedAt) => {
          if (outcome === 'failed') return;
          const at = asOf ?? firedAt;
          const unrecorded = await recordFire(ctx, repo, { name: periodic.name, read }, at, sessionUrl);
          // The turn fails, so the alarm says a periodic may start twice.
          if (unrecorded !== null) periodicsUnread.push(unrecorded);
          ctx.beats.push({ repo, beat: { periodics: [{ name: periodic.name, at, by, session: sessionUrl, state: 'open' }] } });
        },
      })));
    }
    // The waits read before the sweep, above. A ticket not ready got its
    // comment there, and, with unblocked on, gets a spec session here,
    // after the tickets, unclaimed, as a
    // blocker's close starts one. At most DispatchCap of them start a fire,
    // apart from pickup's; one past it keeps its item for the next fire.
    // A ticket whose body names its owner asks that session to rewrite
    // its own spec, with the spec session as the fallback should it refuse
    // as archived. That fallback counts against DispatchCap as the launch
    // it replaces does: past the cap the owner is still asked, and a
    // refusal leaves the item for the next fire.
    let room = ctx.cap;
    for (const { repo, config, ended } of endedByRepo) {
      /** @type {number[]} */
      const left = [];
      for (const wait of ended.specs) {
        const withFallback = room > 0;
        if (!withFallback && wait.owner === null) {
          left.push(wait.issue);
          continue;
        }
        if (withFallback) room -= 1;
        waitSpecs.add(`${repo}#${wait.issue}`);
        launches.push(waitLaunch(ctx, { repo, config, wait, withFallback, unread: waitsUnread }));
      }
      if (left.length > 0) ctx.log('dispatch-wait', { repo, outcome: 'spec sessions past DispatchCap left for the next fire', left });
    }
  }

  /** The turn's own fields: whether a `last-run:` line was stamped. */
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
      /** A repo's own launches by pickup: its periodics and tickets, an ended wait's spec sessions left out. @param {string} repo */
      const pickupOwn = (repo) => dispatched.filter((d) => d.repo === repo && !waitSpecs.has(`${d.repo}#${d.issue}`));

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
      // the heartbeat as the schedule's. It is written in each repo whose file
      // turns it on, into the issue the file names, judged on that
      // repo's own claims and launches (another repo's launch going through
      // says nothing of this one's), and only where that issue's body already
      // carries the marker: a wrong number refuses
      // the write rather than overwrite someone's ticket, and the repo's
      // watchdog then reports the lapse.
      // A file in the `{ issue }` shape gets pickup's line in governor's own
      // block instead, beside the turn's periodic lines, which `run` writes.
      // One repo's read or write that fails leaves the rest to go, then fails
      // the turn.
      /** @type {string[]} */
      const unwritten = [];
      if (ctx.bare) {
        for (const { repo, config } of ctx.served) {
          if (!turnsOn(config, 'heartbeat') || config.heartbeat === undefined || unread.some((u) => u.repo === repo)) continue;
          const own = pickupOwn(repo);
          if (own.length > 0 && own.every((d) => d.outcome === 'failed')) continue;
          const { issue, marker } = config.heartbeat;
          // The `{ issue }` shape: pickup's line, for a repo whose file turns
          // pickup on, written with the turn's other lines by `run`.
          if (marker === undefined) {
            if (swept.has(repo)) ctx.beats.push({ repo, beat: { pickup: { at: new Date(ctx.now()).toISOString(), started: startedOf(own) } } });
            continue;
          }
          const outcome = await writeHeartbeatIssue({
            reader: () => ctx.readerFor(repo),
            repo,
            issue,
            marker,
            refusal: 'the issue\'s body has no marker, so the heartbeat is not written: fix the issue number or marker in the repo\'s .github/dispatch.json, or add the marker to the issue',
            stamp: (body) => stampLastRun(body, marker, ctx.now()),
            log: ctx.log,
          });
          if (typeof outcome === 'object') unwritten.push(outcome.unwritten);
          if (outcome !== 'written') continue;
          ctx.log('dispatch-heartbeat', { repo, issue });
          result.heartbeat = true;
        }
      }
      failed.push(...unread, ...sweepsUnread, ...periodicsUnread, ...waitsUnread);
      if (unwritten.length !== 0) throw new Error(`heartbeat not written: ${unwritten.join('; ')}`);
    },
  };
};
