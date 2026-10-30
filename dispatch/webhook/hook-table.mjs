/**
 * The hook table: what the receiver knows of each served repo's hooks, so it
 * can refuse a revoked key or a removed hook before the fire reaches the
 * queue.
 *
 * The receiver reads no config file. The task does, and each time it reads a
 * served repo's file it writes that repo's one item here ({@link hookTable}
 * `publish`): `hooks#<repo>` / `listed`, a map from each hook's name to its
 * `keyVersion`, empty when the file turns hooks off or lists none, and beside
 * it a map from each name to its `perHour`. The receiver reads the item after
 * a request's signature checks out (route.mjs). A hook the map does not name
 * is refused, and so is a key version older than the map's, as {@link
 * HOOK_KEY_STALE}, which pages. A repo with no item yet is queued, and the
 * task decides (dispatch/hooks.mjs), so a lost item costs task starts and
 * nothing more.
 *
 * The receiver also counts each hook's fires here ({@link hookTable}
 * `count`), one item per hook and clock hour, `fires#<repo>#<hook>` /
 * `<hour>`, raised only while under the hook's cap and expired by `ttl` when
 * the hour ends. A lost count item lets at most one more hour's cap through.
 *
 * It is a table of its own, apart from the state table
 * (docs/constraints/dispatcher-state.md): the receiver is internet-facing,
 * and the state table holds records other checks trust. The item has no
 * expiry: a repo that stops being served keeps its last list, and its fires
 * still reach the task, which refuses them.
 *
 * A leaf beside hook.mjs: the Lambda packages dispatch/webhook/ whole, and the
 * task image copies this file.
 */

import { ConditionalCheckFailedException, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { HOOK_PER_HOUR } from './fire.mjs';

// Defined in the pure leaf fire.mjs, so route.mjs need not load the SDK for it.
export { HOOK_KEY_STALE } from './fire.mjs';

const HOUR_MS = 60 * 60 * 1000;

/** @param {unknown} error */
const conditionFailed = (error) => error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException';

/** @param {number} n */
const positive = (n) => Number.isSafeInteger(n) && n >= 1;

/**
 * A repo's one item. GitHub's repo names are not case-sensitive, so a path
 * written in another case reaches the same item.
 *
 * @param {string} repo
 */
const keyOf = (repo) => ({ pk: { S: `hooks#${repo.toLowerCase()}` }, sk: { S: 'listed' } });

/**
 * @typedef {{ keyVersion: number, perHour: number }} Listed A hook as the
 *   repo's file named it when the task last read it.
 * @typedef {{
 *   listed: (repo: string) => Promise<ReadonlyMap<string, Listed> | null>,
 *   publish: (repo: string, hooks: ReadonlyArray<{ name: string } & Listed>, at: string) => Promise<boolean>,
 *   count: (repo: string, hook: string, at: number, cap: number) => Promise<boolean>,
 * }} HookTable
 *   `listed`: each hook the repo's file listed when the task last read it,
 *   its key version and its cap; null when the repo has no item. An item
 *   written before hooks had a cap gives each one 20. A read that fails, or
 *   an item that is malformed, throws: never a missing item.
 *   `publish`: the repo's whole list, as the file read at `at` holds it, put
 *   unless a write from a later read stands, false then. Any other failure
 *   throws.
 *   `count`: one more fire of the hook in the clock hour holding `at`, taken
 *   only while that hour's count is under `cap`; false when it is not. Any
 *   other failure throws.
 */

/**
 * @param {Pick<import('@aws-sdk/client-dynamodb').DynamoDBClient, 'send'>} client
 * @param {string} table
 * @returns {HookTable}
 */
export const hookTable = (client, table) => ({
  listed: async (repo) => {
    const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: keyOf(repo), ConsistentRead: true }));
    if (item === undefined) return null;
    const map = item.hooks?.M;
    const caps = item.perHour === undefined ? {} : item.perHour.M;
    /** @type {Array<[string, Listed]>} */
    const entries = Object.entries(map ?? {}).map(([name, value]) => [name, {
      keyVersion: Number(value.N),
      perHour: Object.hasOwn(caps ?? {}, name) ? Number(caps?.[name]?.N) : HOOK_PER_HOUR,
    }]);
    // A malformed item is a failed read, never a missing one.
    if (map === undefined || caps === undefined || entries.some(([, { keyVersion, perHour }]) => !positive(keyVersion) || !positive(perHour))) {
      throw new Error(`the hook table's item for ${repo} is malformed: ${JSON.stringify(item)}`);
    }
    return new Map(entries);
  },
  // Only over an item from an earlier read: two turns racing cannot put an
  // older file's list back.
  publish: async (repo, hooks, at) => {
    try {
      await client.send(new PutItemCommand({
        TableName: table,
        Item: {
          ...keyOf(repo),
          at: { S: at },
          hooks: { M: Object.fromEntries(hooks.map(({ name, keyVersion }) => [name, { N: String(keyVersion) }])) },
          perHour: { M: Object.fromEntries(hooks.map(({ name, perHour }) => [name, { N: String(perHour) }])) },
        },
        ConditionExpression: 'attribute_not_exists(pk) OR #at <= :at',
        ExpressionAttributeNames: { '#at': 'at' },
        ExpressionAttributeValues: { ':at': { S: at } },
      }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  },
  // Raised in one conditional update, never read then written: two fires
  // racing cannot both take the last place.
  count: async (repo, hook, at, cap) => {
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    try {
      await client.send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `fires#${repo.toLowerCase()}#${hook}` }, sk: { S: new Date(hour).toISOString().slice(0, 13) } },
        UpdateExpression: 'ADD #fires :one SET #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#fires) OR #fires < :cap',
        ExpressionAttributeNames: { '#fires': 'fires', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': { N: '1' }, ':cap': { N: String(cap) }, ':ttl': { N: String((hour + HOUR_MS) / 1000) } },
      }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  },
});
