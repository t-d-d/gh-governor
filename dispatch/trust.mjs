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
 * `task` is whose issue or PR may become work when a person sets it going:
 * pickup starts a ready ticket (`byOf`, dispatch/pickup.mjs), and a summons
 * starts a session (dispatch/dispatch-fire.mjs), only where its author is in
 * it ({@link taskOf}). It defaults to the authors with a say, and may never
 * hold `BOT`. The older `pickup.by` is read as it, and a file may not set
 * both (dispatch/repo-config.mjs).
 *
 * `relay` is whose text may reach a session that is already running: a
 * comment or review, and a session link or `governor:subscribe` line in the
 * body of an issue or PR they opened ({@link relayOf}). It defaults to the
 * authors with a say and any bot ({@link RELAY}). The receiver judges it from
 * the repo's hook-table item, and the task again from the file.
 *
 * `start` is who may set work going: whose ready label counts
 * (`judgeReady`, dispatch/start.mjs), and whose summons starts a session
 * (dispatch/dispatch-fire.mjs). It holds only the authors with a say, and a
 * repo may narrow it, never widen it ({@link startOf}). It sits outside the
 * chain below: it is about who acts, not whose text the work is about.
 *
 * `review` is whose PRs governor's PR review reads (dispatch/review.mjs):
 * a PR by an author it leaves out gets a `neutral` check, and a person
 * merges it ({@link reviewOf}). It defaults to the authors with a say
 * ({@link REVIEW}). Dependabot's bumps are read by the Dependabot list
 * whatever it says. The issue reviews read a ticket only where its author
 * is in it (dispatch/issue-review.mjs).
 *
 * The lists form a chain, `auto` within `task` within `relay` within
 * `review`, `BOT` left aside. A list the file leaves unset is narrowed to
 * fit the lists it sets, never widened ({@link autoOf}); two lists the file
 * sets that break the chain are a schema fault.
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
 * Whose PRs the PR review reads where the file sets no `trust.review`: the
 * authors with a say.
 *
 * @type {readonly string[]}
 */
export const REVIEW = Object.freeze([...SUMMONERS]);

/**
 * Who may set work going where the file sets no `trust.start`: the authors
 * with a say. It is also the most a file may set.
 *
 * @type {readonly string[]}
 */
export const START = Object.freeze([...SUMMONERS]);

/**
 * @typedef {{ trust?: { start?: readonly string[] | undefined, auto?: readonly string[] | undefined, task?: readonly string[] | undefined, relay?: readonly string[] | undefined, review?: readonly string[] | undefined } | undefined, pickup?: { by?: readonly string[] | undefined } | undefined }} TrustConfig
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
 * A repo's `trust.start`: who may set work going, by readying a ticket or
 * writing a summons. The list the file sets, or {@link START}.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const startOf = (config) => config.trust?.start ?? START;

/**
 * Whether a `trust.start` list leaves out any of the authors with a say.
 * Only then is a ready label's adder looked up: at the default, anyone who
 * can add a label but the author has triage access, and so is in it.
 *
 * @param {readonly string[]} start
 */
export const narrows = (start) => START.some((a) => !start.includes(a));

/**
 * Whether a repo's `trust.start` is narrowed ({@link narrows}).
 *
 * @param {TrustConfig} config
 */
export const startNarrowed = (config) => narrows(startOf(config));

/**
 * A repo's `trust.review`: whose PRs the PR review reads. The list the file
 * sets, or {@link REVIEW}. Nothing sits above it, so an unset review is
 * never narrowed.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const reviewOf = (config) => config.trust?.review ?? REVIEW;

/**
 * A repo's `trust.relay`: whose text may reach a session that is already
 * running. The list the file sets, else {@link RELAY} narrowed to fit a
 * `trust.review` the file sets. `BOT` is left aside, as the chain leaves
 * it: an unset relay keeps it whatever review says.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const relayOf = (config) => {
  if (config.trust?.relay !== undefined) return config.trust.relay;
  const review = config.trust?.review;
  return review === undefined ? RELAY : RELAY.filter((a) => a === BOT || review.includes(a));
};

/**
 * The task list as the file sets it: `trust.task`, or the older `pickup.by`
 * read as it. The schema refuses a file that sets both.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[] | undefined}
 */
export const taskSet = (config) => config.trust?.task ?? config.pickup?.by;

/**
 * The name a file gives its task list, where it sets one.
 *
 * @param {TrustConfig} config
 */
export const taskKey = (config) => (config.trust?.task === undefined ? 'pickup.by' : 'trust.task');

/**
 * A repo's `trust.task`: whose issue or PR may become work when a person
 * sets it going, by readying it or by a summons on it. The list the file
 * sets, as `trust.task` or the older `pickup.by`, else the default narrowed
 * to fit the relay list, which a `trust.relay` or `trust.review` the file
 * sets narrows.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const taskOf = (config) => taskSet(config) ?? within(PICKUP_BY, [relayOf(config)]);

/**
 * The lists the file sets above `list` in the chain `auto` ⊆ `task` ⊆
 * `relay` ⊆ `review`, by the names the file gives them: what an unset
 * `list` is narrowed to fit.
 *
 * @param {TrustConfig} config
 * @param {'auto' | 'task' | 'relay'} list
 * @returns {string[]}
 */
export const fitsInside = (config, list) => [
  ...(list === 'auto' && taskSet(config) !== undefined ? [taskKey(config)] : []),
  ...(list !== 'relay' && config.trust?.relay !== undefined ? ['trust.relay'] : []),
  ...(config.trust?.review === undefined ? [] : ['trust.review']),
];

/**
 * A repo's `trust.auto`: the list the file sets, or the default narrowed to
 * fit the task list and the relay list.
 *
 * @param {TrustConfig} config
 * @returns {readonly string[]}
 */
export const autoOf = (config) => config.trust?.auto ?? within(AUTO, [taskOf(config), relayOf(config)]);

/**
 * The lists the file leaves unset that governor narrowed to fit the chain,
 * each with what it now holds.
 *
 * @param {TrustConfig} config
 * @returns {Array<{ list: 'auto' | 'task' | 'relay', to: readonly string[] }>}
 */
export const narrowedLists = (config) => {
  const auto = autoOf(config);
  const task = taskOf(config);
  const relay = relayOf(config);
  return [
    ...(config.trust?.auto === undefined && auto.length < AUTO.length ? [{ list: /** @type {const} */ ('auto'), to: auto }] : []),
    ...(taskSet(config) === undefined && task.length < PICKUP_BY.length ? [{ list: /** @type {const} */ ('task'), to: task }] : []),
    ...(config.trust?.relay === undefined && relay.length < RELAY.length ? [{ list: /** @type {const} */ ('relay'), to: relay }] : []),
  ];
};

/** What each list opens, as the config check says it. */
const OPENS = Object.freeze({
  auto: 'governor sets work going by itself, with no person choosing the ticket, on their issues and PRs: a spec session or a message to the ticket\'s owner session when its wait ends or its blocker closes, a place in a periodic\'s counts and in the list its prompt carries, and the conflicts check\'s message and fallback session',
  task: 'their issues and PRs can become work: a ready label a person adds to their ticket starts pickup on it, and an @claude summons on their issue or PR starts a session there, with the issue or PR as its task',
  review: 'governor\'s PR review reads their pull requests: the model reads the title, the body and the changed lines, and a pass merges the pull request where review.merge is on, so their code can reach the default branch with no person reading it',
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
  // Only the list under its own name: the retired pickup.by, which the
  // check never warned of, is left as it was.
  const task = (config.trust?.task ?? []).filter((a) => !SUMMONERS.has(a));
  if (task.length > 0) lines.push(`trust.task: lets in ${named(task)} authors, beyond owners, members and collaborators: ${OPENS.task}`);
  const relay = (config.trust?.relay ?? []).filter((a) => !SUMMONERS.has(a));
  const people = relay.filter((a) => a !== BOT);
  if (relay.length > 0) {
    lines.push(`trust.relay: lets in ${named(relay)} authors, beyond owners, members and collaborators: ${[
      ...(people.length > 0 ? [OPENS.relay] : []),
      ...(relay.includes(BOT) ? [BOT_RELAY] : []),
    ].join('; and ')}`);
  }
  const review = (config.trust?.review ?? []).filter((a) => !SUMMONERS.has(a));
  if (review.length > 0) lines.push(`trust.review: lets in ${named(review)} authors, beyond owners, members and collaborators: ${OPENS.review}`);
  return lines;
};

/**
 * A ticket's author as a trust list judges it: as the receiver judges it,
 * with a ticket governor's own App filed (`app`, as the reader returns it)
 * let in as the App (`own`). Every place that judges a ticket's author
 * against a trust list reads it through this.
 *
 * @template {import('./webhook/fire.mjs').Author & { app?: boolean }} T
 * @param {T} row
 * @returns {T & { own: boolean }}
 */
export const ticketAuthor = (row) => ({ ...row, own: row.own === true || row.app === true });
