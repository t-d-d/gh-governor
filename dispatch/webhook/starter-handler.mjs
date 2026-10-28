/**
 * The starter Lambda: dispatch/webhook/starter.mjs bound to ECS, invoked by
 * the lane's event source one fire at a time (infra/governor.cfn.yml,
 * StarterFunction). Packaged from this directory beside the receiver; the
 * AWS SDK is the runtime's own.
 *
 * The task it starts is the schedule fire's: same cluster, task definition,
 * subnets and container override, read from the environment the stack sets.
 */

import { ECSClient, ListTasksCommand, RunTaskCommand } from '@aws-sdk/client-ecs';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { containerOverride } from './fire.mjs';
import { handleRecords } from './starter.mjs';

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
  runTask: async (fire, startedBy) => {
    const started = await ecs.send(new RunTaskCommand({
      cluster: String(env.CLUSTER),
      startedBy,
      taskDefinition: String(env.TASK_FAMILY),
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: { subnets: String(env.SUBNET_IDS).split(','), assignPublicIp: 'ENABLED' },
      },
      overrides: containerOverride(String(env.CONTAINER_NAME), fire),
    }));
    const arn = started.tasks?.[0]?.taskArn;
    if (!arn) throw new Error(`RunTask placed nothing: ${JSON.stringify(started.failures ?? [])}`);
    return arn;
  },
  defer: async (receiptHandle, seconds) => {
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: String(env.FIRES_QUEUE_URL),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    }));
  },
  log: (event, context = {}) => console.log(JSON.stringify({ event, ...context })),
};

/** @param {{ Records?: Array<{ messageId: string, receiptHandle: string, body: string }> }} event */
export const handler = async (event) => handleRecords(event.Records ?? [], deps);
