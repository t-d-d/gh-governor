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
 * The lists form a chain, `auto` within `task`. Until `trust.task` exists,
 * `pickup.by` is the task list (`byOf`, dispatch/pickup.mjs). A list the
 * file leaves unset is narrowed to fit the lists it sets, never widened
 * ({@link autoOf}); two lists the file sets that break the chain are a
 * schema fault.
 */

import { ASSOCIATIONS, PICKUP_BY, SUMMONERS } from './webhook/fire.mjs';

/** The value that stands for any account GitHub marks as a bot. */
export const BOT = 'BOT';

/** Every value a trust list may name. */
export const TRUST_VALUES = /** @type {const} */ ([...ASSOCIATIONS, BOT]);

/**
 * Whose issues and PRs governor sets going by itself where the file sets no
 * `trust.auto`, before narrowing: the authors with a say.
 *
 * @type {readonly string[]}
 */
export const AUTO = Object.freeze([...SUMMONERS]);

/**
 * What an issue's or PR's author counts as in a trust list: `BOT` for an
 * account GitHub marks as a bot (`bot`, from its user's `type`) or whose
 * login ends in `[bot]`, as a GitHub App's does, else the author's
 * `author_association`, `NONE` where none was read.
 *
 * @param {{ author?: string, association?: string, bot?: boolean }} row
 */
export const authorKind = ({ author, association, bot }) => (bot === true || /\[bot\]$/.test(String(author ?? '')) ? BOT : String(association ?? 'NONE'));

/**
 * Whether `list` lets in the author of an issue or PR.
 *
 * @param {readonly string[]} list
 * @param {{ author?: string, association?: string, bot?: boolean }} row
 */
export const lets = (list, row) => list.includes(authorKind(row));

/**
 * A repo's `trust.auto`: the list the file sets, or the default narrowed to
 * fit the task list, `pickup.by` where the file sets it.
 *
 * @param {{ trust?: { auto?: readonly string[] }, pickup?: { by?: readonly string[] } }} config
 * @returns {readonly string[]}
 */
export const autoOf = (config) => {
  if (config.trust?.auto !== undefined) return config.trust.auto;
  // pickup.by as `byOf` (dispatch/pickup.mjs) reads it, which imports
  // periodics.mjs, which imports this.
  const task = config.pickup?.by ?? PICKUP_BY;
  return AUTO.filter((a) => task.includes(a));
};

/**
 * The lists the file leaves unset that governor narrowed to fit the chain,
 * each with what it now holds.
 *
 * @param {{ trust?: { auto?: readonly string[] }, pickup?: { by?: readonly string[] } }} config
 * @returns {Array<{ list: string, to: readonly string[] }>}
 */
export const narrowedLists = (config) => {
  const auto = autoOf(config);
  return config.trust?.auto === undefined && auto.length < AUTO.length ? [{ list: 'auto', to: auto }] : [];
};

/** What each list opens, as the config check says it. */
const OPENS = Object.freeze({
  auto: 'governor sets work going by itself, with no person choosing the ticket, on their issues and PRs: a spec session or a message to the ticket\'s owner session when its wait ends or its blocker closes, a place in a periodic\'s counts and in the list its prompt carries, and the conflicts check\'s message and fallback session',
});

/**
 * Where a list the file sets reaches beyond the authors with a say: one line
 * per list, naming the values and what they open. Such a file works, so
 * this is no fault.
 *
 * @param {{ trust?: { auto?: readonly string[] } }} config
 * @returns {string[]}
 */
export const trustExposures = (config) => {
  const beyond = (config.trust?.auto ?? []).filter((a) => !SUMMONERS.has(a));
  if (beyond.length === 0) return [];
  const named = beyond.length === 1 ? beyond[0] : `${beyond.slice(0, -1).join(', ')} and ${beyond.at(-1)}`;
  return [`trust.auto: lets in ${named} authors, beyond owners, members and collaborators: ${OPENS.auto}`];
};
