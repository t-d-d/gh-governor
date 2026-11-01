/**
 * The dispatcher task's lane: the task takes fires off governor-fires.fifo
 * (infra/governor.cfn.yml DispatchFiresQueue) one at a time and runs each as
 * its own turn, so a burst pays one cold start, not one per fire.
 *
 * The task is the lane's only reader. The starter only starts a task when a
 * fire waits and none runs (dispatch/webhook/starter.mjs), so there is one
 * task and one login at a time, and one turn at a time inside the task: a
 * turn refreshes the stored login, and two turns refreshing one login leave
 * one of them dead.
 *
 * A fire is deleted as it is taken, before its turn. A turn that fails is
 * logged and not retried, as a fire whose task started always was, and a
 * fire still held would block the lane's one message group behind it. A
 * fire the task's parser refuses (`parseFire`) goes to the dead-letter
 * queue as it came, so a redrive puts it back once it is mended.
 *
 * The task exits once a long poll has come back empty for the whole idle
 * grace since its last turn, or once it has taken fires for
 * TAKE_FIRES_FOR_MS, so a long burst does not keep running the image it
 * started with after a deploy. Either way its stop event calls the starter,
 * which starts the next task if a fire is waiting.
 *
 * Pure: `work` takes its I/O as `deps`. `sqsLane` binds the queue, and
 * dispatch/cli.mjs the turn.
 */

import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LANE, parseFire } from './webhook/fire.mjs';

/**
 * How long the lane may stay empty after a turn before the task exits. A
 * longer grace catches more of a spread-out burst, such as a push and then
 * its workflow runs, at the price of idle task time: a minute of half a
 * vCPU costs far less than the cold start it saves.
 */
export const IDLE_GRACE_MS = 60 * 1000;

/** The longest long poll SQS takes. */
export const RECEIVE_WAIT_SECONDS = 20;

/**
 * How long a task takes fires before it leaves the rest to the next task.
 * A turn that started before the limit still runs to its end, under its own
 * deadline (dispatch/cli.mjs DEADLINE_MS).
 */
export const TAKE_FIRES_FOR_MS = 30 * 60 * 1000;

/**
 * @typedef {{ messageId: string, receiptHandle: string, body: string }} LaneMessage
 * @typedef {{
 *   receive: (waitSeconds: number) => Promise<LaneMessage | null>,
 *   remove: (receiptHandle: string) => Promise<void>,
 *   deadLetter: (body: string, reason: string, messageId: string) => Promise<void>,
 *   reset: () => void,
 *   turn: (fire: unknown, messageId: string) => Promise<void>,
 *   now: () => number,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 * }} Deps
 */

/** @param {unknown} error */
const messageOf = (error) => String(/** @type {any} */ (error)?.message ?? error);

/**
 * Take one message off the lane: refuse it to the dead-letter queue, or
 * delete it and run its turn.
 *
 * @param {LaneMessage} message
 * @param {Deps} deps
 * @returns {Promise<boolean>} Whether a turn ran.
 */
const take = async ({ messageId, receiptHandle, body }, deps) => {
  /** @type {any} */
  let carried;
  /** @type {import('./webhook/fire.mjs').Fire} */
  let fire;
  try {
    carried = JSON.parse(body);
    fire = parseFire(carried?.fire);
  } catch (error) {
    const refused = messageOf(error);
    try {
      // Moved first: a delete that went first would lose the fire if the move failed.
      await deps.deadLetter(body, `the task refuses it: ${refused}`, messageId);
      await deps.remove(receiptHandle);
      deps.log('fire-refused', { level: 'error', messageId, error: refused });
    } catch (moveError) {
      deps.log('fire-refused-unmoved', { level: 'error', messageId, error: refused, moveError: messageOf(moveError) });
    }
    return false;
  }
  try {
    await deps.remove(receiptHandle);
  } catch (error) {
    // Run and offered again, the fire would run twice. Left, it comes back
    // after the lane's visibility timeout, and the dead-letter queue takes
    // it after the lane's receive count.
    deps.log('fire-untaken', { level: 'error', messageId, kind: fire.kind, error: messageOf(error) });
    return false;
  }
  deps.log('fire-taken', { messageId, kind: fire.kind, reason: carried.reason });
  try {
    deps.reset();
  } catch (error) {
    // The fire is deleted, so a throw would lose it without a line the alarm
    // counts. Run over the last turn's state, it could act in another repo's
    // directory, so it is not run.
    deps.log('dispatch-failed', { reason: 'reset-failed', messageId, exitCode: 1, error: messageOf(error) });
    return false;
  }
  await deps.turn(carried.fire, messageId);
  return true;
};

/**
 * Take fires off the lane until it has been empty for the idle grace, or
 * the task has taken fires for TAKE_FIRES_FOR_MS.
 *
 * @param {Deps} deps
 * @returns {Promise<0 | 1>} The task's exit code: 1 when the lane could not be read.
 */
export const work = async (deps) => {
  const begun = deps.now();
  let idleSince = begun;
  let taken = 0;
  for (;;) {
    if (deps.now() - begun >= TAKE_FIRES_FOR_MS) {
      deps.log('lane-left', { taken, reason: `took fires for ${TAKE_FIRES_FOR_MS} ms; the next task takes the rest` });
      return 0;
    }
    const left = IDLE_GRACE_MS - (deps.now() - idleSince);
    if (left <= 0) {
      deps.log('lane-idle', { taken, idleMs: IDLE_GRACE_MS });
      return 0;
    }
    /** @type {LaneMessage | null} */
    let message;
    try {
      message = await deps.receive(Math.max(1, Math.min(RECEIVE_WAIT_SECONDS, Math.ceil(left / 1000))));
    } catch (error) {
      deps.log('dispatch-failed', { reason: 'lane-unread', error: messageOf(error) });
      return 1;
    }
    if (message === null) continue;
    if (await take(message, deps)) taken += 1;
    idleSince = deps.now();
  }
};

/**
 * The lane and its dead-letter queue, as the task role may use them: take
 * one fire at a time, delete it, and move a refused one.
 *
 * @param {Pick<import('@aws-sdk/client-sqs').SQSClient, 'send'>} client
 * @param {{ lane: string, dead: string }} urls
 * @returns {Pick<Deps, 'receive' | 'remove' | 'deadLetter'>}
 */
export const sqsLane = (client, { lane, dead }) => ({
  receive: async (waitSeconds) => {
    const { Messages } = await client.send(new ReceiveMessageCommand({ QueueUrl: lane, MaxNumberOfMessages: 1, WaitTimeSeconds: waitSeconds }));
    const m = Messages?.[0];
    if (m === undefined) return null;
    return { messageId: String(m.MessageId ?? ''), receiptHandle: String(m.ReceiptHandle ?? ''), body: String(m.Body ?? '') };
  },
  remove: async (receiptHandle) => {
    await client.send(new DeleteMessageCommand({ QueueUrl: lane, ReceiptHandle: receiptHandle }));
  },
  // The body as it came, so a redrive returns it to the lane unchanged; the
  // reason rides beside it. The message id deduplicates a retried move.
  deadLetter: async (body, reason, messageId) => {
    await client.send(new SendMessageCommand({
      QueueUrl: dead,
      MessageBody: body,
      MessageGroupId: LANE,
      MessageDeduplicationId: messageId,
      MessageAttributes: { reason: { DataType: 'String', StringValue: reason.slice(0, 1000) } },
    }));
  },
});
