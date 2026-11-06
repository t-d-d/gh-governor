/**
 * A ticket's builders, found one way wherever governor looks for them, and
 * called from `rolesOf` alone (dispatch/roles.mjs), which finds every role
 * on a ticket. The
 * builder is the session building the ticket. It holds the branch and the
 * PR, and never writes the issue body.
 *
 * 1. The owner (`ownerOf`, dispatch/deliveries.mjs) of each open PR whose
 *    body closes the ticket, read from the open list the standing line
 *    reads (`openClosing`). Where two open PRs close it, both owners are
 *    builders.
 * 2. Where no open PR names one and a merge closed the ticket, that PR's
 *    owner, found with `closure`.
 * 3. Otherwise, the session the newest dispatch comment names
 *    (`lastDispatch`), read over the whole thread, so a thread past one
 *    page of comments still finds its newest. Only a comment governor's App
 *    posted counts.
 * 4. Otherwise, on a claimed ticket, the session the body's owner link
 *    names, read through the repo's `trust.relay`: a spec session that
 *    claimed its own ticket builds it.
 * 5. Otherwise, none.
 *
 * A read that fails rejects. It never reads as no builder.
 */

import { lastDispatch } from './webhook/fire.mjs';
import { relayedBody, sameSession, sessionNamedIn } from './webhook/subscribe.mjs';

/**
 * @typedef {{
 *   openClosing: (n: number) => Promise<Array<{ number: number }>>,
 *   closure: (n: number) => Promise<{ pr: { number: number } | null }>,
 *   allComments: (n: number) => Promise<Array<{ body: string, ours: boolean }>>,
 * }} BuilderReader
 *
 * @typedef {'open PR' | 'merged PR' | 'dispatch comment' | 'owner link'} BuilderSource
 *
 * @typedef {{ sessions: string[], by: BuilderSource | null, prs: number[], owns: Record<string, number[]> }} Builders
 *   `sessions`: each builder once. `by`: the step that found them, null for
 *   none. `prs`: the PRs whose owners they are, for the first two steps.
 *   `owns`: each of those builders' own PRs, keyed by the session as
 *   `sessions` spells it, so a send to one can hand the message to the live
 *   session on its PRs' head branches should it answer archived.
 */

/**
 * Each PR's owner, once each, the PRs whose owner was found, and each
 * owner's own PRs.
 *
 * @param {number[]} prs
 * @param {(pr: number) => Promise<{ session: string | null }>} ownerOf
 */
const ownersOf = async (prs, ownerOf) => {
  /** @type {string[]} */
  const sessions = [];
  /** @type {number[]} */
  const owned = [];
  /** @type {Record<string, number[]>} */
  const owns = {};
  for (const pr of prs) {
    const { session } = await ownerOf(pr);
    if (session === null) continue;
    const known = sessions.find((s) => sameSession(s, session));
    if (known === undefined) {
      sessions.push(session);
      owns[session] = [pr];
    } else {
      owns[known]?.push(pr);
    }
    owned.push(pr);
  }
  return { sessions, prs: owned, owns };
};

/**
 * @param {{
 *   reader: BuilderReader,
 *   ownerOf: (pr: number) => Promise<{ session: string | null }>,
 *   issue: number,
 *   ticket: { state: string, labels: readonly string[], body?: string } & import('./webhook/fire.mjs').Author,
 *   claim: string,
 *   relay: readonly string[],
 *   owner?: string | null,
 * }} args
 *   `ticket`: the ticket as just read, or as a delivery carried it.
 *   `claim`: the repo's claim label. `relay`: its `trust.relay`. `owner`:
 *   the session the body's owner link names, where the caller already
 *   read it under `relay`, as the receiver does for a ticket fire
 *   (dispatch/ticket-fire.mjs); the body is then not read.
 * @returns {Promise<Builders>}
 */
export const buildersOf = async ({ reader, ownerOf, issue, ticket, claim, relay, owner: named }) => {
  const open = (await reader.openClosing(issue)).map((p) => p.number);
  if (open.length > 0) {
    const found = await ownersOf(open, ownerOf);
    if (found.sessions.length > 0) return { ...found, by: 'open PR' };
  }
  if (ticket.state === 'closed') {
    const { pr } = await reader.closure(issue);
    if (pr !== null) {
      const found = await ownersOf([pr.number], ownerOf);
      if (found.sessions.length > 0) return { ...found, by: 'merged PR' };
    }
  }
  const marked = lastDispatch(await reader.allComments(issue))?.sessionUrl ?? null;
  if (marked !== null) return { sessions: [marked], by: 'dispatch comment', prs: [], owns: {} };
  const owner = !ticket.labels.includes(claim) ? null : named === undefined ? sessionNamedIn(relayedBody(ticket, relay)) : named;
  if (owner !== null) return { sessions: [owner], by: 'owner link', prs: [], owns: {} };
  return { sessions: [], by: null, prs: [], owns: {} };
};
