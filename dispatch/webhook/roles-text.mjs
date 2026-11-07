/**
 * The lines that tell a session its role on a ticket, written in this one
 * place for every path that writes them: the task's role holders
 * (`rolesOf`, dispatch/roles.mjs) and the receiver's relay to an issue's
 * spec owner (dispatch/webhook/mention.mjs). It lives beside the receiver,
 * which imports nothing from outside dispatch/webhook/.
 */

import { sameSession } from './subscribe.mjs';

/**
 * What a ticket's spec owner is told where a comment calls on it: the
 * spec is its to judge, and a comment it disagrees with gets a reply, not
 * an edit. Governor's own comment's note (dispatch/told.mjs) says the same.
 */
export const SPEC_OWNER_DUTY = 'You own its spec. If the comment calls for a change you agree with, edit the body. If you disagree, reply on the issue saying why.';

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
 * Text as a Markdown link's words: on one line, each bracket or backslash
 * escaped, so it cannot end the link's words early.
 *
 * @param {unknown} text
 */
export const linkWords = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[[\]\\]/g, '\\$&');

/**
 * An issue or a PR as a message names it with its title: one Markdown link
 * whose words are the label and the title ({@link linkWords}), its
 * backticks dropped, since the app shows a link whose words hold a code
 * span as raw brackets.
 *
 * @param {string} label such as `#7` or `PR #12`
 * @param {unknown} title
 * @param {string} url
 */
export const titleLink = (label, title, url) => {
  const words = linkWords(String(title ?? '').replace(/`/g, ''));
  return `[${words === '' ? label : `${label} ${words}`}](${url})`;
};

/**
 * The builders other than the recipient, as links.
 *
 * @param {readonly string[]} others
 * @param {string} [first] the link text of the only one
 */
const buildersLinked = (others, first = 'another builder') => (others.length === 1
  ? sessionLink(first, /** @type {string} */ (others[0]))
  : listed(others.map((b, i) => sessionLink(`builder ${i + 1}`, b))));

/**
 * What a message about a ticket adds under what happened: the role the
 * recipient (`holder`) holds, with a link to each session that holds the
 * other role. `duty`: the event calls on the role, a comment on an open
 * ticket, so each role the recipient holds gets its duty line. `notice`:
 * the message asks nothing of the recipient, and says so. A message that
 * asks something of its own passes neither, and says nothing more. A
 * builder whose PR has merged is told so, and acts on the message only
 * where it calls for new work. No line carries a verb that depends on the
 * ticket's state, since a ticket closed as not planned was never built, so
 * the lines read the same on an open ticket, a closed one and one closed as
 * not planned.
 *
 * @param {{ issue: number, owner: string | null, builders: readonly string[] }} roles
 * @param {{ role: 'spec owner' | 'builder' | 'spec owner and builder', merged: boolean, session?: string }} holder
 * @param {{ duty?: boolean, notice?: boolean }} [options]
 * @returns {string}
 */
export const rolesText = ({ issue, owner, builders }, { role, merged, session }, { duty = false, notice = false } = {}) => {
  // The recipient: the session handed in, else the spec owner where it holds that role.
  const self = session ?? (role === 'builder' ? null : owner);
  const others = builders.filter((b) => self === null || !sameSession(b, self));
  const specOwner = owner === null ? 'a person owns its body' : `${sessionLink('its spec owner', owner)} writes its body`;
  const also = others.length === 0 ? '' : ` It also has ${buildersLinked(others)}.`;
  let first;
  if (role === 'spec owner') first = others.length === 0 ? 'You are its spec owner.' : `You are its spec owner; ${buildersLinked(others, 'its builder')} ${others.length === 1 ? 'is another session' : 'are its builders'}.`;
  else if (role === 'builder') first = `You are its builder; ${specOwner}.${also}`;
  else first = `You are its spec owner and its builder.${also}`;
  const lines = [first];
  if (duty && role !== 'builder') lines.push(SPEC_OWNER_DUTY);
  if (duty && role !== 'spec owner') lines.push(BUILDER_DUTY);
  if (role !== 'spec owner' && merged) lines.push(mergedNote(issue));
  if (notice && !duty) lines.push(NOTHING_ASKED);
  return lines.join('\n');
};
