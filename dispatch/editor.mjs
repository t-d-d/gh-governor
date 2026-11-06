/**
 * Who made a ticket's body edit that leaves the owner link in place, under
 * `sessionRules` (PRD #599, "A body edit that leaves the owner link in
 * place").
 *
 * Every session edits as the operator's login, so an `issues` `edited`
 * delivery cannot say whose edit it was, and the spec owner used to be told
 * the edit may be its own (`EDIT_SPEC_OWNER`). Most such edits are the
 * owner's own. Governor looks for the editor, the owner first:
 *
 * 1. The owner's own events are read, as an unsigned post's candidates'
 *    are (dispatch/author.mjs), from `AUTHOR_BEFORE_MS` before the edit to
 *    `AUTHOR_AFTER_MS` after it, for a tool call that edited the issue's
 *    body ({@link editedBody}). The window is anchored on the edit's time,
 *    the issue's `updated_at` in the payload, so a fire run late reads the
 *    same events.
 * 2. **Found**: the owner made it. It is not told of its own edit, and
 *    nobody is nudged.
 * 3. **Not found**: the other candidates are searched as an unsigned
 *    post's author is, the owner left out. One match is told once
 *    (`edit-unsigned`) to post its change as a comment, and the owner that
 *    another session edited its issue. Undecided: each candidate not ruled
 *    out is told once (`edit-unsigned-maybe`) the edit may be its own, and
 *    the owner that someone else edited it. All ruled out: the owner is told
 *    someone else edited it, most likely a person.
 * 4. **The owner's events cannot be read**: the owner gets the notice as it
 *    was, with `EDIT_SPEC_OWNER`.
 *
 * The search runs in the turn that tells the owner of the edit: the owner's
 * message (dispatch/turn.mjs) or the ticket fire (dispatch/ticket-fire.mjs),
 * both under `subscribeMessages`. An edit that moved the owner link is a
 * take (dispatch/take.mjs) and is not searched. The builder hears every
 * edit, as before. Text read from a session's events is never logged: a
 * `dispatch-editor` line names sessions, counts and reasons that quote no
 * event.
 */

import { NUMBER_KEYS, escaped, judgeCommands, readCandidate, readsOnly, repoNamedIn, searchAuthor, shellBody, tellFound } from './author.mjs';
import { SESSION_RULES } from './session-rules.mjs';
import { EDIT_SPEC_OWNER } from './webhook/mention.mjs';
import { sessionId } from './webhook/subscribe.mjs';

/** The log event for a search for a body edit's editor. */
export const EDITOR = 'dispatch-editor';

/**
 * @typedef {import('./webhook/fire.mjs').UnsignedPost} BodyEdit
 *   The edit's time, its issue's page and the new body's words around the change (`editWords`, dispatch/webhook/mention.mjs).
 * @typedef {{ by: 'owner' }
 *   | { by: 'unknown', reason: string }
 *   | { by: 'other', found: import('./author.mjs').Found }} EditFound
 *   `owner`: the owner's events show the edit. `unknown`: they could not be
 *   read, with a reason that quotes no event. `other`: they were read and
 *   do not, and `found` is the search of the other candidates.
 * @typedef {(on: number, edit: BodyEdit, owner: string) => Promise<EditFound>} FindEditor
 */

/**
 * Whether a tool call edited the body of `repo`'s issue `on`, and the text
 * its input carries, if any: `{ text }`, with `text` null where the input
 * names the issue but not the body (a body read from a file), or null
 * where the call made no body edit there.
 *
 * - A shell command, each command of its line judged on its own
 *   ({@link import('./author.mjs').shellCommands}), edits it where it writes to `repos/<repo>/issues/<on>`
 *   itself, not a path under it such as its comments, with `gh api` and a
 *   method other than GET, or runs `gh issue edit <on>`, and carries a
 *   body: inline (`body=`, `--body`, `-b`, a here document), unless the
 *   shell expands it, or from a file or stdin. A write with no body, a
 *   title or a label, made no body edit.
 * - Any other tool edits it where its input names the repo's owner and
 *   name, `on` by one of `NUMBER_KEYS`, and a `body`, and its name neither
 *   reads (`get`, `list`, `search`, `read`) nor names a comment, a review
 *   or a pull request.
 *
 * @type {import('./author.mjs').Match}
 */
export const editedBody = (call, repo, on) => {
  const input = /** @type {Record<string, unknown> | null} */ (call.input !== null && typeof call.input === 'object' ? call.input : null);
  if (input === null) return null;
  const [owner = '', name = ''] = repo.toLowerCase().split('/');
  if (typeof input.command === 'string') {
    const path = new RegExp(`repos/(?:${escaped(owner)}/${escaped(name)}|\\{owner\\}/\\{repo\\})/issues/${on}(?![0-9/])`, 'i');
    // The issue may follow flags, such as `-R <repo>`, or be named by its page.
    const cli = new RegExp(`\\bgh\\s+issue\\s+edit\\s+(?:-\\S+(?:\\s+[^-\\s]\\S*)?\\s+)*(?:#?|https://github\\.com/${escaped(owner)}/${escaped(name)}/issues/)${on}(?![0-9])`, 'i');
    return judgeCommands(input.command, (command) => {
      const viaCli = cli.test(command) && repoNamedIn(command, repo);
      if (!viaCli && !(path.test(command) && !readsOnly(command))) return null;
      // A write with no body, a title or a label, made no body edit.
      return shellBody(command);
    });
  }
  const tool = String(call.name ?? '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  if (/(?:^|_)(?:get|list|search|read)(?:_|$)/i.test(tool) || /comment|review|pull/i.test(tool)) return null;
  if (String(input.owner ?? '').toLowerCase() !== owner || String(input.repo ?? '').toLowerCase() !== name) return null;
  if (!NUMBER_KEYS.some((key) => Number(input[key]) === on)) return null;
  return typeof input.body === 'string' ? { text: input.body } : null;
};

/**
 * Search for who made a body edit on `repo`'s issue `on` that names
 * `owner` (see the module's head): the owner's events first, then the
 * other candidates. Logs nothing.
 *
 * @param {{ owner: string, list: () => Promise<readonly unknown[]>, events: (id: string, cursor?: string) => Promise<unknown>, repo: string, on: number, edit: BodyEdit }} args
 * @returns {Promise<EditFound>}
 */
export const searchEditor = async ({ owner, list, events, repo, on, edit }) => {
  const id = `cse_${sessionId(owner).replace(/^session_/, '')}`;
  const own = await readCandidate({ events, id, repo, on, post: edit, match: editedBody });
  if (own.read === 'posted') return { by: 'owner' };
  if (own.read === 'unreadable') return { by: 'unknown', reason: `the owner's ${own.reason}` };
  return { by: 'other', found: await searchAuthor({ list, events, repo, on, post: edit, match: editedBody, skip: [owner] }) };
};

const AGAIN = 'Read the body again before you next edit it, so you do not write over that change from an old copy.';

/**
 * What the spec owner is told of the edit's author, in place of
 * `EDIT_SPEC_OWNER`: that line itself where nothing was searched or the
 * owner's events could not be read.
 *
 * @param {EditFound | null} edited
 */
export const ownerLine = (edited) => {
  if (edited === null || edited.by !== 'other') return EDIT_SPEC_OWNER;
  const { found } = edited;
  if (!found.searched) return `Someone else made the edit, not this session. ${AGAIN}`;
  if (found.author !== null) return `Another session made the edit, not this one. A session should comment on an issue it does not own, and governor tells it so. ${AGAIN}`;
  if (found.maybe.length > 0) return `Someone else made the edit, not this session. Governor could not tell which session made it. ${AGAIN}`;
  return `Someone else made the edit, not this session, most likely a person. ${AGAIN}`;
};

/**
 * The owner's message of a body edit with its `EDIT_SPEC_OWNER` line
 * replaced by {@link ownerLine}, where the search found someone else. The
 * text as it came otherwise.
 *
 * @param {string} text
 * @param {EditFound | null} edited
 */
export const editedText = (text, edited) => {
  const line = `\n\n${EDIT_SPEC_OWNER}`;
  return edited?.by === 'other' && text.endsWith(line) ? `${text.slice(0, -line.length)}\n\n${ownerLine(edited)}` : text;
};

/**
 * The message to the session found to have edited another session's issue.
 *
 * @param {number} on
 * @param {string} url the issue's page
 */
export const editNudgeText = (on, url) => [
  `You edited the body of issue #${on} (${url}), which another session owns. An edit names only the operator's login, so governor searched the sessions working in this repo for who made it, and found this session.`,
  "An issue's body is its owner's to edit. Post your change as a comment on the issue instead, signed with this session's link, so its owner can decide whether the body takes it, and comment rather than edit from now on.",
  '',
  SESSION_RULES,
].join('\n');

/**
 * The message to a session that may have edited another session's issue,
 * where the search could not decide.
 *
 * @param {number} on
 * @param {string} url the issue's page
 */
export const editMaybeText = (on, url) => [
  `The body of issue #${on} (${url}) was edited, and not by the session that owns it. Governor searched the sessions working in this repo and could not tell which made the edit: it may be yours.`,
  "If you made it, post your change as a comment on the issue instead, signed with this session's link, and leave the body to its owner from now on. If you did not, there is nothing to do.",
  '',
  SESSION_RULES,
].join('\n');

/**
 * Tell what a search for a body edit's editor found: nothing where the
 * owner made it or its events could not be read, else the editor its nudge
 * or each candidate not ruled out that the edit may be its own, each once.
 * Returns each delivery sent. Logs {@link EDITOR} lines naming sessions
 * and counts, never text.
 *
 * @param {{
 *   repo: string,
 *   on: number,
 *   edit: BodyEdit,
 *   edited: EditFound,
 *   tellOnce: (session: string, kind: string) => Promise<boolean>,
 *   deliveries: Pick<import('./deliveries.mjs').Deliveries, 'deliver'>,
 *   log: import('./author.mjs').Log,
 * }} args
 * @returns {Promise<import('./deliveries.mjs').Delivery[]>}
 */
export const tellEditor = async ({ repo, on, edit, edited, tellOnce, deliveries, log }) => {
  const at = { repo, on, edit: edit.at };
  if (edited.by === 'owner') {
    log(EDITOR, { ...at, outcome: 'the owner made it', reason: 'it is not told of its own edit' });
    return [];
  }
  if (edited.by === 'unknown') {
    log(EDITOR, { ...at, level: 'warn', outcome: 'not searched', reason: `${edited.reason}: the owner hears the edit may be its own` });
    return [];
  }
  return tellFound({
    event: EDITOR,
    at,
    found: edited.found,
    nudge: { kind: 'edit-unsigned', text: editNudgeText(on, edit.url) },
    maybe: { kind: 'edit-unsigned-maybe', text: editMaybeText(on, edit.url) },
    tellOnce,
    deliveries,
    log,
  });
};
