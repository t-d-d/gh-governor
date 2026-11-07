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
 *   whose `review.merge` is false, a pass is the comment alone, and
 *   nothing merges: the owner does. Nothing approves.
 * - Every answer is also the `governor` check run on the head reviewed
 *   (`CHECK`), which a ruleset can require: `success` for a pass,
 *   `failure` for a conflict and for any fail the author session meets,
 *   `neutral` where only a person can act. GitHub counts `neutral` as
 *   passing, so a fail the session owes is never `neutral`. A required
 *   check not finished is the check in progress, an author the repo's
 *   `trust.review` leaves out is `neutral`, and a review that does not finish is
 *   `failure`, and so is a PR a review of every open PR ran out of time
 *   before it reached (`outOfTime`). Every other skip posts no check. The
 *   check goes first: a pass's before its merge, which a ruleset requiring
 *   it would refuse otherwise, and a fail's before its comment, so a check
 *   write GitHub refuses leaves no marker either. An installation that has not
 *   granted the Checks write refuses it with a 403, which the review
 *   records and passes over.
 * - A PR whose author the repo's `trust.review` does not let in
 *   (dispatch/trust.mjs) is not read: a person merges it. Nor is a PR into any base
 *   but the repo's default branch: a stacked PR's pass would merge it into
 *   the branch below.
 * - A required status check red on the head fails in code (test 8): a
 *   check the settings cannot express is the repo's CI, never its code run
 *   here. Where the repo's file names `workflows.ci`, the latest run of that
 *   workflow at the head counts too, as a required check does: a repo whose
 *   plan cannot require a check still holds a pass for its CI. A repo whose
 *   CI runs only after the merge sets `review.waitForCi` false, and the
 *   turn then passes no `ci`. A check's end at a head whose last review
 *   failed test 8 on the same red checks says nothing again, so another
 *   App answering the `governor` check cannot loop with it.
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
 * - No run but the CI workflow's at the head holds a merge (an earlier
 *   review held one while a Deploy Prod run was unfinished). A held pass
 *   from before that change merges nothing: its PR is judged again.
 *
 * Every comment ends with a marker (dispatch/pr-body.mjs) naming the head
 * and the body reviewed, and, where the model was asked, the digest of
 * what it read. The review keeps the same verdict in the state table
 * (`Verdicts`), and reads it back from there alone: a person with write
 * access can edit any comment, governor's included, so comment text never
 * passes a PR. A head and body the verdict names are not read twice. A
 * pass at an earlier head is reused at a new one where the digest is the
 * same: the tests decided in code run again, and only the model's answer
 * is kept. A fail is never reused. A missing item reuses nothing.
 *
 * The comment and the check are the record people read, and the relay
 * sends the comment to no session (webhook/mention.mjs). The review
 * messages the PR's owner itself: each new comment hands the turn the
 * owner's message (`tell`, {@link ownerMessage}), which the turn queues as
 * a `message` fire for the PR's owner as `ownerOf` finds it
 * (dispatch/deliveries.mjs), so the send and any takeover run under a turn
 * of their own. Only a verdict that asks the session for work
 * (`asksOwner`), a fail an edit, a claim or a push meets and a conflict,
 * carries the fallback that takes a gone session's PR over; a pass or a
 * wait on a person reaches a live owner and starts nobody. A comment
 * edited in place tells nobody again, unless a message is owed: at a new
 * head or body it then sends the comment as it now reads in its place.
 *
 * `reviewPull` reads and writes through the injected reader.
 */

import { createHash } from 'node:crypto';
import { DEPENDABOT, FIRE_BUDGET, UNATTENDED, authorKind, build, fireWeight, lets } from './webhook/fire.mjs';
import { asksOwner, commentKey, commentText, sentence } from './webhook/review-comment.mjs';
import { HANDOFF, oneLine } from './webhook/mention.mjs';
import { checkLabel, checklist, checksFailure, dependabotAnswer } from './checklist.mjs';
import { bodyDigest, closedBy, closingTickets, foreignClosings, lastReview, namedOwners, proseClosings, reviewMarker } from './pr-body.mjs';
import { sessionNamedIn } from './webhook/subscribe.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { RED_CONCLUSIONS } from '../scripts/lib/github-app.mjs';

/**
 * @typedef {import('../scripts/lib/github-app.mjs').PullRequestRow} PullRequestRow
 * @typedef {import('../scripts/lib/github-app.mjs').FileRow} FileRow
 * @typedef {import('../scripts/lib/github-app.mjs').TicketRow} TicketRow
 * @typedef {import('../scripts/lib/github-app.mjs').ThreadRow} ThreadRow
 * @typedef {import('./checklist.mjs').RequiredCheck} RequiredCheck
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
 *   checkRun: (run: { name: string, sha: string, state: CheckState, title: string, summary: string }) => Promise<void>,
 *   requiredChecks: (branch: string) => Promise<string[]>,
 *   checksAt: (sha: string) => Promise<Array<{ name: string, state: 'red' | 'green' | 'pending', app?: string }>>,
 *   ownCheck: (name: string, sha: string) => Promise<{ state: 'red' | 'green' | 'pending', title: string } | null>,
 *   ciRuns: (path: string, sha: string) => Promise<Array<import('../scripts/lib/github-app.mjs').RunRow & { path: string }>>,
 * }} ReviewReader
 *   `requiredChecks`: the status checks a branch's protection and rulesets
 *   require. `checksAt`: the latest check runs and statuses at a commit,
 *   each red, green or pending, a check run with the slug of its App. `ownCheck`: governor's own
 *   latest run of a check at a commit, with its title, or null. `ciRuns`: a workflow's runs at a commit,
 *   newest first.
 * @typedef {{ headSha: string, bodySha: string, readSha: string | null, pass: { reason: string, at: string } | null, again: boolean, owed?: Owed | null }} Verdict
 *   What a review that commented decided, as the next review relies on it:
 *   the head and body digest it read, the digest of what the model read
 *   (`readDigest`, dispatch/checklist.mjs) or null where the code decided,
 *   the model's pass with its reason and the head it was given at, or null,
 *   `again` for a test-8 fail, read again at the same head, and `owed`, the
 *   owner's message the lane refused, left out where none is owed.
 * @typedef {{ comment: string, message: import('./webhook/fire.mjs').MessageFire, tries: number }} Owed
 *   An owner's message no review turn has queued yet: the comment it tells
 *   of, with its marker, the message as the review built it, fallback and
 *   all, and how many review turns have tried to queue it.
 * @typedef {{
 *   read: (pr: number) => Promise<(Verdict & { at: string }) | null>,
 *   record: (pr: number, read: (Verdict & { at: string }) | null, verdict: Verdict) => Promise<boolean>,
 * }} Verdicts
 *   The PR's verdict in the state table: read (null for none), and written
 *   over the item read, false where another review's stood. A read or
 *   write that fails throws.
 * @typedef {'in_progress' | 'success' | 'failure' | 'neutral'} CheckState
 * @typedef {'merged' | 'passed' | 'conflict' | 'commented' | 'marker-moved' | 'skipped' | 'limited' | 'failed' | 'out-of-time'} Outcome
 * @typedef {{ pr: number, outcome: Outcome, reason: string | null, headSha: string | null, answer: Answer | null, error: string | null, check: string | null, told?: string, owed?: string, untold?: string }} Reviewed
 *   `check`: the state of the check the review posted, `refused: <why>` where
 *   GitHub refused it with a 403, or null where it posted none. `told`: what
 *   came of the owner's message, as the turn's `tell` says. `owed`: why it
 *   was not queued, where a later review turn tries again, which the turn
 *   logs at warn. `untold`: why it was not queued on its last try, so it is
 *   dropped, which fails the turn.
 * @typedef {(pr: number, comment: string, message: import('./webhook/fire.mjs').MessageFire) => Promise<string>} Tell
 *   The turn's hand-off of the owner's message of comment `comment` on PR
 *   `pr`: what came of it, or a throw where it could not be queued.
 */

/**
 * How many review turns try to queue one owner's message: the one that
 * posted its comment, and the next review fires at the same head and body.
 */
export const MESSAGE_TRIES = 3;

/** What a message from the review says under the comment, where it asks the owner for work. */
const ASKS = 'This is your pull request, and the review asks this of you. Do it on its branch: push, edit its description, or claim its ticket, as the comment says. Do not open a new branch or PR.';

/** What a message from the review says under the comment, where it asks nothing. */
const NOTICE = 'This is your pull request. This is a notice: the review asks nothing of you. Do not open a new branch or PR.';

/**
 * The PR's owner's message of a review comment, as a `message` fire for the
 * owner the PR's body or head branch names when it runs (`byBranch`,
 * dispatch/deliveries.mjs): the comment's words without the marker, and
 * whether the review asks the session for work. Only where it asks
 * (`acts`) does it carry the fallback that takes a gone session's PR over,
 * on the PR's head branch. It is governor's own text, so it names no
 * author for `trust.relay` to judge; the owner lookup reads the body's
 * link only where `trust.relay` lets the PR's author in. A comment too long
 * for one lane message ({@link FIRE_BUDGET}), sent twice where it carries
 * the fallback, is cut short, pointing at the PR for the rest.
 *
 * @param {{ pull: Pick<PullRequestRow, 'number' | 'title' | 'html_url'>, text: string, acts: boolean }} args
 * @returns {import('./webhook/fire.mjs').MessageFire}
 */
export const ownerMessage = ({ pull, text, acts }) => {
  /** @param {string} words */
  const fire = (words) => {
    const said = [
      'Governor\'s PR review commented on your pull request.',
      '',
      `[#${pull.number}](${pull.html_url}) ${oneLine(pull.title)}`,
      '',
      words,
    ].join('\n');
    return build.message({
      byBranch: true,
      text: `${said}\n\n${acts ? ASKS : NOTICE}`,
      on: pull.number,
      authors: [],
      fallback: acts
        ? { prompt: [said, '', HANDOFF, ASKS, UNATTENDED].join('\n'), sessionName: oneLine(`PR review #${pull.number} ${pull.title}`).slice(0, 100), issue: pull.number }
        : undefined,
    });
  };
  let message = fire(text);
  for (let limit = text.length; fireWeight(message) > FIRE_BUDGET && limit > 1;) {
    limit = Math.floor(limit / 2);
    message = fire(`${text.slice(0, limit).trimEnd()}… [${text.length - limit} more characters in the comment on the PR]`);
  }
  return message;
};

/**
 * The lane's deduplication id for the owner's message of one comment: the
 * repo, the PR, the comment with its marker and when its turn started,
 * hashed, since SQS takes 128 characters. A review turn is never run again
 * (dispatch/lane.mjs), so nothing needs this to drop a second send; the
 * time keeps a later comment with the same words and marker, such as a
 * red check's fail after a pass at one head, from being dropped as the
 * first.
 *
 * @param {string} repo
 * @param {number} pr
 * @param {string} comment
 * @param {number} at
 */
export const ownerMessageId = (repo, pr, comment, at) => createHash('sha256').update(`pr-review:${repo.toLowerCase()}#${pr}:${at}:${comment}`).digest('hex');

/** The check run the review posts its verdict as. It is named for governor, not the review: it is a gate, and approves nothing. */
export const CHECK = 'governor';

/** How long a check's title runs before it is cut. */
const TITLE_CHARS = 200;

/** How much of an error a check that did not finish quotes: a check run on a public repo is public. */
const ERROR_CHARS = 300;

/** The `governor` check's title for a review that did not finish or start. */
const DID_NOT_RUN = 'The PR review did not run.';

/** What a review that did not finish or start tells the reader to do. */
const RUNS_AGAIN = 'A push or an edit to the description runs it again.';

/**
 * A check's title: the first sentence of `text`, cut at {@link TITLE_CHARS}.
 *
 * @param {string} text
 */
const firstSentence = (text) => {
  const end = /[.!?](?=\s|$)/.exec(text);
  const first = end === null ? text.trim() : text.slice(0, end.index + 1).trim();
  return first.length <= TITLE_CHARS ? first : `${first.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
};

/** The `owner/repo` a PR's URL names, or undefined. @param {string} url */
const repoOf = (url) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url)?.[1];

/** How often, and how far apart, a PR is read again for GitHub to compute its mergeable state. */
const MERGEABLE_READS = 10;
const MERGEABLE_WAIT_MS = 3000;

/**
 * The required status checks red on the PR's head, and those not finished
 * there: any run of the name pending, or none started. Red wins over
 * pending, and a name whose only run was skipped reads green. The checks
 * the base requires on GitHub and those the repo's `requireChecks` lists
 * count alike, each once. A listed entry that names its App reads only
 * that App's check runs of the name, so a job of the same name in a PR's
 * own workflow neither meets nor fails it. A name GitHub requires reads
 * every run and status of the name. None required reads no check: a repo
 * with no CI needs no checks permission.
 *
 * @param {ReviewReader} reader
 * @param {PullRequestRow} pull
 * @param {readonly RequiredCheck[]} listed The repo's `review.requireChecks`.
 * @returns {Promise<{ red: RequiredCheck[], pending: RequiredCheck[] }>}
 */
const requiredStates = async (reader, pull, listed) => {
  // The review's own check is left out: a repo that requires it would
  // otherwise skip the review until the review had run, and read its own
  // earlier failure at the same head as a red required check.
  /** @type {Map<string, { entry: RequiredCheck, name: string, app: string | null }>} */
  const byKey = new Map();
  for (const entry of [...(await reader.requiredChecks(pull.base)), ...listed]) {
    const [name, app] = typeof entry === 'string' ? [entry, null] : [entry.name, entry.app];
    if (name !== CHECK) byKey.set(JSON.stringify([name, app]), { entry, name, app });
  }
  if (byKey.size === 0) return { red: [], pending: [] };
  const checks = await reader.checksAt(pull.headSha);
  /** @type {RequiredCheck[]} */
  const red = [];
  /** @type {RequiredCheck[]} */
  const pending = [];
  for (const { entry, name, app } of byKey.values()) {
    const runs = checks.filter((c) => c.name === name && (app === null || c.app === app));
    // Unfinished while any run of the name is pending, even beside a green
    // one: a run that skipped its job reads green while the push run of the
    // same name is still going.
    if (runs.some((c) => c.state === 'red')) red.push(entry);
    else if (runs.length === 0 || runs.some((c) => c.state === 'pending')) pending.push(entry);
  }
  return { red, pending };
};

/**
 * The state of the CI workflow's latest run at the PR's head: red where it
 * ended in a way that blocks a merge, as `checksAt` reads a check, green
 * where it ended otherwise (skipped included), pending while it runs or
 * where none has started. Only runs of `ci` at the head count, whatever
 * the reader answers.
 *
 * @param {ReviewReader} reader
 * @param {PullRequestRow} pull
 * @param {string} ci The workflow's file, the repo's `workflows.ci`.
 * @returns {Promise<'red' | 'green' | 'pending'>}
 */
const ciState = async (reader, pull, ci) => {
  const runs = (await reader.ciRuns(ci, pull.headSha)).filter((r) => r.path === ci && r.head_sha === pull.headSha);
  const latest = runs.reduce((/** @type {typeof runs[number] | null} */ last, r) => (last === null || r.created_at > last.created_at ? r : last), null);
  if (latest === null || latest.status !== 'completed') return 'pending';
  return RED_CONCLUSIONS.has(String(latest.conclusion)) ? 'red' : 'green';
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
 * @returns {Promise<Omit<Facts, 'held' | 'rules' | 'red' | 'redCi'>>}
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
 * @param {RequiredCheck[]} red The required checks red on its head.
 * @param {string | null} redCi The CI workflow's file, where its run at the head is red.
 * @returns {Promise<Answer>}
 */
const bumpAnswer = async (reader, pull, list, red, redCi) => {
  const [files, commits] = await Promise.all([reader.pullFiles(pull.number), reader.pullCommits(pull.number)]);
  const answer = dependabotAnswer({ files, commits, list });
  return answer.answer === 'pass' ? checksFailure(red, redCi) ?? answer : answer;
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
 *   review: Omit<import('./repo-config.mjs').Review, 'checklist'> & { checklist?: string },
 *   labels: import('./checklist.mjs').Rules['labels'],
 *   base: string,
 *   started: (session: string) => Promise<boolean>,
 *   verdicts: Verdicts,
 *   trusted: readonly string[],
 *   ci?: string,
 *   outOfTime?: boolean,
 *   byCommit?: boolean,
 *   tell?: Tell,
 * }} args `review.checklist`: the checklist the model reads, part of the digest a pass is reused by. `started`: whether governor started a session, from its state table. `verdicts`: the PR's last verdict, in the same table. `trusted`: the repo's `trust.review`, whose authors' PRs it reads. `ci`: the repo's `workflows.ci`, whose run at the head test 8 reads, left out where `review.waitForCi` is false.
 *   `outOfTime`: the turn ran out of time for this PR. It goes through the
 *   usual skips, then posts a `failure` check in place of reading the facts
 *   and asking the model. `byCommit`: the fire carried the commit and not
 *   the PR, a check's end at that head. A PR whose author `trusted` leaves
 *   out got its `neutral` check at that head from the push's own fire,
 *   so it is skipped without another. `tell`: the turn's hand-off of the
 *   owner's message of each new comment ({@link ownerMessage}); without
 *   it, nobody is told.
 * @returns {Promise<Reviewed>}
 */
export const reviewPull = async ({ number, headSha, reader, judge, sleep, review, labels, base, started, verdicts, trusted, ci, outOfTime = false, byCommit = false, tell }) => {
  /** @type {import('./checklist.mjs').Rules} */
  const rules = { humanOnly: review.humanOnly, tickets: review.tickets, quote: review.quote, decides: review.decides, labels };
  /** @type {Reviewed} */
  const reviewed = { pr: number, outcome: 'skipped', reason: null, headSha: null, answer: null, error: null, check: null };
  /** @param {string} reason */
  const skip = (reason) => ({ ...reviewed, outcome: /** @type {Outcome} */ ('skipped'), reason });
  /**
   * One try at queueing the owner's message of `comment`, its `tries`
   * earlier tries refused: null where it is queued, or dropped on its last
   * try, else the message, still owed.
   *
   * @param {string} comment
   * @param {import('./webhook/fire.mjs').MessageFire} message
   * @param {number} tries
   * @returns {Promise<Owed | null>}
   */
  const handOff = async (comment, message, tries) => {
    if (tell === undefined) return null;
    // A turn can try two messages, an owed one and its review's new one:
    // what it reports is the last try's. A drop stays, and fails the turn.
    delete reviewed.told;
    delete reviewed.owed;
    try {
      reviewed.told = await tell(number, comment, message);
      return null;
    } catch (error) {
      const why = messageOf(error);
      if (tries + 1 >= MESSAGE_TRIES) {
        reviewed.untold = `${why}; dropped after ${tries + 1} tries`;
        return null;
      }
      reviewed.owed = why;
      return { comment, message, tries: tries + 1 };
    }
  };
  // A PR merged, or commented on, before a later write failed keeps its
  // check: the review ran, and its comment says what the check does.
  let merged = false;
  let said = false;
  /**
   * The `governor` check at the head read. A 403 on the read of the runs
   * already there, or on the write, is an installation that has not granted
   * the Checks permission: recorded, and the review goes on. Any other
   * refusal throws.
   *
   * @param {CheckState} state
   * @param {string} title
   * @param {string} summary
   */
  const check = async (state, title, summary) => {
    try {
      await reader.checkRun({ name: CHECK, sha: /** @type {string} */ (reviewed.headSha), state, title, summary });
      reviewed.check = state;
    } catch (error) {
      if (/** @type {{ status?: number }} */ (error)?.status !== 403) throw error;
      reviewed.check = `refused: ${messageOf(error)}`;
    }
  };
  try {
    const pull = await reader.pullRequest(number);
    reviewed.headSha = pull.headSha;
    if (pull.state !== 'open') return skip(`#${number} is ${pull.state}`);
    if (pull.draft) return skip(`#${number} is a draft`);
    // A stacked PR's pass would merge it into the branch below, not the default branch.
    if (pull.base !== base) return skip(`#${number} is into ${pull.base}, not ${base}: its retarget to ${base} reviews it`);
    const bump = pull.author === DEPENDABOT;
    if (!bump && !lets(trusted, pull)) {
      const kind = authorKind(pull);
      if (byCommit) return skip(`#${number} is by a ${kind} author, whose PR has its neutral check from the push: a check's end at ${pull.headSha.slice(0, 12)} adds none`);
      await check('neutral', 'Not reviewed: a person merges it.', `The PR review reads no pull request by a ${kind} author: this repo's trust.review lets in only ${trusted.join(', ') || 'nobody'}. A person merges it.`);
      return skip(`#${number} is by a ${kind} author, whom the repo's trust.review does not let in: a person merges it`);
    }
    if (headSha !== undefined && headSha !== pull.headSha) return skip(`#${number} has moved past ${headSha.slice(0, 12)} to ${pull.headSha.slice(0, 12)}: that push's fire reviews it`);
    const bodySha = bodyDigest(pull.body);
    // The verdict comes from the state table, never from the comment: a
    // person with write access can edit governor's comment.
    let verdict = await verdicts.read(number);
    // A red required check's or CI run's fail is read again: a re-run can turn it green on the same head.
    const sameHead = verdict !== null && verdict.headSha === pull.headSha && verdict.bodySha === bodySha;
    // The owner's message an earlier review at this head and body could
    // not queue goes first, with no model and no comment, and the verdict
    // is written again owing it or not, so a message queued is never
    // queued again. A verdict at another head or body is a newer review's
    // to tell: its message replaces the older one.
    if (verdict !== null && sameHead && verdict.owed != null && tell !== undefined) {
      // The earlier review commented and posted its check: a write that
      // fails here fails the turn, and leaves that check standing.
      said = true;
      const { at: _, owed, ...kept } = verdict;
      const still = await handOff(owed.comment, owed.message, owed.tries);
      await verdicts.record(number, verdict, { ...kept, ...(still === null ? {} : { owed: still }) });
      const what = still !== null ? 'is owed still' : reviewed.untold !== undefined ? 'is dropped' : 'is sent';
      if (!verdict.again) return skip(`#${number} already reviewed at ${pull.headSha.slice(0, 12)} with this body: its owner's message ${what}`);
      // A test-8 fail is read again: over the item just written.
      const now = await verdicts.read(number);
      if (now === null || now.headSha !== pull.headSha || now.bodySha !== bodySha) return skip(`#${number}'s verdict changed while its owner's message was sent: that review's own fire reads it`);
      verdict = now;
    }
    if (verdict !== null && sameHead && !verdict.again) return skip(`#${number} already reviewed at ${pull.headSha.slice(0, 12)} with this body`);
    // The comment is read only to edit it in place, and to tell which red
    // checks a test-8 fail the table holds named, so a PR skipped above
    // pages through no thread.
    const last = lastReview(await reader.allComments(number));
    // The model's pass at an earlier head, offered for reuse: the checklist
    // reuses it only where what the model reads has the same digest. A
    // verdict naming no digest, or a fail, offers nothing.
    /** @type {{ read: string, reason: string, at: string } | null} */
    const earlier = verdict !== null && verdict.readSha !== null && verdict.pass !== null && verdict.headSha !== pull.headSha
      ? { read: verdict.readSha, reason: verdict.pass.reason, at: verdict.pass.at }
      : null;
    /** @type {string | null} The digest of what the model read, or would have: null where the code decided. */
    let readSha = null;

    // A required check, or the CI run at the head, not yet finished: its
    // end queues the review again (dispatch/webhook/route.mjs), so this
    // one says nothing.
    const [checks, cis] = await Promise.all([requiredStates(reader, pull, review.requireChecks), ci === undefined ? null : ciState(reader, pull, ci)]);
    const ciWaits = cis === 'pending';
    if (checks.pending.length > 0 || ciWaits) {
      const names = checks.pending.map(checkLabel).join(', ');
      const what = [
        ...(checks.pending.length > 0 ? [`required check${checks.pending.length > 1 ? 's' : ''} ${names}`] : []),
        ...(ciWaits ? [`CI workflow \`${ci}\``] : []),
      ].join(' and ');
      const many = checks.pending.length + (ciWaits ? 1 : 0) > 1;
      const title = checks.pending.length === 0 ? 'Waits for its CI run to finish.' : ciWaits ? 'Waits for its CI run and required checks to finish.' : 'Waits for its required checks to finish.';
      await check('in_progress', title, `The PR review runs when the ${what} ${many ? 'have' : 'has'} finished on ${pull.headSha.slice(0, 12)}.`);
      return skip(`#${number}'s ${what} ${many ? 'have' : 'has'} not finished on ${pull.headSha.slice(0, 12)}: its end reviews it`);
    }
    const redCi = cis === 'red' ? /** @type {string} */ (ci) : null;
    // A check's end at a head whose last review failed test 8 on these same
    // red checks says nothing again: another App answering the `governor`
    // check with a check of its own would otherwise loop. A re-run that
    // changes which checks are red, or turns them green, is still read. So
    // is one where governor's own latest `governor` run there is anything
    // but that fail: one in progress is a review that waited on the re-run,
    // and one saying the review did not run promises it runs again.
    const sameRed = checksFailure(checks.red, redCi);
    if (byCommit && sameRed !== null && verdict !== null && sameHead && verdict.again && last !== null && last.text === commentText(sameRed, { conflict: false })) {
      const own = await reader.ownCheck(CHECK, pull.headSha);
      if (own !== null && own.state === 'red' && own.title === firstSentence(last.text)) {
        return skip(`#${number} failed test 8 at ${pull.headSha.slice(0, 12)} on the same red checks: a check's end there changes nothing`);
      }
    }

    // A required check would wait on a PR that gets no check at all, so it
    // fails out loud, and the owner can bypass it.
    if (outOfTime) {
      const why = `The review turn ran out of time before it reached this pull request. ${RUNS_AGAIN}`;
      await check('failure', DID_NOT_RUN, why);
      return { ...reviewed, outcome: /** @type {Outcome} */ ('out-of-time'), reason: why };
    }

    const answer = bump
      ? await bumpAnswer(reader, pull, review.dependabot, checks.red, redCi)
      : await checklist({ ...await readFacts(reader, pull, started), red: checks.red, redCi, rules, system: review.checklist ?? '', earlier, read: (digest) => { readSha = digest; } }, judge);
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

    let outcome = /** @type {Outcome} */ (answer.answer === 'pass' ? (conflict ? 'conflict' : review.merge ? 'merged' : 'passed') : 'commented');
    const text = commentText(answer, { conflict, merge: review.merge });
    const marker = reviewMarker(pull.headSha, bodySha, readSha);
    const acts = asksOwner(answer, { conflict });
    // A fail only a person meets is `neutral`, which passes a required
    // check: never one the author session can act on.
    await check(answer.answer === 'pass' && !conflict ? 'success' : acts ? 'failure' : 'neutral', firstSentence(text), text);
    if (outcome === 'merged') {
      const done = await reader.merge(number, { sha: pull.headSha });
      if (!done.merged) throw new Error(`GitHub did not merge #${number}`);
      merged = true;
    }

    const body = `${text}\n\n${marker}`;
    const key = commentKey(text);
    const saidAlready = last !== null && key !== null && commentKey(last.text) === key;
    if (saidAlready) {
      await reader.updateComment(last.id, body);
      outcome = 'marker-moved';
    } else {
      await reader.comment(number, body);
    }
    said = true;
    // A new comment's owner hears it from this turn, which knows its
    // verdict: the relay sends governor's comment to nobody. An edit in
    // place tells nobody again, unless a message is owed. The hand-off goes
    // before the verdict's write, so a write that fails still leaves the
    // owner told, and one the lane refuses is owed on the verdict for the
    // next review turn. An owed message goes only once a newer one is
    // queued or owed in its place: a new comment's own message replaces
    // it, and an edit in place at a new head or body sends the comment as
    // it now reads in its place, with its tries. An edit in place at this
    // head and body keeps it.
    const prior = verdict?.owed ?? null;
    const message = ownerMessage({ pull, text, acts });
    const owed = !saidAlready ? await handOff(body, message, 0)
      : prior === null || sameHead ? prior
        : await handOff(body, message, prior.tries);
    // After the comment: one GitHub refused leaves no verdict, so the next
    // fire reads the PR again. Another review's item standing is its own
    // verdict, as good as this one.
    await verdicts.record(number, verdict, {
      headSha: pull.headSha,
      bodySha,
      readSha,
      pass: answer.answer === 'pass' && readSha !== null ? { reason: answer.reason, at: answer.reused ?? pull.headSha } : null,
      again: key === 'push',
      ...(owed === null ? {} : { owed }),
    });
    return { ...reviewed, outcome, reason: text };
  } catch (error) {
    const limited = /** @type {{ limit?: string }} */ (error)?.limit === 'session';
    const message = messageOf(error);
    if (reviewed.headSha !== null && reviewed.headSha !== '' && !merged && !said) {
      // A gate fails out loud, and the owner can bypass it. A check write
      // that fails here too leaves the review's own error as the one told.
      const quoted = message.length <= ERROR_CHARS ? message : `${message.slice(0, ERROR_CHARS - 1).trimEnd()}…`;
      const why = limited ? `The claude.ai login's usage limit stopped it: ${quoted}` : `It failed: ${quoted}`;
      await check('failure', DID_NOT_RUN, `${sentence(why)} ${RUNS_AGAIN}`).catch(() => {});
    }
    return { ...reviewed, outcome: limited ? 'limited' : 'failed', error: message };
  }
};
