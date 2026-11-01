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
 * @property {Wait} [wait] What the body's `Blocked until:` line says
 *   (`waitOf`), where it has one.
 */

/**
 * What a ticket's `Blocked until:` line says: the date it waits for, as
 * `YYYY-MM-DD`, or the value governor could not read as one.
 *
 * @typedef {{ until: string } | { unreadable: string }} Wait
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

/**
 * What a ticket's labels say about picking it up, under its repo's label
 * rules: `excluded` when it carries any excluded label, else `claimed` when
 * it carries the claim, else `ready` when it carries every ready label, else
 * `not-ready`. Only `ready` may be picked up.
 *
 * The selection (`selectReadyWork`), the claim's second read
 * (dispatch/turn.mjs) and the unblocked row (`ticketRow`,
 * dispatch/unblocked.mjs) all call this, so a rule added here holds in all
 * three. Copies of it drifted once: the selection learned the excluded
 * labels and the claim did not, so a ticket labelled to keep out between
 * the plan and its launch was claimed anyway.
 *
 * The claim is checked whatever the ready labels say: a claim swaps the
 * ready label for the claim, but a worker that only adds leaves both, and
 * the ready label alone would dispatch it again.
 *
 * @param {readonly string[] | undefined} on The ticket's label names. None
 *   read is the same answer as none.
 * @param {Labels} labels
 * @returns {'excluded' | 'claimed' | 'ready' | 'not-ready'}
 */
export const labelRow = (on, labels) => {
  const names = on ?? [];
  if (labels.exclude.some((label) => names.includes(label))) return 'excluded';
  if (names.includes(labels.claim)) return 'claimed';
  if (labels.ready.every((label) => names.includes(label))) return 'ready';
  return 'not-ready';
};

/**
 * Whether any linked blocker is still open.
 *
 * `gh-deps list-blockers` returns every blocker ever linked, closed ones
 * included, so "has blockers" is not "is blocked". Reading it that way would
 * strand a ticket for good the moment anything was ever linked to it — the
 * kind of filter that looks like it is working because it only ever removes
 * rows. No rows means nothing was fetched for that issue, which is the
 * same answer as no blockers: not blocked.
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

/** The line a ticket waits by: its body's first non-empty line, in any case. */
const WAIT_LINE = /^blocked until:\s*(.*)$/i;

/**
 * What a ticket's body says about waiting, as `{ wait }`, or `{}` where it
 * has no `Blocked until:` line. Only the body's first non-empty line counts,
 * so a body that quotes the line further down holds nothing. The value is a
 * date, `YYYY-MM-DD`, that exists on the calendar; text after it, past a
 * space, is a reason and is ignored. Any other value is unreadable, which
 * holds the ticket too (`isWaiting`): a line a person wrote must never be
 * silently ignored.
 *
 * @param {string | null | undefined} body
 * @returns {{ wait?: Wait }}
 */
export const waitOf = (body) => {
  const first = (body ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
  const match = first === undefined ? null : WAIT_LINE.exec(first);
  if (match === null) return {};
  const value = (match[1] ?? '').trim();
  const date = value.split(/\s/, 1)[0] ?? '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (parts !== null) {
    const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const at = new Date(Date.UTC(year, month - 1, day));
    if (at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day) return { wait: { until: date } };
  }
  return { wait: { unreadable: value } };
};

/**
 * Whether a ticket's own `Blocked until:` line holds it at `now`: a date
 * still to come, whose wait ends at 00:00 UTC on that date, or a line
 * governor could not read. A row with no line is not held.
 *
 * Like `labelRow` and `isBlocked`, the selection, the claim's second read
 * and the unblocked row all call this. It holds in every served repo,
 * whatever its config file says.
 *
 * @param {{ wait?: Wait }} issue
 * @param {number} now Epoch ms.
 */
export const isWaiting = ({ wait }, now) => {
  if (wait === undefined) return false;
  if ('unreadable' in wait) return true;
  return now < Date.parse(`${wait.until}T00:00:00Z`);
};

/**
 * @param {IssueRow} issue
 * @param {Map<number, BlockerRow[]>} blockers
 * @param {Labels} labels
 * @param {number} now
 */
const isEligible = (issue, blockers, labels, now) => {
  // `state` is defensive: the caller queries open issues, but a stale page or
  // a hand-assembled list should not be able to put a closed ticket in front
  // of an agent.
  if ((issue.state ?? 'open') !== 'open') return false;
  if (labelRow(issue.labels, labels) !== 'ready') return false;
  if (isBlocked(issue, blockers.get(issue.number))) return false;
  if (isWaiting(issue, now)) return false;
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
 * @param {number} [options.now] Epoch ms, which a ticket's `Blocked until:`
 *   date is judged against. Defaults to the clock.
 * @returns {IssueRow[]}
 */
export const selectReadyWork = (
  issues,
  { cap = 1, blockers = new Map(), labels, now = Date.now() },
) =>
  issues
    .filter((issue) => isEligible(issue, blockers, labels, now))
    .sort(byAge)
    .slice(0, Math.max(0, cap));
