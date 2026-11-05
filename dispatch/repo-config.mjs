/**
 * A served repo's dispatcher config file: what the dispatcher does in a
 * repo, written and reviewed in that repo.
 *
 * The file is `.github/dispatch.json` on the repo's default branch. It names
 * the repo's cloud environment, by ID or by name, the labels that mark a ticket ready, the
 * label that claims it and the labels that keep a ticket out, turns each feature on, may replace the
 * instruction in each message kind (`prompts`, dispatch/prompts.mjs),
 * names the repo's CI workflow, its triage targets and the tag
 * each target's deploy moves (`workflows`), and holds the PR
 * review's checklist and lists (`review`), names the issue
 * governor records its fires on (`heartbeat`, dispatch/heartbeat.mjs), sets how
 * often pickup sweeps its ready tickets (`pickup`, dispatch/pickup.mjs), lists the
 * recurring sessions the schedule fire starts (`periodics`, dispatch/periodics.mjs),
 * and lists the hooks an outside system fires (`hooks`, dispatch/hooks.mjs).
 * Every feature is a switch, off unless the file turns it on, and a turn
 * refuses a fire kind its repo's file does not turn on ({@link switchOf}).
 * Every switch is generic: the schema accepts none by repo. The file holds
 * no secret: a served repo may be public.
 *
 * Every prompt value, each in `prompts`, the review's `checklist`, each
 * periodic's `prompt` and each hook's, and a ticket review's `checklist` and
 * each of its `types` entries', is the
 * text or `{ "file": "<path>" }`, a file in the repo read from the default
 * branch beside the config file ({@link resolveFiles}).
 *
 * The schema is {@link configSchema}; {@link readConfig} reads a file's text
 * against it for one repo, {@link resolveFiles} reads the prompt files it
 * names, and {@link environmentFrom} turns a name into its ID from the
 * login's environment list.
 */

import { z } from 'zod';
import { ASSOCIATIONS, COUNTS, HOOK_NAME, HOOK_PER_HOUR, HOOK_PER_HOUR_MAX, SUMMONERS, WORKFLOW_PATH } from './webhook/fire.mjs';
import { PROMPTS, RETIRED_PROMPTS, unknownFills } from './prompts.mjs';
import { BOT, START, TRUST_VALUES, autoOf, reviewOf, taskKey as taskKeyOf, taskSet } from './trust.mjs';

/** Where the file lives, on the repo's default branch. */
export const CONFIG_PATH = '.github/dispatch.json';

/**
 * The switches any served repo may turn on: pickup, summons, PR and
 * subscribe messages, the red scheduled run, what a blocker's close does to
 * a ticket that is not ready to pick up (`unblocked`, dispatch/unblocked.mjs), CI and
 * deploy messages, branch-run messages, the conflicts check,
 * deployed-label job fires, the PR review, the heartbeat, periodics,
 * hooks, what governor does when a ticket's wait ends (`waits`,
 * dispatch/waits.mjs), and the sign-off sweep's archive and the standing
 * line's ask to sign off (`signOff`, scripts/lib/session-signoff.mjs), and
 * the ticket reviews (`ticketReviews`, dispatch/ticket-review.mjs).
 * Every switch there is.
 */
export const GENERIC_SWITCHES = Object.freeze([
  'pickup', 'summons', 'prMessages', 'subscribeMessages', 'redScheduledRun', 'unblocked',
  'ciMessages', 'deployMessages', 'branchRunMessages', 'conflicts', 'deployedLabels', 'prReview',
  'heartbeat', 'periodics', 'hooks', 'waits', 'signOff', 'ticketReviews',
]);

/**
 * Switches a served file may still set, each read as the switch that took
 * its work over: the schema is strict, and a file the change made invalid
 * would stop its repo being served. The merge hand-off's work is
 * `unblocked`'s; a file setting both reads `unblocked`.
 */
export const RETIRED_SWITCHES = Object.freeze({ mergeHandoff: 'unblocked' });

/**
 * What each switch turns on, as the config file's JSON Schema describes it
 * and the switch table in docs/serving-a-repo.md says it
 * (test/config-schema.test.ts).
 *
 * @type {Readonly<Record<string, string>>}
 */
const SWITCH_DESCRIPTIONS = Object.freeze({
  pickup: 'A session per ready ticket, picked up on its label, on the close of its last open blocker, and on the sweep at the interval `pickup.sweepHours` sets.',
  summons: 'A session per `@claude` remark, and a dispatch started by hand.',
  prMessages: 'Messages into the session a PR names, or the newest live session holding its branch.',
  subscribeMessages: 'Messages to sessions subscribed by a `governor:subscribe` line, and to an issue\'s filer. A filer hears a `deployed:` label on its issue only through a subscribe line for `deploys`.',
  redScheduledRun: 'A fresh session on a scheduled run on the default branch that went red.',
  unblocked: 'What a blocker\'s close does to a ticket that is not ready to pick up: a comment when the blocker closed as not planned, a message to a claimed ticket\'s session, and the spec work on a not-ready ticket. The session whose link ends the ticket\'s body owns it and is asked to rewrite its own spec; a fresh session rewrites it only where the body names no session or that session is archived, so nobody takes a ticket from its owner. A file that still sets the older `mergeHandoff` reads as this.',
  ciMessages: 'A red CI run tells the sessions of the merges it may blame. Needs `workflows.ci`.',
  deployMessages: 'A shipping job, or a red deploy, tells the sessions of the merges it shipped.',
  branchRunMessages: 'A run dispatched on a branch tells the session that wrote its commit.',
  conflicts: 'A merge into the default branch tells each PR it left conflicted.',
  deployedLabels: 'A shipping job labels the tickets it shipped `deployed: <target>`. Needs `deployMessages`.',
  prReview: 'The PR review, run from the `review` section.',
  heartbeat: 'Governor records each fire on the issue the `heartbeat` section names: a line for pickup and one per periodic. In the older shape with a `marker`, the hourly sweep stamps the issue\'s `last-run:` line instead.',
  periodics: 'A session per periodic in the `periodics` list, each time its day limit passes or one of its counts is reached.',
  hooks: 'A session on a hook\'s prompt when a signed request fires one of the hooks the `hooks` list holds. A fire while the hook\'s last session is open goes into that session as a message.',
  waits: 'When a ticket\'s `Blocked until:` date passes and it is not ready, one comment saying the wait ended, and, if `unblocked` is on, its spec work, which goes to its owner first as a blocker\'s close does. Every session governor starts is told how to make a ticket wait. The hold itself needs no switch.',
  ticketReviews: 'Each review the `ticketReviews` list holds comments on a ticket it selects, when the ticket is opened, reopened or has its body edited: whether it passes, waits for an edit, or waits for a person.',
  signOff: 'Governor archives an idle session in the repo whose last reply ends `Signing off.`, and a message about a close or a deploy, with nothing else open, asks the session to sign off.',
});

/**
 * The `features` section: every generic switch, and the retired ones read
 * as theirs.
 */
const featuresSchema = z.strictObject({
  ...Object.fromEntries(GENERIC_SWITCHES.map((name) => [name, z.boolean().optional().meta({ description: /** @type {string} */ (SWITCH_DESCRIPTIONS[name]) })])),
  ...Object.fromEntries(Object.entries(RETIRED_SWITCHES).map(([old, now]) => [old, z.boolean().optional().meta({ deprecated: true, description: `Retired: read as ${now}.` })])),
}).transform((features) => {
  /** @type {Record<string, boolean | undefined>} */
  const read = { ...features };
  for (const [old, now] of Object.entries(RETIRED_SWITCHES)) {
    if (read[now] === undefined && read[old] !== undefined) read[now] = read[old];
    delete read[old];
  }
  return read;
});

// GitHub's issues query splits its `labels` on commas, so a ready label
// holding one would match nothing.
const label = z.string().trim().min(1).max(50).regex(/^[^,]*$/, 'a label holds no comma');

/**
 * The fault in a prompt's text for `kind`: a fact the kind does not have,
 * or null.
 *
 * @param {string} kind
 * @param {string} text
 */
const fillsFault = (kind, text) => {
  const unknown = unknownFills(kind, text);
  return unknown.length === 0 ? null : `${kind} has no fact ${unknown.map((n) => `{${n}}`).join(', ')} (it has ${PROMPTS[kind]?.fills.map((n) => `{${n}}`).join(', ') || 'none'})`;
};

/**
 * A path in the repo, from its root: no leading slash, no `..` segment, so
 * a prompt file is always one of the repo's own.
 */
const repoPath = z.string().trim().min(1).refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0'), 'a path in the repo, from its root');

/** A prompt in a file: the file, read from the default branch beside the config file. */
const promptFile = z.strictObject({
  file: repoPath.meta({ description: 'The file holding the text: a path in the repo, from its root, read from the default branch beside the config file. A skill file\'s frontmatter is dropped.' }),
});

/**
 * What a prompt for `kind` replaces, and the facts it may name, for the
 * JSON Schema's description of its key.
 *
 * @param {string} kind
 */
const promptDescription = (kind) => {
  const { replaces, fills } = /** @type {import('./prompts.mjs').Kind} */ (PROMPTS[kind]);
  const named = fills.map((n) => `{${n}}`);
  const list = named.length === 1 ? `the fact ${named[0]}` : `the facts ${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  const facts = named.length === 0 ? 'It may name no fact.' : `It may name ${list}, which governor writes in.`;
  return `Replaces the default wording of ${replaces}. ${facts} The text, or { "file": "<path>" }.`;
};

/**
 * A prompt for `kind`: some text naming only the facts the kind has, or a
 * file holding it, whose text {@link resolveFiles} checks the same way. A
 * key the schema does not know is refused, so a typo is a fault, not a
 * default.
 *
 * @param {string} kind
 */
const prompt = (kind) => z.union([
  z.string().trim().min(1).superRefine((text, ctx) => {
    const fault = fillsFault(kind, text);
    if (fault !== null) ctx.addIssue({ code: 'custom', message: fault });
  }),
  promptFile,
]).meta({ description: promptDescription(kind) });

// A glob a review list matches changed paths with (dispatch/checklist.mjs's `globMatches`).
const glob = z.string().trim().min(1);

/**
 * A ticket rule: `labels`, the labels it is about; `unless`, the labels that
 * waive it. Under `require`, a ticket carries one of `labels`; under
 * `forbid`, none; either unless it carries one of `unless`.
 */
const ticketRule = z.strictObject({
  labels: z.array(label).min(1).meta({ description: 'The labels the rule is about.' }),
  unless: z.array(label).default([]).meta({ description: 'Labels that waive the rule for a ticket carrying one of them. Default none.' }),
});

/**
 * The PR review's settings: `checklist`, the model's prompt;
 * `humanOnly`, the globs a PR may not change without a person, each with
 * its reason and the labels that waive it when every ticket the PR closes
 * carries one; `tickets`, the label rules each ticket the PR closes meets;
 * `quote`, the globs of changed files the model reads whole (a `!` entry
 * takes a path back out); `decides`, the labels of a ticket whose body's
 * first line, `Constraint now lives at <path>, …`, decides the quoted files
 * it names, so they pass unread; `dependabot`, the manifests a Dependabot PR may
 * change; `requireChecks`, the checks the review requires beside those
 * GitHub requires, each a name or a name and the App that must post it; `waitForCi`, whether test 8 reads the `workflows.ci`
 * run at the head; `merge`, whether a pass merges. Settings, never code: a check
 * they cannot express is the repo's CI, read as a required status check.
 */
const reviewSchema = z.strictObject({
  checklist: z.union([z.string().trim().min(1), promptFile]).meta({ description: 'Required. The review model\'s system prompt, after governor\'s fixed frame and before a suffix naming what the code decided: the text, or { "file": "<path>" }.' }),
  humanOnly: z.array(z.strictObject({
    glob: glob.meta({ description: 'The paths a PR may not change without a person, as a glob.' }),
    reason: z.string().trim().min(1).meta({ description: 'Why a person must see a change to these paths, which the review says.' }),
    unless: z.array(label).default([]).meta({ description: 'Labels that waive the wait when every ticket the PR closes carries one and passes the review\'s ticket checks. They waive nothing for a PR from a session governor started. Default none.' }),
  })).default([]).meta({ description: 'Paths a PR may not change without a person: a PR changing a matching path waits for one, unless every ticket it closes carries one of the entry\'s `unless` labels and the PR is not from a session governor started. Default none.' }),
  tickets: z.strictObject({
    require: z.array(ticketRule).default([]).meta({ description: 'Rules each ticket the PR closes meets by carrying one of the rule\'s labels, unless it carries one of its `unless` labels. Default none.' }),
    forbid: z.array(ticketRule).default([]).meta({ description: 'Rules each ticket the PR closes meets by carrying none of the rule\'s labels, unless it carries one of its `unless` labels. Default none.' }),
  }).default({ require: [], forbid: [] }).meta({ description: 'The label rules every ticket the PR closes must meet: `require` and `forbid`.' }),
  quote: z.array(z.string().trim().regex(/^!?[^!\s]/, 'a glob, or `!` and a glob')).default([]).meta({ description: 'Globs of changed files the review model reads whole, at the merge base and at the head. Only a modified file is quoted: one added, removed or renamed waits for a person. A `!` entry takes a path back out. Default none.' }),
  decides: z.array(label).default([]).meta({ description: 'Labels of a ticket that may decide a quoted file\'s change: its body\'s first line, `Constraint now lives at <path>, …`, names the files it decides, which then pass unread. Default none.' }),
  dependabot: z.array(glob).default([]).meta({ description: 'Globs of the manifests a Dependabot PR may change and pass with no model. Default none.' }),
  requireChecks: z.array(z.union([
    z.string().trim().min(1),
    z.strictObject({
      name: z.string().trim().min(1).meta({ description: 'The check run\'s name.' }),
      app: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/, 'an App slug: lowercase letters, digits and hyphens, the last part of its github.com/apps/<slug> page').meta({ description: 'The slug of the GitHub App that must post it, such as `github-actions` or `github-code-scanning`: lowercase letters, digits and hyphens, the last part of its `github.com/apps/<slug>` page. A run of the name from any other App, and a commit status of the name, does not count.' }),
    }),
  ])).default([]).meta({ description: 'Checks the review treats as required, beside any the default branch requires on GitHub: a name, which a check run from any App or a commit status context meets, or `{ "name", "app" }`, which only that App\'s check run of the name meets. One red on the PR\'s head fails the review for a push; one not finished, or not posted, holds the review with `governor` in progress until it ends. A name GitHub also requires counts once, and the review\'s own `governor` check is left out. Default none.' }),
  waitForCi: z.boolean().default(true).meta({ description: 'Whether the review waits for the `workflows.ci` run at the PR\'s head: one red fails it for a push, one not finished, or none at the head, holds it with `governor` in progress. Set it false where the CI workflow does not run on pull requests, such as one that runs only on a push to the default branch; the review then reads no workflow runs, and still reads the required checks and `requireChecks`. A red CI run on the default branch still drives `ciMessages`. Default true.' }),
  merge: z.boolean().default(true).meta({ description: 'Whether a pass merges the PR. With false, a pass posts its comment and a success check, and the owner merges. Default true.' }),
});

// A deploy target, as a shipping job's name ends `deployed: <target>`.
const target = z.string().trim().min(1).max(50 - 'deployed: '.length).regex(/^[^\n,]*$/, 'a target is one line, with no comma');

/**
 * What the repo's workflows are to the dispatcher: `ci`, the
 * workflow whose red run its merges' sessions hear of; `triage`, the deploy
 * targets whose failure starts one fresh session instead; `tags`, the tag a
 * target's deploy moves, which its messages name.
 */
const workflowsSchema = z.strictObject({
  ci: z.string().regex(WORKFLOW_PATH, 'a workflow file under .github/workflows/').optional().meta({ description: 'The CI workflow\'s file, under `.github/workflows/`. A red run of it tells the sessions of the merges it may blame. Without it, no run is CI.' }),
  triage: z.array(target).default([]).meta({ description: 'The deploy targets whose failure starts one fresh session, rather than messages to the sessions of the merges it shipped. Default none.' }),
  tags: z.record(target, z.string().trim().min(1).regex(/^[\w./-]+$/, 'a tag name')).default({}).meta({ description: 'The tag each deploy target\'s deploy moves, keyed by target, which deploy messages name. Default none.' }),
}).default({ triage: [], tags: {} });

/** A repo's `workflows` when its file names none: no CI, no triage, no tags. @type {Readonly<Workflows>} */
export const NO_WORKFLOWS = Object.freeze({ triage: [], tags: {} });

// What CI is, and the switch each fire kind needs, live in a leaf the
// receiver shares (dispatch/webhook/switches.mjs).
export { isCi, switchOf } from './webhook/switches.mjs';

/**
 * The issue governor records its fires on (dispatch/heartbeat.mjs). With a
 * `marker`, the bare schedule fire stamps `last-run` under it; without one,
 * governor keeps a line for pickup and one per periodic under its own
 * `<!-- governor:heartbeat -->`. Either marker the body must already carry
 * for a write to go: a wrong number then refuses the write rather than
 * overwrite someone's ticket.
 */
const heartbeatSchema = z.strictObject({
  issue: z.number().int().positive().meta({ description: 'The number of the issue governor records its fires on. Its body must already carry the marker, or governor writes nothing into it.' }),
  marker: z.string().trim().regex(/^<!--[^\n]*-->$/, 'an HTML comment on one line, `<!-- … -->`').optional().meta({ description: 'The older shape: the repo\'s own marker, an HTML comment on one line, under which the hourly sweep keeps one `last-run:` line. Without it, governor keeps a line for pickup and one per periodic under `<!-- governor:heartbeat -->`.' }),
});

/**
 * The wait ticket (dispatch/waits.mjs): with `waits` on, governor links each
 * waiting ticket as blocked by it, so GitHub's sidebar shows the ticket is
 * held, and removes the link when the wait ends. The link is only for
 * display: the ticket's line holds it.
 */
const waitsSchema = z.strictObject({
  issue: z.number().int().positive().meta({ description: 'The number of the wait ticket: governor links each waiting ticket as blocked by it, and removes the link when the wait ends. An issue can block at most 50.' }),
});

/**
 * Pickup's settings (dispatch/pickup.mjs). `sweepHours`: how many whole
 * hours the bare schedule fire leaves between two sweeps of the repo's ready
 * tickets, one when unset. `by`: the `author_association` values whose
 * tickets pickup may start (`PICKUP_BY` when unset).
 */
const pickupSchema = z.strictObject({
  sweepHours: z.number().int().min(1).optional().meta({ description: 'How many whole hours the hourly fire leaves between two sweeps of the repo\'s ready tickets, at least one. Default one, which sweeps at every fire.' }),
  by: z.array(z.enum(ASSOCIATIONS)).min(1).optional().meta({ description: 'Retired: read as `trust.task`, and refused beside it. Whose tickets pickup may start, and whose issue or PR a summons may start a session on: the `author_association` values GitHub gives the person who opened it. Default `OWNER`, `MEMBER` and `COLLABORATOR`. Where a repo lists any other value, a ready label on such a ticket counts only when a person other than its author, or governor\'s own App, added it last.' }),
});

/**
 * Whose GitHub text governor acts on (dispatch/trust.mjs). `auto`: whose
 * issues and PRs governor sets going by itself, with no person choosing the
 * ticket. It may never hold `BOT`: a bot's issue is a rule firing, and no
 * one read it. `task`: whose issue or PR may become work when a person sets
 * it going, by readying it or by a summons on it; nor may it hold `BOT`.
 * `relay`: whose text may reach a session that is already running.
 * `start`: who may set work going; only the authors with a say, narrowed
 * where the file sets it. `review`: whose PRs the PR review reads.
 */
const trustSchema = z.strictObject({
  start: z.array(z.enum(TRUST_VALUES))
    .min(1)
    .refine((list) => list.every((a) => START.includes(a)), 'takes only OWNER, MEMBER and COLLABORATOR: only someone with a say in the repo may set work going, and a repo may narrow that, never widen it')
    .optional()
    .meta({ description: 'Who may set work going, by `author_association`: whose ready label counts, and whose summons starts a session. Default `OWNER`, `MEMBER` and `COLLABORATOR`. A repo may narrow it, never widen it: any other value, and `BOT`, is refused.' }),
  auto: z.array(z.enum(TRUST_VALUES))
    .refine((list) => !list.includes(BOT), 'BOT is refused here: governor sets nothing going by itself on a bot\'s issue or PR, which no person has read')
    .optional()
    .meta({ description: 'Whose issues and PRs governor sets going by itself, with no person choosing the ticket, by `author_association`: a spec session or owner message when a ticket\'s wait ends or its blocker closes, a periodic\'s issue counts and listings, and the conflicts check. Default `OWNER`, `MEMBER` and `COLLABORATOR`, narrowed to fit `task` (or `pickup.by`), `relay` and `review` where the file sets them. `BOT` is refused.' }),
  task: z.array(z.enum(TRUST_VALUES))
    .refine((list) => !list.includes(BOT), 'BOT is refused here: a bot\'s issue or PR is a rule firing, which no person has read, so no work may be about it')
    .optional()
    .meta({ description: 'Whose issue or PR may become work when a person sets it going, by `author_association`: pickup starts a ready ticket, and a summons starts a session, only where its author is listed. Default `OWNER`, `MEMBER` and `COLLABORATOR`, narrowed to fit `relay` and `review` where the file sets them. `BOT` is refused. The older `pickup.by` is read as this list, and a file may not set both.' }),
  relay: z.array(z.enum(TRUST_VALUES))
    .optional()
    .meta({ description: 'Whose text may reach a session that is already running, by `author_association`, with `BOT` for any account GitHub marks as a bot: their comments and reviews, and a session link or `governor:subscribe` line in the body of an issue or PR they open. An event such as a label, a close or a push is judged by the author of the issue or PR it is on. Default `OWNER`, `MEMBER`, `COLLABORATOR` and `BOT`, less any of the first three a `review` the file sets leaves out. Governor\'s own App is never judged.' }),
  review: z.array(z.enum(TRUST_VALUES))
    .optional()
    .meta({ description: 'Whose pull requests governor\'s PR review reads, by `author_association`, with `BOT` for any account GitHub marks as a bot. A pull request by an author it leaves out gets a `neutral` `governor` check, and a person merges it. Dependabot\'s pull requests are read by `review.dependabot` whatever it says. Default `OWNER`, `MEMBER` and `COLLABORATOR`.' }),
});

/**
 * A recurring session: `name`, unique in the file, which the session is
 * named after and its record keyed by; `prompt`, what it runs; `days`, how
 * many whole days after its last fire it comes due. `counts`, each of
 * merges into the default branch, issues opened and issues closed it names,
 * brings it due sooner, once that many have happened since its last fire.
 * `gapHours`: the fewest whole hours between two of its runs.
 * `connectors`: the claude.ai connectors its session needs, each by its
 * name in the account's connector list (`feed_prod`). A periodic that
 * names any starts as a routine run with those attached, and no others
 * (dispatch/routines.mjs).
 */
/** A claude.ai connector's name as a routine's `mcp_connections` takes it. */
export const CONNECTOR_NAME = /^[A-Za-z0-9_-]+$/;

/** What each of a periodic's counts counts. @type {Readonly<Record<string, string>>} */
const COUNT_DESCRIPTIONS = Object.freeze({
  merges: 'Pull requests merged into the default branch',
  issuesOpened: 'Issues opened',
  issuesClosed: 'Issues closed',
});

const periodicSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).regex(/^[^\n]*$/, 'a name is one line').meta({ description: 'The periodic\'s name: one line, unique in the file. Its session is named after it, and governor keys its record by it.' }),
  prompt: z.union([z.string().trim().min(1), promptFile]).meta({ description: 'What the periodic\'s session runs: the text, or { "file": "<path>" }. Governor adds a line under it giving the last fire\'s time, and lists what each count counted since then.' }),
  days: z.number().int().min(1).meta({ description: 'Required. The day limit, in whole days, at least one: the periodic is due on the sweep nearest that many days after its last fire.' }),
  counts: z.strictObject(Object.fromEntries(COUNTS.map((kind) => [kind, z.number().int().min(1).optional().meta({ description: `${COUNT_DESCRIPTIONS[kind]} since the last fire that bring the periodic due, a whole number of at least one.` })])))
    .refine((c) => Object.values(c).some((n) => n !== undefined), 'counts names at least one of merges, issuesOpened and issuesClosed')
    .optional()
    .meta({ description: 'Counts that bring the periodic due before its day limit, once any reaches its number since the last fire: `merges`, `issuesOpened` and `issuesClosed`. At its day limit, a periodic whose counts counted nothing starts no session.' }),
  gapHours: z.number().int().min(1).optional().meta({ description: 'The fewest whole hours between two of the periodic\'s runs, at least one. A count reached inside the gap fires on the first event or sweep after it.' }),
  connectors: z.array(z.string().regex(CONNECTOR_NAME, 'a connector name is letters, digits, hyphens and underscores'))
    .min(1, 'connectors names at least one connector, or is left out')
    .refine((names) => new Set(names).size === names.length, 'connectors names each connector once')
    .optional()
    .meta({ description: 'The claude.ai connectors the periodic\'s session needs, each named once by its name in the account\'s connector list. A periodic naming any starts as a run of a routine governor keeps for it, with those connectors attached and no others.' }),
});

/**
 * A hook an outside system fires (dispatch/hooks.mjs): `name`, unique in the
 * file and safe in a URL path, which the hook's URL ends in and its session
 * is named after; `prompt`, what the session runs; `keyVersion`, the version
 * of the hook's key a fire must be signed with. Raising it revokes the key
 * before it. A version is not a secret: the key is derived from the stack's.
 * `perHour`, the most fires the receiver queues for the hook in a clock hour,
 * 20 when unset (`HOOK_PER_HOUR`, webhook/fire.mjs), and at most 100
 * (`HOOK_PER_HOUR_MAX`).
 */
const hookSchema = z.strictObject({
  name: z.string().regex(HOOK_NAME, 'lower-case letters, digits and hyphens, safe in a URL path').meta({ description: 'The hook\'s name: lower-case letters, digits and hyphens, unique in the file. It ends the hook\'s URL, and its session is named after it.' }),
  prompt: z.union([z.string().trim().min(1), promptFile]).meta({ description: 'What the hook\'s session runs: the text, or { "file": "<path>" }. Governor adds lines under it saying which hook fired and when, and quoting the caller\'s text as the caller\'s data.' }),
  // At most nine digits, as a request's `v=` and scripts/hook-key.mjs take:
  // a larger version could never be signed.
  keyVersion: z.number().int().positive().max(999_999_999).meta({ description: 'Required. The version of the hook\'s key a request must be signed with, a positive whole number of at most nine digits. Raising it revokes the key before it. It is not a secret.' }),
  // An hour's count item holds each signature it counted: a larger cap
  // could outgrow the item.
  perHour: z.number().int().positive().max(HOOK_PER_HOUR_MAX).optional().meta({ description: `The most fires governor queues for the hook in one clock hour, a positive whole number up to ${HOOK_PER_HOUR_MAX}. A fire past it gets 429. Default ${HOOK_PER_HOUR}.` }),
});

/**
 * Who a ticket review reads where its `when.by` is unset: the authors with a
 * say (dispatch/ticket-review.mjs).
 */
export const TICKET_REVIEW_BY = Object.freeze([...SUMMONERS]);

/** A ticket review's conclusions, in the words GitHub uses for a check run. */
const CONCLUSION_NAMES = /** @type {const} */ (['success', 'failure', 'neutral']);

/**
 * One `types` entry of a ticket review: the labels that match a ticket
 * carrying any of them, in any case; the checklist it adds after the
 * review's base; and the conclusions whose labels it overrides.
 */
const ticketTypeSchema = z.strictObject({
  labels: z.array(label).min(1).meta({ description: 'The labels that match a ticket carrying any of them, in any case. At least one.' }),
  checklist: z.union([z.string().trim().min(1), promptFile]).optional().meta({ description: 'Checks a matching ticket gets after the review\'s base checklist: the text, or { "file": "<path>" }. Default none.' }),
  conclusions: z.strictObject({
    success: z.array(label).optional().meta({ description: 'The labels a `success` adds on a matching ticket, in place of the review\'s.' }),
    failure: z.array(label).optional().meta({ description: 'The labels a `failure` adds on a matching ticket, in place of the review\'s.' }),
    neutral: z.array(label).optional().meta({ description: 'The labels a `neutral` adds on a matching ticket, in place of the review\'s.' }),
  }).optional().meta({ description: 'The conclusions whose labels this entry overrides, each a list, each label starting with the review\'s name, a colon and a space. A conclusion it leaves out takes its labels from an entry later in the file that matches, or from the review\'s `conclusions`.' }),
});

/**
 * One ticket review (dispatch/ticket-review.mjs): its `name`, which goes
 * into every comment and marker it writes, and its selector, `when`. Only
 * `on: "opened"` is built; any other event fails loudly rather than be
 * read as something else. `conclusions` names the labels each conclusion
 * adds, which the code applies (dispatch/ticket-review.mjs). `checklist` is
 * the review's base checklist, a prompt value, and `types` adds checks and
 * labels per ticket type, matched by label. No other key yet: a file
 * written for a later governor fails here.
 */
const ticketReviewSchema = z.strictObject({
  name: z.string().regex(HOOK_NAME, 'lower-case letters, digits and hyphens: it goes into a marker that can never be migrated').meta({ description: 'The review\'s name: lower-case letters, digits and hyphens, unique in the list. It goes into every comment and marker the review writes, so renaming a review starts its rounds afresh.' }),
  when: z.strictObject({
    on: z.literal('opened').meta({ description: 'The event that runs the review. Only `"opened"`: an open issue opened, reopened or with its body edited.' }),
    labels: z.array(label).optional().meta({ description: 'Labels the ticket must carry, every one of them, in any case. Default none.' }),
    exclude: z.array(label).optional().meta({ description: 'Labels the ticket must not carry, any of them, in any case. Default none.' }),
    by: z.array(z.enum(ASSOCIATIONS)).min(1).optional().meta({ description: 'Who may have opened the ticket, as GitHub\'s `author_association` values. Default `OWNER`, `MEMBER` and `COLLABORATOR`. The repo\'s `trust.review` bounds every review.' }),
  }).meta({ description: 'The review\'s selector: `on`, the event, and the labels and authors a ticket must meet.' }),
  conclusions: z.strictObject({
    success: z.array(label).default([]).meta({ description: 'The labels a `success` adds: the ticket passes. Default none.' }),
    failure: z.array(label).default([]).meta({ description: 'The labels a `failure` adds: the ticket waits for an edit by whoever filed it. Default none.' }),
    neutral: z.array(label).default([]).meta({ description: 'The labels a `neutral` adds: the ticket waits for a person. Default none.' }),
  }).default({ success: [], failure: [], neutral: [] }).meta({ description: 'The labels each conclusion adds: `success`, `failure` and `neutral`, each a list, each none when unset. Each run adds its conclusion\'s labels and removes the ones the other two name, and touches no other label. Each label starts with the review\'s name, a colon and a space, such as `triage: build` for a review named `triage`, in any case, so a review never adds or removes a label a person uses. A label appears under one conclusion of one review. A review whose `by`, within `trust.review`, reaches beyond `trust.auto` names no ready label. No conclusion names a label a `types` entry matches on, a label the review\'s own `when.labels` or `when.exclude` names, or `labels.claim`.' }),
  checklist: z.union([z.string().trim().min(1), promptFile]).optional().meta({ description: 'The review\'s base checklist, after governor\'s fixed frame: the text, or { "file": "<path>" }. Default governor\'s own checklist.' }),
  types: z.array(ticketTypeSchema).min(1).optional().meta({ description: 'Checks and labels per ticket type, each entry matched by label. A ticket gets the base checklist and then each matching entry\'s, in file order; one matching none gets the base alone. For each conclusion, the labels come from the first matching entry that names it, and otherwise from `conclusions`.' }),
});

/**
 * The file's schema. It is the same in every repo: no switch is any one
 * repo's. Each key's description is what the exported JSON Schema shows on
 * hover, and the key table in docs/serving-a-repo.md says the same
 * (test/config-schema.test.ts). `$schema` names that JSON Schema for an
 * editor, and {@link readConfig} drops it unread; any other unknown key, and
 * `$schema` below the top, is a fault.
 */
export const configSchema = z.strictObject({
  $schema: z.string().optional().meta({ description: 'The URL of this file\'s JSON Schema, for an editor to describe and check each key. Governor ignores it. Use the schema at the commit the config check is pinned to, and bump both together.' }),
  environment: z.string().trim().min(1, 'a cloud environment name, or its ID (env_…)').meta({ description: 'The claude.ai cloud environment the repo\'s sessions start in: its name as `/remote-env` lists it, or its ID. A public repo should use the name.' }),
  labels: z.strictObject({
    ready: z.array(label).min(1).meta({ description: 'Every label a ready ticket carries.' }),
    claim: label.meta({ description: 'The label governor claims a ticket with before its session starts. It is created in a repo that lacks it. A ticket carrying it is never picked up.' }),
    claimRemoves: z.array(label).default([]).meta({ description: 'The ready labels the claim takes off, and a failed launch puts back. Default none.' }),
    exclude: z.array(label).default(['type: prd']).meta({ description: 'Labels that keep a ticket out: a ticket carrying any of them is never picked up, and a blocker\'s close starts no session for it. It cannot name a ready label. Default `["type: prd"]`. A hold label, one that marks a ticket as needing a person or staying not ready (`mode: human`, say), belongs here, or a blocker\'s close starts a session to rewrite that ticket\'s spec.' }),
  }).refine((l) => !l.ready.includes(l.claim), 'the claim label cannot be a ready label')
    .refine((l) => l.claimRemoves.every((r) => l.ready.includes(r)), 'claimRemoves names only ready labels')
    // A ready ticket carries every ready label, so excluding one would
    // keep every ticket out.
    .refine((l) => !l.exclude.some((e) => l.ready.includes(e)), 'exclude cannot name a ready label')
    .meta({ description: 'The labels governor reads and writes on tickets: `ready`, `claim`, `claimRemoves` and `exclude`.' }),
  features: featuresSchema.meta({ description: 'The switches that turn governor\'s features on, each `true` or `false`. A switch left out is off.' }),
  // A retired prompt is still valid, and dropped unread: governor sends
  // no message of its kind, so its file is never read.
  prompts: z.strictObject({
    ...Object.fromEntries(Object.keys(PROMPTS).map((kind) => [kind, prompt(kind).optional()])),
    ...Object.fromEntries(RETIRED_PROMPTS.map((kind) => [kind, z.union([z.string(), promptFile]).optional().meta({ deprecated: true, description: 'Retired: governor sends no message of this kind, so it is never read.' })])),
  }).transform((prompts) => Object.fromEntries(Object.entries(prompts).filter(([kind]) => !RETIRED_PROMPTS.includes(kind)))).default({})
    .meta({ description: 'Replacement wording for the instruction in each kind of message, keyed by kind.' }),
  workflows: workflowsSchema.meta({ description: 'What the repo\'s workflows are to governor: `ci`, `triage` and `tags`.' }),
  review: reviewSchema.optional().meta({ description: 'The PR review\'s settings: its checklist, and the lists it checks a PR against. Needed when `prReview` is on.' }),
  heartbeat: heartbeatSchema.optional().meta({ description: '`{ "issue": <number> }`: the issue governor records every fire on, under the `<!-- governor:heartbeat -->` marker its body must carry. The older `{ "issue": <number>, "marker": "<!-- … -->" }` keeps one `last-run:` line under the repo\'s own marker, which the hourly sweep updates. Needed when `heartbeat` is on.' }),
  waits: waitsSchema.optional().meta({ description: '`{ "issue": <number> }`: the wait ticket, which each waiting ticket is linked as blocked by while it waits, so its sidebar shows the wait. Read only with `waits` on. Without it, governor links nothing.' }),
  pickup: pickupSchema.optional().meta({ description: '`{ "sweepHours": <number>, "by": [ … ] }`: how many whole hours the hourly fire leaves between two sweeps of the repo\'s ready tickets, at least one, default one; and `by`, the retired name of `trust.task`, which governor reads as it.' }),
  trust: trustSchema.optional().meta({ description: '`{ "start": [ … ], "auto": [ … ], "task": [ … ], "relay": [ … ], "review": [ … ] }`: whose GitHub text governor acts on, by `author_association`. `start` is who may set work going, by readying a ticket or writing a summons, default `OWNER`, `MEMBER` and `COLLABORATOR`, which a repo may narrow and never widen. `auto` is whose issues and PRs governor sets going by itself, default `OWNER`, `MEMBER` and `COLLABORATOR`. `task` is whose issue or PR may become work when a person readies it or summons a session on it, default the same three. `relay` is whose text may reach a running session, default those three and `BOT`. `review` is whose pull requests the PR review reads, default the three.' }),
  periodics: z.array(periodicSchema).default([])
    .superRefine((list, ctx) => {
      const seen = new Set();
      for (const { name } of list) {
        if (seen.has(name)) ctx.addIssue({ code: 'custom', message: `two periodics are named "${name}": a name is unique in the file` });
        seen.add(name);
      }
    })
    .meta({ description: 'The recurring sessions governor starts on a day limit, or on a count of merges, issues opened or issues closed. At least one when the `periodics` switch is on.' }),
  hooks: z.array(hookSchema).default([])
    .superRefine((list, ctx) => {
      const seen = new Set();
      for (const { name } of list) {
        if (seen.has(name)) ctx.addIssue({ code: 'custom', message: `two hooks are named "${name}": a name is unique in the file` });
        seen.add(name);
      }
    })
    .meta({ description: 'The sessions an outside system starts with a signed request, each with an optional `perHour` cap on fires. At least one when the `hooks` switch is on.' }),
  ticketReviews: z.array(ticketReviewSchema).optional()
    .superRefine((list, ctx) => {
      const seen = new Set();
      for (const { name } of list ?? []) {
        if (seen.has(name)) ctx.addIssue({ code: 'custom', message: `two ticket reviews are named "${name}": a name is unique in the list` });
        seen.add(name);
      }
    })
    .meta({ description: 'The ticket reviews governor runs, in file order, each with its `name`, its selector `when`, the labels each of its `conclusions` adds, and optionally its own `checklist` and checks and labels per ticket type (`types`). Each comments on a ticket it selects whether it passes, waits for an edit, or waits for a person, and applies that conclusion\'s labels. At least one when the `ticketReviews` switch is on.' }),
}).refine((c) => c.features.prReview !== true || c.review !== undefined, { message: 'prReview is on, so the file needs a review section with its checklist', path: ['review'] })
  .refine((c) => c.features.heartbeat !== true || c.heartbeat !== undefined, { message: 'heartbeat is on, so the file needs a heartbeat section naming its issue', path: ['heartbeat'] })
  .refine((c) => c.features.periodics !== true || c.periodics.length > 0, { message: 'periodics is on, so the file lists at least one periodic', path: ['periodics'] })
  .refine((c) => c.features.hooks !== true || c.hooks.length > 0, { message: 'hooks is on, so the file lists at least one hook', path: ['hooks'] })
  .refine((c) => c.features.ticketReviews !== true || (c.ticketReviews?.length ?? 0) > 0, { message: 'ticketReviews is on, so the file lists at least one ticket review', path: ['ticketReviews'] })
  // A conclusion's labels, in the review's `conclusions` and in each of its
  // `types` entries: each under one conclusion of one review, so no run
  // removes a label another conclusion or review just added; none that a
  // `types` entry matches on, so no run changes a ticket's type; and none
  // that readies a ticket on a review governor runs for an author outside
  // trust.auto: a stranger's text would set work going by itself. The
  // authors a review runs for are its `by` narrowed by trust.review, since
  // it reads no other ticket. None that the review's own `when` selects
  // on: a failure label it excludes stops it reading the filer's fix. And
  // never the claim label, which would come off a ticket being built.
  // Each starts with the review's name, a colon and a space, so a run never adds or
  // removes a label a person also uses, such as a mode: human hold.
  .superRefine((c, ctx) => {
    /** @type {Map<string, string>} Each label, lower-cased as GitHub matches it, and the review that names it. */
    const owner = new Map();
    const auto = autoOf(c);
    const review = reviewOf(c);
    const claimKey = c.labels.claim.toLowerCase();
    const readyKeys = new Set(c.labels.ready.map((l) => l.toLowerCase()));
    /** @type {Map<string, string>} Each label a `types` entry matches on, lower-cased, and the review whose entry names it. */
    const typeKeys = new Map();
    for (const { name, types } of c.ticketReviews ?? []) {
      for (const entry of types ?? []) for (const l of entry.labels) if (!typeKeys.has(l.toLowerCase())) typeKeys.set(l.toLowerCase(), name);
    }
    (c.ticketReviews ?? []).forEach(({ name, when, conclusions, types }, i) => {
      /** @type {Array<{ path: Array<string | number>, sets: Partial<Record<string, string[]>> }>} The default's labels, then each entry's. */
      const places = [
        { path: ['ticketReviews', i, 'conclusions'], sets: conclusions },
        ...(types ?? []).map((entry, j) => ({ path: ['ticketReviews', i, 'types', j, 'conclusions'], sets: entry.conclusions ?? {} })),
      ];
      /** Every conclusion label starts with this, in any case. Names are lower-case, so one review's prefix is never another's. */
      const prefix = `${name}: `;
      /** @type {Map<string, string>} Each label, lower-cased as GitHub matches it, and the conclusion of this review that names it. */
      const under = new Map();
      /** @type {Map<string, Array<string | number>>} Each ready label this review names, as written, and where it is first named. */
      const ready = new Map();
      /** @type {Map<string, string>} Each label the review's `when` names, lower-cased, and the key that names it. */
      const selects = new Map();
      for (const l of when.exclude ?? []) selects.set(l.toLowerCase(), 'when.exclude');
      for (const l of when.labels ?? []) selects.set(l.toLowerCase(), 'when.labels');
      for (const { path: at, sets } of places) {
        for (const conclusion of CONCLUSION_NAMES) {
          for (const l of sets[conclusion] ?? []) {
            const path = [...at, conclusion];
            const key = l.toLowerCase();
            if (!key.startsWith(prefix)) ctx.addIssue({ code: 'custom', path, message: `the ${name} review names "${l}" under ${conclusion}, which does not start with "${prefix}": a review adds and removes only labels of its own, so it never changes a label a person steers work with. Give the conclusion a label starting "${prefix}"` });
            const first = under.get(key);
            if (first !== undefined && first !== conclusion) ctx.addIssue({ code: 'custom', path, message: `the ${name} review names "${l}" under both ${first} and ${conclusion}: each run would add it and take it off. Name it under one conclusion` });
            else if (first === undefined) under.set(key, conclusion);
            const other = owner.get(key);
            if (other !== undefined && other !== name) ctx.addIssue({ code: 'custom', path, message: `the ${other} and ${name} reviews both name "${l}" in their conclusions: one review's run would take off a label the other added. Give each review labels of its own` });
            else if (other === undefined) owner.set(key, name);
            const typed = typeKeys.get(key);
            if (typed !== undefined) ctx.addIssue({ code: 'custom', path, message: `the ${name} review names "${l}" under ${conclusion}, and a types entry of the ${typed} review matches on it: applying it would change the ticket's type. Give the conclusion a label no types entry matches on` });
            // The claim label belongs in when.exclude, so the claim fault stands alone.
            const selector = selects.get(key);
            if (key === claimKey) ctx.addIssue({ code: 'custom', path, message: `the ${name} review names "${l}" under ${conclusion}, and it is labels.claim: a run would add or take the claim off a ticket. Give the conclusion a label of its own` });
            else if (selector !== undefined) ctx.addIssue({ code: 'custom', path, message: `the ${name} review names "${l}" under ${conclusion}, and its own ${selector} names it too: applying it would change whether the review runs on the ticket again. Give the conclusion a label the review does not select on` });
            if (readyKeys.has(key) && !ready.has(l)) ready.set(l, at);
          }
        }
      }
      const beyond = (when.by ?? TICKET_REVIEW_BY).filter((a) => review.includes(a) && !auto.includes(a));
      if (beyond.length === 0) return;
      for (const [l, path] of ready) {
        ctx.addIssue({ code: 'custom', path, message: `the ${name} review names the ready label "${l}", and its by, within trust.review, lets in ${beyond.join(', ')}, which trust.auto does not: a ticket from them could be readied with no person choosing it. Narrow the review's by to trust.auto, or give it labels that ready nothing` });
      }
    });
  })
  // pickup.by is retired and read as trust.task, so a file may set one.
  .refine((c) => c.pickup?.by === undefined || c.trust?.task === undefined, { message: 'sets both pickup.by and trust.task: pickup.by is the older name of trust.task, so keep trust.task and remove pickup.by', path: ['pickup', 'by'] })
  // The chain auto ⊆ task ⊆ relay ⊆ review, for each two lists the file sets, BOT
  // left aside. pickup.by, where the file sets it, is the task list. A list
  // the file leaves unset is narrowed instead (dispatch/trust.mjs).
  .superRefine((c, ctx) => {
    const auto = c.trust?.auto;
    const task = taskSet(c);
    const taskKey = taskKeyOf(c);
    const taskPath = taskKey.split('.');
    const relay = c.trust?.relay;
    /** @param {readonly string[] | undefined} inner @param {readonly string[] | undefined} outer */
    const outside = (inner, outer) => (inner === undefined || outer === undefined ? [] : inner.filter((a) => a !== BOT && !outer.includes(a)));
    const autoTask = outside(auto, task);
    if (autoTask.length > 0) ctx.addIssue({ code: 'custom', path: ['trust', 'auto'], message: `names ${autoTask.join(', ')}, which ${taskKey} does not: governor would set going by itself a ticket pickup may not start. Narrow trust.auto, or widen ${taskKey}` });
    const autoRelay = outside(auto, relay);
    if (autoRelay.length > 0) ctx.addIssue({ code: 'custom', path: ['trust', 'auto'], message: `names ${autoRelay.join(', ')}, which trust.relay does not: governor would set work going on a ticket whose comments could not reach its session. Narrow trust.auto, or widen trust.relay` });
    const taskRelay = outside(task, relay);
    if (taskRelay.length > 0) ctx.addIssue({ code: 'custom', path: taskPath, message: `names ${taskRelay.join(', ')}, which trust.relay does not: pickup would start a ticket whose author's comments could not reach its session. Narrow ${taskKey}, or widen trust.relay` });
    const review = c.trust?.review;
    const relayReview = outside(relay, review);
    if (relayReview.length > 0) ctx.addIssue({ code: 'custom', path: ['trust', 'relay'], message: `names ${relayReview.join(', ')}, which trust.review does not: their comments would reach a session whose pull request the PR review may not read. Narrow trust.relay, or widen trust.review` });
    const taskReview = outside(task, review);
    if (taskReview.length > 0) ctx.addIssue({ code: 'custom', path: taskPath, message: `names ${taskReview.join(', ')}, which trust.review does not: pickup would start work whose pull request the PR review may not read. Narrow ${taskKey}, or widen trust.review` });
    const autoReview = outside(auto, review);
    if (autoReview.length > 0) ctx.addIssue({ code: 'custom', path: ['trust', 'auto'], message: `names ${autoReview.join(', ')}, which trust.review does not: governor would set work going whose pull request the PR review may not read. Narrow trust.auto, or widen trust.review` });
  });

/**
 * @typedef {{ ci?: string, triage: string[], tags: Record<string, string> }} Workflows
 *   `ci`: the CI workflow's file; without it, no run is CI. `triage`: the
 *   targets whose failure gets one fresh session. `tags`: each target's tag.
 * @typedef {{ labels: string[], unless: string[] }} TicketRule
 * @typedef {{ glob: string, reason: string, unless: string[] }} HumanOnly
 * @typedef {string | { name: string, app: string }} RequiredCheck A required check: a name any App or status may post, or a name and the slug of the App that must post it.
 * @typedef {{
 *   checklist: string,
 *   humanOnly: HumanOnly[],
 *   tickets: { require: TicketRule[], forbid: TicketRule[] },
 *   quote: string[],
 *   decides: string[],
 *   dependabot: string[],
 *   requireChecks: RequiredCheck[],
 *   waitForCi: boolean,
 *   merge: boolean,
 * }} Review The PR review's settings, its checklist read.
 * @typedef {{ file: string }} PromptFile
 * @typedef {{ issue: number, marker?: string }} Heartbeat
 * @typedef {{ sweepHours?: number, by?: string[] }} Pickup
 * @typedef {{ start?: string[], auto?: string[], task?: string[], relay?: string[], review?: string[] }} Trust
 * @typedef {{ name: string, prompt: string, days: number, counts?: Partial<Record<import('./webhook/fire.mjs').Count, number>>, gapHours?: number, connectors?: string[] }} Periodic A recurring session, its prompt read.
 * @typedef {{ name: string, prompt: string, keyVersion: number, perHour?: number }} Hook A hook an outside system fires, its prompt read.
 * @typedef {{ success: string[], failure: string[], neutral: string[] }} Conclusions The labels each conclusion of a ticket review adds.
 * @typedef {{ labels: string[], checklist?: string, conclusions?: Partial<Conclusions> }} TicketType One `types` entry of a ticket review, its checklist read.
 * @typedef {{ name: string, when: { on: 'opened', labels?: string[], exclude?: string[], by?: string[] }, conclusions: Conclusions, checklist?: string, types?: TicketType[] }} TicketReview
 *   One ticket review, its selector, its conclusions' labels, and its
 *   checklists read.
 * @typedef {{ environment: string, labels: { ready: string[], claim: string, claimRemoves: string[], exclude: string[] }, features: Record<string, boolean | undefined>, prompts: Record<string, string | undefined>, workflows: Workflows, review?: Review, heartbeat?: Heartbeat, waits?: { issue: number }, pickup?: Pickup, trust?: Trust, periodics: Periodic[], hooks: Hook[], ticketReviews?: TicketReview[] }} RepoConfig
 *   `labels.ready`: every label a ready ticket carries. `labels.claim`: the
 *   label the dispatcher claims a ticket with. `labels.claimRemoves`: the
 *   ready labels the claim takes off, and a failed launch puts back.
 *   `labels.exclude`: the labels that keep a ticket out; `type: prd`
 *   when the file names none.
 *   `prompts`: the repo's instruction for each message kind it replaces.
 *   `workflows`: what the repo's workflows are to the dispatcher.
 *   `review`: the PR review's settings, where the file has them.
 *   `heartbeat`: the issue governor's heartbeat goes into, and the repo's
 *   marker in the old shape.
 *   `waits`: the wait ticket waiting tickets are linked to, where the file
 *   names one.
 *   `pickup`: pickup's sweep interval and whose tickets it starts, where the
 *   file sets them.
 *   `trust`: whose GitHub text governor acts on, where the file sets it.
 *   `periodics`: the recurring sessions the schedule fire starts.
 *   `hooks`: the hooks an outside system fires.
 *   `ticketReviews`: the ticket reviews, where the file lists them.
 * @typedef {Omit<TicketReview, 'checklist' | 'types'> & { checklist?: string | PromptFile, types?: Array<Omit<TicketType, 'checklist'> & { checklist?: string | PromptFile }> }} FileTicketReview
 *   A ticket review as the file holds it, before its checklist files are read.
 * @typedef {Omit<RepoConfig, 'prompts' | 'review' | 'periodics' | 'hooks' | 'ticketReviews'> & { prompts: Record<string, string | PromptFile | undefined>, review?: Omit<Review, 'checklist'> & { checklist: string | PromptFile }, periodics: Array<Omit<Periodic, 'prompt'> & { prompt: string | PromptFile }>, hooks: Array<Omit<Hook, 'prompt'> & { prompt: string | PromptFile }>, ticketReviews?: FileTicketReview[] }} FileConfig
 *   The file as read, before {@link resolveFiles} reads the prompt files it names.
 */

/**
 * A config file's text, read: the config, or the fault that keeps the repo
 * unserved. The schema is every repo's, so the repo does not enter.
 *
 * @param {string} text
 * @returns {{ ok: true, config: FileConfig } | { ok: false, fault: string }}
 */
export const readConfig = (text) => {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, fault: `not JSON: ${/** @type {Error} */ (error).message}` };
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, fault: result.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; ') };
  }
  // `$schema` is for the editor, and governor does nothing with it.
  const { $schema: _editor, ...config } = result.data;
  return { ok: true, config: /** @type {FileConfig} */ (config) };
};

/**
 * A prompt file's text without a skill's frontmatter, which is the CLI's
 * metadata and nothing the model is to follow: a repo may point its
 * checklist at the skill its sessions run by hand.
 *
 * @param {string} text
 */
export const withoutFrontmatter = (text) => text.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();

/**
 * The config with every prompt file it names read, through `read` (a path's
 * text on the default branch, null when GitHub says it is not there; any
 * other failure throws, and is never a missing file). A file that is
 * missing or empty, or a prompt naming a fact its kind lacks, is the fault
 * that keeps the repo unserved, naming the key and the path.
 *
 * @param {FileConfig} config
 * @param {(path: string) => Promise<string | null>} read
 * @returns {Promise<{ ok: true, config: RepoConfig } | { ok: false, fault: string }>}
 */
export const resolveFiles = async (config, read) => {
  /** @type {Map<string, Promise<string | null>>} */
  const reads = new Map();
  /** @param {string} path */
  const once = (path) => {
    let text = reads.get(path);
    if (text === undefined) reads.set(path, text = read(path));
    return text;
  };
  /**
   * @param {string} key
   * @param {string | PromptFile} value
   * @returns {Promise<{ text: string } | { fault: string }>}
   */
  const textOf = async (key, value) => {
    if (typeof value === 'string') return { text: value };
    const text = await once(value.file);
    if (text === null) return { fault: `${key}: ${value.file} is not on the default branch` };
    const body = withoutFrontmatter(text);
    return body === '' ? { fault: `${key}: ${value.file} is empty` } : { text: body };
  };
  /** @type {Record<string, string | undefined>} */
  const prompts = {};
  /** @type {string[]} */
  const faults = [];
  const entries = Object.entries(config.prompts).filter(/** @returns {e is [string, string | PromptFile]} */ (e) => e[1] !== undefined);
  /**
   * A value that may be unset: unset reads as unset.
   *
   * @param {string} key
   * @param {string | PromptFile | undefined} value
   * @returns {Promise<{ text?: string } | { fault: string }>}
   */
  const optionalTextOf = async (key, value) => (value === undefined ? {} : textOf(key, value));
  const [texts, checklist, periodicTexts, hookTexts, ticketTexts] = await Promise.all([
    Promise.all(entries.map(([kind, value]) => textOf(`prompts.${kind}`, value))),
    config.review === undefined ? null : textOf('review.checklist', config.review.checklist),
    Promise.all(config.periodics.map((p) => textOf(`periodics.${p.name}.prompt`, p.prompt))),
    Promise.all(config.hooks.map((h) => textOf(`hooks.${h.name}.prompt`, h.prompt))),
    Promise.all((config.ticketReviews ?? []).map((r) => Promise.all([
      optionalTextOf(`ticketReviews.${r.name}.checklist`, r.checklist),
      Promise.all((r.types ?? []).map((t, i) => optionalTextOf(`ticketReviews.${r.name}.types.${i}.checklist`, t.checklist))),
    ]))),
  ]);
  entries.forEach(([kind], i) => {
    const got = /** @type {{ text: string } | { fault: string }} */ (texts[i]);
    if ('fault' in got) { faults.push(got.fault); return; }
    const fault = fillsFault(kind, got.text);
    if (fault === null) prompts[kind] = got.text;
    else faults.push(`prompts.${kind}: ${fault}`);
  });
  if (checklist !== null && 'fault' in checklist) faults.push(checklist.fault);
  /** @type {Periodic[]} */
  const periodics = [];
  config.periodics.forEach((p, i) => {
    const got = /** @type {{ text: string } | { fault: string }} */ (periodicTexts[i]);
    if ('fault' in got) faults.push(got.fault);
    else periodics.push({ ...p, prompt: got.text });
  });
  /** @type {Hook[]} */
  const hooks = [];
  config.hooks.forEach((h, i) => {
    const got = /** @type {{ text: string } | { fault: string }} */ (hookTexts[i]);
    if ('fault' in got) faults.push(got.fault);
    else hooks.push({ ...h, prompt: got.text });
  });
  /** @type {TicketReview[]} */
  const ticketReviews = [];
  (config.ticketReviews ?? []).forEach((r, i) => {
    const [base, typeTexts] = /** @type {[{ text?: string } | { fault: string }, Array<{ text?: string } | { fault: string }>]} */ (ticketTexts[i]);
    /** @type {(got: { text?: string } | { fault: string }) => string | undefined} */
    const textIn = (got) => {
      if ('fault' in got) { faults.push(got.fault); return undefined; }
      return got.text;
    };
    const { checklist: _base, types, ...kept } = r;
    const text = textIn(base);
    const typed = types?.map((t, j) => {
      const { checklist: _entry, ...entry } = t;
      const entryText = textIn(/** @type {{ text?: string } | { fault: string }} */ (typeTexts[j]));
      return entryText === undefined ? entry : { ...entry, checklist: entryText };
    });
    ticketReviews.push({ ...kept, ...(text === undefined ? {} : { checklist: text }), ...(typed === undefined ? {} : { types: typed }) });
  });
  if (faults.length > 0) return { ok: false, fault: faults.join('; ') };
  const review = config.review === undefined || checklist === null || 'fault' in checklist ? undefined : { ...config.review, checklist: checklist.text };
  const { review: _file, ticketReviews: _reviews, ...rest } = config;
  return { ok: true, config: { ...rest, prompts, periodics, hooks, ...(review === undefined ? {} : { review }), ...(config.ticketReviews === undefined ? {} : { ticketReviews }) } };
};

/** A cloud environment ID: anything else in `environment` is a name. */
const ENVIRONMENT_ID = /^env_[A-Za-z0-9]+$/;

/** Whether a file's `environment` names its environment rather than giving its ID. */
export const namesEnvironment = (/** @type {string} */ environment) => !ENVIRONMENT_ID.test(environment);

const environmentList = z.object({
  environments: z.array(z.object({ environment_id: z.string().regex(ENVIRONMENT_ID), name: z.string() })),
});

/**
 * A file's `environment` as an ID: an ID as it is, a name as the ID of the
 * one environment in the login's list (`GET /v1/environment_providers`,
 * which `/remote-env` lists) of that name. No match, or more than one, is
 * the fault that keeps the repo unserved. A list not in that shape throws:
 * a failed read, never no match.
 *
 * @param {string} environment
 * @param {unknown} listed The environment list's answer, parsed.
 * @returns {{ id: string } | { fault: string }}
 */
export const environmentFrom = (environment, listed) => {
  if (!namesEnvironment(environment)) return { id: environment };
  const read = environmentList.safeParse(listed);
  if (!read.success) throw new Error(`the login's environment list is not in the shape the CLI reads: ${read.error.issues[0]?.message ?? ''}`);
  const matches = read.data.environments.filter((e) => e.name === environment);
  if (matches.length === 1) return { id: /** @type {{ environment_id: string }} */ (matches[0]).environment_id };
  return { fault: matches.length === 0 ? `no cloud environment is named "${environment}"` : `${matches.length} cloud environments are named "${environment}"` };
};

/**
 * Whether `config` turns `name` on.
 *
 * @param {RepoConfig} config
 * @param {string} name
 */
export const turnsOn = (config, name) => config.features[name] === true;
