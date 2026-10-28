/**
 * The retrier Lambda: dispatch/webhook/retry.mjs bound to SQS, invoked by
 * the not-run rule with the ECS stop event of a dispatcher task that failed
 * to start (infra/governor.cfn.yml, RetrierFunction). Packaged from this
 * directory beside the receiver and the starter; the AWS SDK is the
 * runtime's own.
 */

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LANE } from './fire.mjs';
import { retryFire } from './retry.mjs';

const env = process.env;
const sqs = new SQSClient({});

/**
 * @param {string} queueUrl
 * @param {unknown} message
 * @param {string} dedupId
 */
const send = async (queueUrl, message, dedupId) => {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: LANE,
    MessageDeduplicationId: dedupId,
  }));
};

/** @type {import('./retry.mjs').Deps} */
const deps = {
  requeue: (message, dedupId) => send(String(env.FIRES_QUEUE_URL), message, dedupId),
  deadLetter: (message, dedupId) => send(String(env.DEAD_QUEUE_URL), message, dedupId),
  log: (event, context = {}) => console.log(JSON.stringify({ event, ...context })),
};

/** @param {import('./retry.mjs').StopEvent} event */
export const handler = async (event) => retryFire(event, deps);
