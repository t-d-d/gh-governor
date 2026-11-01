/**
 * What a delivery about a PR or an issue says to sessions: a fresh session
 * summoned by a mention of @claude, and a message to each session
 * subscribed to what happened (subscribe.mjs).
 *
 * A mention: four places it arrives, a comment on an issue or a pull
 * request, a review comment, a review, and an issue opened with the mention
 * in its body or assigned to `claude`. Each becomes a `dispatch` fire
 * carrying a prompt of its own, which names where the mention is and quotes
 * what it said; the session reads the rest from GitHub itself, so the
 * prompt never embeds the PR or the issue. The prompt reaches the task
 * through a container override, which has a size cap, so a long body is
 * quoted only so far.
 *
 * A subscription: a pull request a session wrote names that session, the
 * last claude.ai/code link in its body (the attribution footer Claude Code
 * tells every session to end a PR description with), and a message wakes a
 * session whether its container is warm or gone. Such a PR is the
 * session's to keep, so every comment, review comment and review on it is
 * a `message` fire, mention or not, carrying the `dispatch` it would
 * otherwise have been as its fallback, which the task starts only if the
 * session refuses (archived). Any other session subscribes with a line in
 * the body, a PR's or an issue's, and hears of the events it names
 * with no fallback: the task drops a subscriber that refuses. An issue a
 * session filed names it the same way, and it hears of every event there
 * but labels and deploys (a `deployed: ` label) as its owner, with
 * no fallback, since an issue has nothing to take over; the task strikes its footer link should it refuse. A push, a
 * close, a label: each is a message fire per subscriber, the owner's with
 * no fallback either, since a gone session owes them nothing. A review
 * bot's findings go through too; they are what the session is waiting for,
 * and the review loop ends when a session reads a remark and posts nothing.
 *
 * A PR raised from a local session (the CLI, or the desktop app with Remote
 * Control on) names no session: nothing gives a local session its own link.
 * Its owner is the live session holding its head branch, which only
 * the task can ask the sessions API, so a remark, a close or a merge on a
 * PR whose body names no session queues one owner's fire with `byBranch` in
 * place of the session, the remark's with its fallback. A push does not:
 * the session on the branch is the one pushing, and its commits carry no
 * trailer to tell. Nor does a mention, which summons a fresh session there
 * as ever, nor a session's post naming no session, which is taken for the
 * local session's own; a post naming one tells the task it as `poster`.
 *
 * Who may summon a fresh session: someone with a say in the repository
 * (owner, member, collaborator). A bot cannot, and neither can a session:
 * every comment a session posts ends in the Claude Code footer, and one
 * quoting "@claude" back would otherwise start a session that starts one.
 *
 * Who wrote a session's post: the session whose link sits under the footer,
 * or alone on the line above it, and that session is not messaged with its
 * own post. The footer Claude Code puts on a comment names no session, so a
 * session signs its posts only when told to. Every session the dispatcher
 * starts is told in its opening prompt (`SIGN_POSTS`, fire.mjs). A
 * session's post naming no session may be any subscriber's, so it reaches
 * every one, and the message says so ({@link UNSIGNED}). An author that
 * reads its own post back posts nothing and signs the next one. Skipping
 * the owner instead would lose a reviewer session's remark, and an owner
 * that nothing wakes leaves its PR idle.
 *
 * Pure: no I/O. route.mjs calls it for the events it applies to.
 */

import { DISPATCH_MARKER, OVERRIDE_BUDGET, SIGN_POSTS, SUMMONERS, UNATTENDED, build, deployedTarget, isBranch, isCommit, overrideWeight } from './fire.mjs';
import { REVIEW_MARKER, ownerActs, postedByApp, withoutMarker } from './review-comment.mjs';
import { ownSessionPost, postedBy, sameSession, sessionId, sessionNamedIn, subscribersFor, unsignedPost, withoutQuotes } from './subscribe.mjs';

export const MENTION = '@claude';

/**
 * A mention as GitHub links one, in any case and outside code (a domain,
 * `@claude.ai`, and a team or package scope, `@claude/sdk`, are not; a `_`
 * before it is markdown emphasis): `@claude` not inside another handle
 * (`@claude-bot`, `@claudette`) or an address (`support@claude.ai`).
 */
const MENTION_RE = /(?<![A-Za-z0-9@.-])@claude(?![\w-]|\.\w|\/)/i;

/** Code GitHub links nothing in: a fence (to the end, unclosed), a span (within its paragraph). */
const CODE_RE = /(`{3,}|~{3,})[\s\S]*?(?:\1|(?![\s\S]))|(`+)(?!`)(?:(?![ \t\r]*\n[ \t\r]*\n)[\s\S])+?\2/g;

/**
 * Whether `text` mentions @claude itself: outside code and outside any
 * quote. A reply quoting a post that named @claude does not repeat it.
 *
 * @param {unknown} text
 */
export const mentions = (text) => MENTION_RE.test(withoutQuotes(String(text ?? '').replace(CODE_RE, ' ')));

/** The events a mention can arrive in, beside `issues`. */
export const MENTION_EVENTS = new Set(['issue_comment', 'pull_request_review_comment', 'pull_request_review']);

/** How much of a body the prompt quotes; the URL carries the rest. */
const EXCERPT_CHARS = 1500;

const OWN_PR = 'This is your pull request. Decide what it needs: a code change (commit and push to its branch), a reply on the thread, or nothing. Do not open a new branch or PR.';

const SUBSCRIBED_PR = 'You subscribe to this pull request; it is not yours. Decide what it needs from you: a review, a reply on the thread, or nothing. Do not push to its branch.';

const SUBSCRIBED_ISSUE = 'You subscribe to this issue. Decide what it needs from you: a reply on the issue, a change to work of yours it bears on, or nothing.';

/**
 * The repo's default branch, off a delivery's `repository`, or null where
 * the payload names none: nothing takes it for `main`.
 *
 * @param {any} payload
 * @returns {string | null}
 */
export const defaultBranch = (payload) => (isBranch(payload?.repository?.default_branch) ? payload.repository.default_branch : null);

/**
 * What the fallback's prompt adds: the fresh session takes the PR over. The
 * turn points the PR body's footer at it (`relinkSession`); the session
 * does so itself where that rewrite failed, and keeps the link there.
 */
export const HANDOFF = 'The session that wrote this PR is gone; it is yours now. The dispatcher points the PR description\'s session link at you; if it still names another session, put your own link in its place, and keep it there, so later remarks reach you.';

/**
 * What a message about a session's post naming no session adds: the
 * recipient may be its author, and is told to sign its posts so the next one
 * is skipped.
 */
export const UNSIGNED = `This post ends in the Claude Code footer and names no session, so the dispatcher cannot tell which session wrote it. If you wrote it, it has come back to you: post nothing about it. ${SIGN_POSTS}`;

/** A review with no text still says something when its state is one of these. */
const VERDICTS = new Set(['approved', 'changes_requested']);

/** @param {unknown} text */
export const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {unknown} body
 * @param {number} [limit]
 */
const excerpt = (body, limit = EXCERPT_CHARS) => {
  const text = String(body ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${text.length - limit} more characters at the URL above]`;
};

/**
 * Whom a prompt addresses: a fresh session a mention summoned, the PR's
 * owner, or a subscriber.
 *
 * @typedef {'mention' | 'owner' | 'subscriber'} Role
 * @typedef {import('./fire.mjs').SubscriptionEvent} SubscriptionEvent
 * @typedef {{ login?: string, type?: string }} User
 * @typedef {{ body?: unknown, user?: User, performed_via_github_app?: { id?: unknown } | null }} Written
 * @typedef {import('./fire.mjs').DispatchFire} DispatchFire
 * @typedef {import('./fire.mjs').MessageFire} MessageFire
 * @typedef {{ fire: DispatchFire | MessageFire, reason: string, key?: string }} Queued
 * @typedef {{ fires: Queued[], reason: string }} Fanout
 */

/**
 * Why `body` by `user` is not a summons, or null when it is. A session's
 * post is one whose footer stands outside any quote: a member's reply
 * quoting a session's post is the member's. An issue's body (`issue`) that
 * names its owner session is that session's own, even where the GitHub
 * tool stripped its footer to the link on its last line.
 *
 * @param {{ body: unknown, user: User | undefined, association: unknown, issue?: boolean }} args
 * @returns {string | null}
 */
const notASummons = ({ body, user, association, issue = false }) => {
  const text = String(body ?? '');
  if (!mentions(text)) return `no ${MENTION} mention`;
  if (user?.type === 'Bot') return `a bot (${user?.login ?? 'unnamed'}) cannot summon a session`;
  if (ownSessionPost(text) || (issue && sessionNamedIn(text) !== null)) return 'a session cannot summon another';
  if (!SUMMONERS.has(String(association))) {
    return `${user?.login ?? 'someone'} (${association ?? 'no association'}) has no say in the repository`;
  }
  return null;
};

/**
 * Whether `written` is the PR review's comment: it carries the review's
 * marker and the dispatcher's own App (`appId`) posted it as its bot.
 * Another App's, or a workflow's, is any bot's remark, and a
 * receiver that knows no App ID takes none for the review's.
 *
 * @param {Written | undefined} written
 * @param {number | undefined} appId
 */
const reviewComment = (written, appId) => String(written?.body ?? '').includes(REVIEW_MARKER) && postedByApp(written, appId);

/**
 * Why `written` reaches no subscriber, or null when it may. A bot's
 * may: a review bot's findings are what a session waits for. A stranger's
 * may not, nor the dispatcher's own marker, nor a person quoting the PR
 * review's marker, nor a PR review comment the owner cannot act on.
 * Whose post it is decides only who is skipped ({@link fanOut}); the PR
 * review's comment reaches only the owner.
 *
 * @param {{ written: Written | undefined, association: unknown, review: boolean }} args `review`: {@link reviewComment}.
 * @returns {string | null}
 */
const notAnUpdate = ({ written, association, review }) => {
  const text = String(written?.body ?? '');
  const user = written?.user;
  if (text.includes(DISPATCH_MARKER)) return "the dispatcher's own marker";
  if (text.includes(REVIEW_MARKER) && user?.type !== 'Bot') return "a person's comment quoting the PR review's marker";
  if (review && !ownerActs(withoutMarker(text))) return "the PR review's comment: nothing in it for the session to do, and the comment is the record";
  if (user?.type !== 'Bot' && !SUMMONERS.has(String(association))) {
    return `${user?.login ?? 'someone'} (${association ?? 'no association'}) has no say in the repository`;
  }
  return null;
};

/**
 * The name the session shows in the sessions pane: the mention, then the
 * number and title, so it matches against the backlog the way a pickup's
 * does.
 *
 * @param {unknown} number
 * @param {unknown} title
 */
const sessionName = (number, title) => oneLine(`${MENTION} #${number} ${title}`).slice(0, 100);

/**
 * The fire a summons queues: a `dispatch` with the prompt for what `on`
 * (an issue or a pull request) received, ending in the Unattended line,
 * since it starts a session.
 *
 * @param {string} prompt
 * @param {any} on
 * @param {string} reason
 * @returns {Queued}
 */
const summons = (prompt, on, reason) => ({
  fire: build.dispatch({ prompt: `${prompt}\n${UNATTENDED}`, sessionName: sessionName(on?.number, on?.title) }),
  reason,
});

/**
 * One subscriber's fire: a `message` of the prompt into its session, keyed
 * by the session so each subscriber's is its own lane message. The owner's
 * fire on a remark carries the dispatch it would otherwise have been as
 * the fallback, told to take the PR over; the prompt then rides twice, so a
 * remark too long for the override is quoted shorter, halving until it
 * fits.
 *
 * @param {{
 *   prompt: (role: Role, limit: number) => string,
 *   subscriber: { session: string | null, owner: boolean },
 *   poster?: string | null,
 *   on: any,
 *   event: SubscriptionEvent,
 *   fallback: boolean,
 *   commit?: string | undefined,
 *   closing?: boolean,
 *   issue?: boolean,
 *   unsigned?: boolean,
 *   reason: string,
 * }} args `issue`: `on` is an issue, whose owner, its filer, hears by subscription.
 *   `unsigned`: a session's post naming no session, which the message says
 *   ({@link UNSIGNED}); the fallback's fresh session wrote nothing, and is
 *   not told.
 * @returns {Queued}
 */
const messageFire = ({ prompt, subscriber: { session, owner }, poster = null, on, event, fallback, commit, closing, issue = false, unsigned = false, reason }) => {
  const role = owner ? 'owner' : 'subscriber';
  const number = Number.isInteger(on?.number) ? on.number : undefined;
  /** @param {string} text @returns {MessageFire} */
  const fire = (text) => build.message({
    ...(session === null ? { byBranch: /** @type {true} */ (true), poster: poster ?? undefined } : { session }),
    text: unsigned ? `${text}\n\n${UNSIGNED}` : text,
    on: number,
    event,
    commit,
    closing,
    subscribed: !owner || issue,
    fallback: owner && fallback
      ? { prompt: `${text}\n${HANDOFF}\n${UNATTENDED}`, sessionName: sessionName(on?.number, on?.title), issue: number }
      : undefined,
  });
  let limit = EXCERPT_CHARS;
  let message = fire(prompt(role, limit));
  while (overrideWeight(message) > OVERRIDE_BUDGET && limit > 1) {
    limit = Math.floor(limit / 2);
    message = fire(prompt(role, limit));
  }
  if (session === null) return { fire: message, reason: `${reason}, for the live session on its head branch, if one is`, key: 'branch-owner' };
  const id = sessionId(session);
  return { fire: message, reason: `${reason}, for ${id}, which ${owner ? 'its body names' : 'subscribes to it'}`, key: id };
};

/**
 * A fire for each subscriber to `event` on `on` (a PR or an issue), but the
 * session that posted it. `fallback`: the owner's fire carries one, which
 * takes the PR over. `closing`: `on` is finished with (an issue
 * closed, a PR closed unmerged); a reopen is the same event and closes
 * nothing, and a merge leaves CI and the deploys to come.
 *
 * @param {{
 *   on: any,
 *   event: SubscriptionEvent,
 *   poster: string | null,
 *   prompt: (role: Role, limit: number) => string,
 *   fallback?: boolean,
 *   commit?: string,
 *   closing?: boolean,
 *   ownerOnly?: boolean,
 *   byBranch?: boolean,
 *   sessionPost?: boolean,
 *   unsigned?: boolean,
 *   issue?: boolean,
 *   reason: string,
 * }} args `ownerOnly`: the PR's owner hears it, and no subscriber.
 *   `issue`: `on` is an issue, whose owner hears `deploys` only by a line.
 *   `byBranch`: `on` is a PR, and with no session its body names, the
 *   live session on its head branch is the owner; `sessionPost`, what was
 *   posted is a session's outside any quote (`ownSessionPost`), which then
 *   is that session's own. `unsigned`: a
 *   session posted it and did not sign it (`unsignedPost`), so any
 *   subscriber may have written it, and each hears of it, told so
 *   ({@link UNSIGNED}).
 * @returns {Fanout}
 */
const fanOut = ({ on, event, poster, prompt, fallback = false, commit, closing = false, ownerOnly = false, byBranch = false, sessionPost = false, unsigned = false, issue = false, reason }) => {
  /** @type {Queued[]} */
  const fires = [];
  /** @type {string[]} */
  const skipped = [];
  const subscribers = subscribersFor(on?.body, event, { issue });
  if (byBranch && sessionNamedIn(on?.body) === null) {
    if (sessionPost && poster === null) skipped.push("a session's post naming no session, taken for the local session's own");
    else fires.push(messageFire({ prompt, subscriber: { session: null, owner: true }, poster, on, event, fallback, commit, closing, reason }));
  }
  for (const subscriber of subscribers) {
    if (ownerOnly && !subscriber.owner) continue;
    if (poster !== null && sameSession(poster, subscriber.session)) {
      skipped.push(`${sessionId(poster)}'s own post`);
      continue;
    }
    fires.push(messageFire({ prompt, subscriber, on, event, fallback, commit, closing, issue, unsigned, reason }));
  }
  const heard = fires.length === 0 && skipped.length === 0 ? [`${reason}: nobody subscribes to ${event}`] : [];
  return { fires, reason: [...fires.map((f) => f.reason), ...skipped, ...heard].join('; ') };
};

/**
 * The first line of a prompt to a subscriber or the owner: what was
 * written, and on whose.
 *
 * @param {'owner' | 'subscriber'} role
 * @param {string} what
 */
const heading = (role, what) => (role === 'owner' ? `A ${what} on your pull request.` : `A ${what} on a pull request you subscribe to.`);

/** @param {Role} role */
const closingFor = (role) => (role === 'owner' ? OWN_PR : SUBSCRIBED_PR);

/** @param {any} payload @param {Role} [role] @param {number} [limit] */
const issueCommentPrompt = ({ issue, comment }, role = 'mention', limit = EXCERPT_CHARS) => [
  role === 'mention' ? `An issue comment mentioned ${MENTION}.` : 'A comment on an issue you subscribe to.',
  '',
  `Issue #${issue?.number}: ${oneLine(issue?.title)} (${issue?.html_url})`,
  `Comment by ${comment?.user?.login} (${comment?.html_url}):`,
  excerpt(comment?.body, limit),
  '',
  role === 'mention'
    ? `Do what the comment asks. If it needs code changes, create a branch, implement them, and open a PR linking issue #${issue?.number}. If it is a question, answer it as a comment on issue #${issue?.number}.`
    : SUBSCRIBED_ISSUE,
].join('\n');

/** @param {any} payload @param {Role} [role] @param {number} [limit] */
const prCommentPrompt = ({ issue, comment }, role = 'mention', limit = EXCERPT_CHARS) => [
  role === 'mention' ? `A comment on a pull request mentioned ${MENTION}.` : heading(role, 'comment'),
  '',
  `PR #${issue?.number}: ${oneLine(issue?.title)} (${issue?.html_url})`,
  `Comment by ${comment?.user?.login} (${comment?.html_url}):`,
  excerpt(comment?.body, limit),
  '',
  role === 'mention'
    ? `You are updating an existing PR. Check out its head branch and work on it directly. If the comment asks for code changes, implement them, commit, and push to that branch; do not open a new branch or PR. If it is a question, answer it as a comment on PR #${issue?.number}.`
    : closingFor(role),
].join('\n');

/** @param {any} payload @param {Role} [role] @param {number} [limit] */
const reviewCommentPrompt = ({ pull_request: pr, comment }, role = 'mention', limit = EXCERPT_CHARS) => [
  role === 'mention' ? `A PR review comment mentioned ${MENTION}.` : heading(role, 'review comment'),
  '',
  `PR #${pr?.number}: ${oneLine(pr?.title)} (${pr?.html_url}), head branch "${pr?.head?.ref}"`,
  `Review comment by ${comment?.user?.login} on ${comment?.path} line ${comment?.line ?? comment?.original_line ?? '?'} (${comment?.html_url}):`,
  excerpt(comment?.body, limit),
  '',
  role === 'mention'
    ? `You are updating an existing PR. Check out branch "${pr?.head?.ref}" and work on it directly: address the feedback, commit, and push to that branch; do not open a new branch or PR. Reply on the review thread when done.`
    : closingFor(role),
].join('\n');

/** @param {any} payload @param {Role} [role] @param {number} [limit] */
const reviewPrompt = ({ pull_request: pr, review }, role = 'mention', limit = EXCERPT_CHARS) => [
  role === 'mention' ? `A PR review mentioned ${MENTION}.` : heading(role, 'review'),
  '',
  `PR #${pr?.number}: ${oneLine(pr?.title)} (${pr?.html_url}), head branch "${pr?.head?.ref}"`,
  `Review by ${review?.user?.login}, state ${review?.state} (${review?.html_url}):`,
  excerpt(review?.body, limit),
  '',
  role === 'mention'
    ? `You are updating an existing PR. Check out branch "${pr?.head?.ref}" and work on it directly: address the review, commit, and push to that branch; do not open a new branch or PR. Reply on the review when done.`
    : closingFor(role),
].join('\n');

/** @param {any} payload */
const issuePrompt = ({ issue }) => [
  `An issue was opened or assigned that mentions ${MENTION}.`,
  '',
  `Issue #${issue?.number}: ${oneLine(issue?.title)} (${issue?.html_url})`,
  `Labels: ${(issue?.labels ?? []).map((/** @type {{ name?: string }} */ l) => l?.name).filter(Boolean).join(', ') || 'none'}`,
  'Body:',
  excerpt(issue?.body),
  '',
  `Analyse the issue. If you can address it, create a branch, implement the fix or feature, and open a PR linking issue #${issue?.number}. Otherwise comment on the issue with your analysis.`,
].join('\n');

/** @param {any} payload @param {Role} role */
const pushPrompt = ({ pull_request: pr, sender, before, after, repository }, role) => [
  role === 'owner' ? 'A push to your pull request.' : 'A push to a pull request you subscribe to.',
  '',
  `PR #${pr?.number}: ${oneLine(pr?.title)} (${pr?.html_url}), head branch "${pr?.head?.ref}"`,
  `Pushed by ${sender?.login}: ${repository?.html_url}/compare/${before}...${after}`,
  '',
  role === 'owner'
    ? 'Someone else pushed to your branch: pull it before you push again, and decide whether it needs anything from you.'
    : SUBSCRIBED_PR,
].join('\n');

/** @param {any} payload @param {Role} role */
const prClosedPrompt = ({ pull_request: pr, sender }, role) => {
  const how = pr?.merged ? 'merged' : 'closed without merging';
  return [
    role === 'owner' ? `Your pull request was ${how}.` : `A pull request you subscribe to was ${how}.`,
    '',
    `PR #${pr?.number}: ${oneLine(pr?.title)} (${pr?.html_url}), by ${sender?.login}`,
    '',
    pr?.merged
      ? 'Its change reaches dev and prod through the deploys, which its subscribers to deploys hear of. Nothing else on it is left to do unless its thread says so.'
      : 'Nothing on it is left to do unless its thread says so.',
  ].join('\n');
};

/** @param {any} payload @param {string | null} target The `deployed: ` label's target, if one was added. */
const issueEventPrompt = ({ action, issue, label, sender }, target) => {
  if (target !== null) {
    return [
      `The change of an issue you subscribe to reached ${target}.`,
      '',
      `Issue #${issue?.number}: ${oneLine(issue?.title)} (${issue?.html_url}), labelled "${label?.name}" by ${sender?.login}`,
      '',
      SUBSCRIBED_ISSUE,
    ].join('\n');
  }
  const what = {
    labeled: `was labelled "${label?.name}"`,
    unlabeled: `lost the label "${label?.name}"`,
    closed: `was closed${issue?.state_reason ? ` (${String(issue.state_reason).replace(/_/g, ' ')})` : ''}`,
    reopened: 'was reopened',
  }[String(action)];
  return [
    `An issue you subscribe to ${what}.`,
    '',
    `Issue #${issue?.number}: ${oneLine(issue?.title)} (${issue?.html_url}), by ${sender?.login}`,
    '',
    SUBSCRIBED_ISSUE,
  ].join('\n');
};

/**
 * The three events that carry something written: what it is on (`on`, and
 * whether that is a pull request, `pr`), the text and its author (`by`), the
 * one action that counts (`wanted`, named as `what`), the subscription
 * event it is, and the prompt for it. `issues` is its own arm below: an
 * assignment carries no text.
 *
 * @type {Record<string, (payload: any) => { on: any, pr: boolean, by: any, wanted: string, what: string, event: SubscriptionEvent, prompt: (payload: any, role?: Role, limit?: number) => string }>}
 */
const WRITTEN = {
  issue_comment: ({ issue, comment }) => ({
    on: issue, pr: Boolean(issue?.pull_request), by: comment, wanted: 'created', what: 'comment', event: 'comments',
    prompt: issue?.pull_request ? prCommentPrompt : issueCommentPrompt,
  }),
  pull_request_review_comment: ({ pull_request: pr, comment }) => ({
    on: pr, pr: true, by: comment, wanted: 'created', what: 'review comment', event: 'comments', prompt: reviewCommentPrompt,
  }),
  pull_request_review: ({ pull_request: pr, review }) => ({
    on: pr, pr: true, by: review, wanted: 'submitted', what: 'review', event: 'reviews', prompt: reviewPrompt,
  }),
};

/** @param {Fanout[]} parts @returns {Fanout} */
const joined = (parts) => ({
  fires: parts.flatMap((p) => p.fires),
  reason: parts.map((p) => p.reason).filter(Boolean).join('; '),
});

/**
 * What something written says to sessions: a summons, where it mentions
 * @claude on what no session owns; a message to each subscriber to it.
 * Null when it is neither (the caller has a better reason).
 *
 * @param {(payload: any) => ReturnType<typeof WRITTEN[string]>} written
 * @param {string} event
 * @param {any} payload
 * @param {number | undefined} appId The dispatcher's App, whose comment alone is the PR review's.
 * @returns {Fanout | null}
 */
const writtenFires = (written, event, payload, appId) => {
  const action = payload?.action;
  const { on, pr, by, wanted, what, event: subscribed, prompt } = written(payload ?? {});
  const body = String(by?.body ?? '');
  /** @type {Fanout[]} */
  const parts = [];
  let summoned = false;
  // A mention summons a fresh session where no session owns the PR: the
  // owner, where there is one, is messaged instead.
  if ((pr ? sessionNamedIn(on?.body) : null) === null && mentions(body)) {
    if (action !== wanted) {
      parts.push({ fires: [], reason: `${event} ${action}: only a ${wanted} ${what} summons a session` });
    } else {
      const refused = notASummons({ body, user: by?.user, association: by?.author_association });
      const reason = `${what} ${by?.id} on #${on?.number} mentioned ${MENTION}`;
      summoned = refused === null;
      parts.push(refused ? { fires: [], reason: refused } : { fires: [summons(prompt(payload), on, reason)], reason });
    }
  }
  // A PR naming no session is its head branch's session's, unless a mention summoned one.
  const byBranch = pr && sessionNamedIn(on?.body) === null && !summoned;
  if (subscribersFor(on?.body, subscribed).length === 0 && !byBranch) return parts.length === 0 ? null : joined(parts);
  if (action !== wanted) {
    parts.push({ fires: [], reason: `${event} ${action}: only a ${wanted} ${what} reaches a subscriber` });
  } else if (what === 'review' && body.trim() === '' && !VERDICTS.has(by?.state)) {
    // A review with neither text nor a verdict is the wrapper of its inline
    // comments, each of which arrives as an event of its own.
    parts.push({ fires: [], reason: `review ${by?.id} on #${on?.number} carries no text and no verdict: its comments arrive as their own events` });
  } else {
    // The PR review's comment reaches the PR's owner alone: a subscriber
    // reads it on the PR. The owner's fire carries the fallback, so
    // a gone session is replaced whenever in the review turn the comment was
    // posted.
    const ownerOnly = reviewComment(by, appId);
    const refused = notAnUpdate({ written: by, association: by?.author_association, review: ownerOnly });
    // The PR review's marker is the receiver's to read, not the session's
    // to quote: a reply quoting it would be refused as a person's.
    const told = ownerOnly ? { ...payload, comment: { ...payload?.comment, body: withoutMarker(body) } } : payload;
    parts.push(refused ? { fires: [], reason: refused } : fanOut({
      on,
      event: subscribed,
      poster: postedBy(body),
      prompt: (role, limit) => prompt(told, role, limit),
      // An issue's owner, its filer, has nothing to hand over.
      fallback: pr,
      issue: !pr,
      ownerOnly,
      byBranch,
      sessionPost: ownSessionPost(body),
      unsigned: unsignedPost(body),
      reason: `${what} ${by?.id} on #${on?.number}`,
    }));
  }
  return joined(parts);
};

/**
 * The fires a mention summons, or a remark on something subscribed to
 * queues, with the reason for each refusal; or null when the delivery
 * carries no mention and is on nothing anyone subscribes to (the caller has
 * a better reason).
 *
 * @param {{ event: string | undefined, payload: any, appId?: number | undefined }} args
 * `appId`: the dispatcher's App, whose comment alone is the PR review's.
 * @returns {Fanout | null}
 */
export const mentionFires = ({ event, payload, appId }) => {
  const action = payload?.action;
  const written = WRITTEN[String(event)];
  if (written) return writtenFires(written, String(event), payload, appId);
  if (event === 'issues') {
    const issue = payload?.issue;
    // The one just assigned is `assignee`; `issue.assignees` is everyone,
    // so it would name claude again on every later assignment. Only someone
    // who can assign at all can assign to `claude`, so the assignment is its
    // own gate; a bot's assignment is still refused.
    const assignedToClaude = action === 'assigned' && payload?.assignee?.login === 'claude';
    if (assignedToClaude) {
      if (payload?.sender?.type === 'Bot') return { fires: [], reason: `a bot (${payload.sender.login ?? 'unnamed'}) cannot summon a session` };
      const reason = `issue #${issue?.number} assigned to claude`;
      return { fires: [summons(issuePrompt(payload), issue, reason)], reason };
    }
    if (action !== 'opened' || !mentions(issue?.body)) return null;
    // Opened already assigned to claude: GitHub sends the assignment too,
    // and that delivery is the one summons.
    if ((issue?.assignees ?? []).some((/** @type {User} */ a) => a?.login === 'claude')) {
      return { fires: [], reason: `issue #${issue?.number} opened assigned to claude: the assignment summons it` };
    }
    const refused = notASummons({ body: issue?.body, user: issue?.user, association: issue?.author_association, issue: true });
    if (refused) return { fires: [], reason: refused };
    const reason = `issue #${issue?.number} opened mentioning ${MENTION}`;
    return { fires: [summons(issuePrompt(payload), issue, reason)], reason };
  }
  return null;
};

/** What each `issues` action is to a subscriber. */
const ISSUE_EVENTS = /** @type {Record<string, SubscriptionEvent>} */ ({ labeled: 'labels', unlabeled: 'labels', closed: 'close', reopened: 'close' });

/**
 * The label a delivery added, or null: a removal is a person's edit, since
 * the dispatcher only ever adds a `deployed: ` label.
 *
 * @param {unknown} action
 * @param {{ name?: unknown } | undefined} label
 */
const addedLabel = (action, label) => (action === 'labeled' ? label?.name : null);

/**
 * An issue labelled, unlabelled, closed or reopened: a message to each
 * subscriber to it. Who did it is a login, never a session's own post, so
 * every subscriber hears; the filer hears of a label only by a line of its
 * own ({@link subscribersFor}), since the label may well be its own. A
 * `deployed: ` label added is `deploys`, not `labels`: the change
 * reached a target, which on a closed issue ends what a subscriber waits on
 * as a close does, and the filer hears of it only by a line too.
 *
 * @param {any} payload
 * @returns {Fanout}
 */
export const issueEventFires = (payload) => {
  const action = payload?.action;
  const target = deployedTarget(addedLabel(action, payload?.label));
  const deployed = target !== null;
  const event = deployed ? 'deploys' : ISSUE_EVENTS[String(action)];
  if (event === undefined) return { fires: [], reason: `issues ${action}: nothing a subscriber hears of` };
  const issue = payload?.issue;
  return fanOut({
    on: issue,
    event,
    poster: null,
    prompt: () => issueEventPrompt(payload, target),
    closing: action === 'closed' || (deployed && issue?.state === 'closed'),
    issue: true,
    reason: `issue #${issue?.number} ${deployed ? `deployed to ${target}` : action}`,
  });
};

/**
 * A pull request pushed to or closed: a message to each subscriber to
 * pushes or to close, the owner included, none with a fallback. A push
 * names its commit, so the task can skip the session whose commit it is
 * (its `Claude-Session` trailer): a push is a session's post too, and the
 * receiver cannot read the commit. Every other action is acknowledged.
 *
 * @param {any} payload
 * @returns {Fanout}
 */
export const pullRequestFires = (payload) => {
  const pr = payload?.pull_request;
  const action = payload?.action;
  if (action === 'synchronize') {
    const after = typeof payload?.after === 'string' ? payload.after : pr?.head?.sha;
    return fanOut({
      on: pr,
      event: 'pushes',
      poster: null,
      prompt: (role) => pushPrompt(payload, role),
      ...(isCommit(after) ? { commit: after } : {}),
      reason: `push to #${pr?.number}`,
    });
  }
  if (action === 'closed') {
    return fanOut({
      on: pr,
      event: 'close',
      poster: null,
      prompt: (role) => prClosedPrompt(payload, role),
      closing: !pr?.merged,
      byBranch: true,
      reason: `#${pr?.number} ${pr?.merged ? 'merged' : 'closed'}`,
    });
  }
  return { fires: [], reason: `pull_request ${action}: only a push or a close reaches a subscriber` };
};
