/**
 * Who set work going, judged by the repo's `trust.start` (dispatch/trust.mjs).
 *
 * A ready label counts only when its latest add was by someone in `start`,
 * or by governor's own App (`startRefused`, scripts/lib/ready-work.mjs).
 * The selection judges it before the cap counts a ticket, and the claim's
 * second read judges it again ({@link judgeReady}).
 *
 * At the default `start` nothing is looked up: someone without triage
 * access can add a label only through an issue template, so an adder other
 * than the ticket's author is in the three, and the author's association is
 * on the issue. Where a repo narrows `start`, governor looks the adder up
 * ({@link startKinds}): `OWNER` is the repo owner's login; on a user's
 * repo anyone else who can add a label is a `COLLABORATOR`; on an org's
 * repo the repo's outside-collaborator list tells `COLLABORATOR` from
 * `MEMBER`. A lookup that fails counts the label for nothing that turn.
 * An issue assigned to the summons account is a summons by its assigner,
 * looked up the same way (dispatch/dispatch-fire.mjs).
 */

import { addedBy, readsAdders, startRefused } from '../scripts/lib/ready-work.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/**
 * The two reads a lookup needs: whether the repo's owner is a `User` or an
 * `Organization`, and the logins of the repo's outside collaborators.
 *
 * @typedef {{
 *   repoOwnerType: () => Promise<string>,
 *   outsideCollaborators: () => Promise<string[]>,
 * }} StartLookups
 */

/**
 * What each of `logins` counts as in `trust.start`, keyed by the login in
 * lower case. A login the lookup could not place is left out, and `error`
 * says why. The repo's owner is placed with nothing read.
 *
 * @param {{ reader: StartLookups, repo: string, logins: readonly string[] }} args
 * @returns {Promise<{ kinds: Map<string, string>, error?: string }>}
 */
export const startKinds = async ({ reader, repo, logins }) => {
  const owner = String(repo.split('/')[0] ?? '').toLowerCase();
  /** @type {Map<string, string>} */
  const kinds = new Map();
  const others = [...new Set(logins.map((l) => l.toLowerCase()))].filter((l) => {
    if (l !== owner) return true;
    kinds.set(l, 'OWNER');
    return false;
  });
  if (others.length === 0) return { kinds };
  try {
    if (await reader.repoOwnerType() !== 'Organization') {
      for (const l of others) kinds.set(l, 'COLLABORATOR');
      return { kinds };
    }
    const outside = new Set((await reader.outsideCollaborators()).map((l) => l.toLowerCase()));
    for (const l of others) kinds.set(l, outside.has(l) ? 'COLLABORATOR' : 'MEMBER');
    return { kinds };
  } catch (error) {
    return { kinds, error: messageOf(error) };
  }
};

/**
 * A ready ticket that a person `trust.start` leaves out readied: each label
 * that does not count, who added it, and what they count as.
 *
 * @typedef {{ repo: string, issue: number, start: readonly string[], by: Array<{ label?: string, actor: string, kind: string }> }} Unstarted
 *   `label`: on a readying, the label; a summons has none. `actor`: the
 *   login, empty where the fire carries only an association.
 */

/**
 * A ready ticket whose adders governor could not look up this turn.
 *
 * @typedef {{ repo: string, issue: number, logins: string[], error: string }} Unlooked
 */

/**
 * @typedef {{ counts: true }
 *   | { counts: false, outsider: import('../scripts/lib/dispatch-router.mjs').Outsider }
 *   | { counts: false, unstarted: Unstarted }
 *   | { counts: false, unread: Unlooked }} Judged
 *   `outsider`: a template, a bot or no event added a ready label, a repo
 *   fault, said at warn. `unstarted`: a person outside `start` did, the
 *   repo's own choice, said at info. `unread`: an adder could not be
 *   looked up, said at warn, with no comment.
 */

/**
 * Whether a ready ticket's ready labels count under the repo's
 * `trust.start`. Its label events are read only where `readsAdders` says
 * so; a read that fails throws, as any other read of the ticket does. Each
 * adder but the author and governor's App is looked up only where `start`
 * is narrowed.
 *
 * @param {{
 *   reader: Partial<StartLookups> & { labelAdds: (n: number) => Promise<import('../scripts/lib/ready-work.mjs').LabelAdd[]> },
 *   repo: string,
 *   ticket: { number: number, author?: string, association?: string },
 *   ready: readonly string[],
 *   start: readonly string[],
 * }} args
 * @returns {Promise<Judged>}
 */
export const judgeReady = async ({ reader, repo, ticket, ready, start }) => {
  if (!readsAdders(ticket, start)) return { counts: true };
  const adds = await reader.labelAdds(ticket.number);
  const narrowed = readsAdders({ association: 'OWNER' }, start);
  /** @type {((login: string) => string | null) | undefined} */
  let kindOf;
  /** @type {string | undefined} */
  let failed;
  if (narrowed) {
    // Only the people whose add is the latest of a ready label, other than
    // the author, governor's App and a bot, are looked up.
    const author = String(ticket.author ?? '').toLowerCase();
    const logins = startRefused(ticket, adds, ready, start, () => null)
      .filter((r) => r.why === 'unread' && r.actor !== null && r.actor.toLowerCase() !== author)
      .map((r) => String(r.actor));
    const { kinds, error } = logins.length === 0
      ? { kinds: new Map(), error: undefined }
      : await startKinds({ reader: { repoOwnerType: reader.repoOwnerType ?? noLookup, outsideCollaborators: reader.outsideCollaborators ?? noLookup }, repo, logins });
    failed = error;
    kindOf = (login) => kinds.get(login.toLowerCase()) ?? null;
  }
  const refused = startRefused(ticket, adds, ready, start, kindOf);
  if (refused.length === 0) return { counts: true };
  const faults = refused.filter((r) => r.why === 'template' || r.why === 'bot' || r.why === 'unknown').map((r) => r.label);
  if (faults.length > 0) {
    return { counts: false, outsider: { repo, issue: ticket.number, labels: faults, author: ticket.author ?? '', association: ticket.association ?? 'NONE', addedBy: addedBy(adds, faults) } };
  }
  const unread = refused.filter((r) => r.why === 'unread');
  if (unread.length > 0) {
    return { counts: false, unread: { repo, issue: ticket.number, logins: [...new Set(unread.map((r) => String(r.actor)))], error: failed ?? 'no lookup placed them' } };
  }
  return { counts: false, unstarted: { repo, issue: ticket.number, start, by: refused.map((r) => ({ label: r.label, actor: String(r.actor), kind: String(r.kind) })) } };
};

/** A reader that cannot look anyone up. @returns {Promise<never>} */
const noLookup = async () => {
  throw new Error('this reader cannot look up who added a label');
};
