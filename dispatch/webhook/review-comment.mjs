/**
 * The PR review's comment (dispatch/review.mjs): its words, and what the
 * receiver reads from them. It lives beside the receiver because the
 * receiver's Lambda ships this directory alone, and it must tell a comment
 * the owner session can act on from one it cannot.
 *
 * Pure: no I/O.
 */

/** The start of the marker every review comment ends with. */
export const REVIEW_MARKER = '<!-- governor:pr-review ';

/**
 * Whether App `appId` posted `row` as its bot. Another App, or
 * `github-actions[bot]`, is not this one, nor a person acting through this
 * App with a user access token; without `appId`, no App posted anything.
 *
 * @param {{ user?: { type?: string } | null, performed_via_github_app?: { id?: unknown } | null } | undefined} row
 * @param {number | undefined} appId
 */
export const postedByApp = (row, appId) => appId !== undefined
  && row?.user?.type === 'Bot'
  && row?.performed_via_github_app?.id === appId;

/** What a conflict asks of the author session, in both conflict comments. */
const BASE_MERGE = "merging the base branch in is the author session's to push, and the review runs again on the push.";

/** A conflict comment's fixed opening, before the model's reason. */
const CONFLICT = `Passes the PR review, but conflicts with its base: ${BASE_MERGE}`;

/**
 * The conflict comment a merge to main left on a PR it conflicted:
 * the review's conflict shape, naming the commit main was at and the merge
 * that moved it. Nothing posts one any more: the conflicts check messages
 * the session (dispatch/conflicts.mjs). The words stay so the review
 * keys the ones still on open PRs as its own conflict (`commentKey`).
 *
 * @param {{ mainSha: string, merged: number }} moved
 */
export const mergeConflictText = ({ mainSha, merged }) =>
  `Conflicts with its base since main moved to ${mainSha} (after #${merged} merged): ${BASE_MERGE}`;

const MERGE_CONFLICT = /^Conflicts with its base since main moved to ([0-9a-f]{40}) /;

/**
 * The commit of main a `mergeConflictText` names, or null for any other
 * text. Two merges read at one commit of main name different PRs, so the
 * commit, not the whole text, says whether a PR was already told.
 *
 * @param {string} text
 */
export const mergeConflictSha = (text) => MERGE_CONFLICT.exec(text)?.[1] ?? null;

/** @param {string} text */
const sentence = (text) => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** A claim fail's fixed opening. */
const CLAIM = 'Waits for its ticket to be claimed: ';

/** A red required check's fixed opening (test 8). */
const PUSH = 'Waits for a push: ';

/** What a pass says where the repo's `review.merge` is false: the review approved it, and nothing merged. */
const APPROVED = 'Approved: the repo\'s owner merges it.';

/** The openings of a fail whose first test the author session meets and a later one only a person does. */
const CLAIM_THEN = 'Waits for its ticket to be claimed, then a person: ';
const EDIT_THEN = 'Waits for a description edit, then a person: ';

/**
 * What the comment says: a pass, a pass the review approved and left for
 * the owner to merge (`merge` false), a pass that conflicts, a fail an
 * edit can meet, a ticket the author session claims, a red required check
 * its push meets, a fail only a person can. A fail with `person` says the
 * session's part (the edit or the claim) first, then the later test that
 * waits for a person.
 *
 * @param {import('../checklist.mjs').Answer} answer
 * @param {{ conflict: boolean, merge?: boolean }} options
 */
export const commentText = (answer, { conflict, merge = true }) => {
  if (answer.answer === 'pass') {
    if (conflict) return `${CONFLICT} ${sentence(answer.reason)}`;
    return merge ? `Passes the PR review: ${sentence(answer.reason)}` : `Passes the PR review: ${sentence(answer.reason)} ${APPROVED}`;
  }
  const reason = answer.reason.trim().replace(/[.!?]$/, '');
  const { person } = answer;
  const then = person ? ` Test ${person.test} fails whatever the description says: ${sentence(person.reason)} A person merges it.` : '';
  if (answer.claim) {
    return `${person ? CLAIM_THEN : CLAIM}${reason} (test ${answer.test}). The author session claims each ticket named, then pushes or edits the description, and the review runs again.${then}`;
  }
  if (answer.push) return `${PUSH}${reason} (test ${answer.test}). A push that turns it green meets it, and the review runs again on the push.`;
  if (person) return `${EDIT_THEN}${reason} (test ${answer.test}). An edit to the description meets test ${answer.test}, and the review runs again on the edit.${then}`;
  return answer.editable
    ? `Waits for a description edit: ${reason} (test ${answer.test}). An edit to the description meets it, and the review runs again on the edit.`
    : `Waits for a person: ${reason} (test ${answer.test}). No edit to the description makes it pass. A person merges it.`;
};

/** A held pass as the review wrote it before it stopped holding merges: still on PRs reviewed then. */
const HELD_PASS = /^Passes the PR review: ([\s\S]*?) The merge waits for Deploy Prod runs? [^\n]* to end, and the review after it merges\.$/;

/**
 * The pass's reason a held pass comment carries, or null for any other
 * text: the next review merges on it without judging again. Nothing
 * writes one any more; the reader stays so a PR held before the change
 * merges on its next review.
 *
 * @param {string} text
 */
export const heldPassReason = (text) => HELD_PASS.exec(text.trim())?.[1] ?? null;

const FAIL = /^Waits for (a description edit|a person): [\s\S]* \(test (\d+)\)\. (?:An|No) edit to the description (?:meets|makes it pass)/;
const EDIT_THEN_FAIL = /^Waits for a description edit, then a person: [\s\S]* \(test (\d+)\)\. An edit to the description meets test \1,/;

/**
 * What a comment says, less the model's reason: a fail's test and whether
 * an edit meets it, `claim` for a claim, either with `then a person` when a
 * later test waits for one, `conflict` for a conflict, the review's or a
 * merge to main's, or null for any other comment. The reason is free text and
 * rewords on every run, so two comments on the same key say the same
 * thing: a review that finds the conflict a merge's comment already told
 * edits that comment. `meets this one` is an older person-fail wording,
 * still on PRs.
 *
 * @param {string} text
 */
export const commentKey = (text) => {
  if (text.startsWith(CONFLICT) || mergeConflictSha(text) !== null) return 'conflict';
  if (text.startsWith(CLAIM)) return 'claim';
  if (text.startsWith(PUSH)) return 'push';
  if (text.startsWith(CLAIM_THEN)) return 'claim, then a person';
  const owed = EDIT_THEN_FAIL.exec(text);
  if (owed) return `test ${owed[1]}, an edit meets it, then a person`;
  const found = FAIL.exec(text);
  return found ? `test ${found[2]}, ${found[1] === 'a person' ? 'no edit' : 'an edit'} meets it` : null;
};

/**
 * Whether the owner session can act on the comment: a fail an edit
 * meets, a ticket to claim, either of those beside a later test
 * only a person meets, a red required check its push meets, or
 * a conflict, the review's or a merge to main's. A
 * pass is followed by the merge's own message, and a fail with nothing
 * but a person's part waits for the person.
 *
 * @param {string} text
 */
export const ownerActs = (text) => {
  const key = commentKey(text.trim());
  return key !== null && (['conflict', 'claim', 'claim, then a person', 'push'].includes(key) || key.includes(', an edit meets it'));
};

/**
 * The comment's words without its marker: what the owner session is told.
 *
 * @param {string} body
 */
export const withoutMarker = (body) => {
  const at = body.indexOf(REVIEW_MARKER);
  return (at === -1 ? body : body.slice(0, at)).trim();
};
