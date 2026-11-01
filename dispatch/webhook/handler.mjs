/**
 * The webhook receiver Lambda: dispatch/webhook/route.mjs bound to Secrets
 * Manager and SQS. Packaged from this directory by `aws cloudformation
 * package` in .github/workflows/deploy.yml (infra/governor.cfn.yml,
 * WebhookFunction); the AWS SDK is the runtime's own.
 *
 * It starts nothing itself: every fire goes on the lane, one message group,
 * which the dispatcher task reads in the order the fires arrived
 * (dispatch/lane.mjs). Once a request has queued its fires, it calls the
 * starter asynchronously (poke.mjs), which starts a task if none runs.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { poking } from './poke.mjs';
import { hookTable } from './hook-table.mjs';
import { LANE, ownersOf, selectLabelsOf } from './fire.mjs';
import { appIdOf, cachedSecret, handle, handleSchedule } from './route.mjs';

const env = process.env;
const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});
const lambda = new LambdaClient({});
// No table named: every hook request's read fails, answered 503 and logged
// at error, never queued as if the repo had no item. A delivery's read of
// the repo's switches fails too, logged at error, and drops no fire.
const unset = async () => { throw new Error('HOOK_TABLE is unset'); };
const hooks = env.HOOK_TABLE
  ? hookTable(new DynamoDBClient({}), env.HOOK_TABLE)
  : { listed: unset, count: unset, switches: unset };

/** @type {import('./route.mjs').Deps} */
const deps = {
  secret: cachedSecret(async () => {
    const read = await secrets.send(new GetSecretValueCommand({ SecretId: String(env.WEBHOOK_SECRET_ID) }));
    return String(read.SecretString ?? '');
  }),
  // Every hook key's root (hook.mjs): read only when a hook request comes.
  hookSecret: cachedSecret(async () => {
    const read = await secrets.send(new GetSecretValueCommand({ SecretId: String(env.HOOK_SECRET_ID) }));
    return String(read.SecretString ?? '');
  }),
  // The hooks each repo's file listed when the task last read it: read
  // after a hook request's signature, before it queues.
  listedHooks: hooks.listed,
  // Each hook's fires this clock hour, counted under its cap before it queues.
  countFire: hooks.count,
  // Each repo's switches as the task last read its file: read once a
  // delivery would queue a fire, to drop the fires whose switch is off.
  repoSwitches: hooks.switches,
  now: Date.now,
  // The stack's owner list (DispatchOwners); unset is no owner, so nothing routes.
  owners: ownersOf(env.DISPATCH_OWNERS),
  // The stack's SelectLabels; unset is every label.
  selectLabels: selectLabelsOf(env.SELECT_LABELS),
  appId: appIdOf(env.APP_ID),
  enqueue: async (message, dedupId) => {
    const sent = await sqs.send(new SendMessageCommand({
      QueueUrl: String(env.FIRES_QUEUE_URL),
      MessageBody: JSON.stringify(message),
      MessageGroupId: LANE,
      ...(dedupId ? { MessageDeduplicationId: dedupId } : {}),
    }));
    return String(sent.MessageId ?? '');
  },
  // One object, which Lambda's JSON log format nests under `message`, so a
  // metric filter can match the event field and nothing a caller wrote.
  log: (event, context = {}) => console.log({ event, ...context }),
};

/**
 * The starter, invoked asynchronously: the receiver waits for Lambda to take
 * the call, not for the task.
 *
 * @param {unknown} payload
 */
const invokeStarter = async (payload) => {
  await lambda.send(new InvokeCommand({ FunctionName: String(env.STARTER_FUNCTION), InvocationType: 'Event', Payload: JSON.stringify(payload) }));
};

/**
 * Two callers: the EventBridge schedule rule, whose Input is the bare
 * `{"kind":"schedule"}`, and the Function URL, whose event carries its path,
 * headers and a body: a hook's path, or any other for GitHub's deliveries.
 *
 * @param {{ kind?: string, rawPath?: string, headers?: Record<string, string>, body?: string, isBase64Encoded?: boolean }} request
 */
export const handler = async (request) => {
  const { deps: queueing, poke } = poking(deps, invokeStarter);
  if (request.kind === 'schedule') {
    const answer = await handleSchedule(queueing);
    await poke();
    return answer;
  }
  const { statusCode, body } = await handle({ path: request.rawPath, headers: request.headers ?? {}, body: request.body, isBase64Encoded: request.isBase64Encoded }, queueing);
  await poke();
  return { statusCode, headers: { 'content-type': 'text/plain' }, body };
};
