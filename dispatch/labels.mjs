/**
 * What a workflow file declares about the deploy target it ships to:
 * the reader dispatch/coverage.mjs reads a run's file through.
 * The label write (dispatch/turn.mjs `ticketsOf`) and the messages
 * (dispatch/workflow.mjs) both consume what coverage makes of it.
 *
 * The label is the shipping job's to name: its name ends ` · deployed:
 * <target>` (`shippingJob` in webhook/fire.mjs), and the receiver fires on
 * the job. A deploy workflow's file declares one top-level `env:` entry no
 * job uses, `TICKET_LABEL_PATHS`: which tickets get the label: `all`, every
 * ticket the job shipped; `trigger`, the workflow's own `on.push.paths`; or
 * globs, one per line. A red run has no job to name its target, so its
 * target is read off the file's jobs ({@link shippingLabelsOf}): the last
 * shipping job's label, a `uses:` job's read from the file it calls. Both
 * are read from the file at the run's commit, so a run labels by the file
 * it ran.
 */

import yaml from 'js-yaml';
import { shippingJob } from './webhook/fire.mjs';

/**
 * @typedef {{ paths: 'all' | string[], merge: boolean }} TicketLabel `paths`: `trigger` already resolved to the push paths.
 *   `merge`: a merge to main starts the workflow (`on.push`, or `on.workflow_run` after CI), not only a hand.
 */

/** The file's YAML, or null when it is none the task can read. @param {string} text @returns {any} */
const parsed = (text) => {
  try {
    return yaml.load(text);
  } catch {
    return null;
  }
};

/**
 * Which tickets a workflow file's label goes to, and whether a merge starts
 * the workflow; null when it declares no `TICKET_LABEL_PATHS`, a `trigger`
 * with no push paths, or is no YAML the task can read. `TICKET_LABEL` and
 * `TICKET_LABEL_JOBS`, which a file may still carry, say nothing: the job's
 * name does.
 *
 * @param {string} text
 * @returns {TicketLabel | null}
 */
export const ticketLabelOf = (text) => {
  const doc = parsed(text);
  const paths = doc?.env?.TICKET_LABEL_PATHS;
  if (typeof paths !== 'string' || paths.trim() === '') return null;
  const which = paths.trim();
  // `on` is a map of events, a list of them, or one event's name.
  const on = doc?.on;
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  const merge = events.includes('push') || events.includes('workflow_run');
  /** @type {'all' | string[]} */
  let picked;
  if (which === 'all') picked = 'all';
  else if (which === 'trigger') {
    const push = doc?.on?.push?.paths;
    if (!Array.isArray(push) || push.length === 0 || !push.every((p) => typeof p === 'string')) return null;
    picked = push;
  } else picked = lines(which);
  return { paths: picked, merge };
};

/** The `${{ … }}` expression that ends a job name, and a single-quoted string literal in one. */
const LAST_EXPRESSION = /\$\{\{((?:(?!\}\})[\s\S])*)\}\}$/;
const LITERAL = /'((?:[^']|'')*)'/g;

/** A reusable workflow a job calls, as `uses: ./.github/workflows/<file>` names it. */
const USES = /^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/;

/**
 * The labels a workflow file's shipping jobs earn, in job order: each job's `name:`, or for a job that `uses:` a reusable workflow
 * in the repository, each job's `name:` in that file with the caller's
 * `with:` values put in for `${{ inputs.<k> }}` (that expression alone; any
 * other is left as it is, and a label still carrying one is no label). A
 * red run's target is the last of these. `fetchUses` reads the called
 * file by its name; a read that fails throws, since a list read short
 * would name the wrong stage.
 *
 * @param {string} text
 * @param {(file: string) => Promise<string>} fetchUses
 * @returns {Promise<string[]>}
 */
export const shippingLabelsOf = async (text, fetchUses) => {
  const doc = parsed(text);
  const jobs = doc?.jobs && typeof doc.jobs === 'object' ? Object.values(doc.jobs) : [];
  /** @type {string[]} */
  const labels = [];
  /** @type {Map<string, Promise<string>>} */
  const fetched = new Map();
  /** @param {unknown} name */
  const marked = (name) => {
    if (typeof name !== 'string') return;
    // The expression that ends the name may carry the marker inside a string
    // literal (`… || format('… · deployed: <target>', …)`): read its literals
    // too. One with text after it does not end the run's name, so its marker
    // is not the run's.
    const last = LAST_EXPRESSION.exec(name);
    const literals = last === null ? [] : [...String(last[1]).matchAll(LITERAL)].map((m) => String(m[1]).replaceAll("''", "'"));
    for (const text of [name, ...literals]) {
      const found = shippingJob(text);
      // `${{ … }}` left unresolved, an expression's tail (`', github.sha) }}`)
      // or a format() placeholder (`{1}`) names no target.
      if (found !== null && !found.label.includes('${{') && !found.label.includes('}}') && !/\{\d+\}/.test(found.label)) labels.push(found.label);
    }
  };
  for (const job of /** @type {any[]} */ (jobs)) {
    const file = typeof job?.uses === 'string' ? USES.exec(job.uses)?.[1] : undefined;
    if (file === undefined) {
      marked(job?.name);
      continue;
    }
    const inputs = job?.with && typeof job.with === 'object' ? job.with : {};
    // One read per called file: a delivery workflow may call one stage's file twice.
    if (!fetched.has(file)) fetched.set(file, fetchUses(file));
    const called = parsed(await /** @type {Promise<string>} */ (fetched.get(file)));
    for (const inner of /** @type {any[]} */ (called?.jobs && typeof called.jobs === 'object' ? Object.values(called.jobs) : [])) {
      if (typeof inner?.name !== 'string') continue;
      marked(inner.name.replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (/** @type {string} */ whole, /** @type {string} */ key) => (inputs[key] === undefined ? whole : String(inputs[key]))));
    }
  }
  return labels;
};

/** A block's non-blank lines, trimmed. @param {string} text */
const lines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

/**
 * Whether `path` matches `glob` as a workflow's `paths` filter reads it:
 * `**` crosses directories (and, before a slash, may match none), `*`
 * stays within one, the rest is literal. Not checklist.mjs's `globMatches`,
 * which reads the human-only list's grammar (`?`, basename-only globs).
 *
 * @param {string} glob
 * @param {string} path
 */
export const globMatches = (glob, path) => {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = /** @type {string} */ (glob[i]);
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      pattern += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i += 1;
    } else if (c === '*') {
      pattern += '[^/]*';
    } else {
      pattern += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`).test(path);
};

/**
 * Whether `path` matches a workflow's `paths` list: the last pattern it
 * matches decides, and one starting `!` excludes.
 *
 * @param {string[]} globs
 * @param {string} path
 */
export const pathsMatch = (globs, path) => globs.reduce((matched, glob) => (
  glob.startsWith('!') ? (globMatches(glob.slice(1), path) ? false : matched) : (matched || globMatches(glob, path))
), false);
