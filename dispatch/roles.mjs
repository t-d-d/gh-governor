/**
 * A ticket's roles, found one way wherever governor looks for them, as
 * `ownerOf` finds a PR's owner (dispatch/deliveries.mjs), and the lines that
 * tell a session who holds them.
 *
 * - The spec owner is the session the link that ends the ticket's body
 *   names, read through `relayedBody` under the repo's `trust.relay`, with a
 *   ticket governor's App filed let in as the receiver lets it in
 *   ({@link ticketAuthor}).
 * - The builders, on a claimed ticket, are those the one builder lookup
 *   finds (`buildersOf`, dispatch/builders.mjs), each with the PRs it owns
 *   and whether the PR it was found through has merged.
 *
 * {@link rolesOf} returns each session that holds a role once, with its
 * roles and the PRs it owns as a builder, so a send to it can hand the
 * message to the live session on a PR's head branch should it answer
 * archived. {@link rolesText} writes the lines that tell the recipient its
 * role, from what it returns, on every path that writes them.
 */

import { buildersOf } from './builders.mjs';
import { ticketAuthor } from './trust.mjs';
import { relayedBody, sameSession, sessionNamedIn } from './webhook/subscribe.mjs';
import { SPEC_OWNER_DUTY } from './webhook/mention.mjs';

/** @typedef {'spec owner' | 'builder' | 'spec owner and builder'} TicketRole */

/**
 * @typedef {{ session: string, role: TicketRole, owns: number[], merged: boolean }} RoleHolder
 *   One session that holds a role. `owns`: the PRs it owns as a builder.
 *   `merged`: it builds through a PR whose merge closed the ticket.
 *
 * @typedef {{ issue: number, owner: string | null, builders: string[], by: import('./builders.mjs').BuilderSource | null, holders: RoleHolder[] }} TicketRoles
 *   `owner`: the spec owner. `builders`: each builder once. `by`: the step
 *   of the builder lookup that found them, null for none or where none was
 *   looked for. `holders`: each session that holds a role, once, the spec
 *   owner first.
 *
 * @typedef {{ state?: string, labels?: readonly string[], body?: unknown, app?: boolean } & import('./webhook/fire.mjs').Author} TicketRow
 *   A ticket as the reader returns it, or as a fire carried it.
 */

/**
 * The spec owner a ticket's row names: the session link that ends its body,
 * read only where `relay` lets the body's author in.
 *
 * @param {TicketRow} row
 * @param {readonly string[]} relay
 * @returns {string | null}
 */
const specOwnerOf = (row, relay) => sessionNamedIn(relayedBody({ ...ticketAuthor(row), body: String(row.body ?? '') }, relay));

/**
 * The roles as {@link rolesOf} returns them, from a spec owner and the
 * builders already known: each session once, the spec owner first, with
 * the PRs each builder owns (`owns`, keyed as `builders` spells them).
 * `merged`: the builders were found through the PR whose merge closed the
 * ticket.
 *
 * @param {{ issue: number, owner: string | null, builders?: readonly string[], owns?: Readonly<Record<string, readonly number[]>>, by?: import('./builders.mjs').BuilderSource | null }} args
 * @returns {TicketRoles}
 */
export const rolesFrom = ({ issue, owner, builders = [], owns = {}, by = null }) => {
  const merged = by === 'merged PR';
  const ownsOf = (/** @type {string} */ session) => [...(owns[Object.keys(owns).find((s) => sameSession(s, session)) ?? ''] ?? [])];
  /** @type {RoleHolder[]} */
  const holders = [];
  const both = owner !== null && builders.some((b) => sameSession(b, owner));
  if (owner !== null) holders.push({ session: owner, role: both ? 'spec owner and builder' : 'spec owner', owns: both ? ownsOf(owner) : [], merged: both && merged });
  for (const builder of builders) {
    if (holders.some((h) => sameSession(h.session, builder))) continue;
    holders.push({ session: builder, role: 'builder', owns: ownsOf(builder), merged });
  }
  return { issue, owner, builders: [...builders], by, holders };
};

/**
 * A ticket's roles. The ticket is `ticket` where the caller has already
 * read it, or a delivery carried it, and is read with `reader` otherwise.
 * The spec owner is `owner` where the caller already read it from the body
 * under `relay`, as the receiver does for a ticket fire; otherwise it is
 * read from the row. The builders are looked for only on a ticket that
 * carries `claim`, the repo's claim label: a caller that messages the spec
 * owner alone passes none, and nothing more is read. A read that fails
 * rejects: it never reads as nobody.
 *
 * @param {{
 *   issue: number,
 *   relay: readonly string[],
 *   claim?: string,
 *   ticket?: TicketRow,
 *   owner?: string | null,
 *   reader?: import('./builders.mjs').BuilderReader & { ticket?: (n: number) => Promise<TicketRow> },
 *   ownerOf?: (pr: number) => Promise<{ session: string | null }>,
 * }} args
 * @returns {Promise<TicketRoles>}
 */
export const rolesOf = async ({ issue, relay, claim = '', ticket, owner, reader, ownerOf }) => {
  /** @type {TicketRow} */
  let row;
  if (ticket !== undefined) row = ticket;
  else if (reader?.ticket !== undefined) row = await reader.ticket(issue);
  else throw new Error(`rolesOf: #${issue} was neither handed in nor readable`);
  const spec = owner === undefined ? specOwnerOf(row, relay) : owner;
  const labels = row.labels ?? [];
  if (claim === '' || !labels.includes(claim)) return rolesFrom({ issue, owner: spec });
  if (reader === undefined || ownerOf === undefined) throw new Error(`rolesOf: #${issue} is claimed, and no reader was handed in to find its builders`);
  const found = await buildersOf({ reader, ownerOf, issue, ticket: { state: String(row.state ?? 'open'), labels }, claim, relay, owner: spec });
  return rolesFrom({ issue, owner: spec, builders: found.sessions, owns: found.owns, by: found.by });
};

/** Items joined as a sentence lists them: `a, b and c`. @param {readonly string[]} items */
export const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * What a message to a builder whose PR closed the ticket and has merged
 * says, on every path that messages it: such a builder still hears the
 * ticket's events, since a repo may keep a ticket open past a merge.
 *
 * @param {number} issue
 */
export const mergedNote = (issue) => `Your PR, which closed #${issue}, has merged: act on this message only where it calls for new work.`;

/** What a ticket's builder is told where a comment calls on it. */
export const BUILDER_DUTY = 'As its builder you build it, on its branch and PR, and do not edit its body: act on what bears on the build, and record where your work differs from the body in your PR description.';

/** What a message that asks nothing of a role holder says, in place of a duty line. */
export const NOTHING_ASKED = 'Nothing is asked of you.';

/**
 * A session as a message names it: a Markdown link to its page, with
 * `text` as the link's words.
 *
 * @param {string} text
 * @param {string} session
 */
export const sessionLink = (text, session) => `[${text}](${session})`;

/**
 * The builders other than the recipient, as links, and the verb that fits them.
 *
 * @param {readonly string[]} others
 * @param {string} first the link text of the first, or the only one
 */
const buildersLinked = (others, first) => {
  if (others.length === 1) return `${sessionLink(first, /** @type {string} */ (others[0]))} builds it`;
  return `${listed(others.map((b, i) => sessionLink(`builder ${i + 1}`, b)))} build it`;
};

/**
 * What a message about a ticket adds under what happened: the role the
 * recipient (`holder`) holds, with a link to each session that holds the
 * other role. `duty`: the event calls on the role, a comment on an open
 * ticket, so each role the recipient holds gets its duty line. `notice`:
 * the message asks nothing of the recipient, and says so. A message that
 * asks something of its own passes neither, and says nothing more. A
 * builder whose PR has merged is told so, and acts on the message only
 * where it calls for new work.
 *
 * @param {TicketRoles} roles
 * @param {Pick<RoleHolder, 'role' | 'merged'> & { session?: string }} holder
 * @param {{ duty?: boolean, notice?: boolean }} [options]
 * @returns {string}
 */
export const rolesText = ({ issue, owner, builders }, { role, merged, session }, { duty = false, notice = false } = {}) => {
  // The recipient: the session handed in, else the spec owner where it holds that role.
  const self = session ?? (role === 'builder' ? null : owner);
  const others = builders.filter((b) => self === null || !sameSession(b, self));
  const specOwner = owner === null ? 'a person owns its body' : `${sessionLink('its spec owner', owner)} writes its body`;
  let first;
  if (role === 'spec owner') first = others.length === 0 ? 'You are its spec owner.' : `You are its spec owner; ${buildersLinked(others, 'its builder')}.`;
  else if (role === 'builder') first = `You build it; ${specOwner}.${others.length === 0 ? '' : ` ${buildersLinked(others, 'another builder')} too.`}`;
  else first = `You are its spec owner and you build it.${others.length === 0 ? '' : ` ${buildersLinked(others, 'another builder')} too.`}`;
  const lines = [first];
  if (duty && role !== 'builder') lines.push(SPEC_OWNER_DUTY);
  if (duty && role !== 'spec owner') lines.push(BUILDER_DUTY);
  if (role !== 'spec owner' && merged) lines.push(mergedNote(issue));
  if (notice && !duty) lines.push(NOTHING_ASKED);
  return lines.join('\n');
};
