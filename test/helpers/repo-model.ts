import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { makeCfnSchema, type Substitutions, type Template } from './cfn-schema.ts';

// ---------------------------------------------------------------------------
// The repo model: the one reader of the workflows and CloudFormation
// templates the tests assert on. It reads each file once, so every suite sees
// the same parse. It also holds the step locators the suites use to find a
// workflow step.
//
// Everything handed out is frozen: one parse is shared by every caller in a
// process, so a suite editing it would change what the next one reads.
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(import.meta.dirname, '../..');

// --- Shapes -----------------------------------------------------------------

export type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  id?: string;
  // A step whose job is to report cannot be what fails the run; GitHub spells
  // that `continue-on-error`, so a suite that asserts the distinction needs it.
  'continue-on-error'?: boolean;
  // js-yaml parses unquoted scalar env values (`FOO: 1`, `FOO: true`) as
  // number/boolean, so this is not string-only in general.
  env?: Record<string, string | number | boolean>;
  // An action step's inputs. Same scalar-typing caveat as `env`.
  with?: Record<string, string | number | boolean>;
};

/** Which steps a question is about. */
export type StepLocator = (step: WorkflowStep) => boolean;

export type ModelWorkflow = {
  file: string;
  path: string;
  /** The text as written. */
  raw: string;
  /**
   * The text without its comment lines, line-continuations joined first so a
   * flag split across lines still matches as one token. Assertions on shell
   * commands read this, not the header prose that names the strings under test.
   */
  codeOnly: string;
  doc: Record<string, any>;
};

// --- Step locators ----------------------------------------------------------

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A step's `run:` as {@link codeOnlyOf} reads a workflow: continuations
 *  joined, so a command split with `\` matches whole, and comment lines
 *  dropped, since a commented-out call runs nothing. */
const runCode = (step: WorkflowStep): string => codeOnlyOf(step.run ?? '');

/** A step whose `run:` invokes the script file `name` (`run-turn.mjs`, `scripts/x.sh`). */
export const runsScript = (name: string): StepLocator => {
  const pattern = new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w.-])`);
  return (step) => pattern.test(runCode(step));
};

/** A step that uses `action`, at any ref. */
export const usesAction = (action: string): StepLocator =>
  (step) => step.uses === action || (step.uses ?? '').startsWith(`${action}@`);

/** A step with `id: <id>`. */
export const withId = (id: string): StepLocator => (step) => step.id === id;

/**
 * A step whose `run:` carries `command`: a substring, or a pattern for one that
 * varies (flags, a quoted path). For a script file, prefer `runsScript`, which
 * bounds the name.
 */
export const runsCommand = (command: string | RegExp): StepLocator => {
  if (typeof command === 'string') return (step) => runCode(step).includes(command);
  // A /g or /y pattern's `test` resumes from its lastIndex, so it would answer
  // differently for the same step on the next call.
  const pattern = new RegExp(command.source, command.flags.replace(/[gy]/g, ''));
  return (step) => pattern.test(runCode(step));
};

/**
 * A step whose `run:` applies the stack `name` with `aws cloudformation deploy`.
 * The name ends at a non-name character, so `governor` does not match an
 * applied `governor-bootstrap`.
 */
export const appliesStack = (name: string): StepLocator =>
  runsCommand(new RegExp(`cloudformation deploy\\b[^\\n]*--stack-name ${escapeRegExp(name)}(?![\\w-])`));

// --- The model --------------------------------------------------------------

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Comment-free view of a workflow: continuations joined, `#` lines dropped. */
const codeOnlyOf = (raw: string): string =>
  raw
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

export type RepoModel = {
  readonly root: string;
  /** A CloudFormation template under the root. */
  template(relativePath: string, substitutions?: Substitutions): Template;
  /** A workflow by file name. Throws when there is none. */
  workflow(file: string): ModelWorkflow;
};

export type RepoModelOptions = {
  /** Where the workflows live; `<root>/.github/workflows` by default. */
  workflowsDir?: string;
};

const models = new Map<string, RepoModel>();

/** The model of the tree at `root` — this repo by default. One per root and workflows dir. */
export function repoModel(root: string = REPO_ROOT, options: RepoModelOptions = {}): RepoModel {
  const workflowsDir = options.workflowsDir ?? resolve(root, '.github/workflows');
  const key = `${root}\0${workflowsDir}`;
  let model = models.get(key);
  if (!model) {
    model = buildModel(root, workflowsDir);
    models.set(key, model);
  }
  return model;
}

function buildModel(root: string, workflowsDir: string): RepoModel {
  const templateCache = new Map<string, Template>();
  const readTemplate = (relativePath: string, substitutions: Substitutions = {}): Template => {
    const key = `${relativePath}\0${JSON.stringify(substitutions)}`;
    if (!templateCache.has(key)) {
      const text = readFileSync(resolve(root, relativePath), 'utf-8');
      templateCache.set(key, deepFreeze(yaml.load(text, { schema: makeCfnSchema(substitutions) }) as Template));
    }
    return templateCache.get(key) as Template;
  };

  const workflowCache = new Map<string, ModelWorkflow>();
  const readWorkflow = (file: string): ModelWorkflow => {
    const cached = workflowCache.get(file);
    if (cached) return cached;
    const path = resolve(workflowsDir, file);
    if (!existsSync(path)) throw new Error(`no workflow ${file} under ${workflowsDir}`);
    const raw = readFileSync(path, 'utf-8');
    // Workflows carry no CFN tags; the plain schema is the one GitHub's YAML matches.
    const doc = (yaml.load(raw) ?? {}) as Record<string, any>;
    const model = deepFreeze({ file, path, raw, codeOnly: codeOnlyOf(raw), doc });
    workflowCache.set(file, model);
    return model;
  };

  return deepFreeze({ root, template: readTemplate, workflow: readWorkflow });
}
