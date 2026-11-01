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
 * periodic's `prompt` and each hook's, is the
 * text or `{ "file": "<path>" }`, a file in the repo read from the default
 * branch beside the config file ({@link resolveFiles}).
 *
 * The schema is {@link configSchema}; {@link readConfig} reads a file's text
 * against it for one repo, {@link resolveFiles} reads the prompt files it
 * names, and {@link environmentFrom} turns a name into its ID from the
 * login's environment list.
 */

import { z } from 'zod';
import { COUNTS, HOOK_NAME, HOOK_PER_HOUR_MAX, WORKFLOW_PATH } from './webhook/fire.mjs';
import { PROMPTS, RETIRED_PROMPTS, unknownFills } from './prompts.mjs';

/** Where the file lives, on the repo's default branch. */
export const CONFIG_PATH = '.github/dispatch.json';

/**
 * The switches any served repo may turn on: pickup, summons, PR and
 * subscribe messages, the red scheduled run, what a blocker's close does to
 * a ticket that is not ready to pick up (`unblocked`, dispatch/unblocked.mjs), CI and
 * deploy messages, branch-run messages, the conflicts check,
 * deployed-label job fires, the PR review, the heartbeat, periodics and
 * hooks. Every switch there is.
 */
export const GENERIC_SWITCHES = Object.freeze([
  'pickup', 'summons', 'prMessages', 'subscribeMessages', 'redScheduledRun', 'unblocked',
  'ciMessages', 'deployMessages', 'branchRunMessages', 'conflicts', 'deployedLabels', 'prReview',
  'heartbeat', 'periodics', 'hooks',
]);

/**
 * Switches a served file may still set, each read as the switch that took
 * its work over: the schema is strict, and a file the change made invalid
 * would stop its repo being served. The merge hand-off's work is
 * `unblocked`'s; a file setting both reads `unblocked`.
 */
export const RETIRED_SWITCHES = Object.freeze({ mergeHandoff: 'unblocked' });

/**
 * The `features` section: every generic switch, and the retired ones read
 * as theirs.
 */
const featuresSchema = z.strictObject({
  ...Object.fromEntries(GENERIC_SWITCHES.map((name) => [name, z.boolean().optional()])),
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
const promptFile = z.strictObject({ file: repoPath });

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
]);

// A glob a review list matches changed paths with (dispatch/checklist.mjs's `globMatches`).
const glob = z.string().trim().min(1);

/**
 * A ticket rule: `labels`, the labels it is about; `unless`, the labels that
 * waive it. Under `require`, a ticket carries one of `labels`; under
 * `forbid`, none; either unless it carries one of `unless`.
 */
const ticketRule = z.strictObject({ labels: z.array(label).min(1), unless: z.array(label).default([]) });

/**
 * The PR review's settings: `checklist`, the model's prompt;
 * `humanOnly`, the globs a PR may not change without a person, each with
 * its reason and the labels that waive it when every ticket the PR closes
 * carries one; `tickets`, the label rules each ticket the PR closes meets;
 * `quote`, the globs of changed files the model reads whole (a `!` entry
 * takes a path back out); `decides`, the labels of a ticket whose body's
 * first line, `Constraint now lives at <path>, …`, decides the quoted files
 * it names, so they pass unread; `dependabot`, the manifests a Dependabot PR may
 * change; `merge`, whether a pass merges. Settings, never code: a check
 * they cannot express is the repo's CI, read as a required status check.
 */
const reviewSchema = z.strictObject({
  checklist: z.union([z.string().trim().min(1), promptFile]),
  humanOnly: z.array(z.strictObject({ glob, reason: z.string().trim().min(1), unless: z.array(label).default([]) })).default([]),
  tickets: z.strictObject({ require: z.array(ticketRule).default([]), forbid: z.array(ticketRule).default([]) }).default({ require: [], forbid: [] }),
  quote: z.array(z.string().trim().regex(/^!?[^!\s]/, 'a glob, or `!` and a glob')).default([]),
  decides: z.array(label).default([]),
  dependabot: z.array(glob).default([]),
  merge: z.boolean().default(true),
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
  ci: z.string().regex(WORKFLOW_PATH, 'a workflow file under .github/workflows/').optional(),
  triage: z.array(target).default([]),
  tags: z.record(target, z.string().trim().min(1).regex(/^[\w./-]+$/, 'a tag name')).default({}),
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
  issue: z.number().int().positive(),
  marker: z.string().trim().regex(/^<!--[^\n]*-->$/, 'an HTML comment on one line, `<!-- … -->`').optional(),
});

/**
 * Pickup's settings (dispatch/pickup.mjs). `sweepHours`: how many whole
 * hours the bare schedule fire leaves between two sweeps of the repo's ready
 * tickets, two when unset.
 */
const pickupSchema = z.strictObject({
  sweepHours: z.number().int().min(1).optional(),
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

const periodicSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).regex(/^[^\n]*$/, 'a name is one line'),
  prompt: z.union([z.string().trim().min(1), promptFile]),
  days: z.number().int().min(1),
  counts: z.strictObject(Object.fromEntries(COUNTS.map((kind) => [kind, z.number().int().min(1).optional()])))
    .refine((c) => Object.values(c).some((n) => n !== undefined), 'counts names at least one of merges, issuesOpened and issuesClosed')
    .optional(),
  gapHours: z.number().int().min(1).optional(),
  connectors: z.array(z.string().regex(CONNECTOR_NAME, 'a connector name is letters, digits, hyphens and underscores'))
    .min(1, 'connectors names at least one connector, or is left out')
    .refine((names) => new Set(names).size === names.length, 'connectors names each connector once')
    .optional(),
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
  name: z.string().regex(HOOK_NAME, 'lower-case letters, digits and hyphens, safe in a URL path'),
  prompt: z.union([z.string().trim().min(1), promptFile]),
  // At most nine digits, as a request's `v=` and scripts/hook-key.mjs take:
  // a larger version could never be signed.
  keyVersion: z.number().int().positive().max(999_999_999),
  // An hour's count item holds each signature it counted: a larger cap
  // could outgrow the item.
  perHour: z.number().int().positive().max(HOOK_PER_HOUR_MAX).optional(),
});

/**
 * The file's schema. It is the same in every repo: no switch is any one
 * repo's.
 */
export const configSchema = z.strictObject({
  environment: z.string().trim().min(1, 'a cloud environment name, or its ID (env_…)'),
  labels: z.strictObject({
    ready: z.array(label).min(1),
    claim: label,
    claimRemoves: z.array(label).default([]),
    exclude: z.array(label).default(['type: prd']),
  }).refine((l) => !l.ready.includes(l.claim), 'the claim label cannot be a ready label')
    .refine((l) => l.claimRemoves.every((r) => l.ready.includes(r)), 'claimRemoves names only ready labels')
    // A ready ticket carries every ready label, so excluding one would
    // keep every ticket out.
    .refine((l) => !l.exclude.some((e) => l.ready.includes(e)), 'exclude cannot name a ready label'),
  features: featuresSchema,
  // A retired prompt is still valid, and dropped unread: governor sends
  // no message of its kind, so its file is never read.
  prompts: z.strictObject({
    ...Object.fromEntries(Object.keys(PROMPTS).map((kind) => [kind, prompt(kind).optional()])),
    ...Object.fromEntries(RETIRED_PROMPTS.map((kind) => [kind, z.union([z.string(), promptFile]).optional().meta({ deprecated: true, description: 'Retired: governor sends no message of this kind, so it is never read.' })])),
  }).transform((prompts) => Object.fromEntries(Object.entries(prompts).filter(([kind]) => !RETIRED_PROMPTS.includes(kind)))).default({}),
  workflows: workflowsSchema,
  review: reviewSchema.optional(),
  heartbeat: heartbeatSchema.optional(),
  pickup: pickupSchema.optional(),
  periodics: z.array(periodicSchema).default([])
    .superRefine((list, ctx) => {
      const seen = new Set();
      for (const { name } of list) {
        if (seen.has(name)) ctx.addIssue({ code: 'custom', message: `two periodics are named "${name}": a name is unique in the file` });
        seen.add(name);
      }
    }),
  hooks: z.array(hookSchema).default([])
    .superRefine((list, ctx) => {
      const seen = new Set();
      for (const { name } of list) {
        if (seen.has(name)) ctx.addIssue({ code: 'custom', message: `two hooks are named "${name}": a name is unique in the file` });
        seen.add(name);
      }
    }),
}).refine((c) => c.features.prReview !== true || c.review !== undefined, { message: 'prReview is on, so the file needs a review section with its checklist', path: ['review'] })
  .refine((c) => c.features.heartbeat !== true || c.heartbeat !== undefined, { message: 'heartbeat is on, so the file needs a heartbeat section naming its issue', path: ['heartbeat'] })
  .refine((c) => c.features.periodics !== true || c.periodics.length > 0, { message: 'periodics is on, so the file lists at least one periodic', path: ['periodics'] })
  .refine((c) => c.features.hooks !== true || c.hooks.length > 0, { message: 'hooks is on, so the file lists at least one hook', path: ['hooks'] });

/**
 * @typedef {{ ci?: string, triage: string[], tags: Record<string, string> }} Workflows
 *   `ci`: the CI workflow's file; without it, no run is CI. `triage`: the
 *   targets whose failure gets one fresh session. `tags`: each target's tag.
 * @typedef {{ labels: string[], unless: string[] }} TicketRule
 * @typedef {{ glob: string, reason: string, unless: string[] }} HumanOnly
 * @typedef {{
 *   checklist: string,
 *   humanOnly: HumanOnly[],
 *   tickets: { require: TicketRule[], forbid: TicketRule[] },
 *   quote: string[],
 *   decides: string[],
 *   dependabot: string[],
 *   merge: boolean,
 * }} Review The PR review's settings, its checklist read.
 * @typedef {{ file: string }} PromptFile
 * @typedef {{ issue: number, marker?: string }} Heartbeat
 * @typedef {{ sweepHours?: number }} Pickup
 * @typedef {{ name: string, prompt: string, days: number, counts?: Partial<Record<import('./webhook/fire.mjs').Count, number>>, gapHours?: number, connectors?: string[] }} Periodic A recurring session, its prompt read.
 * @typedef {{ name: string, prompt: string, keyVersion: number, perHour?: number }} Hook A hook an outside system fires, its prompt read.
 * @typedef {{ environment: string, labels: { ready: string[], claim: string, claimRemoves: string[], exclude: string[] }, features: Record<string, boolean | undefined>, prompts: Record<string, string | undefined>, workflows: Workflows, review?: Review, heartbeat?: Heartbeat, pickup?: Pickup, periodics: Periodic[], hooks: Hook[] }} RepoConfig
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
 *   `pickup`: pickup's sweep interval, where the file sets one.
 *   `periodics`: the recurring sessions the schedule fire starts.
 *   `hooks`: the hooks an outside system fires.
 * @typedef {Omit<RepoConfig, 'prompts' | 'review' | 'periodics' | 'hooks'> & { prompts: Record<string, string | PromptFile | undefined>, review?: Omit<Review, 'checklist'> & { checklist: string | PromptFile }, periodics: Array<Omit<Periodic, 'prompt'> & { prompt: string | PromptFile }>, hooks: Array<Omit<Hook, 'prompt'> & { prompt: string | PromptFile }> }} FileConfig
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
  return { ok: true, config: /** @type {FileConfig} */ (result.data) };
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
  const [texts, checklist, periodicTexts, hookTexts] = await Promise.all([
    Promise.all(entries.map(([kind, value]) => textOf(`prompts.${kind}`, value))),
    config.review === undefined ? null : textOf('review.checklist', config.review.checklist),
    Promise.all(config.periodics.map((p) => textOf(`periodics.${p.name}.prompt`, p.prompt))),
    Promise.all(config.hooks.map((h) => textOf(`hooks.${h.name}.prompt`, h.prompt))),
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
  if (faults.length > 0) return { ok: false, fault: faults.join('; ') };
  const review = config.review === undefined || checklist === null || 'fault' in checklist ? undefined : { ...config.review, checklist: checklist.text };
  const { review: _file, ...rest } = config;
  return { ok: true, config: { ...rest, prompts, periodics, hooks, ...(review === undefined ? {} : { review }) } };
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
