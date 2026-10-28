/**
 * The starter's decisions: one fire off the lane, one dispatcher task, never
 * beside a running one.
 *
 * A dispatcher turn refreshes the stored login, and two turns refreshing one
 * login leave one of them dead. So a fire that finds a task running is
 * handed straight back as a batch item failure, which returns the message to
 * the queue, asked back in DEFER_SECONDS (ChangeMessageVisibility on its
 * receipt handle); the lane is FIFO with one message group, so nothing
 * behind it is offered first. The queue paces the retry and no Lambda sits
 * idle waiting. After the attempts run out the fire is dead-lettered and the
 * tripwire says so (infra/governor.cfn.yml, DispatchFiresQueue).
 *
 * The queue's own visibility timeout is a different knob: how long an
 * invocation may hold a fire before the lane offers it again, a minute with
 * a margin for the poller. Left as the pace too, the lane ran one fire a
 * minute however short the task (2026-09-26: thirteen fires ahead cost a
 * conflict comment fourteen minutes on its way to its session). A refused
 * ask costs the fire that minute and nothing more.
 *
 * A deferral is as designed, so it is not a throw: a throw counts toward the
 * Lambda Errors metric, and the account-wide safety net paged on a burst of
 * ready labels. A fire that
 * fails (RunTask refused it, a body with no fire) is not a throw either: it
 * is handed back and asked back in DEFER_SECONDS like a deferral, so it
 * spends the lane's receives at the same pace and reaches the dead-letter
 * queue in the same half hour. Thrown, it came back after the visibility
 * timeout and held the lane three hours on the same receive count.
 *
 * Pure: `startFire` takes its I/O as `deps`. starter-handler.mjs binds the
 * real ones.
 */

import { startable } from './fire.mjs';

/**
 * @typedef {import('./fire.mjs').FireMessage} FireMessage
 * @typedef {{
 *   running: () => Promise<string[]>,
 *   runTask: (fire: import('./fire.mjs').Fire, startedBy: string) => Promise<string>,
 *   defer: (receiptHandle: string, seconds: number) => Promise<void>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} Deps
 */

/**
 * How soon a deferred fire is offered again: the lane's pace, since a fire
 * deferred beside a running task idles this out past the task's end,
 * whatever the task took. A message turn takes about twenty-five seconds.
 */
export const DEFER_SECONDS = 10;

/**
 * The task's startedBy, which carries the fire's attempt: the one field
 * RunTask sets that the task's stop event hands back, so the retrier knows a
 * task that failed to start was the lane's, and how many tries the fire has
 * had (dispatch/webhook/retry.mjs). ECS takes letters, digits,
 * hyphens, underscores and slashes there.
 */
const STARTED_BY = /^governor-starter\/attempt-(\d+)$/;

/** @param {number} attempt @returns {string} */
export const startedByFor = (attempt) => `governor-starter/attempt-${attempt}`;

/**
 * @param {string | undefined} startedBy
 * @returns {number | undefined} The attempt, or undefined for a task the starter did not start.
 */
export const attemptFrom = (startedBy) => {
  const match = STARTED_BY.exec(String(startedBy ?? ''));
  return match ? Number(match[1]) : undefined;
};

/**
 * Start the task for one fire, unless one is running. A running task defers
 * the fire: it resolves with no ARN, and handleRecords hands it back. Every
 * failure leaves as a throw, which handleRecords logs and hands back too.
 *
 * @param {FireMessage} message
 * @param {Deps} deps
 * @returns {Promise<string | undefined>} The task ARN, or undefined when deferred.
 */
export const startFire = async (message, deps) => {
  const fire = message?.fire;
  startable(fire);
  const { fire: _fire, ...context } = message;
  const attempt = Number.isInteger(message.attempt) && Number(message.attempt) > 0 ? Number(message.attempt) : 1;
  const running = await deps.running();
  if (running.length > 0) {
    deps.log('fire-deferred', { ...context, kind: fire.kind, running });
    return undefined;
  }
  const taskArn = await deps.runTask(fire, startedByFor(attempt));
  if (!taskArn) throw new Error('RunTask returned no task ARN');
  deps.log('fire-started', { ...context, kind: fire.kind, attempt, taskArn });
  return taskArn;
};

/** @param {unknown} error */
const errorText = (error) => String(/** @type {any} */ (error)?.stack ?? error);

/**
 * Ask the queue to offer a deferred or failed fire again in DEFER_SECONDS. A
 * refusal (a receipt handle the queue no longer knows) is logged, not thrown:
 * the fire is handed back either way and comes back after the queue's own
 * visibility timeout, and a throw would be a Lambda error paging the
 * account-wide safety net for a slower re-offer.
 *
 * @param {{ messageId: string, receiptHandle: string }} record
 * @param {Deps} deps
 */
const reoffer = async (record, deps) => {
  try {
    await deps.defer(record.receiptHandle, DEFER_SECONDS);
  } catch (error) {
    deps.log('fire-defer-failed', { messageId: record.messageId, error: errorText(error) });
  }
};

/**
 * The SQS records of one invocation, in order. One per invocation by the
 * event source's batch size; the loop is for the shape, not for throughput.
 * A deferred or failed fire goes back to the queue with every record behind
 * it, since the lane is FIFO (the event source's ReportBatchItemFailures
 * response); that one is asked back in DEFER_SECONDS, the ones behind it
 * wait the queue's visibility timeout, behind it either way. A failure is
 * logged, never thrown: the dead-letter tripwire is where a fire that fails
 * every attempt ends.
 *
 * @param {Array<{ messageId: string, receiptHandle: string, body: string }>} records
 * @param {Deps} deps
 * @returns {Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>}
 */
export const handleRecords = async (records, deps) => {
  for (const [i, record] of records.entries()) {
    let taskArn;
    /** @type {any} */
    let message;
    try {
      message = JSON.parse(record.body);
      taskArn = await startFire(message, deps);
    } catch (error) {
      const { fire, ...context } = message !== null && typeof message === 'object' ? message : {};
      deps.log('fire-failed', { messageId: record.messageId, ...context, kind: fire?.kind, error: errorText(error) });
    }
    if (taskArn === undefined) {
      await reoffer(record, deps);
      return { batchItemFailures: records.slice(i).map((r) => ({ itemIdentifier: r.messageId })) };
    }
  }
  return { batchItemFailures: [] };
};
