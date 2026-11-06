/**
 * A ticket's builders, found one way wherever governor looks for them. The
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
 *    page of comments still finds its newest.
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
 *   allComments: (n: number) => Promise<Array<{ body: string }>>,
 * }} BuilderReader
 *
 * @typedef {'open PR' | 'merged PR' | 'dispatch comment' | 'owner link'} BuilderSource
 *
 * @typedef {{ sessions: string[], by: BuilderSource | null, prs: number[] }} Builders
 *   `sessions`: each builder once. `by`: the step that found them, null for
 *   none. `prs`: the PRs whose owners they are, for the first two steps.
 */

/**
 * Each PR's owner, once each, and the PRs read.
 *
 * @param {number[]} prs
 * @param {(pr: number) => Promise<{ session: string | null }>} ownerOf
 */
const ownersOf = async (prs, ownerOf) => {
  /** @type {string[]} */
  const sessions = [];
  for (const pr of prs) {
    const { session } = await ownerOf(pr);
    if (session !== null && !sessions.some((s) => sameSession(s, session))) sessions.push(session);
  }
  return sessions;
};

/**
 * @param {{
 *   reader: BuilderReader,
 *   ownerOf: (pr: number) => Promise<{ session: string | null }>,
 *   issue: number,
 *   ticket: { state: string, labels: readonly string[], body?: string } & import('./webhook/fire.mjs').Author,
 *   claim: string,
 *   relay: readonly string[],
 * }} args
 *   `ticket`: the ticket as just read. `claim`: the repo's claim label.
 *   `relay`: its `trust.relay`.
 * @returns {Promise<Builders>}
 */
export const buildersOf = async ({ reader, ownerOf, issue, ticket, claim, relay }) => {
  const open = (await reader.openClosing(issue)).map((p) => p.number);
  if (open.length > 0) {
    const sessions = await ownersOf(open, ownerOf);
    if (sessions.length > 0) return { sessions, by: 'open PR', prs: open };
  }
  if (ticket.state === 'closed') {
    const { pr } = await reader.closure(issue);
    if (pr !== null) {
      const sessions = await ownersOf([pr.number], ownerOf);
      if (sessions.length > 0) return { sessions, by: 'merged PR', prs: [pr.number] };
    }
  }
  const marked = lastDispatch(await reader.allComments(issue))?.sessionUrl ?? null;
  if (marked !== null) return { sessions: [marked], by: 'dispatch comment', prs: [] };
  const owner = ticket.labels.includes(claim) ? sessionNamedIn(relayedBody(ticket, relay)) : null;
  if (owner !== null) return { sessions: [owner], by: 'owner link', prs: [] };
  return { sessions: [], by: null, prs: [] };
};
