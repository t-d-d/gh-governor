/**
 * The PR review: a served repo's checklist, run by the dispatcher
 * over a PR from the repo's `review` settings, and what follows
 * its answer.
 *
 * The receiver queues a `review` fire for a PR opened, readied, pushed to or
 * its body edited (dispatch/webhook/route.mjs). The turn (dispatch/turn.mjs) hands each
 * PR here: read it, skip what needs no reading, read its facts
 * (`readFacts`), ask the checklist (dispatch/checklist.mjs, with the
 * model as its `judge`), and act.
 *
 * - A pass merges with a merge commit, pinned to the head the review read,
 *   once GitHub has computed the PR's mergeable state, then says so in a
 *   comment: a merge GitHub refuses leaves no
 *   marker, so the next fire reads the PR again. A conflict is a comment
 *   telling the author session the base merge is its to push. In a repo
 *   whose `review.merge` is false, a pass is an approving review pinned to
 *   that head, and the comment, and nothing merges: the owner does.
 * - A PR whose author may not summon the dispatcher (fire.mjs's
 *   SUMMONERS) is not read: a person merges it. Nor is a PR into any base
 *   but the repo's default branch: a stacked PR's pass would merge it into
 *   the branch below.
 * - A required status check red on the head fails in code (test 8): a
 *   check the settings cannot express is the repo's CI, never its code run
 *   here.
 * - A Dependabot PR is answered in code by the repo's Dependabot list
 *   (`dependabotAnswer`), not the checklist, and passes like any.
 *   Its conflict is no comment: Dependabot rebases its own PRs, and the
 *   rebase's push is reviewed.
 * - A fail is a comment naming the test and what would meet it, and, when
 *   no edit can, that a person merges it. A first test the author session
 *   meets (an edit, a claim) beside a later one no edit meets says both:
 *   the session's part first, then the person's.
 * - A fail on the same test and editable as the last review's, or a
 *   conflict after a conflict, edits that comment in place, words and
 *   marker, instead of posting again.
 * - No run holds a merge (an earlier review held one while a Deploy Prod
 *   run was unfinished). A PR whose newest review is a held pass from
 *   before that change, same head and body, is merged on it without
 *   judging again, and the comment edited to say it merged.
 *
 * Every comment ends with a marker (dispatch/pr-body.mjs) naming the head
 * and the body reviewed, so neither is read twice. The comment is the
 * record, and also how the
 * session the PR body names hears what it can act on: for a new fail an
 * edit or a claim meets, a person's merge beside it or not, and a
 * conflict, the receiver queues that session a message fire with the
 * fallback any comment carries (webhook/review-comment.mjs).
 * A pass is followed by the merge's own message, a fail with only a
 * person's part waits for the person, and a comment edited in place is no
 * new delivery.
 *
 * `reviewPull` reads and writes through the injected reader.
 */

import { DEPENDABOT, SUMMONERS } from './webhook/fire.mjs';
import { REVIEW_MARKER, commentKey, commentText, heldPassReason } from './webhook/review-comment.mjs';
import { checklist, checksFailure, dependabotAnswer } from './checklist.mjs';
import { bodyDigest, closedBy, closingTickets, foreignClosings, lastReview, namedOwners, proseClosings, reviewMarker } from './pr-body.mjs';
import { sessionNamedIn } from './webhook/subscribe.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/**
 * @typedef {import('../scripts/lib/github-app.mjs').PullRequestRow} PullRequestRow
 * @typedef {import('../scripts/lib/github-app.mjs').FileRow} FileRow
 * @typedef {import('../scripts/lib/github-app.mjs').TicketRow} TicketRow
 * @typedef {import('../scripts/lib/github-app.mjs').ThreadRow} ThreadRow
 * @typedef {import('./checklist.mjs').Answer} Answer
 * @typedef {import('./checklist.mjs').ClosedTicket} ClosedTicket
 * @typedef {import('./checklist.mjs').ConstraintTexts} ConstraintTexts
 * @typedef {import('./checklist.mjs').Facts} Facts
 * @typedef {import('./checklist.mjs').Judge} Judge
 * @typedef {{
 *   pullRequest: (n: number) => Promise<PullRequestRow>,
 *   pullFiles: (n: number) => Promise<FileRow[]>,
 *   pullCommits: (n: number) => Promise<import('../scripts/lib/github-app.mjs').PullCommitRow[]>,
 *   mergeBase: (base: string, head: string) => Promise<string>,
 *   fileAt: (path: string, ref: string) => Promise<string>,
 *   openPulls: () => Promise<Array<{ number: number, body?: string }>>,
 *   ticket: (n: number) => Promise<TicketRow>,
 *   allComments: (n: number) => Promise<ThreadRow[]>,
 *   comment: (n: number, body: string) => Promise<void>,
 *   updateComment: (id: number, body: string) => Promise<void>,
 *   merge: (n: number, options: { sha: string }) => Promise<{ merged: boolean, sha: string }>,
 *   approve: (n: number, options: { sha: string, body: string }) => Promise<void>,
 *   pullReviews: (n: number) => Promise<Array<{ id: number, state: string, body: string, bot: boolean }>>,
 *   dismissReview: (n: number, id: number, message: string) => Promise<void>,
 *   requiredChecks: (branch: string) => Promise<string[]>,
 *   checksAt: (sha: string) => Promise<Array<{ name: string, state: 'red' | 'green' | 'pending' }>>,
 * }} ReviewReader
 *   `requiredChecks`: the status checks a branch's protection and rulesets
 *   require. `checksAt`: the latest check runs and statuses at a commit,
 *   each red, green or pending.
 * @typedef {'merged' | 'approved' | 'conflict' | 'commented' | 'marker-moved' | 'skipped' | 'limited' | 'failed'} Outcome
 * @typedef {{ pr: number, outcome: Outcome, reason: string | null, headSha: string | null, answer: Answer | null, error: string | null }} Reviewed
 */

/** The `owner/repo` a PR's URL names, or undefined. @param {string} url */
const repoOf = (url) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url)?.[1];

/** How often, and how far apart, a PR is read again for GitHub to compute its mergeable state. */
const MERGEABLE_READS = 10;
const MERGEABLE_WAIT_MS = 3000;

/**
 * The required status checks red on the PR's head, and those not finished
 * there: pending, or not yet started. A base with none required reads no
 * check: a repo with no CI needs no checks permission.
 *
 * @param {ReviewReader} reader
 * @param {PullRequestRow} pull
 * @returns {Promise<{ red: string[], pending: string[] }>}
 */
const requiredStates = async (reader, pull) => {
  const required = await reader.requiredChecks(pull.base);
  if (required.length === 0) return { red: [], pending: [] };
  const checks = await reader.checksAt(pull.headSha);
  const red = required.filter((name) => checks.some((c) => c.name === name && c.state === 'red'));
  const pending = required.filter((name) => !red.includes(name) && !checks.some((c) => c.name === name && c.state === 'green'));
  return { red, pending };
};

/**
 * Each quoted file's whole text at the merge base and at the head, for
 * the model to read on test 7. The merge base, not main's tip: a
 * rule main gained since the branch point is not the PR's change. A read
 * that fails throws, so the review fails and nothing merges on a text
 * nobody read.
 *
 * @param {ReviewReader} reader
 * @param {PullRequestRow} pull
 * @param {string[]} paths
 * @returns {Promise<ConstraintTexts>}
 */
const constraintTexts = async (reader, pull, paths) => {
  const base = await reader.mergeBase(pull.base, pull.headSha);
  const files = await Promise.all(paths.map(async (path) => {
    const [before, after] = await Promise.all([reader.fileAt(path, base), reader.fileAt(path, pull.headSha)]);
    return { path, before, after };
  }));
  return { base, head: pull.headSha, files };
};

/**
 * A PR's facts for the checklist, read from GitHub: its changed files, the
 * tickets its top lines close, the other open PRs closing any of them, the
 * owners its Verification table and Left for later name, its prose
 * closings, and its closings of another repo's issue. The quoted files'
 * texts are read only if the checklist asks for them, and so is whether
 * governor started the session the body names: a body naming none is no
 * session of governor's. A number no
 * issue answers to, or one moved to another repository's issue, is a
 * missing ticket.
 *
 * @param {ReviewReader} reader
 * @param {PullRequestRow} pull
 * @param {(session: string) => Promise<boolean>} started Whether governor started `session`; a read that fails throws.
 * @returns {Promise<Omit<Facts, 'held' | 'rules' | 'red'>>}
 */
export const readFacts = async (reader, pull, started) => {
  /** @type {Map<number, Promise<ClosedTicket>>} */
  const reads = new Map();
  // A moved issue's read follows GitHub's redirect to another
  // repository's issue, under another number: none here.
  /** @param {number} n @returns {Promise<ClosedTicket>} */
  const read = (n) => {
    const known = reads.get(n);
    if (known) return known;
    const fresh = reader.ticket(n).then((t) => (t.number === n ? t : /** @type {ClosedTicket} */ ({ number: n, missing: true })), (error) => {
      // 404: no such issue; 410: a deleted one.
      const status = /** @type {{ status?: number }} */ (error)?.status;
      if (status === 404 || status === 410) return /** @type {ClosedTicket} */ ({ number: n, missing: true });
      throw error;
    });
    reads.set(n, fresh);
    return fresh;
  };
  const repo = repoOf(pull.html_url);
  const closing = closingTickets(pull.body, repo);
  const named = namedOwners(pull.body);
  const [files, tickets, open, verification, later] = await Promise.all([
    reader.pullFiles(pull.number),
    Promise.all(closing.map(read)),
    closing.length > 0 ? reader.openPulls() : [],
    Promise.all(named.verification.map(read)),
    Promise.all(named.later.map(read)),
  ]);
  const others = open
    .filter((p) => p.number !== pull.number)
    .map((p) => ({ number: p.number, closes: closedBy(p.body ?? '', repo) }))
    .filter((p) => p.closes.some((n) => closing.includes(n)));
  return {
    pull, files, tickets, others, owners: { verification, later }, prose: proseClosings(pull.body, repo), foreign: foreignClosings(pull.body, repo),
    constraintTexts: (paths) => constraintTexts(reader, pull, paths),
    unattended: async () => {
      const session = sessionNamedIn(pull.body);
      return session !== null && started(session);
    },
  };
};

/**
 * A Dependabot PR's answer, from its files and its commits, then its
 * required checks.
 *
 * @param {ReviewReader} reader
 * @param {PullRequestRow} pull
 * @param {string[]} list The Dependabot list.
 * @param {string[]} red The required checks red on its head.
 * @returns {Promise<Answer>}
 */
const bumpAnswer = async (reader, pull, list, red) => {
  const [files, commits] = await Promise.all([reader.pullFiles(pull.number), reader.pullCommits(pull.number)]);
  const answer = dependabotAnswer({ files, commits, list });
  return answer.answer === 'pass' ? checksFailure(red) ?? answer : answer;
};

/**
 * One PR through the review, under its repo's `review` settings and
 * labels, into its default branch `base`.
 *
 * @param {{
 *   number: number,
 *   headSha?: string,
 *   reader: ReviewReader,
 *   judge: Judge,
 *   sleep: (ms: number) => Promise<void>,
 *   review: Omit<import('./repo-config.mjs').Review, 'checklist'>,
 *   labels: import('./checklist.mjs').Rules['labels'],
 *   base: string,
 *   started: (session: string) => Promise<boolean>,
 * }} args `started`: whether governor started a session, from its state table.
 * @returns {Promise<Reviewed>}
 */
export const reviewPull = async ({ number, headSha, reader, judge, sleep, review, labels, base, started }) => {
  /** @type {import('./checklist.mjs').Rules} */
  const rules = { humanOnly: review.humanOnly, tickets: review.tickets, quote: review.quote, decides: review.decides, labels };
  /** @type {Reviewed} */
  const reviewed = { pr: number, outcome: 'skipped', reason: null, headSha: null, answer: null, error: null };
  /** @param {string} reason */
  const skip = (reason) => ({ ...reviewed, outcome: /** @type {Outcome} */ ('skipped'), reason });
  try {
    const pull = await reader.pullRequest(number);
    reviewed.headSha = pull.headSha;
    if (pull.state !== 'open') return skip(`#${number} is ${pull.state}`);
    if (pull.draft) return skip(`#${number} is a draft`);
    // A stacked PR's pass would merge it into the branch below, not the default branch.
    if (pull.base !== base) return skip(`#${number} is into ${pull.base}, not ${base}: its retarget to ${base} reviews it`);
    const bump = pull.author === DEPENDABOT;
    if (!bump && !SUMMONERS.has(pull.association)) return skip(`#${number} is by a ${pull.association} author, who may not summon the dispatcher: a person merges it`);
    if (headSha !== undefined && headSha !== pull.headSha) return skip(`#${number} has moved past ${headSha.slice(0, 12)} to ${pull.headSha.slice(0, 12)}: that push's fire reviews it`);
    const bodySha = bodyDigest(pull.body);
    const last = lastReview(await reader.allComments(number));
    // A red required check's fail is read again: a re-run can turn it green on the same head.
    const reviewedAlready = last !== null && last.headSha === pull.headSha && last.bodySha === bodySha && commentKey(last.text) !== 'push';
    // A pass whose merge an earlier review held, from before no run held a
    // merge: merged on that pass without judging it again.
    const heldReason = reviewedAlready ? heldPassReason(last.text) : null;
    if (reviewedAlready && heldReason === null) return skip(`#${number} already reviewed at ${pull.headSha.slice(0, 12)} with this body`);

    // A required check not yet finished: its run's end queues the review
    // again (dispatch/webhook/route.mjs), so this one says nothing.
    const checks = await requiredStates(reader, pull);
    if (checks.pending.length > 0) return skip(`#${number}'s required check${checks.pending.length > 1 ? 's' : ''} ${checks.pending.map((c) => `\`${c}\``).join(', ')} ${checks.pending.length > 1 ? 'have' : 'has'} not finished on ${pull.headSha.slice(0, 12)}: the run's end reviews it`);

    // The facts are read again for a held pass: a ticket may have closed or
    // changed its labels since. Only the judgement is kept.
    const answer = bump
      ? await bumpAnswer(reader, pull, review.dependabot, checks.red)
      : await checklist({ ...await readFacts(reader, pull, started), red: checks.red, held: heldReason, rules }, judge);
    reviewed.answer = answer;

    let conflict = false;
    if (answer.answer === 'pass') {
      /** @type {boolean | null} */
      let mergeable = null;
      for (let read = 0; read < MERGEABLE_READS && mergeable === null; read += 1) {
        if (read > 0) await sleep(MERGEABLE_WAIT_MS);
        const now = await reader.pullRequest(number);
        if (now.headSha !== pull.headSha || now.state !== 'open' || now.draft || now.base !== base || bodyDigest(now.body) !== bodySha) {
          return skip(`#${number} changed while the review ran: the change's own fire reviews it`);
        }
        mergeable = now.mergeable;
      }
      if (mergeable === null) throw new Error(`GitHub had not computed #${number}'s mergeable state after ${MERGEABLE_READS} reads`);
      conflict = !mergeable;
      if (conflict && bump) return skip(`#${number} conflicts with ${base}: Dependabot rebases its own PRs, and the rebase's push is reviewed`);
    }

    let outcome = /** @type {Outcome} */ (answer.answer === 'pass' ? (conflict ? 'conflict' : review.merge ? 'merged' : 'approved') : 'commented');
    const said = commentText(answer, { conflict, merge: review.merge });
    const marker = reviewMarker(pull.headSha, bodySha);
    if (outcome === 'merged') {
      const merged = await reader.merge(number, { sha: pull.headSha });
      if (!merged.merged) throw new Error(`GitHub did not merge #${number}`);
    } else if (outcome === 'approved') {
      // The repo's owner merges: an approval pinned to the head
      // reviewed, and no merge call. Its marker lets a later fail find it.
      await reader.approve(number, { sha: pull.headSha, body: `${said}\n\n${marker}` });
    } else if (!review.merge) {
      // A head that no longer passes keeps no approval of an earlier one,
      // which the owner, or auto-merge, could merge on.
      const stale = (await reader.pullReviews(number)).filter((r) => r.state === 'APPROVED' && r.bot && r.body.includes(REVIEW_MARKER));
      for (const { id } of stale) await reader.dismissReview(number, id, `The PR review no longer passes at ${pull.headSha.slice(0, 12)}: see its comment.`);
    }

    const text = heldReason !== null && outcome === 'merged' ? `${said} Merged once the promotion ended.` : said;
    const body = `${text}\n\n${marker}`;
    const key = commentKey(text);
    const saidAlready = last !== null && key !== null && commentKey(last.text) === key;
    if (heldReason !== null && outcome === 'merged') {
      // The held pass's comment now says the merge happened.
      await reader.updateComment(/** @type {{ id: number }} */ (last).id, body);
    } else if (saidAlready) {
      await reader.updateComment(last.id, body);
      outcome = 'marker-moved';
    } else {
      await reader.comment(number, body);
    }
    return { ...reviewed, outcome, reason: text };
  } catch (error) {
    const limited = /** @type {{ limit?: string }} */ (error)?.limit === 'session';
    return { ...reviewed, outcome: limited ? 'limited' : 'failed', error: messageOf(error) };
  }
};
