/**
 * The PR review's shared fixtures: the PR, its body, the CLI's output for
 * an answer. test/dispatch-review.test.ts drives the turn with them and
 * test/dispatch-checklist.test.ts the checklist.
 */

import { CONFIG_PATH, readConfig } from '../../dispatch/repo-config.mjs';
import { factoryFile } from './factory.ts';

export const REPO = 'acme/factory';
export const HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
/** The commit main and the PR's head share. */
export const MERGE_BASE = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
export const BODY = 'Closes #748\n\nAdds the review fire.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01OWNER';
export const SKILL = '# PR review\n\nThe checklist.';
/** The dispatcher's App. */
export const APP_ID = 5075844;

export type Answer = { answer: 'pass' | 'fail'; test?: number; reason: string; editable?: boolean; person?: { test: number; reason: string } };

/** What `claude -p --output-format json --json-schema` prints for an answer. */
export const cliOutput = (answer: Answer, sessionId = 'sess-1') => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer), session_id: sessionId, structured_output: answer,
});

export const PASS: Answer = { answer: 'pass', reason: 'closes #748 as written, every criterion answered at merge, nothing left open' };
export const IAM: Answer = { answer: 'fail', test: 3, reason: 'the change adds an IAM grant', editable: false };

export type FileRow = { filename: string; status: string; previous?: string };
export type TicketRow = { number: number; title: string; body: string; state: string; labels: string[]; pull: boolean };

/** A change on no human-only path. */
export const FILES: FileRow[] = [{ filename: 'src/voices.ts', status: 'modified' }, { filename: 'docs/claude-code-setup.md', status: 'modified' }];

export type Pull = { number: number; title: string; body: string; state: string; draft: boolean; base: string; headSha: string; mergeable: boolean | null; html_url: string; association: string; author: string };

export const pullRow = (over: Partial<Pull> = {}): Pull => ({
  number: 767, title: 'Run the PR review from the dispatcher', body: BODY, state: 'open', draft: false, base: 'main', headSha: HEAD, mergeable: true, html_url: `https://github.com/${REPO}/pull/767`, association: 'MEMBER', author: 'a-member', ...over,
});

export type PullCommit = { sha: string; author: string | null; committer: string | null; verified: boolean };

/** A bump as Dependabot raises one here: its own PR, NONE to the repository, one signed commit. */
export const dependabotRow = (over: Partial<Pull> = {}): Pull => pullRow({
  title: 'Bump the pip group across 1 directory with 3 updates',
  body: 'Bumps the pip group with 3 updates in the /normalize-lambda directory: certifi, filelock and setuptools.',
  association: 'NONE',
  author: 'dependabot[bot]',
  ...over,
});
export const DEPENDABOT_COMMIT: PullCommit = { sha: HEAD, author: 'dependabot[bot]', committer: 'web-flow', verified: true };

const factory = readConfig(factoryFile(CONFIG_PATH));
if (!factory.ok || factory.config.review === undefined) throw new Error(`the factory's ${CONFIG_PATH} has no review section: ${JSON.stringify(factory)}`);

/** The factory's review settings, from its own config file, the checklist read as SKILL. */
export const FACTORY_REVIEW = { ...factory.config.review, checklist: SKILL };

/** The factory's labels, from its config file. */
export const FACTORY_LABELS = factory.config.labels;

/** The rules the code decides tests 1 and 7 from, the factory's. */
export const FACTORY_RULES = { humanOnly: FACTORY_REVIEW.humanOnly, tickets: FACTORY_REVIEW.tickets, quote: FACTORY_REVIEW.quote, decides: FACTORY_REVIEW.decides, labels: FACTORY_LABELS };
