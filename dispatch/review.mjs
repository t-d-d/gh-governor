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
 *   check not finished is the check in progress, an author who may not
 *   summon governor is `neutral`, and a review that does not finish is
 *   `failure`, and so is a PR a review of every open PR ran out of time
 *   before it reached (`outOfTime`). Every other skip posts no check. The
 *   check goes first: a pass's before its merge, which a ruleset requiring
 *   it would refuse otherwise, and a fail's before its comment, so a check
 *   write GitHub refuses leaves no marker either. An installation that has not
 *   granted the Checks write refuses it with a 403, which the review
 *   records and passes over.
 * - A PR whose author may not summon the dispatcher (fire.mjs's
 *   SUMMONERS) is not read: a person merges it. Nor is a PR into any base
 *   but the repo's default branch: a stacked PR's pass would merge it into
 *   the branch below.
 * - A required status check red on the head fails in code (test 8): a
 *   check the settings cannot express is the repo's CI, never its code run
 *   here. Where the repo's file names `workflows.ci`, the latest run of that
 *   workflow at the head counts too, as a required check does: a repo whose
 *   plan cannot require a check still holds a pass for its CI.
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
 *   review held one while a Deploy Prod run was unfinished). A PR whose newest review is a held pass from
 *   before that change, same head and body, is merged on it without
 *   judging again, and the comment edited to say it merged.
 *
 * Every comment ends with a marker (dispatch/pr-body.mjs) naming the head
 * and the body reviewed, so neither is read twice. The comment is the
 * record, and also how the session the PR body names hears the review:
 * the receiver queues that session a message fire for each new comment
 * (webhook/mention.mjs). Only one the session can act on, a fail an edit,
 * a claim or a push meets and a conflict, carries the fallback that takes
 * a gone session's PR over. A comment edited in place is no new delivery.
 *
 * `reviewPull` reads and writes through the injected reader.
 */

import { DEPENDABOT, SUMMONERS } from './webhook/fire.mjs';
import { commentKey, commentText, heldPassReason, ownerActs, sentence } from './webhook/review-comment.mjs';
import { checklist, checksFailure, dependabotAnswer } from './checklist.mjs';
import { bodyDigest, closedBy, closingTickets, foreignClosings, lastReview, namedOwners, proseClosings, reviewMarker } from './pr-body.mjs';
import { sessionNamedIn } from './webhook/subscribe.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { RED_CONCLUSIONS } from '../scripts/lib/github-app.mjs';

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
 *   checkRun: (run: { name: string, sha: string, state: CheckState, title: string, summary: string }) => Promise<void>,
 *   requiredChecks: (branch: string) => Promise<string[]>,
 *   checksAt: (sha: string) => Promise<Array<{ name: string, state: 'red' | 'green' | 'pending' }>>,
 *   ciRuns: (path: string, sha: string) => Promise<Array<import('../scripts/lib/github-app.mjs').RunRow & { path: string }>>,
 * }} ReviewReader
 *   `requiredChecks`: the status checks a branch's protection and rulesets
 *   require. `checksAt`: the latest check runs and statuses at a commit,
 *   each red, green or pending. `ciRuns`: a workflow's runs at a commit,
 *   newest first.
 * @typedef {'in_progress' | 'success' | 'failure' | 'neutral'} CheckState
 * @typedef {'merged' | 'passed' | 'conflict' | 'commented' | 'marker-moved' | 'skipped' | 'limited' | 'failed' | 'out-of-time'} Outcome
 * @typedef {{ pr: number, outcome: Outcome, reason: string | null, headSha: string | null, answer: Answer | null, error: string | null, check: string | null }} Reviewed
 *   `check`: the state of the check the review posted, `refused: <why>` where
 *   GitHub refused it with a 403, or null where it posted none.
 */

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
 * count alike, each name once. None required reads no check: a repo with
 * no CI needs no checks permission.
 *
 * @param {ReviewReader} reader
 * @param {PullRequestRow} pull
 * @param {readonly string[]} listed The repo's `review.requireChecks`.
 * @returns {Promise<{ red: string[], pending: string[] }>}
 */
const requiredStates = async (reader, pull, listed) => {
  // The review's own check is left out: a repo that requires it would
  // otherwise skip the review until the review had run, and read its own
  // earlier failure at the same head as a red required check.
  const required = [...new Set([...(await reader.requiredChecks(pull.base)), ...listed])].filter((name) => name !== CHECK);
  if (required.length === 0) return { red: [], pending: [] };
  const checks = await reader.checksAt(pull.headSha);
  /** @type {string[]} */
  const red = [];
  /** @type {string[]} */
  const pending = [];
  for (const name of required) {
    const runs = checks.filter((c) => c.name === name);
    // Unfinished while any run of the name is pending, even beside a green
    // one: a run that skipped its job reads green while the push run of the
    // same name is still going.
    if (runs.some((c) => c.state === 'red')) red.push(name);
    else if (runs.length === 0 || runs.some((c) => c.state === 'pending')) pending.push(name);
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
 * @param {string[]} red The required checks red on its head.
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
 *   review: Omit<import('./repo-config.mjs').Review, 'checklist'>,
 *   labels: import('./checklist.mjs').Rules['labels'],
 *   base: string,
 *   started: (session: string) => Promise<boolean>,
 *   ci?: string,
 *   outOfTime?: boolean,
 *   byCommit?: boolean,
 * }} args `started`: whether governor started a session, from its state table. `ci`: the repo's `workflows.ci`, whose run at the head test 8 reads.
 *   `outOfTime`: the turn ran out of time for this PR. It goes through the
 *   usual skips, then posts a `failure` check in place of reading the facts
 *   and asking the model. `byCommit`: the fire carried the commit and not
 *   the PR, a check's end at that head. A PR whose author may not summon
 *   governor got its `neutral` check at that head from the push's own fire,
 *   so it is skipped without another.
 * @returns {Promise<Reviewed>}
 */
export const reviewPull = async ({ number, headSha, reader, judge, sleep, review, labels, base, started, ci, outOfTime = false, byCommit = false }) => {
  /** @type {import('./checklist.mjs').Rules} */
  const rules = { humanOnly: review.humanOnly, tickets: review.tickets, quote: review.quote, decides: review.decides, labels };
  /** @type {Reviewed} */
  const reviewed = { pr: number, outcome: 'skipped', reason: null, headSha: null, answer: null, error: null, check: null };
  /** @param {string} reason */
  const skip = (reason) => ({ ...reviewed, outcome: /** @type {Outcome} */ ('skipped'), reason });
  // A PR merged before a later write failed keeps its check: the review ran.
  let merged = false;
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
    if (!bump && !SUMMONERS.has(pull.association)) {
      if (byCommit) return skip(`#${number} is by a ${pull.association} author, whose PR has its neutral check from the push: a check's end at ${pull.headSha.slice(0, 12)} adds none`);
      await check('neutral', 'Not reviewed: a person merges it.', `The PR review reads no pull request by a ${pull.association} author: only an owner, member or collaborator may summon governor. A person merges it.`);
      return skip(`#${number} is by a ${pull.association} author, who may not summon the dispatcher: a person merges it`);
    }
    if (headSha !== undefined && headSha !== pull.headSha) return skip(`#${number} has moved past ${headSha.slice(0, 12)} to ${pull.headSha.slice(0, 12)}: that push's fire reviews it`);
    const bodySha = bodyDigest(pull.body);
    const last = lastReview(await reader.allComments(number));
    // A red required check's or CI run's fail is read again: a re-run can turn it green on the same head.
    const reviewedAlready = last !== null && last.headSha === pull.headSha && last.bodySha === bodySha && commentKey(last.text) !== 'push';
    // A pass whose merge an earlier review held, from before no run held a
    // merge: merged on that pass without judging it again.
    const heldReason = reviewedAlready ? heldPassReason(last.text) : null;
    if (reviewedAlready && heldReason === null) return skip(`#${number} already reviewed at ${pull.headSha.slice(0, 12)} with this body`);

    // A required check, or the CI run at the head, not yet finished: its
    // end queues the review again (dispatch/webhook/route.mjs), so this
    // one says nothing.
    const [checks, cis] = await Promise.all([requiredStates(reader, pull, review.requireChecks), ci === undefined ? null : ciState(reader, pull, ci)]);
    const ciWaits = cis === 'pending';
    if (checks.pending.length > 0 || ciWaits) {
      const names = checks.pending.map((c) => `\`${c}\``).join(', ');
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

    // A required check would wait on a PR that gets no check at all, so it
    // fails out loud, and the owner can bypass it.
    // A held pass carries no check, so it gets this one too.
    if (outOfTime) {
      const why = `The review turn ran out of time before it reached this pull request. ${RUNS_AGAIN}`;
      await check('failure', DID_NOT_RUN, why);
      return { ...reviewed, outcome: /** @type {Outcome} */ ('out-of-time'), reason: why };
    }

    // The facts are read again for a held pass: a ticket may have closed or
    // changed its labels since. Only the judgement is kept.
    const answer = bump
      ? await bumpAnswer(reader, pull, review.dependabot, checks.red, redCi)
      : await checklist({ ...await readFacts(reader, pull, started), red: checks.red, redCi, held: heldReason, rules }, judge);
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
    const said = commentText(answer, { conflict, merge: review.merge });
    const text = heldReason !== null && outcome === 'merged' ? `${said} Merged once the promotion ended.` : said;
    const marker = reviewMarker(pull.headSha, bodySha);
    // A fail only a person meets is `neutral`, which passes a required
    // check: never one the author session can act on.
    await check(answer.answer === 'pass' && !conflict ? 'success' : ownerActs(said) ? 'failure' : 'neutral', firstSentence(text), text);
    if (outcome === 'merged') {
      const done = await reader.merge(number, { sha: pull.headSha });
      if (!done.merged) throw new Error(`GitHub did not merge #${number}`);
      merged = true;
    }

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
    const message = messageOf(error);
    if (reviewed.headSha !== null && reviewed.headSha !== '' && !merged) {
      // A gate fails out loud, and the owner can bypass it. A check write
      // that fails here too leaves the review's own error as the one told.
      const quoted = message.length <= ERROR_CHARS ? message : `${message.slice(0, ERROR_CHARS - 1).trimEnd()}…`;
      const why = limited ? `The claude.ai login's usage limit stopped it: ${quoted}` : `It failed: ${quoted}`;
      await check('failure', DID_NOT_RUN, `${sentence(why)} ${RUNS_AGAIN}`).catch(() => {});
    }
    return { ...reviewed, outcome: limited ? 'limited' : 'failed', error: message };
  }
};
