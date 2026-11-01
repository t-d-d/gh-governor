/**
 * The dispatcher task's entrypoint: one turn, from the event in
 * DISPATCH_EVENT, then exit.
 *
 * ECS starts the container with the event as an environment override (the
 * schedule rule's target input in infra/governor.cfn.yml, or
 * scripts/run-turn.mjs by hand), so the turn is dispatch/turn.mjs's
 * `run` with the real dependencies, and what this file adds is the edge: the
 * event read and refused when it is not one, the result logged as one JSON
 * line, an exit code the probe reads, and a deadline. A Fargate task has no
 * timeout of its own; a launcher that hangs would otherwise hold the task,
 * at a few cents an hour, until the next fire started a second one beside it
 * and both refreshed one login.
 *
 * The one line the stack alarms on is `dispatch-failed`: the metric filter
 * counts it, whether the turn threw, proved nothing, started nothing it was
 * asked to start, or ran out of time. A message an archived session
 * refused, with no fallback tried and no subscriber dropped, still exits 1
 * for the by-hand caller, but logs `dispatch-result`: the dispatcher reached
 * the session, and nothing about it needs an operator. Any other fault in
 * the same turn, such as an unread repo, still logs `dispatch-failed`.
 */

import { isCliEntry } from '../scripts/lib/cli-entry.mjs';
import { CLAIM_STRANDED, realDeps, run, ticketOf } from './turn.mjs';
import { FIRE_VARIABLE } from './webhook/fire.mjs';

/**
 * Two sessions at four minutes each, the reads around them, and the image
 * pull; a workflow turn's send window and one delivery's budget after it
 * (dispatch/turn.mjs) are the longest of these.
 */
export const DEADLINE_MS = 18 * 60 * 1000;

/**
 * What the process exits with, 0 when:
 * - a probe: it proved the runtime;
 * - a message: the session took it; or, refusing, its fallback started,
 *   forwarded the remark or found a session already on the PR; or a
 *   refusing subscriber's line was dropped (`dropped` is set
 *   whenever that was tried); or the push was the session's own;
 * - a workflow, job or branch run: no send faulted (taken, or refused by a
 *   gone session), every fallback or triage session started, and every
 *   ticket label was read and added;
 * - a review: every PR came to an outcome (a merge GitHub refused, an
 *   answer outside the checklist or a failed read is a fault; a run the
 *   login's session limit refused is not);
 * - a conflicts check: every PR was checked;
 * - an unblocked fire for a claimed ticket: its session took the message,
 *   or is gone;
 * - a fire: not every launch failed, and every served repo's config file
 *   was read. A fire with nothing to start is a success, as the heartbeat
 *   rule says;
 * - a turn its repo's config file refused: not served, or a switch turned
 *   off, is as designed;
 * and in any of them, when the fire counted an event for the periodics,
 * every periodic's record and window was read and every periodic it
 * brought due that started launched.
 * In any kind, every governor heartbeat block the turn changed was read and
 * written (`heartbeatUnwritten`), and no repo's part of the turn failed
 * (`unread`), refusal or not.
 *
 * @param {{ kind: string, ok?: boolean, answered?: boolean | null, dropped?: boolean | null, skipped?: string | null, detail?: string, dispatched?: Array<{ outcome: string }>, sessionUrl?: string | null, error?: string | null, fallback?: { outcome: string, sessionUrl: string | null } | null, deliveries?: Array<{ ok: boolean, refused: boolean, fallback: { outcome: string } | null }>, triage?: { outcome: string } | null, labels?: { failed: unknown[] } | null, cursor?: { moved: boolean } | { held: number } | { error: string } | null, reviews?: Array<{ outcome: string }>, checks?: Array<{ outcome: string }>, loginStored?: boolean, refusal?: string, unread?: unknown[], heartbeatUnwritten?: unknown[], periodics?: { dispatched: Array<{ outcome: string }>, unread: unknown[] } | null, messaged?: { ok: boolean, refused?: boolean } | null }} result
 * @returns {0 | 1}
 */
export const exitCodeFor = (result) => {
  if (result.kind === 'probe') return result.ok ? 0 : 1;
  // A heartbeat line the turn could not write goes stale, whatever the turn's own work.
  if ((result.heartbeatUnwritten?.length ?? 0) > 0) return 1;
  // The periodics an event brought due are checked under their own switch,
  // so a fault there fails a turn whose own work was refused or went well.
  if (result.periodics != null && (result.periodics.unread.length > 0 || result.periodics.dispatched.some((d) => d.outcome === 'failed'))) return 1;
  // A repo whose part of the turn failed, its config file or its hook table
  // write, fails the turn of any kind, refused or not.
  if ((result.unread?.length ?? 0) > 0) return 1;
  if (typeof result.refusal === 'string') return 0;
  /** A send's fault: the CLI never answered, answered anything but the session gone, or its fallback started nothing. @param {{ ok: boolean, refused: boolean, fallback: { outcome: string } | null }} d */
  const faultedSend = (d) => !d.ok && (!d.refused || d.fallback?.outcome === 'failed');
  // A refusal with no fallback is a gone session, which owes a deploy check
  // nothing and waits on no branch run.
  if (result.kind === 'workflow' || result.kind === 'job' || result.kind === 'branch-run') {
    const faulted = (result.deliveries ?? []).some(faultedSend)
      || result.triage?.outcome === 'failed'
      || (result.labels?.failed.length ?? 0) > 0
      || (result.cursor != null && 'error' in result.cursor);
    return faulted ? 1 : 0;
  }
  if (result.kind === 'review' || result.kind === 'conflicts') {
    const outcomes = result.kind === 'review' ? result.reviews ?? [] : result.checks ?? [];
    return outcomes.some((r) => r.outcome === 'failed') ? 1 : 0;
  }
  // A hook fire sent into its open session: the send is the turn.
  if (result.kind === 'hook' && result.messaged != null) return result.messaged.ok ? 0 : 1;
  // An unblocked fire's message to a claimed ticket's session: a gone session is told enough.
  if (result.kind === 'unblocked' && result.messaged != null) return result.messaged.ok || result.messaged.refused === true ? 0 : 1;
  if (result.kind === 'message') {
    return result.ok || result.skipped != null || result.dropped != null
      || (result.fallback != null && result.fallback.outcome !== 'failed') ? 0 : 1;
  }
  const dispatched = result.dispatched ?? [];
  return dispatched.length > 0 && dispatched.every((d) => d.outcome === 'failed') ? 1 : 0;
};

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   run: typeof run,
 *   deps: () => ReturnType<typeof realDeps>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   exit: (code: number) => void,
 *   schedule: (fn: () => void, ms: number) => unknown,
 * }} args
 */
export const main = async ({ env, run: turn, deps, log, exit, schedule }) => {
  // The tickets the turn claimed that no marker names a session for yet.
  // The deadline unwinds nothing, so it logs them itself.
  /** Each `owner/name#number`. @type {Set<string>} */
  const claims = new Set();
  schedule(() => {
    for (const key of claims) log(CLAIM_STRANDED, { ...ticketOf(key), reason: `claimed, and the deadline (${DEADLINE_MS} ms) ended the turn before a dispatch marker named its session` });
    log('dispatch-failed', { reason: 'deadline', deadlineMs: DEADLINE_MS });
    exit(1);
  }, DEADLINE_MS);
  try {
    const raw = env[FIRE_VARIABLE];
    if (!raw) throw new Error(`${FIRE_VARIABLE} is not set: the task was started without an invocation`);
    /** @type {unknown} */
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new Error(`${FIRE_VARIABLE} is not JSON: ${raw}`);
    }
    const result = await turn(event, { ...deps(), claims });
    const code = exitCodeFor(result);
    // A message into an archived session exits 1 for its caller, but the
    // dispatcher did not fail: the send counts as taken for the alarm, so
    // any other fault in the turn still fails it.
    const archived = 'archived' in result && result.archived === true;
    const failed = code === 1 && (!archived || exitCodeFor({ ...result, ok: true }) === 1);
    log(failed ? 'dispatch-failed' : 'dispatch-result', { ...result });
    exit(code);
  } catch (error) {
    log('dispatch-failed', { reason: 'threw', error: String(/** @type {any} */ (error)?.stack ?? error) });
    exit(1);
  }
};

if (isCliEntry(import.meta.url, process.argv[1])) {
  await main({
    env: process.env,
    run,
    deps: realDeps,
    log: (event, context = {}) => console.log(JSON.stringify({ event, ...context })),
    exit: (code) => process.exit(code),
    // unref: the deadline fires while a hung launcher keeps the loop alive,
    // and never keeps the process alive on its own after a clean exit.
    schedule: (fn, ms) => setTimeout(fn, ms).unref(),
  });
}
