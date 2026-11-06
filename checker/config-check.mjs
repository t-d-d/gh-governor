/**
 * The config check. It runs in a served repo, never in governor: governor
 * reads `.github/governor.json` from the default branch only, so a bad file
 * shows up only once it merges, when the repo goes unserved. The repo calls
 * the reusable workflow .github/workflows/config-check.yml on its pull
 * requests, pinned to a commit of this repo. That workflow fetches this repo
 * at the commit and runs this file on the caller's own token.
 *
 * It reads the pull request's head: the config file and every prompt file
 * the file names. It runs governor's own `readConfig` and `resolveFiles`
 * (dispatch/repo-config.mjs) over them, so there is no second schema to keep
 * in step, and fails with governor's fault text. It then warns, without
 * failing, on a file that is valid but cannot work: a ready label the repo
 * lacks, a `workflows.ci` file that is not there, a heartbeat issue without
 * its marker, a review glob that matches no path, an issue review whose
 * `by` the repo's `trust.review` lets none of in, and, where the file turns
 * `sessionRules` on, a `CLAUDE.md` (or the file `sessionRules.file` names)
 * without the current session rules block. Only governor can check
 * that `environment` resolves, because that needs the claude.ai login. It
 * warns too, in wording of its own, where a `trust` list reaches beyond
 * owners, members and collaborators, and notes each unset list governor
 * narrowed (dispatch/trust.mjs).
 *
 * It also fails an issue template that names a ready label
 * ({@link templateFaults}). Governor would read such a repo, so this is no
 * fault in the config file, but a template's `labels:` adds its labels
 * whoever opens the issue, and so readies every ticket of its kind before
 * anyone has read it.
 *
 * Governor itself still reads only the default branch
 * (docs/constraints/dispatcher-repos.md): this check reads the head inside
 * the served repo's own Actions run, and governor never sees what it reads.
 */

import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { globMatches } from '../dispatch/checklist.mjs';
import { HEARTBEAT_MARKER } from '../dispatch/heartbeat.mjs';
import { CONFIG_PATH, ISSUE_REVIEW_BY, OLD_CONFIG_PATH, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
import { SESSION_RULES_VERSION, blockIn, rulesFile } from '../dispatch/session-rules.mjs';
import { fitsInside, narrowedLists, reviewOf, trustExposures } from '../dispatch/trust.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

/**
 * @typedef {{
 *   read: (path: string) => Promise<string | null>,
 *   paths: () => Promise<{ paths: string[], truncated: boolean }>,
 *   labels: () => Promise<string[]>,
 *   issueBody: (issue: number) => Promise<string | null>,
 * }} Reads
 *   What the check reads of the served repo. `read`: a file's text at the
 *   pull request's head, null when it is not there; any other failure
 *   throws. `paths`: every file at the head, and whether GitHub cut the
 *   list short. `labels`: the repo's label names. `issueBody`: an issue's
 *   body, null when there is no such issue.
 * @typedef {{ file: string, fault: string }} TemplateFault
 *   An issue template that names a ready label: its path, and what is wrong.
 * @typedef {{ errors: string[], templates: TemplateFault[], warnings: string[], exposures?: string[], narrowed?: string[] }} Verdict
 *   `errors`: governor's faults, each failing the run. `templates`: issue
 *   templates that name a ready label, each failing the run too.
 *   `warnings`: what a valid file names that cannot work. `exposures`, where
 *   there are any: each trust list the file sets that reaches beyond owners,
 *   members and collaborators, and what that opens. Such a file works, so
 *   these have wording and a title of their own. `narrowed`, where there are
 *   any: each trust list the file leaves unset that governor narrowed to fit
 *   the lists it sets. Neither fails the run.
 * @typedef {(path: string) => Promise<any>} Api A GET on the REST API.
 */

/**
 * What a valid file names that cannot work. A read the token may not make
 * warns that its part went unchecked.
 *
 * @param {import('../dispatch/repo-config.mjs').FileConfig} config
 * @param {Reads} reads
 * @returns {Promise<string[]>}
 */
const warningsOf = async (config, reads) => {
  /** @returns {Promise<string[]>} */
  const labels = async () => {
    try {
      const have = new Set((await reads.labels()).map((l) => l.toLowerCase()));
      return config.labels.ready.filter((ready) => !have.has(ready.toLowerCase()))
        .map((ready) => `pickup.ready: the repo has no label "${ready}", so no ticket can carry it and pickup finds nothing`);
    } catch (error) {
      return [`pickup.ready: could not read the repo's labels, so the ready labels went unchecked: ${messageOf(error)}`];
    }
  };
  /** @returns {Promise<string[]>} */
  const ci = async () => {
    const { ci: path } = config.workflows;
    return path !== undefined && await reads.read(path) === null ? [`workflows.ci: ${path} is not in the repo, so no run counts as CI`] : [];
  };
  /** @returns {Promise<string[]>} */
  const heartbeat = async () => {
    if (config.features.heartbeat !== true || config.heartbeat === undefined) return [];
    const { issue } = config.heartbeat;
    try {
      const body = await reads.issueBody(issue);
      if (body === null) return [`heartbeat.issue: #${issue} is not an issue in the repo`];
      return body.includes(HEARTBEAT_MARKER) ? [] : [`heartbeat.issue: #${issue} does not carry ${HEARTBEAT_MARKER}, so governor writes nothing into it`];
    } catch (error) {
      return [`heartbeat.issue: could not read #${issue}, so its marker went unchecked: ${messageOf(error)}`];
    }
  };
  /** @returns {Promise<string[]>} */
  const globs = async () => {
    const { review } = config;
    if (review === undefined || (review.humanOnly.length === 0 && review.quote.length === 0)) return [];
    const { paths, truncated } = await reads.paths();
    if (truncated) return ['prReview: the repo\'s tree is too large for GitHub to list whole, so the humanOnly and quote globs went unchecked'];
    /** @param {string} glob */
    const none = (glob) => !paths.some((p) => globMatches(glob, p));
    return [
      ...review.humanOnly.filter(({ glob }) => none(glob)).map(({ glob }) => `prReview.humanOnly: ${glob} matches no path in the repo`),
      ...review.quote.filter((entry) => none(entry.replace(/^!/, ''))).map((entry) => `prReview.quote: ${entry} matches no path in the repo`),
    ];
  };
  /**
   * Sessions a person starts read the rules only in this file, so a
   * missing or old block warns. A read that fails warns too: the block is
   * advice to sessions, not something governor reads.
   *
   * @returns {Promise<string[]>}
   */
  const sessionRules = async () => {
    if (config.features.sessionRules !== true) return [];
    const path = rulesFile(config);
    /** @type {string | null} */
    let text;
    try {
      text = await reads.read(path);
    } catch (error) {
      return [`sessionRules: could not read ${path}, so its session rules block went unchecked: ${messageOf(error)}`];
    }
    if (text === null) return [`sessionRules: ${path} is not in the repo, so sessions a person starts are not told the rules. Add it with the block from docs/serving-a-repo.md`];
    const found = blockIn(text);
    if (found === 'missing') return [`sessionRules: ${path} does not carry governor's session rules block, so sessions a person starts are not told the rules. Copy the block from docs/serving-a-repo.md into it`];
    if (found === 'old') return [`sessionRules: ${path} carries a session rules block that differs from governor's current one, v${SESSION_RULES_VERSION}. Replace it with the one in docs/serving-a-repo.md`];
    return [];
  };
  // Independent reads, run together; the warnings keep this order.
  return [...(await Promise.all([labels(), ci(), heartbeat(), globs(), sessionRules()])).flat(), ...unreviewable(config)];
};

/**
 * A warning for each issue review whose `by`, or its default, shares no
 * value with the repo's `trust.review` as governor reads it. Governor
 * refuses a ticket whose author `trust.review` leaves out before it reads
 * any selector (dispatch/issue-review.mjs), so such a review never runs.
 * It is dead but harmless, so the file is not refused for it.
 *
 * @param {import('../dispatch/repo-config.mjs').FileConfig} config
 * @returns {string[]}
 */
const unreviewable = (config) => {
  const trusted = reviewOf(config);
  return (config.issueReviews?.reviews ?? []).flatMap(({ name, when }) => {
    const by = when.by ?? ISSUE_REVIEW_BY;
    if (by.some((a) => trusted.includes(a))) return [];
    return [`issueReviews.reviews.${name}: its by${when.by === undefined ? ', left at its default,' : ''} is ${by.join(', ')}, and trust.review lets in ${trusted.length === 0 ? 'nobody' : trusted.join(', ')}, so governor refuses every ticket this review selects before it runs, and it never comments`];
  });
};

/** An issue template in the template folder GitHub reads: an issue form or a Markdown template, at its top level. */
const FOLDER_TEMPLATE = /^\.github\/ISSUE_TEMPLATE\/[^/]+\.(md|ya?ml)$/i;

/** The template chooser's own config, in the template folder, which is no template. */
const CHOOSER = /^\.github\/ISSUE_TEMPLATE\/config\.ya?ml$/i;

/** The single-file template's places GitHub reads: the root, `.github/` and `docs/`. */
const SINGLE_TEMPLATES = ['ISSUE_TEMPLATE.md', '.github/ISSUE_TEMPLATE.md', 'docs/ISSUE_TEMPLATE.md'];

/** A single-file template, in any case, at one of its places. */
const SINGLE_TEMPLATE = /^(\.github\/|docs\/)?ISSUE_TEMPLATE\.md$/i;

/**
 * The label names a template's `labels:` value gives: a list, or a
 * comma-separated string.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
const labelNames = (value) => {
  // An unquoted item such as `- mode: afk` loads as the one-pair mapping
  // `{ mode: 'afk' }`, which still names the label `mode: afk`.
  /** @param {unknown} v @returns {string | null} */
  const name = (v) => {
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const pairs = Object.entries(v);
      if (pairs.length === 1 && pairs[0] !== undefined && (typeof pairs[0][1] === 'string' || typeof pairs[0][1] === 'number')) return `${pairs[0][0]}: ${pairs[0][1]}`;
    }
    return null;
  };
  if (Array.isArray(value)) return value.map(name).filter((v) => v !== null).map((v) => v.trim()).filter((v) => v !== '');
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v !== '');
  return [];
};

/**
 * The labels an issue template adds, or null where governor cannot read
 * them. An issue form is YAML; a Markdown template carries YAML front
 * matter. Where the YAML does not parse, a top-level `labels:` line is
 * still read as a comma-separated string, as people write it unquoted
 * (`labels: type: bug, mode: afk`), so a fault is not missed for a colon.
 *
 * @param {string} path
 * @param {string} text
 * @returns {string[] | null}
 */
const templateLabels = (path, text) => {
  let source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (/\.md$/i.test(path)) {
    const front = /^---\n([\s\S]*?)\n---(\n|$)/.exec(source);
    if (front === null) return [];
    source = front[1] ?? '';
  }
  try {
    const doc = yaml.load(source);
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? labelNames(/** @type {Record<string, unknown>} */ (doc).labels) : [];
  } catch {
    const line = /^labels:[ \t]*(\S.*)$/m.exec(source);
    if (line === null) return null;
    return labelNames(String(line[1]).replace(/^\[|\]$/g, '').split(',').map((v) => v.trim().replace(/^(["'])(.*)\1$/, '$2')));
  }
};

/**
 * The issue templates at the pull request's head that name a ready label,
 * each a fault, and a warning for each template whose labels governor
 * could not read, or for a template folder it could not list. A template's
 * `labels:` adds its labels whoever opens the issue, so one naming a ready
 * label readies every ticket of its kind before anyone has read it. That
 * holds whoever may open issues, so this reads no trust list. Labels match
 * in any case, as GitHub's do.
 *
 * @param {readonly string[]} ready The file's ready labels.
 * @param {Reads} reads
 * @returns {Promise<{ templates: TemplateFault[], warnings: string[] }>}
 */
const templateFaults = async (ready, reads) => {
  /** @type {string[]} */
  const warnings = [];
  const { paths, truncated } = await reads.paths();
  if (truncated) warnings.push('.github/ISSUE_TEMPLATE: the repo\'s tree is too large for GitHub to list whole, so the template folder went unchecked for ready labels');
  const found = paths.filter((p) => (FOLDER_TEMPLATE.test(p) && !CHOOSER.test(p)) || SINGLE_TEMPLATE.test(p));
  // A tree listed short may leave out the single files, so they are read by name then.
  const byName = truncated ? SINGLE_TEMPLATES.filter((p) => !found.some((f) => f.toLowerCase() === p.toLowerCase())) : [];
  const candidates = [...new Set([...found, ...byName])].sort();
  const wanted = new Map(ready.map((r) => [r.toLowerCase(), r]));
  // Independent reads, run together; the faults keep the paths' order.
  const texts = await Promise.all(candidates.map((file) => reads.read(file)));
  /** @type {TemplateFault[]} */
  const templates = [];
  for (const [i, file] of candidates.entries()) {
    const text = texts[i] ?? null;
    if (text === null) continue;
    const labels = templateLabels(file, text);
    if (labels === null) {
      warnings.push(`${file}: governor could not parse this issue template, so its labels went unchecked for ready labels`);
      continue;
    }
    const named = [...new Set(labels.map((l) => wanted.get(l.toLowerCase())).filter((l) => l !== undefined))];
    if (named.length === 0) continue;
    const list = named.map((l) => JSON.stringify(l)).join(', ');
    templates.push({
      file,
      fault: `this issue template's labels: names the ready label${named.length === 1 ? '' : 's'} ${list}, so every issue opened from it is ready before anyone has read it. Take ${named.length === 1 ? 'it' : 'them'} out: a person adds ready labels to one ticket at a time.`,
    });
  }
  return { templates, warnings };
};

/**
 * One check of the pull request's config file, and of its issue templates.
 * A read that fails, other than a file that is not there, throws, so the
 * run goes red rather than pass a file it could not read.
 *
 * @param {Reads} reads
 * @returns {Promise<Verdict>}
 */
export const check = async (reads) => {
  const text = await reads.read(CONFIG_PATH);
  if (text === null) {
    // A failed read of the old file only loses the hint, as in governor
    // (dispatch/repos.mjs): the pull request leaves no file either way.
    const old = await reads.read(OLD_CONFIG_PATH).catch(() => null) !== null;
    return { errors: [], templates: [], warnings: [old
      ? `the pull request leaves no ${CONFIG_PATH}, so governor will not serve this repo once it merges. Governor no longer reads ${OLD_CONFIG_PATH}: add ${CONFIG_PATH} in its layout, one section per feature`
      : `the pull request leaves no ${CONFIG_PATH}, so governor will not serve this repo once it merges`] };
  }
  const parsed = readConfig(text);
  if (!parsed.ok) return { errors: [parsed.fault], templates: [], warnings: [] };
  // The globs and the templates both read the tree: list it once.
  /** @type {ReturnType<Reads['paths']> | undefined} */
  let tree;
  const shared = { ...reads, paths: () => (tree ??= reads.paths()) };
  const [resolved, warnings, found] = await Promise.all([resolveFiles(parsed.config, shared.read), warningsOf(parsed.config, shared), templateFaults(parsed.config.labels.ready, shared)]);
  const exposures = trustExposures(parsed.config);
  const narrowed = narrowedLists(parsed.config).map(({ list, to }) => `trust.${list}: the file leaves it unset, so governor narrows it to ${to.length === 0 ? 'nobody' : to.join(', ')} to fit inside ${fitsInside(parsed.config, list).join(' and ')}`);
  return {
    errors: resolved.ok ? [] : [resolved.fault],
    templates: found.templates,
    warnings: [...warnings, ...found.warnings],
    ...(exposures.length === 0 ? {} : { exposures }),
    ...(narrowed.length === 0 ? {} : { narrowed }),
  };
};

/**
 * The reads over the REST API, at the pull request's head `ref`.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {string} ref
 * @returns {Reads}
 */
export const restReads = (api, repo, ref) => {
  /** @param {Promise<any>} call */
  const orNull = (call) => call.catch((error) => {
    if (/** @type {{ status?: number }} */ (error)?.status === 404) return null;
    throw error;
  });
  return {
    read: async (path) => {
      const answer = await orNull(api(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`));
      if (answer === null) return null;
      if (answer?.type !== 'file' || answer?.encoding !== 'base64' || typeof answer?.content !== 'string') throw new Error(`${path} at ${ref} is no file GitHub sent the text of`);
      return Buffer.from(answer.content, 'base64').toString('utf8');
    },
    paths: async () => {
      const answer = await api(`/repos/${repo}/git/trees/${ref}?recursive=1`);
      /** @type {Array<{ path: string, type: string }>} */
      const tree = answer?.tree ?? [];
      return { paths: tree.filter((e) => e.type === 'blob').map((e) => e.path), truncated: answer?.truncated === true };
    },
    labels: async () => {
      /** @type {string[]} */
      const names = [];
      for (let page = 1; ; page += 1) {
        /** @type {Array<{ name: string }>} */
        const rows = await api(`/repos/${repo}/labels?per_page=100&page=${page}`);
        names.push(...rows.map((l) => l.name));
        if (rows.length < 100) return names;
      }
    },
    issueBody: async (issue) => {
      const answer = await orNull(api(`/repos/${repo}/issues/${issue}`));
      return answer === null ? null : String(answer.body ?? '');
    },
  };
};

/**
 * A workflow command's text, escaped so a new line or `%` in a fault
 * stays in its one annotation.
 *
 * @param {string} text
 */
const escaped = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * A workflow command's property value, such as a `file=` path, escaped so a
 * `,` or `:` in it cannot end the property early.
 *
 * @param {string} text
 */
const escapedProperty = (text) => escaped(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * One run on the runner: the check over `reads`, each fault an error
 * annotation on the config file and each warning a warning one. Answers
 * the exit code: 1 when governor would refuse the file.
 *
 * @param {{ env: Record<string, string | undefined>, reads: (repo: string, ref: string) => Reads, log: (line: string) => void }} args
 */
export const run = async ({ env, reads, log }) => {
  const repo = String(env.GITHUB_REPOSITORY ?? '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY names no repo');
  if (env.GITHUB_TOKEN === undefined || env.GITHUB_TOKEN === '') throw new Error('GITHUB_TOKEN is not set');
  const ref = String(env.CONFIG_CHECK_REF ?? '');
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('CONFIG_CHECK_REF names no commit');
  const { errors, templates, warnings, exposures = [], narrowed = [] } = await check(reads(repo, ref));
  for (const e of errors) log(`::error file=${CONFIG_PATH},title=governor would refuse this file once it merges::${escaped(e)}`);
  for (const t of templates) log(`::error file=${escapedProperty(t.file)},title=an issue template names a ready label::${escaped(t.fault)}`);
  for (const w of warnings) log(`::warning file=${CONFIG_PATH},title=governor reads this file but it cannot work::${escaped(w)}`);
  for (const x of exposures) log(`::warning file=${CONFIG_PATH},title=this file lets more authors' text set governor going::${escaped(x)}`);
  for (const n of narrowed) log(`::notice file=${CONFIG_PATH},title=governor narrowed a trust list this file leaves unset::${escaped(n)}`);
  // The exposures are warning annotations too, so the count holds them.
  const said = warnings.length + exposures.length;
  log(errors.length > 0
    ? `${CONFIG_PATH} at ${ref}: governor would refuse it, and the repo would go unserved.`
    : `${CONFIG_PATH} at ${ref}: governor reads it${said > 0 ? `, with ${said} warning${said === 1 ? '' : 's'}` : ''}.`);
  if (templates.length > 0) log(`${templates.length} issue template${templates.length === 1 ? ' names' : 's name'} a ready label: ${templates.map((t) => t.file).join(', ')}.`);
  return errors.length > 0 || templates.length > 0 ? 1 : 0;
};

/**
 * The REST GET, on the caller's token.
 *
 * @param {string} base
 * @param {string} token
 * @returns {Api}
 */
const restApi = (base, token) => async (path) => {
  const res = await fetch(`${base}${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
  }).catch((error) => { throw new Error(`GET ${path}: ${messageOf(error)}`, { cause: error }); });
  if (!res.ok) throw Object.assign(new Error(`GET ${path}: HTTP ${res.status}`), { status: res.status });
  return res.json();
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  run({
    env,
    reads: (repo, ref) => restReads(restApi(env.GITHUB_API_URL ?? 'https://api.github.com', String(env.GITHUB_TOKEN)), repo, ref),
    log: (line) => console.log(line),
  }).then((code) => { process.exitCode = code; }, (error) => {
    console.error(messageOf(error));
    process.exitCode = 1;
  });
}
