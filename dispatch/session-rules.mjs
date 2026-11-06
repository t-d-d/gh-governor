/**
 * The session rules: the three rules every session working in a served repo
 * follows, whoever started it.
 *
 * A session governor starts reads them at the end of its opening prompt,
 * where the repo's file turns `sessionRules` on (the launcher's suffix,
 * dispatch/turn.mjs). They take the place of `SIGN_POSTS` there, since rule
 * 1 is the signing rule. A session a person starts reads the served repo's
 * `CLAUDE.md`, or the file `sessionRules.file` names, so the repo copies
 * {@link SESSION_RULES_BLOCK} into it. The block's marker carries a
 * version, so the config check (checker/config-check.mjs) can tell a file
 * with no block from one with an older block once the rules change.
 *
 * Pure, and a leaf: the task image copies it (dispatch/Dockerfile), and the
 * config check imports it from a fetch of this repo.
 */

/** The block's version. Bump it whenever {@link SESSION_RULES} changes what it asks. */
export const SESSION_RULES_VERSION = 1;

/** The file a served repo carries the block in when `sessionRules.file` names none. */
export const SESSION_RULES_FILE = 'CLAUDE.md';

/**
 * The three rules, as a session reads them. Rule 3's second sentence holds
 * before governor sends any offer of an ownerless issue, and after.
 */
export const SESSION_RULES = [
  'Rules for every session in this repo:',
  '',
  "1. Sign everything you write on GitHub: comments, reviews, replies, and issue and PR bodies, with this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer. Governor reads the link there to know who wrote a post, so it does not send you your own posts.",
  "2. Only an issue's or a PR's owner edits its body, and only a PR's owner pushes to its branch. You own what you filed or opened, or what governor tells you that you own. Signing off gives up the issues you own. While you own an open PR, do not sign off until governor asks.",
  '3. To change an issue or a PR you do not own, comment on it. Where governor tells you nobody owns an issue, you may take it by editing its body so your link ends it.',
].join('\n');

/** The block's end marker. */
export const SESSION_RULES_END = '<!-- governor:session-rules-end -->';

/** The block's opening marker, of any version. */
const OPENING = /<!-- governor:session-rules v\d+ -->/;

/** The block a served repo copies into its `CLAUDE.md`, from its versioned marker to its end marker. */
export const SESSION_RULES_BLOCK = `<!-- governor:session-rules v${SESSION_RULES_VERSION} -->\n${SESSION_RULES}\n${SESSION_RULES_END}`;

/**
 * Whether a file's text carries the block: `current` where it carries
 * {@link SESSION_RULES_BLOCK} whole, `old` where it has an opening marker
 * of another version, or of this version around other text, and `missing`
 * where it has no opening marker at all. A file whose block a person
 * edited reads as old, so the check asks for the current one back.
 *
 * @param {string} text
 * @returns {'current' | 'old' | 'missing'}
 */
export const blockIn = (text) => {
  // A file saved with Windows line endings carries the same block.
  if (text.replace(/\r\n/g, '\n').includes(SESSION_RULES_BLOCK)) return 'current';
  return OPENING.test(text) ? 'old' : 'missing';
};

/**
 * The file a repo's block is looked for in: `sessionRules.file`, a path
 * from the repo's root, or {@link SESSION_RULES_FILE}.
 *
 * @param {{ sessionRules?: { file?: string } }} config
 * @returns {string}
 */
export const rulesFile = (config) => config.sessionRules?.file ?? SESSION_RULES_FILE;
