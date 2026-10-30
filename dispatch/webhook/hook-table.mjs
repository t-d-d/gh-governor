/**
 * The hook table: what the receiver knows of each served repo's hooks, so it
 * can refuse a revoked key or a removed hook before the fire reaches the
 * queue.
 *
 * The receiver reads no config file. The task does, and each time it reads a
 * served repo's file it writes that repo's one item here ({@link hookTable}
 * `publish`): `hooks#<repo>` / `listed`, a map from each hook's name to its
 * `keyVersion`, empty when the file turns hooks off or lists none. The
 * receiver reads the item after a request's signature checks out
 * (route.mjs). A hook the map does not name is refused, and so is a key
 * version older than the map's, as {@link HOOK_KEY_STALE}, which pages. A
 * repo with no item yet is queued, and the task decides (dispatch/hooks.mjs),
 * so a lost item costs task starts and nothing more.
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

import { ConditionalCheckFailedException, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

/** The event a fire signed with a stale key version logs, at error, at the receiver or the task; `governor-hook-key-stale` pages on it. */
export const HOOK_KEY_STALE = 'hook-key-stale';

/**
 * A repo's one item. GitHub's repo names are not case-sensitive, so a path
 * written in another case reaches the same item.
 *
 * @param {string} repo
 */
const keyOf = (repo) => ({ pk: { S: `hooks#${repo.toLowerCase()}` }, sk: { S: 'listed' } });

/**
 * @typedef {{
 *   listed: (repo: string) => Promise<ReadonlyMap<string, number> | null>,
 *   publish: (repo: string, hooks: ReadonlyArray<{ name: string, keyVersion: number }>, at: string) => Promise<boolean>,
 * }} HookTable
 *   `listed`: each hook the repo's file listed when the task last read it,
 *   and its key version; null when the repo has no item. A read that fails,
 *   or an item that is malformed, throws: never a missing item.
 *   `publish`: the repo's whole list, as the file read at `at` holds it, put
 *   unless a write from a later read stands, false then. Any other failure
 *   throws.
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
    /** @type {Array<[string, number]>} */
    const entries = Object.entries(map ?? {}).map(([name, value]) => [name, Number(value.N)]);
    // A malformed item is a failed read, never a missing one.
    if (map === undefined || entries.some(([, version]) => !Number.isSafeInteger(version) || version < 1)) {
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
        Item: { ...keyOf(repo), at: { S: at }, hooks: { M: Object.fromEntries(hooks.map(({ name, keyVersion }) => [name, { N: String(keyVersion) }])) } },
        ConditionExpression: 'attribute_not_exists(pk) OR #at <= :at',
        ExpressionAttributeNames: { '#at': 'at' },
        ExpressionAttributeValues: { ':at': { S: at } },
      }));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  },
});
