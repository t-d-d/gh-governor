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

export const READY_LABEL = 'workflow: ready for development';
export const AFK_LABEL = 'mode: afk';
const PRD_LABEL = 'type: prd';
export const UNDER_DEVELOPMENT_LABEL = 'workflow: under development';
const BUG_LABEL = 'type: bug';
const ENHANCEMENT_LABEL = 'type: enhancement';

/**
 * Type labels in dispatch order, highest first. Fix what is broken, then
 * verify what exists, then quality attributes, then tidy (Tidy First: the
 * refactor lands before the feature that builds on it). `type: enhancement`
 * is always last; any other type, or none, sits between it and this list.
 */
const TYPE_PRIORITY = [BUG_LABEL, 'type: qa', 'type: nfr', 'type: refactor'];

/**
 * @typedef {object} IssueRow
 * @property {number} number
 * @property {string} [title]
 * @property {string} [state]
 * @property {string[]} [labels] Label names, already flattened from the API's
 *   objects by the caller.
 * @property {string} [created_at] ISO 8601.
 */

/**
 * @typedef {object} BlockerRow
 * @property {number} number
 * @property {string} [state] `open` or `closed`.
 */

/**
 * The labels a repo marks a ticket ready with, and claims it with. A served
 * repo's come from its config file (dispatch/repo-config.mjs); no caller
 * has a default.
 *
 * @typedef {{ ready: readonly string[], claim: string }} Labels
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
 * @param {number} number
 * @param {Map<number, BlockerRow[]>} blockers
 */
const hasOpenBlocker = (number, blockers) =>
  (blockers.get(number) ?? []).some((b) => b.state === 'open');

/**
 * Whether the issue's parent PRD parks it.
 *
 * A PRD's `workflow:` label is a human's call. A repo's tooling labels a
 * PRD `under development` when it files the PRD's tickets; a human taking
 * that label off parks them all, whatever labels the children kept. Reading
 * the child alone would dispatch a ticket of a parked PRD whose children
 * were readied again.
 *
 * Anything short of `under development` on the PRD parks the child: no
 * label, or `ready for development` with the train filed but the PRD never
 * moved. A closed PRD parks the child too, whatever label it kept: a PRD
 * closes when every child has, so a closed one with an open child is a park,
 * not a delivery, and `under development` stays on a closed PRD by
 * convention. A missing entry means no parent was fetched, which is the same
 * answer as no parent: not parked. A parent that is not a PRD says nothing.
 *
 * @param {number} number
 * @param {Map<number, IssueRow | null>} parents
 */
const isParkedByParent = (number, parents) => {
  const parent = parents.get(number);
  if (!parent || !has(parent, PRD_LABEL)) return false;
  if ((parent.state ?? 'open') !== 'open') return true;
  return !has(parent, UNDER_DEVELOPMENT_LABEL);
};

/**
 * @param {IssueRow} issue
 * @param {Map<number, BlockerRow[]>} blockers
 * @param {Map<number, IssueRow | null>} parents
 * @param {Labels} labels
 */
const isEligible = (issue, blockers, parents, labels) => {
  // `state` is defensive: the caller queries open issues, but a stale page or
  // a hand-assembled list should not be able to put a closed ticket in front
  // of an agent.
  if ((issue.state ?? 'open') !== 'open') return false;
  if (!labels.ready.every((label) => has(issue, label))) return false;
  // A claim swaps `ready` for `under development`, but a worker that only
  // adds leaves both, and `ready` alone would re-dispatch it. A
  // repo whose claim leaves its ready label on is read the same way.
  if (has(issue, labels.claim)) return false;
  if (has(issue, PRD_LABEL)) return false;
  if (hasOpenBlocker(issue.number, blockers)) return false;
  if (isParkedByParent(issue.number, parents)) return false;
  return true;
};

/**
 * An issue's type rank: its highest label in `TYPE_PRIORITY`, else the slot
 * after that list, else — for an enhancement — the slot after that. Two type
 * labels rank by the higher, so a mislabelled bug still goes first.
 *
 * @param {IssueRow} issue
 */
const typeRank = (issue) => {
  const rank = TYPE_PRIORITY.findIndex((label) => has(issue, label));
  if (rank !== -1) return rank;
  return TYPE_PRIORITY.length + Number(has(issue, ENHANCEMENT_LABEL));
};

/**
 * Sort key: type rank, then oldest first, then number.
 *
 * The number is the final tiebreak so the order is total. Two issues filed in
 * the same second would otherwise sort by whatever order the API paged them
 * in, which makes a dry run disagree with the dispatch that follows it.
 *
 * @param {IssueRow} a @param {IssueRow} b
 */
export const byPriority = (a, b) => {
  const type = typeRank(a) - typeRank(b);
  if (type !== 0) return type;
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
 * @param {Map<number, IssueRow | null>} [options.parents] Each issue's parent
 *   issue, or null for a top-level one.
 * @param {Labels} options.labels The repo's ready and claim labels.
 * @returns {IssueRow[]}
 */
export const selectReadyWork = (
  issues,
  { cap = 1, blockers = new Map(), parents = new Map(), labels },
) =>
  issues
    .filter((issue) => isEligible(issue, blockers, parents, labels))
    .sort(byPriority)
    .slice(0, Math.max(0, cap));
