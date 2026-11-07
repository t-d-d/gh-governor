/**
 * A ticket fire: a comment on an issue, the issue closed or reopened, or
 * its body edited, which the receiver queued in place of the spec owner's message because
 * the issue carries the repo's claim label, or the hook table could not
 * say which label that is (dispatch/webhook/route.mjs). The receiver holds
 * no token, so the builders are found here.
 *
 * On an unclaimed ticket the spec owner is sent the fire's text as its
 * message was before, and nothing is read from GitHub. On a claimed ticket
 * the spec owner and each builder the one lookup finds
 * (dispatch/builders.mjs) are sent it, each told who holds both roles and
 * which it holds. A session never hears its own signed post, nor an
 * unsigned one the search found it wrote, whatever `sessionRules` says
 * (dispatch/author.mjs). A builder
 * whose PR's merge closed the ticket hears the close through its PR, and
 * not again from the ticket. A comment governor's App posted is no ticket
 * fire: the turn that posted it tells the roles itself (dispatch/told.mjs).
 *
 * Every message is a notice: it asks nothing beyond the recipient's own
 * part. The spec owner acts on a remark that changes what counts as done,
 * by editing the body. The builder acts on a remark about the build, and
 * never edits the body. A body edit tells the spec owner the edit may be
 * its own, and the builder that the spec changed, or, on a closed ticket,
 * to comment on it rather than build. Where the edit left the
 * owner link in place, governor first searches for who made it, whatever
 * `sessionRules` says (dispatch/editor.mjs): the spec owner is not told of
 * its own edit, is told someone else made one, and keeps the old line only
 * where its events could not be read. Only under `sessionRules` is a
 * session the searches find asked to sign its post or to comment instead
 * of editing. The builder hears every edit.
 *
 * Where the spec owner refuses a comment as archived, nobody owns the
 * ticket, so with `sessionRules` on the session that signed the comment is
 * offered it once the roles have heard it, unless it builds the ticket
 * (dispatch/offer.mjs).
 *
 * A body edit that moved the owner link (`moved`), with `sessionRules` on,
 * goes to the old owner as the spec owner, never to the session that made
 * it, and then the take is confirmed or the old link written back
 * (dispatch/take.mjs). On a claimed ticket the builders hear it after
 * that, so their roles line names the editor as the spec owner where the
 * edit was a take, and the old owner otherwise, a settle that failed
 * included. With `sessionRules` off, the new owner hears it as before.
 *
 * A `dispatched` ticket fire, governor's dispatch comment queued before
 * the relay dropped governor's comments, still reaches the spec owner and
 * the builder it displaced, as the posting turn now tells them
 * (`builderChangeSends`, dispatch/told.mjs). A `closingPr` fire is a PR
 * that may have come to close a ticket: where a claimed ticket's builder is
 * another session, governor posts that dispatch comment and tells both
 * itself ({@link planClosingPr}).
 */

import { GITHUB_SOURCE } from './deliveries.mjs';
import { relayOf } from './trust.mjs';
import { rolesOf, rolesText } from './roles.mjs';
import { fireRepoOf } from './repos.mjs';
import { closedBy } from './pr-body.mjs';
import { dispatchMarker } from './webhook/fire.mjs';
import { relayedBody, sameSession, sessionId } from './webhook/subscribe.mjs';
import { EDIT_BUILDER, editClosedBuilder } from './webhook/mention.mjs';
import { builderChangeSends, tellBuilderChange } from './told.mjs';
import { offerIssue } from './offer.mjs';
import { settleMove } from './take.mjs';
import { turnsOn } from './repo-config.mjs';
import { relayedText, tellAuthor, wroteIt } from './author.mjs';
import { ownerLine, tellEditor } from './editor.mjs';

/** @typedef {import('./roles.mjs').TicketRole} TicketRole */



/**
 * A ticket fire's answer: the turn starts nothing.
 *
 * @param {import('./webhook/fire.mjs').TicketFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planTicket = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { issue, event, state, labels, poster, closing } = invocation;
  const config = ctx.configOf(repo);
  // The searches below run whatever sessionRules says, and the asks only
  // under it, as in the message turn (dispatch/turn.mjs).
  const asks = turnsOn(config, 'sessionRules');
  const claimed = labels.includes(config.labels.claim) && config.labels.claim !== '';
  // A session's unsigned comment: its author is searched for first, is not
  // relayed its own post, and the relay drops its UNSIGNED line where the
  // search decided (dispatch/author.mjs). With nothing to ask and no role
  // that could hear the comment, the search would decide nothing.
  const post = event === 'comments' && invocation.unsigned !== undefined && (asks || claimed || (invocation.owner ?? null) !== null) ? invocation.unsigned : null;
  const found = post === null ? null : await ctx.findAuthor(issue, post);
  const text = relayedText(invocation.text, found, asks);
  // A body edit that moved the owner link: under sessionRules the old
  // owner is the spec owner, and the session the new body names made the edit.
  const moved = event === 'edit' && invocation.moved !== undefined && asks ? invocation.moved : null;
  const editor = moved === null ? null : invocation.owner ?? null;
  const owner = moved === null ? invocation.owner ?? null : moved.from ?? null;
  // A body edit that left the owner link in place: who made it is searched
  // for, the owner first (dispatch/editor.mjs).
  const edit = event === 'edit' && moved === null && owner !== null && invocation.edited !== undefined ? invocation.edited : null;
  const edited = edit === null || owner === null ? null : await ctx.findEditor(issue, edit, owner);
  const ownEdit = edited?.by === 'owner';
  const about = { repo, issue, change: event, state, claimed };
  // A comment on an open ticket calls on each role's duty; a close, a
  // reopen or a comment on a closed ticket asks nothing of either, as the
  // receiver tells an unlabelled issue's spec owner, and a body edit's own
  // lines say what each role does with it.
  const asked = { duty: event === 'comments' && state === 'open', notice: event === 'close' || (event === 'comments' && state !== 'open') };
  /**
   * Each send's text is written from the spec owner it names, which a take
   * changes before the builders are told.
   *
   * @type {Array<{ session: string, text: (spec: string | null) => string, role: TicketRole | null, owns: number[] }>}
   */
  const sends = [];
  /** The sessions left out, and why, for the log. @type {string[]} */
  const skipped = [];
  /** The ticket's builders, none on an unclaimed ticket. @type {string[]} */
  let builders = [];
  const own = (/** @type {string} */ session) => (poster !== undefined && sameSession(session, poster)) || (editor !== null && sameSession(session, editor)) || wroteIt(found, session);
  // What a body edit tells each role, under what happened. The spec owner
  // hears nothing of its own edit. A closed ticket's builder is asked to
  // comment, not to build: a follow-up is the spec owner's to file, so a
  // session that holds both roles hears only the spec owner's line.
  const builderLine = (/** @type {TicketRole} */ role) => {
    if (role === 'spec owner') return [];
    if (state !== 'closed') return [EDIT_BUILDER];
    return role === 'builder' ? [editClosedBuilder(issue)] : [];
  };
  const editLines = (/** @type {TicketRole} */ role) => {
    if (event !== 'edit') return '';
    const lines = [...(role === 'builder' || ownEdit ? [] : [ownerLine(edited, asks)]), ...builderLine(role)];
    return lines.length === 0 ? '' : `\n\n${lines.join('\n')}`;
  };
  if (event === 'dispatched') {
    // A dispatch comment's fire queued before the relay dropped governor's
    // comments: the builder it names never hears it.
    const builder = invocation.builder ?? null;
    const displaced = invocation.displaced ?? null;
    const change = builderChangeSends({ issue, text, owner, builder, displaced });
    skipped.push(...change.skipped);
    for (const send of change.sends) sends.push({ session: send.session, text: () => send.text, role: send.role, owns: [] });
    Object.assign(about, { builder, displaced });
  } else if (!claimed) {
    // The spec owner's message as the receiver queued it before, with no read.
    if (owner !== null && own(owner)) skipped.push(`${sessionId(owner)}'s own post`);
    else if (owner !== null && ownEdit) skipped.push(`${sessionId(owner)}, which made the edit`);
    else if (owner !== null) sends.push({ session: owner, text: () => `${text}${editLines('spec owner')}\n\n${rolesText({ issue, owner, builders: [] }, { role: 'spec owner', merged: false }, asked)}`, role: null, owns: [] });
  } else {
    const relay = relayOf(config);
    const reader = await ctx.readerFor(repo);
    // A read that fails fails the turn: it never reads as no builder.
    const roles = await rolesOf({ issue, relay, claim: config.labels.claim, ticket: { state, labels }, owner, reader, ownerOf: (pr) => ctx.delivery().ownerOf(pr) });
    ({ builders } = roles);
    // A builder whose PR's merge closed the ticket heard the merge through its PR.
    const throughPr = event === 'close' && state === 'closed' && roles.by === 'merged PR';
    for (const holder of roles.holders) {
      const { session, role, owns } = holder;
      if (role === 'builder' && throughPr) skipped.push(`${sessionId(session)}, which heard the merge that closed it through its PR`);
      else if (own(session)) skipped.push(`${sessionId(session)}'s own post`);
      else if (role === 'spec owner' && ownEdit) skipped.push(`${sessionId(session)}, which made the edit`);
      else sends.push({ session, text: (spec) => `${text}${editLines(role)}\n\n${rolesText({ ...roles, owner: spec }, holder, asked)}`, role, owns });
    }
    Object.assign(about, { builders, builder: roles.by });
  }
  if (sends.length === 0 && editor === null && (found === null || !asks) && (edited?.by !== 'other' || !asks)) {
    ctx.log('dispatch-ticket', { ...about, outcome: 'nobody told', ...(skipped.length === 0 ? { reason: 'no role on the ticket is held by a session' } : { skipped }) });
    return { answer: { kind: invocation.kind, messaged: null, dispatched: [] } };
  }
  /** @type {import('./deliveries.mjs').Delivery[]} */
  const sent = [];
  /** The offer made to the session that commented, if one was sent. @type {import('./deliveries.mjs').Delivery | null} */
  let offered = null;
  /** Whether the spec owner refused as archived. */
  let ownerGone = false;
  /** The spec owner's delivery, where it was sent. @type {import('./deliveries.mjs').Delivery | null} */
  let notice = null;
  /** The take's confirmation or the correction, where one was sent. @type {import('./deliveries.mjs').Delivery | null} */
  let took = null;
  /** The unsigned post's author's nudge, or each candidate's, or the body edit's editor's. @type {import('./deliveries.mjs').Delivery[]} */
  let nudged = [];
  let loginStored = false;
  /** Send one role its message, naming `spec` as the spec owner. */
  const send = async (/** @type {typeof sends[number]} */ { session, text: told, role, owns }, /** @type {string | null} */ spec) => {
    const delivered = await ctx.delivery().deliver({ session }, told(spec), {
      source: GITHUB_SOURCE,
      kind: 'ticket',
      on: [issue],
      // A displaced builder has nothing left on the ticket: its standing
      // line asks it to sign off where nothing else of its is open.
      closing: closing === true || (event === 'dispatched' && role === 'builder'),
      // The spec owner hears the ticket as its filer does, so an
      // archived one with no fallback is dropped from its subscribe line.
      dropFrom: role === 'builder' ? [] : [issue],
      owns,
    });
    sent.push(delivered);
    if (role !== 'builder') notice = delivered;
    if (role !== 'builder' && delivered.refused) ownerGone = true;
    ctx.log('dispatch-ticket', { ...about, session, role: role ?? 'spec owner', ...(owns.length === 0 ? {} : { prs: owns }), outcome: delivered.ok ? 'messaged' : delivered.refused ? 'its session is archived' : delivered.capped ? 'held at the message ceiling' : 'not messaged', ...(skipped.length === 0 ? {} : { skipped }) });
  };
  // On an edit that moved the owner link, the old owner hears it first,
  // since its answer decides the take, and the builders once it is settled.
  const first = moved === null ? sends : sends.filter((s) => s.role !== 'builder');
  const after = moved === null ? [] : sends.filter((s) => s.role === 'builder');
  try {
    for (const one of first) await send(one, owner);
    // The spec owner refused as archived: nobody owns the ticket, so the
    // session that signed the comment is offered it (dispatch/offer.mjs).
    if (ownerGone && event === 'comments' && poster !== undefined && asks) {
      offered = await offerIssue({ repo, issue, session: poster, why: 'archived', builders, deliveries: ctx.delivery(), log: ctx.log });
    }
    // The edit moved the owner link: the take confirmed, or the old link
    // written back (dispatch/take.mjs).
    /** Whether the edit was a take, so the editor owns the ticket. */
    let taken = false;
    try {
      if (moved !== null && editor !== null) {
        ({ sent: took, taken } = await settleMove({
          repo, issue, editor, moved, notice, builders,
          github: await ctx.readerFor(repo),
          relay: relayOf(config),
          tellOnce: (session, kind) => ctx.state.recordTold(session, kind),
          deliveries: ctx.delivery(),
          log: ctx.log,
        }));
      }
    } finally {
      // A take names the editor as the spec owner. An edit that is not one,
      // or a settle that failed or threw, names the old owner, as the body
      // does once governor has written it back.
      for (const one of after) await send(one, taken ? editor : owner);
    }
    if (post !== null && found !== null) {
      nudged = await tellAuthor({ repo, on: issue, post, found, asks, tellOnce: (session, kind) => ctx.state.recordTold(session, kind), deliveries: ctx.delivery(), log: ctx.log });
    }
    if (edit !== null && edited !== null) {
      nudged = [...nudged, ...await tellEditor({ repo, on: issue, edit, edited, asks, tellOnce: (session, kind) => ctx.state.recordTold(session, kind), deliveries: ctx.delivery(), log: ctx.log })];
    }
  } finally {
    loginStored = await ctx.storeLogin();
  }
  // The turn's answer: a send that failed, so the turn says so, else one
  // that took it, else the last refusal.
  // A send held at the ceiling is no fault, so one that faulted goes first.
  const answered = [...sent, ...(offered === null ? [] : [offered]), ...(took === null ? [] : [took]), ...nudged];
  const messaged = answered.find((t) => !t.ok && !t.refused && t.capped !== true) ?? answered.find((t) => t.ok) ?? answered.at(-1) ?? null;
  return { answer: { kind: invocation.kind, messaged, dispatched: [], loginStored } };
};

/**
 * A PR that may have come to close a ticket (`closingPr`): for each claimed
 * open ticket its body closes, where the PR's owner, as `ownerOf` finds it,
 * is not among the ticket's builders without this PR, governor posts its
 * dispatch comment naming the owner. Where the builder it replaces was
 * found by the newest dispatch comment or the owner link, the comment names
 * that builder as displaced. The turn then tells the spec owner, and the
 * displaced builder, which is asked to stop ({@link tellBuilderChange}),
 * since the relay sends governor's comment to nobody. Where another
 * open PR closes the ticket, both owners build it, and nobody is displaced.
 * Only a dispatch comment governor's App posted names a builder, as the
 * lookup reads it. A read or a comment that fails fails the turn.
 *
 * @param {import('./webhook/fire.mjs').ClosingPrFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planClosingPr = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { pr } = invocation;
  const config = ctx.configOf(repo);
  const claim = config.labels.claim;
  /** @type {number[]} */
  const announced = [];
  const answer = () => ({ answer: { kind: invocation.kind, dispatched: [], announced } });
  const relay = relayOf(config);
  const reader = await ctx.readerFor(repo);
  const pull = await reader.pull(pr);
  // The receiver judged the author by the hook-table item, which may lag
  // the file: a body trust.relay leaves out closes nothing here.
  const tickets = closedBy(relayedBody(pull, relay), repo);
  if (!pull.open || tickets.length === 0) {
    ctx.log('dispatch-builder', { repo, pr, outcome: 'nothing announced', reason: pull.open ? 'its body closes no ticket, or trust.relay leaves its author out' : 'it is closed' });
    return answer();
  }
  const owners = ctx.delivery();
  // The PR as read above: the owner is found without reading it again.
  const { session } = await owners.ownerOf(pr, pull);
  if (session === null) {
    ctx.log('dispatch-builder', { repo, pr, outcome: 'nothing announced', reason: 'no session holds it' });
    return answer();
  }
  // The ticket's builders as they were without this PR.
  const without = {
    openClosing: async (/** @type {number} */ n) => (await reader.openClosing(n)).filter((p) => p.number !== pr),
    closure: (/** @type {number} */ n) => reader.closure(n),
    allComments: (/** @type {number} */ n) => reader.allComments(n),
  };
  // A send may refresh the login, which is stored once, whatever the loop
  // threw.
  let loginStored = false;
  try {
    for (const issue of tickets) {
      const ticket = await reader.ticket(issue);
      const at = { repo, pr, issue, session };
      if (ticket.pull || ticket.state !== 'open' || claim === '' || !ticket.labels.includes(claim)) {
        ctx.log('dispatch-builder', { ...at, outcome: 'nothing announced', reason: 'the ticket is not an open claimed issue' });
        continue;
      }
      const found = await rolesOf({ issue, relay, claim, ticket: { ...ticket, association: ticket.association ?? 'NONE' }, reader: without, ownerOf: (n) => owners.ownerOf(n) });
      if (found.builders.some((s) => sameSession(s, session))) {
        ctx.log('dispatch-builder', { ...at, outcome: 'nothing announced', reason: `it builds the ticket already, by its ${found.by}` });
        continue;
      }
      const displaced = found.by === 'dispatch comment' || found.by === 'owner link' ? found.builders[0] ?? null : null;
      await reader.comment(issue, dispatchMarker({ at: new Date(ctx.now()).toISOString(), sessionUrl: session, displaced }));
      announced.push(issue);
      ctx.log('dispatch-builder', { ...at, displaced, outcome: 'announced the new builder on the ticket' });
      // The comment is a record for people: this turn tells the spec owner,
      // and the builder it displaced, itself.
      await tellBuilderChange({
        deliver: (target, text, options) => owners.deliver({ session: target }, text, { source: GITHUB_SOURCE, kind: 'builder-change', ...options }),
        log: ctx.log,
        repo,
        issue,
        title: ticket.title,
        url: `https://github.com/${repo}/issues/${issue}`,
        owner: found.owner,
        builder: session,
        displaced,
      });
    }
  } finally {
    if (announced.length > 0) loginStored = await ctx.storeLogin();
  }
  return { answer: { kind: invocation.kind, dispatched: [], announced, loginStored } };
};
