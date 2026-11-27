/**
 * The measures a periodic's limits count (dispatch/periodics.mjs), one
 * entry each. An entry holds everything governor knows of its measure:
 *
 * - `name`: its key in a periodic's `when`, and the `counted` a
 *   `periodics` fire carries (fire.mjs).
 * - `wakes`: whether a webhook delivery is one it counts. The receiver
 *   queues a `periodics` fire naming it for each delivery it wakes on
 *   (route.mjs), carrying `base` where the entry gives one, unless the
 *   repo's hook-table item says no limit in its file names it.
 * - `read`: its window, what happened after a time, read afresh from
 *   GitHub, oldest first. A read that fails throws.
 * - `heading`: what the lines under a periodic's prompt call it.
 * - `line`: what a heartbeat line calls one and many (dispatch/heartbeat.mjs).
 * - `describe`: what the schema says it counts (dispatch/repo-config.mjs).
 * - `filters`: the settings its object form takes beside `count`. Each
 *   one's value is a list of at least one string. A filter says what the
 *   schema says of it, how the prompt names it, and which of the window's
 *   rows it keeps. A filter may also wake its measure: `wakes` then says
 *   which deliveries do, and the receiver queues a `periodics` fire for
 *   them only where a limit of the measure has the filter, as the repo's
 *   hook-table item lists (route.mjs). `labels` wakes its measure on a
 *   label change, since an issue often gets its labels just after it opens.
 *
 * The schema's keys, the receiver's fires, the fire's parser, the window
 * reads, the prompt and the heartbeat all read this table, so a new
 * measure is one entry here. `days` and `hours` are not entries: they are
 * one timer in two units, which comes due on the sweep and reads no
 * window, and no webhook event wakes them.
 *
 * Pure, and a leaf: the Lambda packages dispatch/webhook/ whole, and the
 * task image copies this file (dispatch/Dockerfile).
 */

/**
 * @typedef {{ number: number, title: string, at: string, labels?: readonly string[] }} Counted One item a
 *   measure counted, and when it happened. An issue carries the labels it
 *   had when the window was read.
 * @typedef {{
 *   defaultBranch: () => Promise<string>,
 *   mergedSince: (base: string, since: string) => Promise<Counted[]>,
 *   issuesOpenedSince: (since: string, by?: readonly string[]) => Promise<Counted[]>,
 *   issuesClosedSince: (since: string, by?: readonly string[]) => Promise<Counted[]>,
 * }} WindowReader The repo's reads a measure's window takes (scripts/lib/github-app.mjs).
 * @typedef {{ branch: () => Promise<string>, auto: readonly string[] }} WindowContext
 *   `branch`: the default branch, the fire's where it names one, else read
 *   once for the turn. `auto`: the repo's `trust.auto` (dispatch/trust.mjs):
 *   an issue is counted only where it lets its author in.
 * @typedef {{ filename: string, previous?: string }} ChangedFile A file a pull
 *   request changed, and the path a rename left.
 * @typedef {{
 *   files: (number: number) => Promise<ChangedFile[]>,
 *   globMatches: (glob: string, path: string) => boolean,
 *   filesListed: number,
 * }} FilterContext What a filter reads beside the row: a pull request's
 *   files, read at most once a check; the pattern grammar of the human-only
 *   list (dispatch/checklist.mjs); and the most files GitHub lists for one
 *   pull request. This file is a leaf the receiver packages, so the task
 *   hands them in.
 * @typedef {{
 *   describe: string,
 *   heading: (values: readonly string[]) => string,
 *   keep: (row: Counted, values: readonly string[], context: FilterContext) => Promise<boolean>,
 *   wakes?: (event: string | undefined, payload: any) => boolean,
 * }} Filter One setting a measure's object form takes beside `count`.
 * @typedef {{
 *   name: string,
 *   wakes: (event: string | undefined, payload: any, main: string | null) => { base?: string } | null,
 *   read: (reader: any, since: string, context: WindowContext) => Promise<Counted[]>,
 *   heading: string,
 *   line: readonly [string, string],
 *   describe: string,
 *   filters: Readonly<Record<string, Filter>>,
 * }} Measure
 */

/** @param {any} payload */
const issueNumbered = (payload) => typeof payload?.issue?.number === 'number';

/**
 * Whether a delivery is a label added to an issue, or taken off one.
 *
 * @param {string | undefined} event
 * @param {any} payload
 */
const relabelled = (event, payload) => event === 'issues' && (payload?.action === 'labeled' || payload?.action === 'unlabeled') && issueNumbered(payload);

/**
 * `labels` on an issues measure: an issue counts where it carries every
 * label listed, in any case, as GitHub matches labels. The labels are
 * those the window's read gave, which is the check's, so the filter reads
 * nothing of its own. A label change wakes the measure where `wakes` says
 * the issue can count toward it.
 *
 * @param {string} happened What happened to the issues the measure counts, `opened` or `closed`, for the schema's text.
 * @param {(payload: any) => boolean} counts Whether the issue a label change names can count toward the measure.
 * @returns {Filter}
 */
const labelsFilter = (happened, counts) => ({
  describe: `Count only the issues ${happened} that carry every one of these labels, a list of at least one, matched in any case. Governor reads the labels an issue carries when the check runs, not the ones it had when it ${happened}, and a label added to an issue or taken off one checks the limit again. \`{ "count": 10, "labels": ["type: bug"] }\` runs after ten such issues carry \`type: bug\`, and \`{ "count": 1, "labels": ["type: bug", "sev: 1"] }\` runs for each issue that carries both.`,
  heading: (values) => `carrying the label${values.length === 1 ? '' : 's'} ${values.map((v) => `\`${v}\``).join(' and ')}`,
  keep: async (row, values) => {
    const carried = new Set((row.labels ?? []).map((label) => label.toLowerCase()));
    return values.every((label) => carried.has(label.toLowerCase()));
  },
  wakes: (event, payload) => relabelled(event, payload) && counts(payload),
});

/**
 * The table. A test may add an entry and take it out again, so every
 * reader reads it when it runs, never a copy taken at load. The one
 * exception is the config schema (dispatch/repo-config.mjs), built once
 * at load: an entry a test adds is not a key its `when` takes.
 *
 * @type {Measure[]}
 */
export const MEASURES = [
  {
    name: 'merges',
    // Counted by merge time into the default branch, never by comparing
    // commits: that stops at 250, and a busy week passes it.
    wakes: (event, payload, main) => {
      const pr = payload?.pull_request;
      return event === 'pull_request' && payload?.action === 'closed' && pr?.merged === true && main !== null && pr?.base?.ref === main ? { base: main } : null;
    },
    read: async (reader, since, { branch }) => /** @type {WindowReader} */ (reader).mergedSince(await branch(), since),
    heading: 'Pull requests merged into the default branch',
    line: ['merge', 'merges'],
    describe: 'Pull requests merged into the default branch since the last fire.',
    filters: {
      paths: {
        describe: 'Count only the merges that changed a file one of these patterns matches, a list of at least one, read as `review.humanOnly` reads its entries: a pattern with a slash is matched against the whole path from the root, one without matches a file of that name at any depth, `*` stays within a segment and `**` spans any. A rename counts under the path it left and the path it took. A merge that changed more files than GitHub lists, 3000, counts. `{ "count": 10, "paths": ["dispatch/turn.mjs", "dispatch/webhook/**"] }` runs after ten merges change that file or anything under that folder, and `{ "count": 1, "paths": ["infra/**"] }` runs on every change under `infra/`.',
        heading: (values) => `that changed a file matching ${values.map((v) => `\`${v}\``).join(' or ')}`,
        // Every path a merge changed, and each path a rename left.
        keep: async (row, values, { files, globMatches, filesListed }) => {
          const changed = await files(row.number);
          if (changed.length >= filesListed) return true;
          return changed.some((f) => [f.filename, ...(f.previous === undefined ? [] : [f.previous])].some((path) => values.some((glob) => globMatches(glob, path))));
        },
      },
    },
  },
  {
    name: 'issuesOpened',
    wakes: (event, payload) => (event === 'issues' && payload?.action === 'opened' && issueNumbered(payload) ? {} : null),
    read: (reader, since, { auto }) => /** @type {WindowReader} */ (reader).issuesOpenedSince(since, auto),
    heading: 'Issues opened',
    line: ['issue opened', 'issues opened'],
    describe: 'Issues opened since the last fire.',
    filters: { labels: labelsFilter('opened', () => true) },
  },
  {
    name: 'issuesClosed',
    wakes: (event, payload) => (event === 'issues' && payload?.action === 'closed' && issueNumbered(payload) ? {} : null),
    read: (reader, since, { auto }) => /** @type {WindowReader} */ (reader).issuesClosedSince(since, auto),
    heading: 'Issues closed',
    line: ['issue closed', 'issues closed'],
    describe: 'Issues closed since the last fire.',
    // An open issue counts toward no close, whatever its labels.
    filters: { labels: labelsFilter('closed', (payload) => payload?.issue?.state === 'closed') },
  },
];

/** The measures' names, in the table's order, read now. */
export const measureNames = () => MEASURES.map((m) => m.name);

/**
 * A measure by its name; undefined where the table has none.
 *
 * @param {string} name
 */
export const measureOf = (name) => MEASURES.find((m) => m.name === name);

/**
 * The measures a delivery wakes, each with the `base` its fire carries.
 * One a filter wakes names the filter as `by`: the receiver queues its
 * fire only where a limit of the measure has that filter (route.mjs). A
 * measure the delivery wakes by its own events is not woken again by a
 * filter.
 *
 * @param {string | undefined} event
 * @param {any} payload
 * @param {string | null} main The repo's default branch, null where the payload names none.
 * @returns {Array<{ name: string, base?: string, by?: string }>}
 */
export const wokenBy = (event, payload, main) => MEASURES.flatMap((m) => {
  const woken = m.wakes(event, payload, main);
  if (woken !== null) return [{ name: m.name, ...(woken.base === undefined ? {} : { base: woken.base }) }];
  const by = Object.entries(m.filters).find(([, filter]) => filter.wakes?.(event, payload) === true)?.[0];
  return by === undefined ? [] : [{ name: m.name, by }];
});
