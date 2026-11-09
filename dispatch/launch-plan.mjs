/**
 * The launches a planner planned, started in turn: `planSweep`
 * (dispatch/sweep.mjs), `planHook` (dispatch/hooks.mjs), `planUnblocked`
 * (dispatch/unblocked-fire.mjs) and `planDispatch` (dispatch/dispatch-fire.mjs)
 * each hand `turnFor` (dispatch/turn.mjs) a `Plan`, and `launchPlan` starts
 * it: the claims, the launch window, each launch through the launcher's
 * `start`, the record each launch moves, the markers and releases, the
 * plan's `done`, and the stranded-claim lines.
 */

import { authorPicked, mayPickUp, ticketStatus, unreadableOf } from '../scripts/lib/ready-work.mjs';
import { outsiderReason, strangerReason } from '../scripts/lib/dispatch-router.mjs';
import { byOf, PICKUP_FAILED_HOLD_MS, PICKUP_FAILED_UNRECORDED } from './pickup.mjs';
import { reportUncounted, reportUnlooked, reportUnstarted } from './uncounted.mjs';
import { judgeReady } from './start.mjs';
import { relayOf, startOf } from './trust.mjs';
import { tellBuilderChange, tellerFor } from './told.mjs';
import { rolesOf } from './roles.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { reportUnreadable } from './waits.mjs';
import { GITHUB_SOURCE, OUTPUT_TAIL, nameSpecSession } from './deliveries.mjs';
import { dispatchMarker } from './webhook/fire.mjs';
import { LAUNCH_FAILED_EVENT, sayLaunchFailed } from './launch-failed.mjs';

/**
 * @typedef {import('./launcher.mjs').LaunchResult} LaunchResult
 * @typedef {import('./turn.mjs').TurnContext} TurnContext
 * @typedef {TurnContext['log']} Log
 * @typedef {Exclude<import('./turn.mjs').Plan, { answer: unknown }>} LaunchablePlan
 * @typedef {import('./turn.mjs').PlannedLaunch} PlannedLaunch
 * @typedef {import('./turn.mjs').Dispatched} Dispatched
 */

/**
 * The event a claimed ticket with no session-naming marker logs, here and at
 * the deadline (dispatch/cli.mjs). Its own alarm pages on it
 * (infra/governor.cfn.yml).
 */
export const CLAIM_STRANDED = 'dispatch-claim-stranded';

/**
 * Why a fire under a `DispatchCap` of 0 starts nothing: the reason every
 * fire's `not started` line gives, for a ticket, a blocker's close or a
 * due periodic.
 */
export const CAP_ZERO_REASON = 'DispatchCap is 0: no fire starts anything';

/**
 * The event a repo whose launch started nothing logs: the fire skips the
 * rest of its tickets. Its own alarm pages on it (infra/governor.cfn.yml).
 */
export const REPO_SKIPPED = 'dispatch-repo-skipped';

/**
 * The event a periodic logs when it names a connector the account has not
 * connected: it starts nothing (infra/governor.cfn.yml pages on it).
 */
export const CONNECTOR_MISSING = 'dispatch-connector-missing';

/**
 * The event a periodic logs when the routines API refused its routine
 * before the fire: it starts nothing, and the repo's other launches go on,
 * as `claude --cloud` would still start them (infra/governor.cfn.yml pages on it).
 */
export const ROUTINE_REFUSED = 'dispatch-routine-refused';

/**
 * A claim's key, `owner/name#number`, as the repo and issue it names.
 *
 * @param {string} key
 * @returns {{ repo: string, issue: number }}
 */
export const ticketOf = (key) => {
  const at = key.lastIndexOf('#');
  return { repo: key.slice(0, at), issue: Number(key.slice(at + 1)) };
};

/**
 * How long into a schedule turn a launch may still start: one more launch at
 * the launcher's budget (`LAUNCH_TIMEOUT_MS`, dispatch/turn.mjs), its marker and the heartbeat still end inside the task's
 * deadline (dispatch/cli.mjs), so the refreshed login is stored. Two launches
 * at the full budget both start; a DispatchCap above two runs out of window.
 * The spec owners' messages of their new builders go after the heartbeat,
 * once the loop ends, and this window does not count them: each send has
 * its own limit (`MESSAGE_TIMEOUT_MS`, dispatch/turn.mjs), and none runs
 * past `SENDS_LATEST_MS`, so the login is still stored before the deadline.
 */
export const SCHEDULE_LAUNCH_WINDOW_MS = 7 * 60 * 1000;

/**
 * A periodic whose connectors the account has not connected started
 * nothing: an alarmed error naming the repo, the periodic and each
 * connector. Its record stays, so the next fire tries again, and the
 * repo's other launches go on: the fault is this periodic's alone.
 *
 * @param {{ log: Log }} deps
 * @param {string} repo
 * @param {string} periodic
 * @param {string[]} missing
 */
const connectorMissing = ({ log }, repo, periodic, missing) => {
  log(CONNECTOR_MISSING, { level: 'error', repo, periodic, connectors: missing, reason: `its .github/governor.json names ${missing.length === 1 ? 'a connector' : 'connectors'} the claude.ai account has not connected, so its session was not started: connect ${missing.join(', ')} on the account, or take ${missing.length === 1 ? 'it' : 'them'} out of the file` });
};

/**
 * A routine launch that started nothing for a fault of its own periodic: a
 * connector the account lacks, or the routines API refusing the routine
 * or its fire. Either logs an alarmed error naming the repo and the periodic, and
 * says so, so the caller writes no record and goes on with the repo's
 * other launches: `claude --cloud` would still start them. A launch through
 * the CLI that failed is neither, and still skips the repo.
 *
 * @param {{ log: Log }} deps
 * @param {string} repo
 * @param {string} periodic
 * @param {LaunchResult} launched
 * @returns {boolean} Whether the launch was one of these.
 */
export const routineFault = (deps, repo, periodic, launched) => {
  if (launched.missing !== undefined) {
    connectorMissing(deps, repo, periodic, launched.missing);
    return true;
  }
  if (launched.refused !== true) return false;
  deps.log(ROUTINE_REFUSED, { level: 'error', repo, periodic, reason: `the routines API refused its routine or its fire, so its session was not started and it stays due; the repo's other launches go on: ${launched.output.slice(-OUTPUT_TAIL)}` });
  return true;
};

/**
 * Start a plan's launches in turn. A picked-up ticket is claimed first and
 * released where its launch started nothing, after its failed-launch record
 * is put (dispatch/pickup.mjs), and its thread is told so once
 * (dispatch/launch-failed.mjs). A launch the routines API
 * refused moves no record. A failed launch that holds its repo skips the
 * repo's later launches. Past the launch window, counted from `started`,
 * nothing more starts. The plan's `done` hears what ran and what was left.
 * Whatever the loop throws, each claim no marker covers is logged stranded
 * and `claims` is cleared.
 *
 * @param {Pick<LaunchablePlan, 'launches' | 'done'>} plan
 * @param {Pick<TurnContext, 'readerFor' | 'configOf' | 'start' | 'claims' | 'now' | 'log' | 'delivery'> & { state: Pick<TurnContext['state'], 'recordFailedLaunch'> }} ctx
 * @param {number} started When the turn started, before its planner ran.
 * @returns {Promise<Array<Dispatched & { planned: PlannedLaunch }>>} The launches that ran, a failed claim's included.
 */
export const launchPlan = async (plan, ctx, started) => {
  const { readerFor, configOf, start, claims, now, log, state } = ctx;
  const { launches } = plan;
  // The dispatcher claims a ticket before its launch: a session that
  // never claims, or dies first, would leave it ready for the next fire. A
  // ticket stays in `claims` until a marker naming its session covers it, or
  // its labels are back as they were. Each repo claims with its own labels
  // (dispatch/repo-config.mjs), the claim label made where the repo lacks it.
  /** @param {{ repo: string, issue: number }} ticket */
  const keyOf = ({ repo, issue }) => `${repo}#${issue}`;
  /** The repos whose claim label is known to exist this turn. @type {Set<string>} */
  const labelled = new Set();
  /** Each claimed ticket's row as its claim read it, for its spec owner. @type {Map<string, import('../scripts/lib/github-app.mjs').TicketRow>} */
  const ticketRows = new Map();

  /**
   * Put the ticket's failed-launch record, which holds it from pickup for
   * the hour (dispatch/pickup.mjs). The ready labels go back on next, and a
   * ready label queues a selection fire whoever added it, so the record is
   * put first. One that cannot be put is logged, and the release goes on.
   *
   * @param {{ repo: string, issue: number }} ticket
   * @returns {Promise<string | null>} When the hold ends, or null where the record was not put.
   */
  const hold = async ({ repo, issue }) => {
    const until = new Date(now() + PICKUP_FAILED_HOLD_MS).toISOString();
    try {
      await state.recordFailedLaunch(repo, issue, until);
      return until;
    } catch (error) {
      log(PICKUP_FAILED_UNRECORDED, { level: 'error', repo, issue, until, error: messageOf(error), reason: 'its ready labels go back with nothing to hold it, so its label\'s fire may launch it again at once' });
      return null;
    }
  };

  /**
   * Put the ready labels the claim took off back, and take the claim off. A
   * release that fails leaves the ticket in `claims`, so the turn's end logs
   * it stranded.
   *
   * @param {{ repo: string, issue: number }} ticket
   * @returns {Promise<boolean>} Whether the ticket was released.
   */
  const release = async (ticket) => {
    const { repo, issue } = ticket;
    const { labels } = configOf(repo);
    try {
      const github = await readerFor(repo);
      if (labels.claimRemoves.length > 0) await github.addLabels(issue, labels.claimRemoves);
      await github.removeLabel(issue, labels.claim);
      claims.delete(keyOf(ticket));
      log('dispatch-claim', { repo, issue, outcome: 'released' });
      return true;
    } catch (error) {
      log('dispatch-claim', { repo, issue, outcome: 'not released', error: messageOf(error) });
      return false;
    }
  };

  /** Each launch's or failure's message to its spec owner, sent in launch order once the loop ends. @type {Array<() => Promise<unknown>>} */
  const tells = [];

  /**
   * A ticket whose launch or claim failed: its failed-launch record put,
   * its labels released, and, where the record stands, one comment on the
   * thread saying so (dispatch/launch-failed.mjs), which the ticket's spec
   * owner hears once the loop ends, since the relay sends a governor
   * comment to nobody. With no record there is no hold to describe, and a
   * ticket the release left claimed is stranded, not held, so neither is
   * said. A comment that fails is logged and has no effect on the release.
   *
   * @param {{ repo: string, issue: number }} ticket
   * @param {import('./launch-failed.mjs').Failed} failed
   */
  const fail = async (ticket, failed) => {
    const until = await hold(ticket);
    const released = await release(ticket);
    if (until === null || !released) return;
    const { repo, issue } = ticket;
    let reader;
    try {
      reader = await readerFor(repo);
    } catch (error) {
      log(LAUNCH_FAILED_EVENT, { level: 'error', repo, issue, failed, until, outcome: 'not said', error: messageOf(error), reason: 'the repo could not be reached, so the ticket is not told its launch failed' });
      return;
    }
    const text = await sayLaunchFailed({ reader, repo, issue, until, failed, log });
    if (text === null) return;
    const tell = tellerFor(ctx, repo, GITHUB_SOURCE, ticketRows.get(keyOf(ticket)));
    tells.push(() => tell(issue, text));
  };

  /**
   * Claim one ticket: the claim label on, then the ready labels it takes
   * off. The plan was read before earlier launches that take minutes, so
   * the ticket is read again first: one closed, unreadied, claimed, given
   * one of the repo's excluded labels, given an open blocker or held by a
   * `Blocked until:` line since (`ticketStatus`, `mayPickUp`) is skipped,
   * untouched, since its session would proceed on the prompt's claim line
   * over someone else's work, or on work that waits on another. So is one
   * whose author the repo's `trust.task` does not list (`authorPicked`),
   * and one whose ready labels no one in the repo's `trust.start` added
   * last (`judgeReady`). A claim that fails puts the ticket's failed-launch
   * record, is released, says so on the ticket, and starts nothing.
   *
   * @param {{ repo: string, issue: number }} ticket
   * @returns {Promise<'claimed' | 'taken' | 'failed'>}
   */
  const claim = async (ticket) => {
    const { repo, issue } = ticket;
    const config = configOf(repo);
    const { labels } = config;
    try {
      const github = await readerFor(repo);
      const read = await github.ticket(issue);
      ticketRows.set(keyOf(ticket), read);
      const { state, labels: on, wait } = read;
      const at = now();
      const first = ticketStatus(read, { labels, now: at });
      const ready = first.open && first.labels === 'ready';
      // The rows are read only where the summary is missing and the rest
      // still reads ready, as the selection reads them.
      const rows = ready && read.openBlockers === undefined ? await github.blockers(issue) : undefined;
      const status = rows === undefined ? first : ticketStatus(read, { labels, now: at, blockers: rows });
      const blocked = ready && status.open && status.holds.includes('blocker');
      if (!mayPickUp(status)) {
        const line = wait === undefined ? '' : `, Blocked until: ${'until' in wait ? wait.until : 'after' in wait ? `${wait.after.days} days after ${wait.after.repo ?? ''}#${wait.after.issue} closes` : `${wait.unreadable} (unreadable)`}`;
        const open = blocked ? `, ${read.openBlockers ?? (rows ?? []).filter((b) => b.state === 'open').length} open blocker(s)` : '';
        log('dispatch-claim', { repo, issue, outcome: 'skipped', reason: `no longer ready to claim: ${state}, labelled ${JSON.stringify(on)}${open}${line}` });
        // Said only on a ticket still ready by its labels: one claimed or
        // unreadied since is someone else's.
        const unread = ready && status.open && status.holds.includes('unreadable') ? unreadableOf(read) : undefined;
        if (unread !== undefined) await reportUnreadable({ reader: github, repo, issue, value: unread, log, tell: tellerFor(ctx, repo, GITHUB_SOURCE, read) });
        return 'taken';
      }
      // Pickup starts only tickets whose author the repo's `by` lists.
      const association = read.association ?? 'NONE';
      if (!authorPicked(read, byOf(config))) {
        log('dispatch-claim', { repo, issue, outcome: 'skipped', reason: strangerReason({ association }) });
        return 'taken';
      }
      // A ready label counts only where someone in the repo's trust.start,
      // or governor's App, added it last: a stranger's issue template, a
      // labelling bot or a person the repo leaves out can add every ready
      // label (`judgeReady`).
      const judged = await judgeReady({ reader: github, repo, ticket: { ...read, number: issue }, ready: labels.ready, start: startOf(config) });
      if (!judged.counts) {
        if ('outsider' in judged) {
          log('dispatch-claim', { repo, issue, outcome: 'skipped', reason: outsiderReason(judged.outsider) });
          await reportUncounted({ reader: github, outsider: judged.outsider, log });
        } else if ('unstarted' in judged) {
          await reportUnstarted({ reader: github, unstarted: judged.unstarted, what: 'readied', event: 'dispatch-claim', log });
        } else {
          reportUnlooked({ unlooked: judged.unread, event: 'dispatch-claim', log });
        }
        return 'taken';
      }
    } catch (error) {
      log('dispatch-claim', { repo, issue, outcome: 'not claimed', error: `the ticket, its blockers or its label events could not be read: ${messageOf(error)}` });
      return 'failed';
    }
    claims.add(keyOf(ticket));
    try {
      const github = await readerFor(repo);
      if (!labelled.has(repo)) {
        await github.ensureLabel(labels.claim);
        labelled.add(repo);
      }
      await github.addLabels(issue, [labels.claim]);
      for (const label of labels.claimRemoves) await github.removeLabel(issue, label);
      return 'claimed';
    } catch (error) {
      log('dispatch-claim', { repo, issue, outcome: 'not claimed', error: messageOf(error) });
      // The release puts back any ready label the claim took off.
      await fail(ticket, 'claim');
      return 'failed';
    }
  };

  /** The repos whose launch started nothing: the rest of their tickets and periodics wait for the next fire. @type {Set<string>} */
  const skipped = new Set();
  /** The planned launches that ran, a failed claim's included, and those the window or a repo skip left. @type {Array<Dispatched & { planned: PlannedLaunch }>} */
  const ran = [];
  /** @type {PlannedLaunch[]} */
  const left = [];
  try {
    for (const [i, entry] of launches.entries()) {
      if (now() - started > SCHEDULE_LAUNCH_WINDOW_MS) {
        log('dispatch-launch', { undispatched: launches.slice(i).map((e) => ({ repo: e.repo, issue: e.issue })), reason: `out of time: past ${SCHEDULE_LAUNCH_WINDOW_MS} ms, another launch might outrun the deadline; each is left unmarked for the next fire` });
        left.push(...launches.slice(i));
        break;
      }
      const ticket = entry.issue === null ? null : { repo: entry.repo, issue: entry.issue };
      if (skipped.has(entry.repo)) {
        left.push(entry);
        continue;
      }
      // A spec session's ticket is not claimed: the session claims it before it builds.
      const claimed = ticket === null || !entry.claim ? 'claimed' : await claim(ticket);
      if (claimed === 'taken') continue;
      if (claimed === 'failed') {
        ran.push({ repo: entry.repo, issue: entry.issue, outcome: 'failed', sessionUrl: null, planned: entry });
        continue;
      }
      // A message in place of the launch: an ended wait's owner, asked to
      // rewrite its own spec, with this launch as the message's fallback,
      // which names itself in the ticket's body. It runs here so the window and a repo
      // skip hold it as they hold a launch.
      if (entry.ask !== undefined) {
        const fell = await entry.ask();
        if (fell === null) continue;
        log('dispatch-launch', { repo: entry.repo, issue: entry.issue, sessionName: entry.asked.sessionName, outcome: fell.outcome, sessionUrl: fell.sessionUrl, fallback: true });
        if (entry.holdsRepo && fell.outcome === 'failed') {
          skipped.add(entry.repo);
          log(REPO_SKIPPED, { level: 'error', repo: entry.repo, issue: entry.issue, reason: 'its launch started nothing: the rest of its tickets and periodics wait for the next fire' });
        }
        ran.push({ repo: entry.repo, issue: entry.issue, outcome: fell.outcome, sessionUrl: fell.sessionUrl, planned: entry });
        continue;
      }
      const firedAt = new Date(now()).toISOString();
      const launched = await start({ ...entry.asked, repo: entry.repo });
      if (routineFault(ctx, entry.repo, entry.asked.sessionName, launched)) continue;
      const { outcome, sessionUrl, status } = launched;
      const periodic = entry.periodic === undefined ? {} : { periodic: entry.periodic };
      log('dispatch-launch', { repo: entry.repo, issue: entry.issue, sessionName: entry.asked.sessionName, ...periodic, outcome, status, sessionUrl });
      // The record the launch moves: a periodic's, a wait item, a hook's.
      if (entry.started !== undefined) await entry.started(launched, firedAt);
      if (entry.holdsRepo && outcome === 'failed') {
        if (ticket !== null && entry.claim) await fail(ticket, 'launch');
        // A launch that started nothing is the repo's environment or the
        // login: the repo's next ticket or periodic would fail the same way.
        // A routine the routines API refused is not (`routineFault`).
        skipped.add(entry.repo);
        log(REPO_SKIPPED, { level: 'error', repo: entry.repo, issue: entry.issue, ...periodic, status, reason: 'its launch started nothing: the rest of its tickets and periodics wait for the next fire' });
      } else if (ticket !== null && entry.claim) {
        // A picked-up ticket's builder is named by its dispatch comment.
        const at = new Date(now()).toISOString();
        await (await readerFor(ticket.repo)).comment(ticket.issue, dispatchMarker({ at, sessionUrl }));
        if (sessionUrl !== null) claims.delete(keyOf(ticket));
        // The comment is a record for people: this turn tells the spec
        // owner of its new builder, unless the plan's own message does.
        // The message waits for the loop's end, since each send is a CLI
        // call that would spend the launch window between launches.
        const row = ticketRows.get(keyOf(ticket));
        if (!entry.told && row !== undefined) {
          const { owner } = await rolesOf({ issue: ticket.issue, relay: relayOf(configOf(ticket.repo)), ticket: row });
          tells.push(() => tellBuilderChange({
            deliver: (session, text, options) => ctx.delivery(ticket.repo).deliver({ session }, text, { source: GITHUB_SOURCE, kind: 'builder-change', ...options }),
            log,
            repo: ticket.repo,
            issue: ticket.issue,
            title: row.title,
            url: `https://github.com/${ticket.repo}/issues/${ticket.issue}`,
            owner,
            builder: sessionUrl,
            displaced: null,
          }));
        }
      } else if (ticket !== null && outcome !== 'failed') {
        // A spec session is the ticket's owner, named in its body, where its
        // next spec work finds it. It leaves no dispatch comment. A launch
        // that started nothing names nobody.
        await nameSpecSession(await readerFor(ticket.repo), { repo: ticket.repo, issue: ticket.issue, sessionUrl, log });
      }
      ran.push({ repo: entry.repo, issue: entry.issue, outcome, sessionUrl, planned: entry });
    }
    // The kind's plan settles what its launches left: the sweep's records
    // and pickup's heartbeat line, or a hook left unstarted, which fails
    // the turn.
    await plan.done?.({ dispatched: ran, left });
  } finally {
    // A claim no marker names a session for: an unconfirmed launch, one past
    // its budget, a marker refused, a release refused. Nothing puts the
    // labels back, because the session may be running. It is logged before
    // the messages below, so a send that hangs holds back no line.
    for (const key of claims) log(CLAIM_STRANDED, { ...ticketOf(key), reason: 'claimed, and no dispatch marker names its session: the launch was unconfirmed, ran past its budget, or the turn threw' });
    claims.clear();
    // Every launch has run, so the spec owners' messages spend no launch
    // window. They go even where the loop threw: each launch they name
    // started. A send never throws (`sendAll`, dispatch/told.mjs).
    for (const tell of tells) await tell();
  }
  return ran;
};
