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
 * as a lane message, which has a size cap, so a long body is quoted only
 * so far.
 *
 * A subscription: a pull request a session wrote names that session, the
 * last claude.ai/code link in its body (the attribution footer Claude Code
 * tells every session to end a PR description with), and a message wakes a
 * session whether its container is warm or gone. Such a PR is the
 * session's to keep, so every comment, review comment and review on it,
 * but one governor's App posted, is a `message` fire, mention or not, carrying the `dispatch` it would
 * otherwise have been as its fallback, which the task starts only if the
 * session refuses (archived) and the PR is still open. A session's post
 * carries none: the owner's own is an echo, and another session's remark is
 * not worth a takeover. Any other session subscribes with a line in
 * the body, a PR's or an issue's, and hears of the events it names
 * with no fallback: the task drops a subscriber that refuses. An issue a
 * session filed names it the same way, and it hears of every event there
 * but labels and deploys (a `deployed: ` label) as its owner, with
 * no fallback, since an issue has nothing to take over; its link stays
 * should it refuse, so the ticket names its last owner. A push, a
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
 * trailer to tell. Nor does a mention, which queues a summons: the task
 * hands it to the PR's live owner where it has one, and starts a fresh
 * session only where it has none (dispatch/dispatch-fire.mjs). Nor does a
 * session's post naming no session, which is taken for the branch
 * session's own; a post naming one tells the task it as `poster`.
 *
 * Who may summon a fresh session: someone with a say in the repository
 * (owner, member, collaborator). A bot cannot, and neither can a session:
 * every comment a session posts ends in the Claude Code footer, and one
 * quoting "@claude" back would otherwise start a session that starts one.
 *
 * Whose text reaches a session: an author the repo's `trust.relay` lets in
 * (`relay`, the receiver's list, route.mjs). A comment or review is judged
 * by its own author; a session link or a subscribe line in a body counts
 * only where the body's author is let in ({@link relayedBody}); and an
 * event that carries no text, a label, a close, a reopen or a push, is
 * judged by the author of the issue or PR it is on, since the payload
 * carries no association for its sender. Governor's own App is never
 * judged. Each message fire names the kinds it was judged by
 * (`authors`), so the task judges them again from the repo's file.
 *
 * Who wrote a session's post: the session whose link sits under the footer,
 * or alone on the line above it, and that session is not messaged with its
 * own post. The footer Claude Code puts on a comment names no session, so a
 * session signs its posts only when told to. Every session the dispatcher
 * starts is told in its opening prompt (`SIGN_POSTS`, fire.mjs). A
 * session's post naming no session may be any subscriber's, so it reaches
 * every one, and the message says so ({@link UNSIGNED}). An author that
 * reads its own post back posts nothing and signs the next one. Each fire
 * carries the post, and the task searches the login's live sessions for
 * its author before it relays, so it skips the author and drops the line
 * where the search decided (dispatch/author.mjs); a post no fire relays
 * queues an `author` fire ({@link authorFires}). Skipping
 * the owner instead would lose a reviewer session's remark, and an owner
 * that nothing wakes leaves its PR idle.
 *
 * Pure: no I/O. route.mjs calls it for the events it applies to.
 */

import { DISPATCH_MARKER, FIRE_BUDGET, LOGIN, RELAY, SIGN_POSTS, SUMMONERS, UNATTENDED, authorKind, build, deployedTarget, isBranch, isCommit, fireWeight, lets, postWords, wordsOf, POST_WORDS, POST_WORDS_CHARS } from './fire.mjs';
import { closingNumbers } from './closing.mjs';
import { REVIEW_MARKER, postedByApp } from './review-comment.mjs';
import { ownSessionPost, postedBy, relayedBody, sameSession, sessionId, sessionNamedIn, subscribersFor, unsignedPost, unsignedSessionBody, withoutQuotes } from './subscribe.mjs';

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
 * Quotes go first: GitHub closes a fence where its quote ends, and a code
 * span blanked at the start of a line would leave a `>` that reads as one.
 *
 * @param {unknown} text
 */
export const mentions = (text) => MENTION_RE.test(withoutQuotes(String(text ?? '')).replace(CODE_RE, ' '));

/** The events a mention can arrive in, beside `issues`. */
export const MENTION_EVENTS = new Set(['issue_comment', 'pull_request_review_comment', 'pull_request_review']);

/** How much of a body the prompt quotes; the URL carries the rest. */
const EXCERPT_CHARS = 1500;

/** The least of a quote worth keeping beside a reply: below it, the quote goes. */
const MIN_QUOTE_CHARS = 100;

const OWN_PR = 'This is your pull request. Decide what it needs: a code change (commit and push to its branch), a reply on the thread, or nothing. Do not open a new branch or PR.';

const SUBSCRIBED_PR = 'You subscribe to this pull request; it is not yours. Decide what it needs from you: a review, a reply on the thread, or nothing. Do not push to its branch.';

const SUBSCRIBED_ISSUE = 'You subscribe to this issue. Decide what it needs from you: a reply on the issue, a change to work of yours it bears on, or nothing.';

/**
 * What a ticket's spec owner is told where a comment calls on it: the
 * spec is its to judge, and a comment it disagrees with gets a reply, not
 * an edit. The role lines (dispatch/roles.mjs) and governor's own comment's
 * note (dispatch/told.mjs) say the same.
 */
export const SPEC_OWNER_DUTY = 'You own its spec. If the comment calls for a change you agree with, edit the body. If you disagree, reply on the issue saying why.';

/** The line naming the spec owner's role, to the session an issue's body names. */
const SPEC_OWNER = 'You are its spec owner.';

/** What an issue's spec owner is told of a comment on it, open or closed. @param {any} issue */
const ownedIssueComment = (issue) => (issue?.state === 'closed' ? `${SPEC_OWNER} Nothing is asked of you.` : `${SPEC_OWNER}\n${SPEC_OWNER_DUTY}`);

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
export const HANDOFF = 'The session that wrote this PR is gone; it is yours now. Governor points the PR description\'s session link at you; if it still names another session, put your own link in its place, and keep it there, so later comments reach you.';

/**
 * What a message about a session's post naming no session adds: the
 * recipient may be its author, and is told to sign its posts so the next one
 * is skipped.
 */
export const UNSIGNED = `This post ends in the Claude Code footer and names no session, so governor cannot tell which session wrote it. If you wrote it, it has come back to you: post nothing about it. ${SIGN_POSTS}`;

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
  const { quote, reply } = splitQuote(text);
  if (!quote || !reply) return cut(text, limit);
  // A quote reply puts the quoted post first. The person's own words matter
  // more than the quote, so the quote gives way before the reply does.
  const room = limit - reply.length - 2;
  if (room < MIN_QUOTE_CHARS) return `> [… a quote of ${quote.length} characters at the URL above]\n\n${cut(reply, limit)}`;
  return `${quote.slice(0, room)}\n> [… ${quote.length - room} more characters of the quote at the URL above]\n\n${reply}`;
};

/**
 * @param {string} text
 * @param {number} limit
 */
const cut = (text, limit) => (text.length <= limit
  ? text
  : `${text.slice(0, limit)}\n[… ${text.length - limit} more characters at the URL above]`);

/**
 * A remark's leading quote, its `>` lines and the blank lines among them,
 * and the rest. A remark that does not open with a quote has none.
 *
 * @param {string} text
 */
const splitQuote = (text) => {
  const lead = /^(?:[ \t]*>[^\n]*(?:\n|$)|[ \t\r]*\n)*/.exec(text)?.[0] ?? '';
  return { quote: lead.trimEnd(), reply: text.slice(lead.length).trim() };
};

/**
 * Whom a prompt addresses: a fresh session a mention summoned, the PR's
 * owner, or a subscriber.
 *
 * @typedef {'mention' | 'owner' | 'subscriber' | 'ticket'} Role
 * @typedef {import('./fire.mjs').SubscriptionEvent} SubscriptionEvent
 * @typedef {{ login?: string, type?: string }} User
 * @typedef {{ body?: unknown, user?: User, author_association?: unknown, performed_via_github_app?: { id?: unknown } | null }} Written
 * @typedef {import('./fire.mjs').DispatchFire} DispatchFire
 * @typedef {import('./fire.mjs').MessageFire} MessageFire
 * @typedef {{ fire: DispatchFire | MessageFire, reason: string, key?: string }} Queued
 * @typedef {{ fires: Queued[], reason: string }} Fanout
 */

/**
 * Why `body` by `user` is not a summons, or null when it is. A session's
 * post is one whose footer stands outside any quote: a member's reply
 * quoting a session's post is the member's. An issue's body (`issue`) that
 * names its owner session outside any quote is that session's own, even
 * where the GitHub tool stripped its footer to the link on its last line.
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
 * Whether `written` is a comment governor's App posted, on an issue or a
 * PR. Every such comment is a record for people, and the relay sends it
 * to nobody: the turn that posted it messaged the sessions that should
 * hear it, so one turn decides who hears each fact governor states. That
 * holds for a dispatch comment, a blocker's close, a wait's comments, a
 * trust refusal, an issue review, a deploy and the PR review's comment
 * alike, and for any kind written later. A person's comment quoting
 * governor's marker is a remark like any other.
 *
 * @param {Written | undefined} written
 * @param {number | undefined} appId
 */
const governorComment = (written, appId) => postedByApp(written, appId);

/** Why governor's own comment on issue or PR `n` queued nothing. @param {unknown} n */
const governorDropped = (n) => `governor's comment on #${n} is a record for people: the turn that posted it told the sessions that should hear it`;

/**
 * The author of an issue, a PR or a remark in a payload, as a trust list
 * judges it: governor's own App (`appId`) is `own`.
 *
 * @param {Written | undefined} row
 * @param {number | undefined} appId
 * @returns {import('./fire.mjs').Author}
 */
const authorOf = (row, appId) => ({
  ...(typeof row?.user?.login === 'string' ? { author: row.user.login } : {}),
  ...(typeof row?.author_association === 'string' ? { association: row.author_association } : {}),
  bot: row?.user?.type === 'Bot',
  own: postedByApp(row, appId),
});

/**
 * Why `relay` does not let `author` in, for a refusal's reason, naming
 * whose `what` it is.
 *
 * @param {import('./fire.mjs').Author} author
 * @param {string} what
 */
const unrelayed = (author, what) => `${what} by ${author.author ?? 'someone'} (${authorKind(author)}), whom the repo's trust.relay does not let in`;

/**
 * The kinds a message fire was judged by, for the task to judge again from
 * the file: each author but governor's own App, once each.
 *
 * @param {ReadonlyArray<import('./fire.mjs').Author | null>} authors
 * @returns {string[]}
 */
const kindsOf = (authors) => [...new Set(authors.filter((a) => a !== null && a.own !== true).map((a) => authorKind(/** @type {import('./fire.mjs').Author} */ (a))))];

/**
 * Why `written` reaches no subscriber, or null when it may: only an author
 * `relay` lets in may, and governor's own App always. By default a bot's
 * may: a review bot's findings are what a session waits for. A stranger's
 * may not, nor the dispatcher's own marker, nor a person quoting the PR
 * review's marker. Whose post it is decides only who is skipped
 * ({@link fanOut}). Governor's own comments never get here: the relay
 * drops every one ({@link governorComment}).
 *
 * @param {{ written: Written | undefined, relay: readonly string[], appId: number | undefined }} args
 * @returns {string | null}
 */
const notAnUpdate = ({ written, relay, appId }) => {
  const text = String(written?.body ?? '');
  const user = written?.user;
  if (text.includes(DISPATCH_MARKER)) return "the dispatcher's own marker";
  if (text.includes(REVIEW_MARKER) && user?.type !== 'Bot') return "a person's comment quoting the PR review's marker";
  const author = authorOf(written, appId);
  if (!lets(relay, author)) return unrelayed(author, 'written');
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
 * since it starts a session. It names `on` and the kind of its author, for
 * the task to judge by the repo's `trust.task` and say why on `on` if it
 * refuses: the writer has a say, so a refusal is worth a comment. An `on`
 * governor's own App opened names no author, since every list lets it in.
 * It names who set it going too, for the task to judge by the repo's
 * `trust.start`: the writer's association (`writer`), which the receiver
 * has already held to the three, or, for an assignment, which carries no
 * association, the assigner's login (`assigner`). A summons on an issue
 * names the ticket too ({@link summonedTicket}), so the task can hand it to
 * a live spec owner or builder in place of starting anyone.
 *
 * @param {string} prompt
 * @param {any} on
 * @param {string} reason
 * @param {number | undefined} appId
 * @param {{ writer?: string, assigner?: string, ticket?: import('./fire.mjs').SummonedTicket }} by
 * @returns {Queued}
 */
const summons = (prompt, on, reason, appId, by) => {
  const author = authorOf(on, appId);
  return {
    fire: build.dispatch({
      prompt: `${prompt}\n${UNATTENDED}`,
      sessionName: sessionName(on?.number, on?.title),
      on: Number.isInteger(on?.number) && on.number > 0 ? on.number : undefined,
      author: author.own === true ? undefined : authorKind(author),
      writer: by.writer,
      assigner: by.assigner,
      ticket: by.ticket,
    }),
    reason,
  };
};

/**
 * What a summons on an issue, or a ticket fire ({@link ticketFires}), says
 * of its ticket: its state and labels, and the spec owner its body names,
 * read only where `bodies` lets the body's author in.
 *
 * @param {any} issue
 * @param {readonly string[]} bodies
 * @param {number | undefined} appId
 * @returns {import('./fire.mjs').SummonedTicket}
 */
const summonedTicket = (issue, bodies, appId) => {
  const ticketBody = relayedBody({ body: issue?.body, ...authorOf(issue, appId) }, bodies);
  const owner = sessionNamedIn(ticketBody);
  return {
    state: issue?.state === 'closed' ? 'closed' : 'open',
    labels: (issue?.labels ?? []).map((/** @type {{ name?: unknown }} */ l) => l?.name).filter((/** @type {unknown} */ n) => typeof n === 'string' && n !== ''),
    ...(owner === null ? {} : { owner }),
  };
};

/**
 * One subscriber's fire: a `message` of the prompt into its session, keyed
 * by the session so each subscriber's is its own lane message. The owner's
 * fire on a remark carries the dispatch it would otherwise have been as
 * the fallback, told to take the PR over; the prompt then rides twice, so a
 * remark too long for the lane is quoted shorter, halving until it
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
 *   mergedAt?: string | undefined,
 *   issue?: boolean,
 *   unsigned?: boolean,
 *   post?: import('./fire.mjs').UnsignedPost | null,
 *   offer?: string | null,
 *   moved?: import('./fire.mjs').MovedLink | undefined,
 *   edited?: import('./fire.mjs').UnsignedPost | null,
 *   authors: string[],
 *   reason: string,
 * }} args `issue`: `on` is an issue, whose owner, its filer, hears by subscription.
 *   `authors`: the kinds the fire was judged by, which the task judges again.
 *   `unsigned`: a session's post naming no session, which the message says
 *   ({@link UNSIGNED}). A session's post carries no fallback. `post`: the
 *   unsigned post, which the fire carries so the task can search for its
 *   author before it relays ({@link unsignedOf}).
 *   `offer`: the session that signed a comment on an issue, which the
 *   owner's fire names, so the task offers it the issue should the owner
 *   refuse as archived (dispatch/offer.mjs).
 *   `moved`: on an issue owner's message of a body edit, where the edit
 *   moved the owner link from (dispatch/take.mjs).
 *   `edited`: on an issue owner's message of a body edit, the edit's time,
 *   page and words ({@link editedOf}), so the task can search for
 *   who made it (dispatch/editor.mjs).
 * @returns {Queued}
 */
const messageFire = ({ prompt, subscriber: { session, owner }, poster = null, on, event, fallback, commit, closing, mergedAt, issue = false, unsigned = false, post = null, offer = null, moved, edited = null, authors, reason }) => {
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
    mergedAt,
    subscribed: !owner || issue,
    authors,
    offer: owner && issue && event === 'comments' ? offer : null,
    moved: owner && issue ? moved : undefined,
    unsigned: unsigned ? post : null,
    edited: owner && issue ? edited : null,
    fallback: owner && fallback
      ? { prompt: `${text}\n${HANDOFF}\n${UNATTENDED}`, sessionName: sessionName(on?.number, on?.title), issue: number }
      : undefined,
  });
  let limit = EXCERPT_CHARS;
  let message = fire(prompt(role, limit));
  while (fireWeight(message) > FIRE_BUDGET && limit > 1) {
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
 * nothing. A merge is not closing here: `mergedAt`, the ref it landed at,
 * lets the task ask for the sign-off where the repo sends no deploy
 * messages, or name the deploys to come where it does (dispatch/merge-notice.mjs).
 *
 * @param {{
 *   on: any,
 *   body: string,
 *   by: import('./fire.mjs').Author | null,
 *   onAuthor: import('./fire.mjs').Author,
 *   event: SubscriptionEvent,
 *   poster: string | null,
 *   prompt: (role: Role, limit: number) => string,
 *   fallback?: boolean,
 *   commit?: string,
 *   closing?: boolean,
 *   mergedAt?: string | undefined,
 *   byBranch?: boolean,
 *   sessionPost?: boolean,
 *   unsigned?: boolean,
 *   post?: import('./fire.mjs').UnsignedPost | null,
 *   issue?: boolean,
 *   reason: string,
 * }} args `body`: `on`'s body as {@link relayedBody} lets sessions be read
 *   from it. `by`: who wrote what is relayed, null for an event, which
 *   carries no text; `onAuthor`: who opened `on`. A fire to a session the
 *   body names is judged by both, a fire to the live session on a PR's
 *   head branch by what was written alone, or by `onAuthor` for an event.
 *   `issue`: `on` is an issue, whose owner hears `deploys` only by a line.
 *   `byBranch`: `on` is a PR, and with no session its body names, the
 *   live session on its head branch is the owner; `sessionPost`, what was
 *   posted is a session's outside any quote (`ownSessionPost`), which then
 *   is that session's own. `unsigned`: a
 *   session posted it and did not sign it (`unsignedPost`), so any
 *   subscriber may have written it, and each hears of it, told so
 *   ({@link UNSIGNED}). `post`: that post, as each fire carries it.
 * @returns {Fanout}
 */
const fanOut = ({ on, body, by, onAuthor, event, poster, prompt, fallback = false, commit, closing = false, mergedAt, byBranch = false, sessionPost = false, unsigned = false, post = null, issue = false, reason }) => {
  /** @type {Queued[]} */
  const fires = [];
  /** @type {string[]} */
  const skipped = [];
  const subscribers = subscribersFor(body, event, { issue });
  const named = kindsOf([by, onAuthor]);
  if (byBranch && sessionNamedIn(body) === null) {
    if (sessionPost && poster === null) skipped.push("a session's post naming no session, taken for the local session's own");
    else fires.push(messageFire({ prompt, subscriber: { session: null, owner: true }, poster, on, event, fallback, commit, closing, mergedAt, authors: kindsOf([by ?? onAuthor]), reason }));
  }
  for (const subscriber of subscribers) {
    if (poster !== null && sameSession(poster, subscriber.session)) {
      skipped.push(`${sessionId(poster)}'s own post`);
      continue;
    }
    fires.push(messageFire({ prompt, subscriber, on, event, fallback, commit, closing, mergedAt, issue, unsigned, post, offer: poster, authors: named, reason }));
  }
  const heard = fires.length === 0 && skipped.length === 0 ? [`${reason}: nobody subscribes to ${event}`] : [];
  return { fires, reason: [...fires.map((f) => f.reason), ...skipped, ...heard].join('; ') };
};

/**
 * The first line of a prompt to a subscriber or the owner: what was
 * written, and on whose.
 *
 * @param {Role} role
 * @param {string} what
 */
const heading = (role, what) => (role === 'owner' ? `A ${what} on your pull request.` : `A ${what} on a pull request you subscribe to.`);

/** @param {Role} role */
const closingFor = (role) => (role === 'owner' ? OWN_PR : SUBSCRIBED_PR);

/**
 * An issue or a PR as a message names it: a Markdown link on its number,
 * then its title.
 *
 * @param {any} on
 */
export const refLine = (on) => `[#${on?.number}](${on?.html_url}) ${oneLine(on?.title)}`;

/**
 * What a relay about an issue ends with, by the recipient's role: a
 * mention's ask, a subscriber's, or the spec owner's role and what the
 * event asks of it. A ticket fire's text ends with none: the task adds
 * each role's lines (dispatch/ticket-fire.mjs).
 *
 * @param {Role} role
 * @param {string} mention what a mention asks
 * @param {string} owner what the spec owner is told
 * @returns {string[]}
 */
const issueClose = (role, mention, owner) => {
  if (role === 'ticket') return [];
  return ['', role === 'mention' ? mention : role === 'owner' ? owner : SUBSCRIBED_ISSUE];
};

/** @param {any} payload @param {Role} [role] @param {number} [limit] */
const issueCommentPrompt = ({ issue, comment }, role = 'mention', limit = EXCERPT_CHARS) => [
  role === 'mention' ? `An issue comment mentioned ${MENTION}.` : role === 'subscriber' ? 'A comment on an issue you subscribe to.' : 'A comment on an issue.',
  '',
  refLine(issue),
  `[Comment](${comment?.html_url}) by ${comment?.user?.login}:`,
  excerpt(comment?.body, limit),
  ...issueClose(
    role,
    `Do what the comment asks. If it needs code changes, create a branch, implement them, and open a PR linking issue #${issue?.number}. If it is a question, answer it as a comment on issue #${issue?.number}.`,
    ownedIssueComment(issue),
  ),
].join('\n');

/** @param {any} payload @param {Role} [role] @param {number} [limit] */
const prCommentPrompt = ({ issue, comment }, role = 'mention', limit = EXCERPT_CHARS) => [
  role === 'mention' ? `A comment on a pull request mentioned ${MENTION}.` : heading(role, 'comment'),
  '',
  refLine(issue),
  `[Comment](${comment?.html_url}) by ${comment?.user?.login}:`,
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
  `${refLine(pr)}, head branch "${pr?.head?.ref}"`,
  `[Review comment](${comment?.html_url}) by ${comment?.user?.login} on ${comment?.path} line ${comment?.line ?? comment?.original_line ?? '?'}:`,
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
  `${refLine(pr)}, head branch "${pr?.head?.ref}"`,
  `[Review](${review?.html_url}) by ${review?.user?.login}, state ${review?.state}:`,
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
  refLine(issue),
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
  `${refLine(pr)}, head branch "${pr?.head?.ref}"`,
  `Pushed by ${sender?.login}: ${repository?.html_url}/compare/${before}...${after}`,
  '',
  role === 'owner'
    ? 'Someone else pushed to your branch: pull it before you push again, and decide whether it needs anything from you.'
    : SUBSCRIBED_PR,
].join('\n');

/**
 * The ref a merged PR landed at: its merge commit, or its base branch where
 * the payload names none, or `HEAD`, the default branch, where it names
 * neither. The task reads the repo's workflows there (dispatch/merge-notice.mjs).
 *
 * @param {any} pr
 * @returns {string}
 */
const mergedAt = (pr) => {
  if (isCommit(pr?.merge_commit_sha)) return pr.merge_commit_sha;
  return isBranch(pr?.base?.ref) ? pr.base.ref : 'HEAD';
};

/**
 * A PR's close, to its owner and its subscribers to close. A merge's text
 * says nothing of deploys: the receiver cannot read the repo's switches or
 * its deploy targets, so the task adds them, or the ask to sign off, by the
 * fire's `mergedAt` (dispatch/merge-notice.mjs).
 *
 * @param {any} payload
 * @param {Role} role
 */
const prClosedPrompt = ({ pull_request: pr, sender }, role) => {
  const how = pr?.merged ? 'merged' : 'closed without merging';
  return [
    role === 'owner' ? `Your pull request was ${how}.` : `A pull request you subscribe to was ${how}.`,
    '',
    `${refLine(pr)}, by ${sender?.login}`,
    '',
    pr?.merged
      ? 'Nothing else on it is left to do unless its thread says so.'
      : 'Nothing on it is left to do unless its thread says so.',
  ].join('\n');
};

/**
 * An issue labelled, unlabelled, closed or reopened, or its change
 * deployed, in one line naming the issue as a link, then what it asks of
 * the recipient by its role ({@link issueClose}). None of these events
 * asks anything of the spec owner.
 *
 * @param {any} payload
 * @param {string | null} target The `deployed: ` label's target, if one was added.
 * @param {Role} [role]
 */
const issueEventPrompt = ({ action, issue, label, sender }, target, role = 'subscriber') => {
  const what = target !== null
    ? `reached ${target}, labelled "${label?.name}" by ${sender?.login}`
    : `${{
      labeled: `was labelled "${label?.name}"`,
      unlabeled: `lost the label "${label?.name}"`,
      closed: `was closed${issue?.state_reason ? ` (${String(issue.state_reason).replace(/_/g, ' ')})` : ''}`,
      reopened: 'was reopened',
    }[String(action)]} by ${sender?.login}`;
  return [
    `${refLine(issue)} ${what}.`,
    ...issueClose(role, SUBSCRIBED_ISSUE, `${SPEC_OWNER} Nothing is asked of you.`),
  ].join('\n');
};

/**
 * What a ticket's spec owner is told of a body edit. The delivery names only
 * a login, and sessions edit as the operator's, so governor cannot tell the
 * spec owner's own edit from a person's.
 */
export const EDIT_SPEC_OWNER = 'The edit names only a login, and sessions edit as the operator\'s, so it may be your own. Read the body again before you next edit it, so you do not write over a person\'s change from an old copy.';

/** What a ticket's builder is told of a body edit. */
export const EDIT_BUILDER = 'Its spec changed. Build against the body as it now reads, and record in your PR description where your work differs from it.';

/**
 * A ticket's body edited: what happened, before what each role is told.
 *
 * @param {any} payload
 */
const bodyEditPrompt = ({ issue, sender }) => `The body of ${refLine(issue)} was edited by ${sender?.login}.`;

/**
 * Whether an `issues` delivery is a body edit that reaches a ticket's
 * roles: the body changed, and not by a bot. A bot's body edit is governor's
 * own (a spec session's link written, a wait line rewritten), and the
 * delivery carries no App id to tell another bot's from it.
 *
 * @param {any} payload
 */
const bodyEdited = (payload) => payload?.action === 'edited'
  && payload?.changes?.body !== undefined
  && payload?.sender?.type !== 'Bot';

/** How many unchanged words before a body edit's first changed word its words start with. */
const EDIT_LEAD = 8;

/**
 * The words of a body edit a call that made it carries: the new body's
 * words from {@link EDIT_LEAD} before the first word that differs from the
 * old body's, as many as a post's first words. An older copy of the body,
 * from an earlier edit, does not hold them in that order, so the call that
 * made an earlier edit is not taken for this one's. Empty where no word
 * changed.
 *
 * @param {string} from the old body
 * @param {string} to the new body
 */
export const editWords = (from, to) => {
  const old = wordsOf(from);
  const now = wordsOf(to);
  let i = 0;
  while (i < old.length && i < now.length && old[i] === now[i]) i += 1;
  if (i === old.length && i === now.length) return '';
  const start = Math.max(0, i - EDIT_LEAD);
  return now.slice(start, start + POST_WORDS).join(' ').slice(0, POST_WORDS_CHARS);
};

/**
 * A body edit's time, page and words, in an unsigned post's shape: the
 * time is the issue's `updated_at`, which an `edited` delivery sets to the
 * edit's, the page the issue's, and the words those around the change
 * ({@link editWords}). Null where the payload lacks a time or a github.com
 * page.
 *
 * @param {any} payload
 * @returns {import('./fire.mjs').UnsignedPost | null}
 */
export const editedOf = (payload) => {
  const issue = payload?.issue;
  const at = issue?.updated_at;
  const url = issue?.html_url;
  if (typeof at !== 'string' || at.length > 40 || !Number.isFinite(Date.parse(at))) return null;
  if (typeof url !== 'string' || url.length > 300 || !/^https:\/\/github\.com\/\S+$/.test(url)) return null;
  const from = payload?.changes?.body?.from;
  return { at, url, words: editWords(typeof from === 'string' ? from : '', String(issue?.body ?? '')) };
};

/**
 * Where a body edit moved the issue's owner link from, or undefined where
 * it moved nothing: the new body, read through `relayedBody` under
 * `bodies`, names a session, and the old body (`changes.body.from`), read
 * the same way, names another session (`owned`, with it as `from`), is a
 * session's unsigned post (`unsigned`), or is a person's (`person`). The
 * task decides by the repo's file what it means (dispatch/take.mjs).
 *
 * @param {any} payload
 * @param {readonly string[]} bodies
 * @param {number | undefined} appId
 * @returns {import('./fire.mjs').MovedLink | undefined}
 */
const movedLink = (payload, bodies, appId) => {
  const issue = payload?.issue;
  const author = authorOf(issue, appId);
  const now = relayedBody({ body: issue?.body, ...author }, bodies);
  const to = sessionNamedIn(now);
  if (to === null) return undefined;
  const from = payload?.changes?.body?.from;
  const old = relayedBody({ body: typeof from === 'string' ? from : '', ...author }, bodies);
  const was = sessionNamedIn(old);
  if (was !== null) return sameSession(was, to) ? undefined : { old: 'owned', from: was };
  return { old: unsignedSessionBody(old) ? 'unsigned' : 'person' };
};

/**
 * A ticket's body edited: the spec owner's message, told the edit may be
 * its own ({@link EDIT_SPEC_OWNER}). The fire carries the edit's time
 * ({@link editedOf}): the task searches for who made
 * the edit and tells the owner that in place of the line, or tells it
 * nothing where the edit was its own (dispatch/editor.mjs). On a claimed ticket the ticket fire
 * ({@link ticketFires}) replaces it and reaches the builders too. Only the
 * spec owner hears it here: a subscribe line names no body edits.
 *
 * Judged by the issue's author, under `relay`.
 *
 * @param {any} payload
 * @param {{ relay?: readonly string[], bodies?: readonly string[], appId?: number | undefined }} [trust]
 * @returns {Fanout}
 */
export const bodyEditFires = (payload, { relay = RELAY, bodies = relay, appId } = {}) => {
  const issue = payload?.issue;
  if (!bodyEdited(payload) || issue?.pull_request) return { fires: [], reason: '' };
  const onAuthor = authorOf(issue, appId);
  if (!lets(relay, onAuthor)) return { fires: [], reason: `issue #${issue?.number} body edited: no session hears of it, as it is ${unrelayed(onAuthor, 'opened')}` };
  // The spec owner the body names, read only where `bodies` lets its author in.
  const ticketBody = relayedBody({ body: issue?.body, ...onAuthor }, bodies);
  const owner = sessionNamedIn(ticketBody);
  const reason = `issue #${issue?.number} body edited`;
  if (owner === null) return { fires: [], reason: `${reason}: its body names no spec owner` };
  // `comments` only drops an archived spec owner from the body's subscribe
  // lines, as a comment's message does.
  const fire = messageFire({
    prompt: () => `${bodyEditPrompt(payload)}\n\n${SPEC_OWNER}\n\n${EDIT_SPEC_OWNER}`,
    subscriber: { session: owner, owner: true },
    on: issue,
    event: 'comments',
    fallback: false,
    issue: true,
    authors: kindsOf([onAuthor]),
    moved: movedLink(payload, bodies, appId),
    edited: editedOf(payload),
    reason,
  });
  return { fires: [fire], reason: fire.reason };
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
 * @param {readonly string[]} relay Whose text may reach a running session.
 * @param {readonly string[]} bodies Whose body may name a session.
 * @returns {Fanout | null}
 */
const writtenFires = (written, event, payload, appId, relay, bodies) => {
  const action = payload?.action;
  const { on, pr, by, wanted, what, event: subscribed, prompt } = written(payload ?? {});
  const body = String(by?.body ?? '');
  if (governorComment(by, appId)) return { fires: [], reason: governorDropped(on?.number) };
  const onAuthor = authorOf(on, appId);
  // The sessions `on` names, read only where `bodies` lets its author in.
  const onBody = relayedBody({ body: on?.body, ...onAuthor }, bodies);
  /** @type {Fanout[]} */
  const parts = [];
  let summoned = false;
  // A mention summons a fresh session where no session owns the PR: the
  // owner, where there is one, is messaged instead. On an issue the summons
  // always queues, naming the ticket, and the task hands it to a live spec
  // owner or builder before it starts anyone (dispatch/dispatch-fire.mjs).
  if ((pr ? sessionNamedIn(onBody) : null) === null && mentions(body)) {
    if (action !== wanted) {
      parts.push({ fires: [], reason: `${event} ${action}: only a ${wanted} ${what} summons a session` });
    } else {
      const refused = notASummons({ body, user: by?.user, association: by?.author_association });
      const reason = `${what} ${by?.id} on #${on?.number} mentioned ${MENTION}`;
      summoned = refused === null;
      parts.push(refused ? { fires: [], reason: refused } : { fires: [summons(prompt(payload), on, reason, appId, { writer: String(by?.author_association), ...(pr ? {} : { ticket: summonedTicket(on, bodies, appId) }) })], reason });
    }
  }
  // A PR naming no session is its head branch's session's, unless a mention summoned one.
  const byBranch = pr && sessionNamedIn(onBody) === null && !summoned;
  if (subscribersFor(onBody, subscribed).length === 0 && !byBranch) return parts.length === 0 ? null : joined(parts);
  if (action !== wanted) {
    parts.push({ fires: [], reason: `${event} ${action}: only a ${wanted} ${what} reaches a subscriber` });
  } else if (what === 'review' && body.trim() === '' && !VERDICTS.has(by?.state)) {
    // A review with neither text nor a verdict is the wrapper of its inline
    // comments, each of which arrives as an event of its own.
    parts.push({ fires: [], reason: `review ${by?.id} on #${on?.number} carries no text and no verdict: its comments arrive as their own events` });
  } else {
    const refused = notAnUpdate({ written: by, relay, appId });
    parts.push(refused ? { fires: [], reason: refused } : fanOut({
      on,
      body: onBody,
      by: authorOf(by, appId),
      onAuthor,
      event: subscribed,
      poster: postedBy(body),
      prompt: (role, limit) => prompt(payload, role, limit),
      // An issue's owner, its filer, has nothing to hand over. Nor does a
      // session's post: the owner's own is an echo, and another session's
      // remark is not worth a takeover. A fresh session started on one
      // tends to post and sign off, and its post would start the next. A
      // person's reply quoting a session's post is the person's remark.
      fallback: pr && !ownSessionPost(body),
      issue: !pr,
      byBranch,
      sessionPost: ownSessionPost(body),
      unsigned: unsignedPost(body),
      post: unsignedOf(by),
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
 * @param {{ event: string | undefined, payload: any, appId?: number | undefined, relay?: readonly string[], bodies?: readonly string[] }} args
 * `appId`: the dispatcher's App, whose comment alone is the PR review's.
 * `relay`: whose text may reach a running session, the defaults where the
 * receiver knows no other (route.mjs). `bodies`: whose body may name a
 * session, `relay` where unset. The receiver widens `relay` to the three to
 * drop only a comment it is sure of, and reads bodies under the file's list.
 * @returns {Fanout | null}
 */
export const mentionFires = ({ event, payload, appId, relay = RELAY, bodies = relay }) => {
  const action = payload?.action;
  const written = WRITTEN[String(event)];
  if (written) return writtenFires(written, String(event), payload, appId, relay, bodies);
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
      const assigner = typeof payload?.sender?.login === 'string' && LOGIN.test(payload.sender.login) ? payload.sender.login : undefined;
      return { fires: [summons(issuePrompt(payload), issue, reason, appId, { assigner, ticket: summonedTicket(issue, bodies, appId) })], reason };
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
    return { fires: [summons(issuePrompt(payload), issue, reason, appId, { writer: String(issue?.author_association), ticket: summonedTicket(issue, bodies, appId) })], reason };
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
 * Judged by the issue's author, under `relay`.
 *
 * @param {any} payload
 * @param {{ relay?: readonly string[], bodies?: readonly string[], appId?: number | undefined }} [trust]
 * `bodies`: whose body may name a session, `relay` where unset.
 * @returns {Fanout}
 */
export const issueEventFires = (payload, { relay = RELAY, bodies = relay, appId } = {}) => {
  const action = payload?.action;
  const target = deployedTarget(addedLabel(action, payload?.label));
  const deployed = target !== null;
  const event = deployed ? 'deploys' : ISSUE_EVENTS[String(action)];
  if (event === undefined) return { fires: [], reason: `issues ${action}: nothing a subscriber hears of` };
  const issue = payload?.issue;
  const onAuthor = authorOf(issue, appId);
  if (!lets(relay, onAuthor)) return { fires: [], reason: `issue #${issue?.number} ${action}: no subscriber hears of it, as it is ${unrelayed(onAuthor, 'opened')}` };
  return fanOut({
    on: issue,
    body: relayedBody({ body: issue?.body, ...onAuthor }, bodies),
    by: null,
    onAuthor,
    event,
    poster: null,
    prompt: (role) => issueEventPrompt(payload, target, role),
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
 * Judged by the PR's author, under `relay`.
 *
 * @param {any} payload
 * @param {{ relay?: readonly string[], bodies?: readonly string[], appId?: number | undefined }} [trust]
 * `bodies`: whose body may name a session, `relay` where unset.
 * @returns {Fanout}
 */
export const pullRequestFires = (payload, { relay = RELAY, bodies = relay, appId } = {}) => {
  const pr = payload?.pull_request;
  const action = payload?.action;
  if (action !== 'synchronize' && action !== 'closed') return { fires: [], reason: `pull_request ${action}: only a push or a close reaches a subscriber` };
  const onAuthor = authorOf(pr, appId);
  if (!lets(relay, onAuthor)) return { fires: [], reason: `#${pr?.number} ${action}: no subscriber hears of it, as it is ${unrelayed(onAuthor, 'opened')}` };
  const judged = { body: relayedBody({ body: pr?.body, ...onAuthor }, bodies), by: null, onAuthor };
  if (action === 'synchronize') {
    const after = typeof payload?.after === 'string' ? payload.after : pr?.head?.sha;
    return fanOut({
      on: pr,
      ...judged,
      event: 'pushes',
      poster: null,
      prompt: (role) => pushPrompt(payload, role),
      ...(isCommit(after) ? { commit: after } : {}),
      reason: `push to #${pr?.number}`,
    });
  }
  return fanOut({
    on: pr,
    ...judged,
    event: 'close',
    poster: null,
    prompt: (role) => prClosedPrompt(payload, role),
    closing: !pr?.merged,
    ...(pr?.merged ? { mergedAt: mergedAt(pr) } : {}),
    byBranch: true,
    reason: `#${pr?.number} ${pr?.merged ? 'merged' : 'closed'}`,
  });
};

/**
 * @typedef {{ fire: import('./fire.mjs').TicketFire, reason: string, key: string, claimed?: { labels: string[], replaces: string | null } }} TicketQueued
 *   A ticket fire, and what the receiver settles it by
 *   (`settleClaims`, route.mjs): the issue's labels, which must hold the
 *   repo's claim label for the fire to queue, and the key of the spec
 *   owner's own message, which the fire replaces where it queues. A
 *   dispatch comment's fire carries no `claimed`, and always queues.
 */

/**
 * The `closingPr` fire a PR opened, reopened or edited may queue: its body
 * may now close a ticket, and where a session other than the ticket's
 * builder owns it, the task names that session the ticket's builder in a
 * dispatch comment (dispatch/ticket-fire.mjs). An edit queues it only
 * where the body comes to close an issue its last body did not. A PR whose
 * author `relay` leaves out queues nothing: its body names no session.
 *
 * @param {any} payload
 * @param {{ relay?: readonly string[], appId?: number | undefined }} [trust]
 * @returns {{ fires: Array<{ fire: import('./fire.mjs').ClosingPrFire, reason: string, key: string }>, reason: string }}
 */
export const closingPrFires = (payload, { relay = RELAY, appId } = {}) => {
  const none = { fires: [], reason: '' };
  const pr = payload?.pull_request;
  const action = payload?.action;
  if (action !== 'opened' && action !== 'reopened' && action !== 'edited') return none;
  if (!Number.isInteger(pr?.number) || pr.number <= 0 || pr?.state !== 'open') return none;
  if (!lets(relay, authorOf(pr, appId))) return none;
  // By the one closing grammar closedBy reads too, every repository's
  // references counted: too many, never fewer, as the task reads the body again.
  const closes = closingNumbers(pr?.body);
  if (closes.size === 0) return none;
  if (action === 'edited') {
    const from = payload?.changes?.body?.from;
    if (typeof from !== 'string') return none;
    const before = closingNumbers(from);
    if ([...closes].every((n) => before.has(n))) return none;
  }
  const reason = `#${pr.number} ${action}, its body closing ${[...closes].map((n) => `#${n}`).join(', ')}: a change of builder for the task to judge`;
  return { fires: [{ fire: build.closingPr({ pr: pr.number }), reason, key: 'closingPr' }], reason };
};

/**
 * The `prEdit` fire a PR body edit may queue: an edit sent by no bot,
 * whose old body (`changes.body.from`) names session A and whose new body
 * names B, where B is not A, both read through `relayedBody` under
 * `bodies`. The task sends A a notice and, where A takes it, writes A's
 * link back and tells B once (dispatch/take.mjs). It needs `prMessages`
 * and `sessionRules` both (`switchesOf`, switches.mjs). Governor's own
 * relinks are a bot's edits, and queue nothing. An old body that named no
 * session queues nothing: there is no offer on a PR, and governor takes a
 * PR over when its owner is archived. A PR whose author `relay` leaves out
 * queues nothing: its body names no session.
 *
 * @param {any} payload
 * @param {{ relay?: readonly string[], bodies?: readonly string[], appId?: number | undefined }} [trust]
 * `bodies`: whose body may name a session, `relay` where unset.
 * @returns {{ fires: Array<{ fire: import('./fire.mjs').PrEditFire, reason: string, key: string }>, reason: string }}
 */
export const prEditFires = (payload, { relay = RELAY, bodies = relay, appId } = {}) => {
  const none = { fires: [], reason: '' };
  const pr = payload?.pull_request;
  if (payload?.action !== 'edited' || payload?.changes?.body === undefined || payload?.sender?.type === 'Bot') return none;
  if (!Number.isInteger(pr?.number) || pr.number <= 0) return none;
  const onAuthor = authorOf(pr, appId);
  if (!lets(relay, onAuthor)) return none;
  const now = relayedBody({ body: pr?.body, ...onAuthor }, bodies);
  const to = sessionNamedIn(now);
  if (to === null) return none;
  const from = payload.changes.body.from;
  const old = relayedBody({ body: typeof from === 'string' ? from : '', ...onAuthor }, bodies);
  const was = sessionNamedIn(old);
  if (was === null || sameSession(was, to)) return none;
  const reason = `#${pr.number} body edited, its session link moved from ${sessionId(was)} to ${sessionId(to)}: for its owner to hear`;
  return { fires: [{ fire: build.prEdit({ pr: pr.number, from: was, to, authors: kindsOf([onAuthor]) }), reason, key: 'prEdit' }], reason };
};

/**
 * The ticket fire a comment on an issue, an issue closed or reopened, or
 * its body edited ({@link bodyEdited}), may queue
 * (dispatch/ticket-fire.mjs): one fire for the spec owner and
 * the builders together, which the task sends to each role, told which it
 * holds. The receiver cannot find the builders, so it queues this beside
 * the spec owner's own message, and settles which goes once it knows the
 * repo's claim label. An issue with no labels cannot be claimed, and gets
 * none. What reaches no session today reaches none here either: a PR's
 * comment, an edited one, the dispatcher's marker, a stranger's comment.
 *
 * A comment governor's App posted reaches no session: the turn that posted
 * it told the roles itself ({@link governorComment}).
 *
 * @param {{ event: string | undefined, payload: any, appId?: number | undefined, relay?: readonly string[], bodies?: readonly string[] }} args
 * @returns {{ fires: TicketQueued[], reason: string }}
 */
export const ticketFires = ({ event, payload, appId, relay = RELAY, bodies = relay }) => {
  const none = { fires: [], reason: '' };
  const issue = payload?.issue;
  if (!Number.isInteger(issue?.number) || issue.number <= 0 || issue?.pull_request) return none;
  const onAuthor = authorOf(issue, appId);
  // The spec owner the body names, read only where `bodies` lets its author in.
  const { state, labels, owner = null } = summonedTicket(issue, bodies, appId);
  if (labels.length === 0) return none;
  /** @type {{ text: (limit: number) => string, event: 'comments' | 'close' | 'edit', poster: string | null, closing: boolean, authors: string[], what: string, moved?: import('./fire.mjs').MovedLink | undefined, unsigned?: import('./fire.mjs').UnsignedPost | null, edited?: import('./fire.mjs').UnsignedPost | null }} */
  let about;
  if (event === 'issue_comment') {
    const comment = payload?.comment;
    if (payload?.action !== 'created') return none;
    if (governorComment(comment, appId)) return { fires: [], reason: governorDropped(issue.number) };
    if (notAnUpdate({ written: comment, relay, appId }) !== null) return none;
    const body = String(comment?.body ?? '');
    const unsigned = unsignedPost(body);
    about = {
      text: (limit) => `${issueCommentPrompt(payload, 'ticket', limit)}${unsigned ? `\n\n${UNSIGNED}` : ''}`,
      event: 'comments',
      poster: postedBy(body),
      closing: false,
      authors: kindsOf([authorOf(comment, appId), onAuthor]),
      what: `comment ${comment?.id} on #${issue.number}`,
      unsigned: unsigned ? unsignedOf(comment) : null,
    };
  } else if (event === 'issues' && (payload?.action === 'closed' || payload?.action === 'reopened')) {
    if (!lets(relay, onAuthor)) return none;
    about = {
      text: () => issueEventPrompt(payload, null, 'ticket'),
      event: 'close',
      poster: null,
      closing: payload.action === 'closed',
      authors: kindsOf([onAuthor]),
      what: `issue #${issue.number} ${payload.action}`,
    };
  } else if (event === 'issues' && bodyEdited(payload)) {
    if (!lets(relay, onAuthor)) return none;
    about = {
      text: () => bodyEditPrompt(payload),
      event: 'edit',
      poster: null,
      closing: false,
      authors: kindsOf([onAuthor]),
      what: `issue #${issue.number} body edited`,
      moved: movedLink(payload, bodies, appId),
      edited: editedOf(payload),
    };
  } else {
    return none;
  }
  /** @param {string} text */
  const fire = (text) => build.ticket({ issue: issue.number, text, event: about.event, state, labels, owner, poster: about.poster, closing: about.closing, authors: about.authors, moved: about.moved, unsigned: about.unsigned, edited: about.edited });
  let limit = EXCERPT_CHARS;
  let built = fire(about.text(limit));
  while (fireWeight(built) > FIRE_BUDGET && limit > 1) {
    limit = Math.floor(limit / 2);
    built = fire(about.text(limit));
  }
  const reason = `${about.what}: for its spec owner and, on a claimed ticket, its builders, in place of the spec owner's own message`;
  return { fires: [{ fire: built, reason, key: 'ticket', claimed: { labels, replaces: owner === null ? null : sessionId(owner) } }], reason: '' };
};

/**
 * The `offer` fire a session's signed comment on an issue may queue: where
 * the issue's body is a session's unsigned post (`unsignedSessionBody`),
 * nobody owns it, so the task offers it to the session that commented
 * (dispatch/offer.mjs). It needs `sessionRules` alone, so it goes whatever
 * `subscribeMessages` says. An issue whose body names an owner is offered
 * from the comment's relay, once the owner refuses as archived ({@link
 * messageFire}, dispatch/ticket-fire.mjs), and a person's body, with no
 * footer, is the person's. A body `bodies` masks names nobody and is no
 * session's post. No offer goes on a PR: governor takes a PR over when its
 * owner is archived. What reaches no session gets no offer either: an
 * edited comment, governor's own, a stranger's.
 *
 * @param {{ event: string | undefined, payload: any, appId?: number | undefined, relay?: readonly string[], bodies?: readonly string[] }} args
 * @returns {{ fires: Array<{ fire: import('./fire.mjs').OfferFire, reason: string, key: string }>, reason: string }}
 */
export const offerFires = ({ event, payload, appId, relay = RELAY, bodies = relay }) => {
  const none = { fires: [], reason: '' };
  const issue = payload?.issue;
  const comment = payload?.comment;
  if (event !== 'issue_comment' || payload?.action !== 'created') return none;
  if (!Number.isInteger(issue?.number) || issue.number <= 0 || issue?.pull_request) return none;
  if (governorComment(comment, appId) || notAnUpdate({ written: comment, relay, appId }) !== null) return none;
  const session = postedBy(String(comment?.body ?? ''));
  if (session === null) return none;
  const onAuthor = authorOf(issue, appId);
  if (!unsignedSessionBody(relayedBody({ body: issue?.body, ...onAuthor }, bodies))) return none;
  const reason = `comment ${comment?.id} on #${issue.number}, whose body a session filed unsigned: offer the issue to ${sessionId(session)}`;
  return { fires: [{ fire: build.offer({ issue: issue.number, session, authors: kindsOf([authorOf(comment, appId), onAuthor]) }), reason, key: 'offer' }], reason };
};

/**
 * A session's unsigned post as a fire carries it (`UnsignedPost`,
 * fire.mjs): when it was posted, from the payload, its page, and its first
 * words. Null where `written` is not a session's unsigned post
 * (`unsignedPost`), or where the payload names no time or no github.com
 * page for it, so there is nothing to search by.
 *
 * @param {Written | undefined} written a comment, a review or a review comment
 * @returns {import('./fire.mjs').UnsignedPost | null}
 */
export const unsignedOf = (written) => {
  const body = String(written?.body ?? '');
  if (!unsignedPost(body)) return null;
  const at = /** @type {any} */ (written)?.created_at ?? /** @type {any} */ (written)?.submitted_at;
  const url = /** @type {any} */ (written)?.html_url;
  if (typeof at !== 'string' || at.length > 40 || !Number.isFinite(Date.parse(at))) return null;
  if (typeof url !== 'string' || url.length > 300 || !/^https:\/\/github\.com\/\S+$/.test(url)) return null;
  return { at, url, words: postWords(body) };
};

/**
 * The `author` fire a session's unsigned post may queue: a comment, a
 * review or a review comment, on an issue or a PR, that ends in the Claude
 * Code footer and names no session (`unsignedPost`). The task searches the
 * login's live sessions for its author and tells it (dispatch/author.mjs),
 * under `sessionRules` alone.
 *
 * The receiver queues it beside the delivery's other fires, and keeps it
 * only where none of them relays the post (`settleAuthor`, route.mjs): a
 * relay's own turn runs the search. So a post no role hears, because
 * nobody holds a role or the repo's file turns the relay's switch off, is
 * still searched. A post on a PR whose body names no session is taken for
 * the head branch's local session's own, which cannot sign, and queues
 * none. What reaches no session queues none either: an edited post,
 * governor's own, a stranger's.
 *
 * @param {{ event: string | undefined, payload: any, appId?: number | undefined, relay?: readonly string[], bodies?: readonly string[] }} args
 * @returns {{ fires: Array<{ fire: import('./fire.mjs').AuthorFire, reason: string, key: string }>, reason: string }}
 */
export const authorFires = ({ event, payload, appId, relay = RELAY, bodies = relay }) => {
  const none = { fires: [], reason: '' };
  const written = WRITTEN[String(event)];
  if (written === undefined) return none;
  const { on, pr, by, wanted, what } = written(payload ?? {});
  if (payload?.action !== wanted || !Number.isInteger(on?.number) || on.number <= 0) return none;
  if (governorComment(by, appId) || notAnUpdate({ written: by, relay, appId }) !== null) return none;
  const post = unsignedOf(by);
  if (post === null) return none;
  const onAuthor = authorOf(on, appId);
  const onBody = relayedBody({ body: on?.body, ...onAuthor }, bodies);
  if (pr && sessionNamedIn(onBody) === null) return none;
  const reason = `${what} ${by?.id} on #${on.number} names no session: search the live sessions for its author`;
  return { fires: [{ fire: build.author({ on: on.number, post, authors: kindsOf([authorOf(by, appId), onAuthor]) }), reason, key: 'author' }], reason };
};
