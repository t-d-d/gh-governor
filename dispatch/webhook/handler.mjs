/**
 * The webhook receiver Lambda: dispatch/webhook/route.mjs bound to Secrets
 * Manager and SQS. Packaged from this directory by `aws cloudformation
 * package` in .github/workflows/deploy.yml (infra/governor.cfn.yml,
 * WebhookFunction); the AWS SDK is the runtime's own.
 *
 * It starts nothing itself: every fire goes on the lane the starter drains
 * (starter-handler.mjs), one message group, so fires start one at a time in
 * the order they arrived.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { hookTable } from './hook-table.mjs';
import { LANE, ownersOf, selectLabelsOf } from './fire.mjs';
import { appIdOf, cachedSecret, handle, handleSchedule } from './route.mjs';

const env = process.env;
const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});
// No table named: every hook request's read fails, answered 503 and logged
// at error, never queued as if the repo had no item.
const hooks = env.HOOK_TABLE
  ? hookTable(new DynamoDBClient({}), env.HOOK_TABLE)
  : { listed: async () => { throw new Error('HOOK_TABLE is unset'); } };

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
 * Two callers: the EventBridge schedule rule, whose Input is the bare
 * `{"kind":"schedule"}`, and the Function URL, whose event carries its path,
 * headers and a body: a hook's path, or any other for GitHub's deliveries.
 *
 * @param {{ kind?: string, rawPath?: string, headers?: Record<string, string>, body?: string, isBase64Encoded?: boolean }} request
 */
export const handler = async (request) => {
  if (request.kind === 'schedule') return handleSchedule(deps);
  const { statusCode, body } = await handle({ path: request.rawPath, headers: request.headers ?? {}, body: request.body, isBase64Encoded: request.isBase64Encoded }, deps);
  return { statusCode, headers: { 'content-type': 'text/plain' }, body };
};
