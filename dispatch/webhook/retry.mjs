/**
 * The retrier's decisions: a fire whose task stopped without running its
 * container goes back on the lane, a bounded number of times.
 *
 * The starter is done with a fire once RunTask succeeds, so a task that then
 * fails to start (a pull that came back "not found" with the digest in ECR
 * throughout, no placement, an ENI that would not attach) dropped its fire:
 * three times in two days. The task's ECS stop event carries
 * both halves of what a retry needs: the fire, on the container override the
 * starter set, and the attempt, on the task's startedBy
 * (starter.mjs startedByFor). A fire that has had MAX_START_ATTEMPTS goes to
 * the dead-letter queue instead, whose tripwire pages
 * (infra/governor.cfn.yml, DispatchFiresDeadAlarm); a redrive from there
 * starts its attempts afresh. A fire the task's parser refuses goes there
 * at once (fire.mjs `parseFire`): every attempt would fail the same way.
 *
 * Every failure leaves as a throw, after a retry-failed line: Lambda retries
 * the async invoke, and the retrier's errors tripwire hears what it could
 * not. A caught error would be the lost fire again.
 *
 * Pure: `retryFire` takes its I/O as `deps`. retry-handler.mjs binds the
 * real ones.
 */

import { fireOfOverride, parseFire } from './fire.mjs';
import { attemptFrom } from './starter.mjs';

/**
 * @typedef {import('./fire.mjs').FireMessage} FireMessage
 * @typedef {{
 *   requeue: (message: FireMessage, dedupId: string) => Promise<void>,
 *   deadLetter: (message: FireMessage & { stoppedReason?: string | undefined }, dedupId: string) => Promise<void>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} Deps
 * @typedef {{
 *   detail?: {
 *     taskArn?: string,
 *     startedBy?: string,
 *     stoppedReason?: string,
 *     overrides?: { containerOverrides?: Array<{ environment?: Array<{ name?: string, value?: string }> }> },
 *   },
 * }} StopEvent
 */

/**
 * How many tasks one fire gets before it is dead-lettered. The pull fault
 * cleared within seconds each time it was seen, so a second attempt carries
 * a transient; a third is the margin. infra/governor.cfn.yml's
 * DispatchNotRunAlarm threshold is sized off this.
 */
export const MAX_START_ATTEMPTS = 3;

/**
 * @param {StopEvent['detail']} detail
 * @returns {Record<string, unknown>} The fire as the task carried it.
 */
const fireOf = (detail) => {
  try {
    return fireOfOverride(detail?.overrides);
  } catch (error) {
    throw new Error(`task ${detail?.taskArn}: ${/** @type {Error} */ (error).message}`, { cause: error });
  }
};

/**
 * Put the fire of a task that failed to start back on the lane as its next
 * attempt, or on the dead-letter queue once it has had them all. A task the
 * starter did not start (a probe, a task run by hand) is left to whoever
 * started it; the not-run tripwire still counts its stop.
 *
 * Both queues deduplicate on the failed task, so a redelivered stop event is
 * not a second retry.
 *
 * @param {StopEvent} event
 * @param {Deps} deps
 */
export const retryFire = async (event, deps) => {
  const detail = event?.detail;
  const taskArn = String(detail?.taskArn ?? '');
  const stoppedReason = detail?.stoppedReason;
  const attempt = attemptFrom(detail?.startedBy);
  if (attempt === undefined) {
    deps.log('retry-skipped', { taskArn, startedBy: detail?.startedBy, stoppedReason });
    return;
  }
  const dedupId = `retry-${taskArn.split('/').pop()}`.slice(0, 128);
  /** @type {Record<string, unknown>} */
  const context = { taskArn, stoppedReason };
  try {
    const carried = fireOf(detail);
    context.kind = carried.kind;
    // A fire the task would refuse fails every attempt it is given: it goes
    // to the dead-letter queue now, whose tripwire pages and whose redrive
    // is the way back once the fire is mended.
    /** @type {import('./fire.mjs').Fire} */
    let fire;
    try {
      fire = parseFire(carried);
    } catch (error) {
      const refused = String(/** @type {any} */ (error)?.message ?? error);
      await deps.deadLetter({ fire: /** @type {any} */ (carried), reason: `the task refuses it: ${refused}`, retryOf: taskArn, stoppedReason }, dedupId);
      deps.log('fire-refused', { ...context, attempt, error: refused });
      return;
    }
    // The parsed fire, which is the carried one for any the receiver built
    // (test/dispatch-fire.test.ts), and has a kind whatever was carried.
    if (attempt < MAX_START_ATTEMPTS) {
      const next = attempt + 1;
      await deps.requeue({ fire, reason: `attempt ${next}: ${taskArn} failed to start`, attempt: next, retryOf: taskArn }, dedupId);
      deps.log('fire-retried', { ...context, attempt: next });
    } else {
      await deps.deadLetter({ fire, reason: `gave up after ${attempt} attempts: ${taskArn} failed to start`, retryOf: taskArn, stoppedReason }, dedupId);
      deps.log('fire-gave-up', { ...context, attempts: attempt });
    }
  } catch (error) {
    deps.log('retry-failed', { ...context, attempt, error: String(/** @type {any} */ (error)?.stack ?? error) });
    throw error;
  }
};
