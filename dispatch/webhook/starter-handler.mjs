/**
 * The starter Lambda: dispatch/webhook/starter.mjs bound to ECS and the fire
 * lane, invoked by the receiver, by every dispatcher task's stop event and
 * by the backstop schedule (infra/governor.cfn.yml, StarterFunction).
 * Packaged from this directory beside the receiver; the AWS SDK is the
 * runtime's own.
 *
 * The task it starts carries no fire: it takes its fires off the lane
 * (dispatch/lane.mjs).
 */

import { ECSClient, ListTasksCommand, RunTaskCommand } from '@aws-sdk/client-ecs';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { LANE_COUNTS, laneCount } from './fire.mjs';
import { startNext } from './starter.mjs';

const env = process.env;
const ecs = new ECSClient({});
const sqs = new SQSClient({});

/** @type {import('./starter.mjs').Deps} */
const deps = {
  running: async () => {
    const listed = await ecs.send(new ListTasksCommand({
      cluster: String(env.CLUSTER),
      family: String(env.TASK_FAMILY),
      desiredStatus: 'RUNNING',
    }));
    return listed.taskArns ?? [];
  },
  waiting: async () => {
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: String(env.FIRES_QUEUE_URL), AttributeNames: [...LANE_COUNTS] }));
    return laneCount(Attributes);
  },
  runTask: async (startedBy) => {
    const started = await ecs.send(new RunTaskCommand({
      cluster: String(env.CLUSTER),
      startedBy,
      taskDefinition: String(env.TASK_FAMILY),
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: { subnets: String(env.SUBNET_IDS).split(','), assignPublicIp: 'ENABLED' },
      },
    }));
    const arn = started.tasks?.[0]?.taskArn;
    if (!arn) throw new Error(`RunTask placed nothing: ${JSON.stringify(started.failures ?? [])}`);
    return arn;
  },
  // One object, which Lambda's JSON log format nests under `message`, so a
  // metric filter can match the event field.
  log: (event, context = {}) => console.log({ event, ...context }),
  now: Date.now,
  // Kept across calls in this execution environment.
  memory: {},
};

/** @param {unknown} event */
export const handler = async (event) => {
  await startNext(event, deps);
};
