/**
 * The config check. It runs in a served repo, never in governor: governor
 * reads `.github/dispatch.json` from the default branch only, so a bad file
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
 * its marker, or a review glob that matches no path. Only governor can check
 * that `environment` resolves, because that needs the claude.ai login.
 *
 * Governor itself still reads only the default branch
 * (docs/constraints/dispatcher-repos.md): this check reads the head inside
 * the served repo's own Actions run, and governor never sees what it reads.
 */

import { pathToFileURL } from 'node:url';
import { globMatches } from '../dispatch/checklist.mjs';
import { HEARTBEAT_MARKER } from '../dispatch/heartbeat.mjs';
import { CONFIG_PATH, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
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
 * @typedef {{ errors: string[], warnings: string[] }} Verdict
 *   `errors`: governor's faults, each failing the run. `warnings`: what a
 *   valid file names that cannot work.
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
        .map((ready) => `labels.ready: the repo has no label "${ready}", so no ticket can carry it and pickup finds nothing`);
    } catch (error) {
      return [`labels.ready: could not read the repo's labels, so the ready labels went unchecked: ${messageOf(error)}`];
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
    const { issue, marker = HEARTBEAT_MARKER } = config.heartbeat;
    try {
      const body = await reads.issueBody(issue);
      if (body === null) return [`heartbeat.issue: #${issue} is not an issue in the repo`];
      return body.includes(marker) ? [] : [`heartbeat.issue: #${issue} does not carry ${marker}, so governor writes nothing into it`];
    } catch (error) {
      return [`heartbeat.issue: could not read #${issue}, so its marker went unchecked: ${messageOf(error)}`];
    }
  };
  /** @returns {Promise<string[]>} */
  const globs = async () => {
    const { review } = config;
    if (review === undefined || (review.humanOnly.length === 0 && review.quote.length === 0)) return [];
    const { paths, truncated } = await reads.paths();
    if (truncated) return ['review: the repo\'s tree is too large for GitHub to list whole, so the humanOnly and quote globs went unchecked'];
    /** @param {string} glob */
    const none = (glob) => !paths.some((p) => globMatches(glob, p));
    return [
      ...review.humanOnly.filter(({ glob }) => none(glob)).map(({ glob }) => `review.humanOnly: ${glob} matches no path in the repo`),
      ...review.quote.filter((entry) => none(entry.replace(/^!/, ''))).map((entry) => `review.quote: ${entry} matches no path in the repo`),
    ];
  };
  // Independent reads, run together; the warnings keep this order.
  return (await Promise.all([labels(), ci(), heartbeat(), globs()])).flat();
};

/**
 * One check of the pull request's config file. A read that fails, other
 * than a file that is not there, throws, so the run goes red rather than
 * pass a file it could not read.
 *
 * @param {Reads} reads
 * @returns {Promise<Verdict>}
 */
export const check = async (reads) => {
  const text = await reads.read(CONFIG_PATH);
  if (text === null) return { errors: [], warnings: [`the pull request leaves no ${CONFIG_PATH}, so governor will not serve this repo once it merges`] };
  const parsed = readConfig(text);
  if (!parsed.ok) return { errors: [parsed.fault], warnings: [] };
  const [resolved, warnings] = await Promise.all([resolveFiles(parsed.config, reads.read), warningsOf(parsed.config, reads)]);
  return { errors: resolved.ok ? [] : [resolved.fault], warnings };
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
  const { errors, warnings } = await check(reads(repo, ref));
  for (const e of errors) log(`::error file=${CONFIG_PATH},title=governor would refuse this file once it merges::${escaped(e)}`);
  for (const w of warnings) log(`::warning file=${CONFIG_PATH},title=governor reads this file but it cannot work::${escaped(w)}`);
  log(errors.length > 0
    ? `${CONFIG_PATH} at ${ref}: governor would refuse it, and the repo would go unserved.`
    : `${CONFIG_PATH} at ${ref}: governor reads it${warnings.length > 0 ? `, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}.`);
  return errors.length > 0 ? 1 : 0;
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
