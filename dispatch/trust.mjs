/**
 * A repo's `trust` section: whose GitHub text governor acts on, by what that
 * text can cause. Each list takes GitHub's `author_association` values, and
 * `BOT`, which stands for any account GitHub marks as a bot.
 *
 * `auto` is whose issue or PR governor may set going by itself, with no
 * person choosing that ticket: the spec session or owner message after a
 * blocker's close or an ended wait (dispatch/unblocked-fire.mjs,
 * dispatch/waits.mjs), a periodic's issue counts and listings
 * (dispatch/periodics.mjs), and the conflicts check's message and its
 * fallback session (dispatch/conflicts.mjs). It defaults to the authors with
 * a say, and may never hold `BOT` (dispatch/repo-config.mjs).
 *
 * `relay` is whose text may reach a session that is already running: a
 * comment or review, and a session link or `governor:subscribe` line in the
 * body of an issue or PR they opened ({@link relayOf}). It defaults to the
 * authors with a say and any bot ({@link RELAY}). The receiver judges it from
 * the repo's hook-table item, and the task again from the file.
 *
 * The lists form a chain, `auto` within `task` within `relay`. Until `trust.task` exists,
 * `pickup.by` is the task list (`byOf`, dispatch/pickup.mjs). A list the
 * file leaves unset is narrowed to fit the lists it sets, never widened
 * ({@link autoOf}); two lists the file sets that break the chain are a
 * schema fault.
 */

import { BOT, PICKUP_BY, RELAY, SUMMONERS, TRUST_VALUES, authorKind, lets } from './webhook/fire.mjs';

export { BOT, RELAY, TRUST_VALUES, authorKind, lets };

/**
 * Whose issues and PRs governor sets going by itself where the file sets no
 * `trust.auto`, before narrowing: the authors with a say.
 *
 * @type {readonly string[]}
 */
export const AUTO = Object.freeze([...SUMMONERS]);

/**
 * @typedef {{ trust?: { auto?: readonly string[], relay?: readonly string[] }, pickup?: { by?: readonly string[] } }} TrustConfig
 */

/**
 * `list` narrowed to fit inside each list in `above`, never widened. `BOT`
 * is left aside: a list that may not hold it is not narrowed for it.
 *
 * @param {readonly string[]} list
 * @param {ReadonlyArray<readonly string[]>} above
 */
const within = (list, above) => list.filter((a) => above.every((outer) => outer.includes(a)));

/**
 * A repo's `trust.relay`: whose text may reach a session that is already
 * running. The list the file sets, or {@link RELAY}. Nothing sits above it
 * yet, so an unset relay is never narrowed.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const relayOf = (config) => config.trust?.relay ?? RELAY;

/**
 * A repo's task list: whose tickets pickup may start. Until `trust.task`
 * exists it is `pickup.by` where the file sets it, else the default
 * narrowed to fit a `trust.relay` the file sets.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const taskOf = (config) => {
  if (config.pickup?.by !== undefined) return config.pickup.by;
  return config.trust?.relay === undefined ? PICKUP_BY : within(PICKUP_BY, [config.trust.relay]);
};

/**
 * The lists the file sets above `list` in the chain `auto` ⊆ `task` ⊆
 * `relay`, by the names the file gives them: what an unset `list` is
 * narrowed to fit.
 *
 * @param {TrustConfig} config
 * @param {'auto' | 'task'} list
 * @returns {string[]}
 */
export const fitsInside = (config, list) => [
  ...(list === 'auto' && config.pickup?.by !== undefined ? ['pickup.by'] : []),
  ...(config.trust?.relay === undefined ? [] : ['trust.relay']),
];

/**
 * A repo's `trust.auto`: the list the file sets, or the default narrowed to
 * fit the task list and a `trust.relay` the file sets.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const autoOf = (config) => {
  if (config.trust?.auto !== undefined) return config.trust.auto;
  return within(AUTO, [taskOf(config), ...(config.trust?.relay === undefined ? [] : [config.trust.relay])]);
};

/**
 * The lists the file leaves unset that governor narrowed to fit the chain,
 * each with what it now holds.
 *
 * @param {TrustConfig} config
 * @returns {Array<{ list: 'auto' | 'task', to: readonly string[] }>}
 */
export const narrowedLists = (config) => {
  const auto = autoOf(config);
  const task = taskOf(config);
  return [
    ...(config.trust?.auto === undefined && auto.length < AUTO.length ? [{ list: /** @type {const} */ ('auto'), to: auto }] : []),
    ...(config.pickup?.by === undefined && task.length < PICKUP_BY.length ? [{ list: /** @type {const} */ ('task'), to: task }] : []),
  ];
};

/** What each list opens, as the config check says it. */
const OPENS = Object.freeze({
  auto: 'governor sets work going by itself, with no person choosing the ticket, on their issues and PRs: a spec session or a message to the ticket\'s owner session when its wait ends or its blocker closes, a place in a periodic\'s counts and in the list its prompt carries, and the conflicts check\'s message and fallback session',
  relay: 'their text reaches a running session: their comments and reviews on a PR or issue a session owns or subscribes to are relayed into it, and a session link or a governor:subscribe line in the body of an issue or PR they open routes everyone\'s comments and events there into that session',
});

/** What `BOT` in a relay the file sets opens beyond the three. */
const BOT_RELAY = 'a bot\'s comments reach a running session, so a bot that quotes strangers\' issues or comments, such as a triage or summary bot, carries their text into it';

/** @param {readonly string[]} values */
const named = (values) => (values.length === 1 ? String(values[0]) : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);

/**
 * Where a list the file sets reaches beyond the authors with a say: one line
 * per list, naming the values and what they open. Such a file works, so
 * this is no fault.
 *
 * @param {TrustConfig} config
 * @returns {string[]}
 */
export const trustExposures = (config) => {
  /** @type {string[]} */
  const lines = [];
  const auto = (config.trust?.auto ?? []).filter((a) => !SUMMONERS.has(a));
  if (auto.length > 0) lines.push(`trust.auto: lets in ${named(auto)} authors, beyond owners, members and collaborators: ${OPENS.auto}`);
  const relay = (config.trust?.relay ?? []).filter((a) => !SUMMONERS.has(a));
  const people = relay.filter((a) => a !== BOT);
  if (relay.length > 0) {
    lines.push(`trust.relay: lets in ${named(relay)} authors, beyond owners, members and collaborators: ${[
      ...(people.length > 0 ? [OPENS.relay] : []),
      ...(relay.includes(BOT) ? [BOT_RELAY] : []),
    ].join('; and ')}`);
  }
  return lines;
};
