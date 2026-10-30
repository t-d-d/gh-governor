/**
 * Which open issues are dispatchable right now, and in what order.
 *
 * The dispatcher task has no model in the loop before dispatch, so the
 * selection rule lives here, unit-tested.
 *
 * Pure by design: it takes issue rows and a blocker map and returns rows. The
 * fetching belongs to `scripts/lib/github-app.mjs` and the walk to
 * `scripts/lib/dispatch-router.mjs`, so the interesting part — what counts as
 * eligible — is testable without a network or a GitHub token.
 *
 * Every ambiguous case resolves toward dropping the ticket. Dispatching one
 * that was not eligible puts an agent on work that is claimed, blocked, or
 * needs a human; skipping an eligible one costs nothing, because the next
 * fire re-selects whatever is still open. The dispatcher claims each ticket
 * it launches (`workflow: under development`, dispatch/turn.mjs), and
 * the drop of that label here is what keeps a claimed ticket from being
 * selected again.
 *
 * Unit-tested in `test/scripts/ready-work.test.ts`.
 */

/**
 * @typedef {object} IssueRow
 * @property {number} number
 * @property {string} [title]
 * @property {string} [state]
 * @property {string[]} [labels] Label names, already flattened from the API's
 *   objects by the caller.
 * @property {string} [created_at] ISO 8601.
 * @property {number} [openBlockers] The issue's open blockers, from its
 *   dependency summary (`issue_dependencies_summary.blocked_by`), where the
 *   row carries one.
 */

/**
 * @typedef {object} BlockerRow
 * @property {number} number
 * @property {string} [state] `open` or `closed`.
 */

/**
 * The labels a repo marks a ticket ready with, claims it with, and keeps it
 * out with. A served repo's come from its config file
 * (dispatch/repo-config.mjs); no caller has a default.
 *
 * @typedef {{ ready: readonly string[], claim: string, exclude: readonly string[] }} Labels
 */

/** @param {IssueRow} issue @param {string} label */
const has = (issue, label) => (issue.labels ?? []).includes(label);

/**
 * Whether any linked blocker is still open.
 *
 * `gh-deps list-blockers` returns every blocker ever linked, closed ones
 * included, so "has blockers" is not "is blocked". Reading it that way would
 * strand a ticket for good the moment anything was ever linked to it — the
 * kind of filter that looks like it is working because it only ever removes
 * rows. A missing entry means nothing was fetched for that issue, which is
 * the same answer as no blockers: not blocked.
 *
 * @param {ReadonlyArray<{ state?: string }> | undefined} rows
 */
const hasOpenBlocker = (rows) => (rows ?? []).some((b) => b.state === 'open');

/**
 * Whether an issue has an open blocker by its dependency summary, or, for a
 * row with no summary, by its `blocked_by` rows (`hasOpenBlocker`).
 *
 * GitHub leaves a blocker the caller cannot see, one in a repo the App is
 * not installed on, out of the rows and still answers 200. The summary
 * counts every blocker, seen or not, so where a row has one it decides.
 *
 * @param {{ openBlockers?: number }} issue
 * @param {ReadonlyArray<{ state?: string }> | undefined} rows Its `blocked_by` rows,
 *   if read. None read is the same answer as none: not blocked.
 */
export const isBlocked = (issue, rows) =>
  issue.openBlockers === undefined ? hasOpenBlocker(rows) : issue.openBlockers > 0;

/**
 * @param {IssueRow} issue
 * @param {Map<number, BlockerRow[]>} blockers
 * @param {Labels} labels
 */
const isEligible = (issue, blockers, labels) => {
  // `state` is defensive: the caller queries open issues, but a stale page or
  // a hand-assembled list should not be able to put a closed ticket in front
  // of an agent.
  if ((issue.state ?? 'open') !== 'open') return false;
  if (!labels.ready.every((label) => has(issue, label))) return false;
  // A claim swaps `ready` for `under development`, but a worker that only
  // adds leaves both, and `ready` alone would re-dispatch it. A
  // repo whose claim leaves its ready label on is read the same way.
  if (has(issue, labels.claim)) return false;
  if (labels.exclude.some((label) => has(issue, label))) return false;
  if (isBlocked(issue, blockers.get(issue.number))) return false;
  return true;
};

/**
 * Sort key: oldest first, then number.
 *
 * No label ranks a ticket. The order matters only when more tickets are
 * eligible than the cap allows, in the sweep whose queue spans every served
 * repo, and a label scheme is one repo's, so it cannot rank that queue.
 *
 * The number is the final tiebreak so the order is total. Two issues filed in
 * the same second would otherwise sort by whatever order the API paged them
 * in, which makes a dry run disagree with the dispatch that follows it.
 *
 * @param {IssueRow} a @param {IssueRow} b
 */
export const byAge = (a, b) => {
  const age = Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '');
  if (Number.isFinite(age) && age !== 0) return age;
  return a.number - b.number;
};

/**
 * The issues to dispatch, in dispatch order.
 *
 * The cap is applied last, after the ordering, so raising it only ever adds
 * work to the tail. Capping before the sort would let an arbitrary page order
 * decide which ticket a cap of 1 picks.
 *
 * @param {IssueRow[]} issues
 * @param {object} options
 * @param {number} [options.cap] Maximum to return. Defaults to 1; 0 selects
 *   nothing.
 * @param {Map<number, BlockerRow[]>} [options.blockers]
 * @param {Labels} options.labels The repo's ready, claim and excluded labels.
 * @returns {IssueRow[]}
 */
export const selectReadyWork = (
  issues,
  { cap = 1, blockers = new Map(), labels },
) =>
  issues
    .filter((issue) => isEligible(issue, blockers, labels))
    .sort(byAge)
    .slice(0, Math.max(0, cap));
