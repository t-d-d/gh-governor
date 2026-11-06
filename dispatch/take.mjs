/**
 * A body edit that moved an issue's owner link, under `sessionRules` and
 * `subscribeMessages` (PRD #599, "The take", "Nudges").
 *
 * Any session can edit an issue's body and move its owner link to itself.
 * The receiver carries where the link was (`moved`, dispatch/webhook/fire.mjs)
 * on the edit's fire, the owner's message on an unclaimed issue or the
 * ticket fire on a claimed one, and the edit's notice goes to the old
 * owner, A, never to the editor, B. Then:
 *
 * - **A take.** A refuses as archived, or the old body was a session's
 *   unsigned post: B is told it now owns the issue ({@link takeText}). This
 *   is not a correction, and goes on every take.
 * - **A live owner's issue.** A takes the notice: governor reads the body
 *   again and, where its owner link still names B, writes A's link back, as
 *   `nameSpecSession` writes a spec session's, leaving the rest of B's
 *   edit. B is told once that it edited an issue it does not own.
 * - **No take.** B builds the ticket (`rolesOf`), or the old body was a
 *   person's: governor writes A's link back where the old body named A, and
 *   otherwise removes B's link. B is told once that a builder does not edit
 *   the body, or that the issue is a person's.
 *
 * A correction goes once to a session for each kind: the state table's
 * `told#<session id>` / `<kind>` record is put before the message only
 * where none stands ({@link TellOnce}). The write happens every time. A
 * body read or write that fails logs `dispatch-spec-owner` at error and
 * changes nothing else, and B is told of a write only once it has landed.
 * A notice to A that the ceiling holds back counts as not sent, and one
 * that faults fails the turn: either way nothing more is done. Governor's
 * own write is a bot's edit, and reaches neither role.
 *
 * A PR's session link moved the same way is a `prEdit` fire, under
 * `prMessages` and `sessionRules` both ({@link planPrEdit}). There is no
 * take on a PR to confirm: where A refuses as archived, B owns the PR by
 * its link, as at a takeover, and nothing is written or sent. Where A takes
 * the notice, governor writes A's link back as it relinks a PR at a
 * takeover, and tells B once.
 */

import { GITHUB_SOURCE, SPEC_OWNER } from './deliveries.mjs';
import { relayOf, ticketAuthor } from './trust.mjs';
import { fireRepoOf } from './repos.mjs';
import { rolesOf } from './roles.mjs';
import { SESSION_RULES } from './session-rules.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { relayedBody, relinkSession, sameSession, sessionId, sessionNamedIn, unlinkSession } from './webhook/subscribe.mjs';

/** The log event for what governor made of a body edit that moved the owner link. */
export const TAKE = 'dispatch-take';

/**
 * A correction for a body edit, one record each: an edit of a live owner's
 * issue, a builder's edit, an edit of a person's issue, an edit of a live
 * owner's PR.
 *
 * @typedef {'edit-owned' | 'edit-builder' | 'edit-person' | 'edit-pr'} Correction
 */

/**
 * Put the record that `session` was told of `kind`, only where none stands:
 * true where this put it, false where one stood. A put that fails rejects.
 *
 * @typedef {(session: string, kind: Correction) => Promise<boolean>} TellOnce
 */

/**
 * The confirmation of a take.
 *
 * @param {number} issue
 * @param {'archived' | 'unsigned'} why the old owner refused as archived, or a session filed the issue unsigned
 * @returns {string}
 */
export const takeText = (issue, why) => [
  why === 'archived'
    ? `You now own #${issue}: the session its body named as owner is archived, and your edit ended the body with this session's link.`
    : `You now own #${issue}: a session filed it without signing it, and your edit ended the body with this session's link.`,
  `Comments on #${issue} now reach you, and you write its body. Signing off gives it up.`,
].join(' ');

/**
 * A correction for a body edit, with the rules under it.
 *
 * @param {number} issue the issue, or the PR for `edit-pr`
 * @param {Correction} kind
 * @param {string | null} restored the owner whose link governor wrote back, or null where it removed the editor's
 * @returns {string}
 */
export const correctionText = (issue, kind, restored) => {
  const done = restored === null
    ? 'Governor removed your link from the body and kept the rest of your edit.'
    : `Governor put the owner's link, ${restored}, back and kept the rest of your edit.`;
  const said = {
    'edit-owned': `You edited the body of #${issue} and moved its owner link to this session, but you do not own #${issue}: ${restored} does, and is live. Your link was replaced by the owner's, and the rest of your edit kept. Only an issue's owner edits its body.`,
    'edit-builder': `You edited the body of #${issue}, which you build, and moved its owner link to this session. A builder does not edit a ticket's body, and never takes its spec. ${done}`,
    'edit-person': `You edited the body of #${issue}, which a person filed and owns, and ended it with this session's link. A person's issue is the person's, and no session takes it. ${done}`,
    'edit-pr': `You edited the body of PR #${issue} and moved its session link to this session, but you do not own PR #${issue}: ${restored} does, and is live. ${done} Only a PR's owner edits its body and pushes to its branch.`,
  }[kind];
  return `${said} Next time, comment on the ${kind === 'edit-pr' ? 'PR' : 'issue'} instead.\n\n${SESSION_RULES}`;
};

/**
 * @typedef {{
 *   ticket: (n: number) => Promise<import('./roles.mjs').TicketRow>,
 *   updateIssue: (n: number, change: { body: string }) => Promise<unknown>,
 * }} BodyWriter
 * @typedef {(event: string, context?: Record<string, unknown>) => void} Log
 */

/**
 * Read `issue`'s body again and, where its owner link, read through
 * `relayedBody` under `relay`, still names `editor`, write `restore`'s link
 * back in its place, or remove it where `restore` is null. On a person's
 * issue (`person`) the footer the editor signed with goes too, so the body
 * is not left a session's unsigned post, which any session may take. Returns whether
 * the write landed. A read or write that fails is logged at error
 * ({@link SPEC_OWNER}) and writes nothing.
 *
 * @param {{ github: BodyWriter, repo: string, issue: number, editor: string, restore: string | null, person: boolean, relay: readonly string[], log: Log }} args
 * @returns {Promise<boolean>}
 */
const rewriteOwner = async ({ github, repo, issue, editor, restore, person, relay, log }) => {
  const at = { repo, issue, editor: sessionId(editor), restore };
  try {
    const row = await github.ticket(issue);
    const body = String(row.body ?? '');
    const named = sessionNamedIn(relayedBody({ ...ticketAuthor(row), body }, relay));
    if (named === null || !sameSession(named, editor)) {
      log(TAKE, { ...at, outcome: 'nothing written', reason: 'the body\'s owner link no longer names the editor' });
      return false;
    }
    await github.updateIssue(issue, { body: restore === null ? unlinkSession(body, { footer: person }) : relinkSession(body, restore) });
    log(SPEC_OWNER, { ...at, outcome: restore === null ? 'the editor\'s link removed from the body' : 'the owner\'s link written back' });
    return true;
  } catch (error) {
    log(SPEC_OWNER, { level: 'error', ...at, error: messageOf(error), reason: 'the body still names the editor as its owner' });
    return false;
  }
};

/**
 * What follows a body edit that moved `issue`'s owner link to `editor`,
 * once the old owner's notice has gone (`notice`, null where the old body
 * named no session). `builders`: the ticket's, as `rolesOf` finds them.
 * Returns the take's or the correction's delivery, or null where nothing
 * was sent.
 *
 * @param {{
 *   repo: string,
 *   issue: number,
 *   editor: string,
 *   moved: import('./webhook/fire.mjs').MovedLink,
 *   notice: import('./deliveries.mjs').Delivery | null,
 *   builders: readonly string[],
 *   github: BodyWriter,
 *   relay: readonly string[],
 *   tellOnce: TellOnce,
 *   deliveries: Pick<import('./deliveries.mjs').Deliveries, 'deliver'>,
 *   log: Log,
 * }} args `relay`: the repo's `trust.relay`, by which the body is read again.
 * @returns {Promise<import('./deliveries.mjs').Delivery | null>}
 */
export const settleMove = async ({ repo, issue, editor, moved, notice, builders, github, relay, tellOnce, deliveries, log }) => {
  const at = { repo, issue, editor: sessionId(editor), old: moved.old, ...(moved.from === undefined ? {} : { from: sessionId(moved.from) }) };
  if (notice !== null && !notice.ok && !notice.refused) {
    log(TAKE, { ...at, outcome: 'nothing done', reason: notice.capped === true ? 'the old owner\'s notice was held at the message ceiling' : 'the old owner\'s notice was not sent' });
    return null;
  }
  const builds = builders.some((b) => sameSession(b, editor));
  const refused = notice?.refused === true;
  if (!builds && (moved.old === 'unsigned' || (moved.old === 'owned' && refused))) {
    const sent = await deliveries.deliver({ session: editor }, takeText(issue, refused ? 'archived' : 'unsigned'), { source: GITHUB_SOURCE, kind: 'take', on: [issue] });
    if (sent.capped !== true) log(TAKE, { ...at, outcome: sent.ok ? 'the take confirmed' : sent.refused ? 'the editor is archived' : 'the take not confirmed', ...(sent.ok || sent.refused ? {} : { level: 'error', error: sent.error }) });
    return sent;
  }
  /** @type {Correction} */
  const kind = builds ? 'edit-builder' : moved.old === 'person' ? 'edit-person' : 'edit-owned';
  const restore = moved.from ?? null;
  if (!await rewriteOwner({ github, repo, issue, editor, restore, person: moved.old === 'person', relay, log })) return null;
  let first = false;
  try {
    first = await tellOnce(editor, kind);
  } catch (error) {
    log(TAKE, { level: 'error', ...at, kind, error: messageOf(error), outcome: 'the editor not told', reason: 'the record that it was told could not be put' });
    return null;
  }
  if (!first) {
    log(TAKE, { ...at, kind, outcome: 'the editor not told', reason: 'it was told of this before' });
    return null;
  }
  const sent = await deliveries.deliver({ session: editor }, correctionText(issue, kind, restore), { source: GITHUB_SOURCE, kind: 'correction', on: [issue] });
  if (sent.capped !== true) log(TAKE, { ...at, kind, outcome: sent.ok ? 'the editor told' : sent.refused ? 'the editor is archived' : 'the editor not told', ...(sent.ok || sent.refused ? {} : { level: 'error', error: sent.error }) });
  return sent;
};

/**
 * After an issue owner's message of a body edit that moved its owner link:
 * the ticket is read for its builders, then {@link settleMove}. A read of
 * the ticket that fails rejects.
 *
 * @param {{
 *   repo: string,
 *   issue: number,
 *   editor: string,
 *   moved: import('./webhook/fire.mjs').MovedLink,
 *   notice: import('./deliveries.mjs').Delivery | null,
 *   config: import('./repo-config.mjs').RepoConfig,
 *   reader: () => Promise<NonNullable<Parameters<typeof rolesOf>[0]['reader']> & BodyWriter>,
 *   tellOnce: TellOnce,
 *   deliveries: Pick<import('./deliveries.mjs').Deliveries, 'deliver' | 'ownerOf'>,
 *   log: Log,
 * }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery | null>}
 */
export const takeAfterNotice = async ({ repo, issue, editor, moved, notice, config, reader, tellOnce, deliveries, log }) => {
  const github = await reader();
  const relay = relayOf(config);
  const { builders } = await rolesOf({ issue, relay, claim: config.labels.claim, owner: moved.from ?? null, reader: github, ownerOf: (pr) => deliveries.ownerOf(pr) });
  return settleMove({ repo, issue, editor, moved, notice, builders, github, relay, tellOnce, deliveries, log });
};

/**
 * The notice to a PR's owner that its body was edited and its session link
 * moved to `editor`.
 *
 * @param {number} pr
 * @param {string} editor
 * @returns {string}
 */
export const prEditText = (pr, editor) => [
  `The body of PR #${pr} was edited, and its session link moved from this session to ${editor}.`,
  `You still own PR #${pr}: governor writes this session's link back and tells that session to comment instead.`,
  'Read the body to check the rest of the edit says what you mean.',
].join(' ');

/**
 * A `prEdit` fire: a PR body edit, by no bot, that moved the PR's session
 * link from `from` (A) to `to` (B). A is sent {@link prEditText}, which is
 * how its liveness is learned. Where A refuses as archived, nothing is
 * written and B owns the PR by its link. Where A takes it, the PR is read
 * again and, where its link, read through `relayedBody` under the repo's
 * `trust.relay`, still names B, A's link is written back with
 * `relinkSession`, as a takeover writes it, and B is told once
 * (`edit-pr`). A read or write that fails logs `dispatch-relink` at error
 * and changes nothing else. A notice the ceiling holds back counts as not
 * sent, and one that faults fails the turn: either way nothing more is
 * done.
 *
 * @param {import('./webhook/fire.mjs').PrEditFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planPrEdit = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { pr, from, to } = invocation;
  const at = { repo, pr, owner: sessionId(from), editor: sessionId(to) };
  const relay = relayOf(ctx.configOf(repo));
  const deliveries = ctx.delivery();
  let loginStored = false;
  /** @type {import('./deliveries.mjs').Delivery | null} */
  let notice = null;
  /** @type {import('./deliveries.mjs').Delivery | null} */
  let told = null;
  try {
    notice = await deliveries.deliver({ session: from }, prEditText(pr, to), { source: GITHUB_SOURCE, kind: 'notice', on: [pr] });
    if (notice.ok) {
      told = await relinkPr({ repo, pr, from, to, at, relay, ctx, deliveries });
    } else if (notice.refused) {
      ctx.log(TAKE, { ...at, outcome: 'nothing written: the editor owns the PR by its link', reason: 'the old owner is archived' });
    } else {
      ctx.log(TAKE, { ...at, outcome: 'nothing done', reason: notice.capped === true ? 'the old owner\'s notice was held at the message ceiling' : 'the old owner\'s notice was not sent', ...(notice.capped === true ? {} : { level: 'error', error: notice.error }) });
    }
  } finally {
    loginStored = await ctx.storeLogin();
  }
  // A send that faulted goes first, so the turn fails on it.
  const sent = [notice, told].filter((d) => d !== null);
  const messaged = sent.find((d) => !d.ok && !d.refused && d.capped !== true) ?? told ?? notice;
  return { answer: { kind: invocation.kind, messaged, dispatched: [], loginStored } };
};

/**
 * Write `from`'s link back into PR `pr`'s body where it still names `to`,
 * then tell `to` once. Returns the correction's delivery, or null where
 * nothing was sent.
 *
 * @param {{
 *   repo: string, pr: number, from: string, to: string, at: Record<string, unknown>, relay: readonly string[],
 *   ctx: import('./turn.mjs').TurnContext,
 *   deliveries: Pick<import('./deliveries.mjs').Deliveries, 'deliver'>,
 * }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery | null>}
 */
const relinkPr = async ({ repo, pr, from, to, at, relay, ctx, deliveries }) => {
  try {
    const github = await ctx.readerFor(repo);
    const row = await github.pull(pr);
    const named = sessionNamedIn(relayedBody(row, relay));
    if (named === null || !sameSession(named, to)) {
      ctx.log(TAKE, { ...at, outcome: 'nothing written', reason: 'the body\'s session link no longer names the editor' });
      return null;
    }
    await github.updatePull(pr, { body: relinkSession(row.body, from) });
    ctx.log('dispatch-relink', { level: 'info', ...at, outcome: 'the owner\'s link written back' });
  } catch (error) {
    ctx.log('dispatch-relink', { level: 'error', ...at, error: messageOf(error), reason: 'the body still names the editor as the PR\'s session' });
    return null;
  }
  let first = false;
  try {
    first = await ctx.state.recordTold(to, 'edit-pr');
  } catch (error) {
    ctx.log(TAKE, { level: 'error', ...at, kind: 'edit-pr', error: messageOf(error), outcome: 'the editor not told', reason: 'the record that it was told could not be put' });
    return null;
  }
  if (!first) {
    ctx.log(TAKE, { ...at, kind: 'edit-pr', outcome: 'the editor not told', reason: 'it was told of this before' });
    return null;
  }
  const sent = await deliveries.deliver({ session: to }, correctionText(pr, 'edit-pr', from), { source: GITHUB_SOURCE, kind: 'correction', on: [pr] });
  if (sent.capped !== true) ctx.log(TAKE, { ...at, kind: 'edit-pr', outcome: sent.ok ? 'the editor told' : sent.refused ? 'the editor is archived' : 'the editor not told', ...(sent.ok || sent.refused ? {} : { level: 'error', error: sent.error }) });
  return sent;
};
