/**
 * The heartbeat checker. It runs in a served repo, never in governor: a
 * checker inside governor stops whenever governor stops, so it could not
 * report governor stopping. The repo calls the reusable workflow
 * .github/workflows/heartbeat-check.yml, pinned to a commit of this repo.
 * That workflow fetches this repo at the commit and runs this file on the
 * caller's own token.
 *
 * It reads the caller's config file from the default branch, and the
 * heartbeat issue the file names, where governor keeps one line for pickup
 * and one per periodic (dispatch/heartbeat.mjs). Each line whose last fire
 * is older than its limit (pickup's sweep interval, a periodic's day limit)
 * plus the caller's tolerance gets one open issue, which closes once the
 * line is fresh again. The session rules line, which says the repo's
 * `CLAUDE.md` lacks governor's current block, is read and raises nothing:
 * it reports the repo's file, not a stopped dispatcher. A periodic governor
 * has read but not fired yet has a line at its first read, and its day
 * limit runs from then. A check that
 * cannot read the file or the issue keeps one issue open saying why, so a
 * broken check is never silence.
 *
 * It reads the file with governor's own `readConfig`
 * (dispatch/repo-config.mjs), pickup's interval with pickup's own default
 * (dispatch/pickup.mjs), and the issue with governor's own `readHeartbeat`,
 * all at the caller's pinned commit, so there is no second reader to keep in
 * step. A file that commit's governor would refuse is a fault here too.
 */

import { pathToFileURL } from 'node:url';
import { STATES, readHeartbeat } from '../dispatch/heartbeat.mjs';
import { sweepHoursOf } from '../dispatch/pickup.mjs';
import { CONFIG_PATH, readConfig, turnsOn } from '../dispatch/repo-config.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * @typedef {import('../dispatch/heartbeat.mjs').Heartbeat} Heartbeat
 * @typedef {import('../dispatch/heartbeat.mjs').PeriodicLine} PeriodicLine
 */

/**
 * @typedef {{ issue: number, pickupHours: number | null, periodics: Array<{ name: string, days: number }> }} CheckConfig
 *   `pickupHours`: pickup's sweep interval, null where pickup is off.
 */

/**
 * What the check needs of a config file, read by governor's `readConfig`:
 * the heartbeat issue, pickup's interval where pickup is on, and each
 * periodic's day limit where the periodics are on. A file governor refuses,
 * or one that leaves the heartbeat off, is a fault.
 *
 * @param {string} text
 * @returns {{ ok: true, config: CheckConfig } | { ok: false, fault: string }}
 */
export const checkConfigOf = (text) => {
  const read = readConfig(text);
  if (!read.ok) return { ok: false, fault: `${CONFIG_PATH} is a file governor refuses: ${read.fault}` };
  const { config } = read;
  if (!turnsOn(config, 'heartbeat') || config.heartbeat === undefined) return { ok: false, fault: `${CONFIG_PATH} does not turn the heartbeat on with a heartbeat section naming its issue` };
  return {
    ok: true,
    config: {
      issue: config.heartbeat.issue,
      pickupHours: turnsOn(config, 'pickup') ? sweepHoursOf(config) : null,
      periodics: turnsOn(config, 'periodics') ? config.periodics.map(({ name, days }) => ({ name, days })) : [],
    },
  };
};

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @param {number} ms */
const hoursText = (ms) => plural(Math.round((ms / HOUR_MS) * 10) / 10, 'hour', 'hours');

/** The marker on each issue the check keeps, by what it reports. */
const markerOf = (/** @type {string} */ key) => `<!-- governor:heartbeat-check ${key} -->`;
const FAULT_KEY = 'fault';
const PICKUP_KEY = 'pickup';
const periodicKey = (/** @type {string} */ name) => `periodic ${encodeURIComponent(name)}`;
// Anchored: the check's issues start with their marker, and an issue that
// only quotes one is someone else's.
const KEYED = /^<!-- governor:heartbeat-check (\S+(?: \S+)?) -->/;

/**
 * @typedef {{ key: string, title: string, body: string }} Overdue
 * @typedef {{ key: string, fresh: string }} Fresh
 */

/** @param {PeriodicLine} line */
const holdText = (line) => {
  switch (line.state) {
    case 'held': return `Governor is holding it for an open session: ${line.session}. It fires again once that session signs off or is archived.`;
    case 'open': return `Its last run's session, ${line.session}, has not signed off, so governor will hold its next fire for that session.`;
    case 'signed off': return 'Governor is not holding it for an open session: its last run\'s session signed off.';
    default: return 'Governor is not holding it for an open session: its last fire found nothing to do.';
  }
};

/**
 * Each line the file says governor keeps, overdue or fresh.
 *
 * @param {{ config: CheckConfig, beat: Heartbeat, now: number, toleranceHours: number, configChanged: () => Promise<number> }} args
 *   `configChanged`: when the config file last changed, read only for a
 *   line governor has not written yet.
 * @returns {Promise<Array<Overdue | Fresh>>}
 */
export const judge = async ({ config, beat, now, toleranceHours, configChanged }) => {
  const tolerance = toleranceHours * HOUR_MS;
  const issue = `#${config.issue}`;
  const tail = `This issue closes itself once the line is fresh again.`;
  /** @type {Array<Overdue | Fresh>} */
  const out = [];
  /** @type {Promise<number> | undefined} */
  let changedOnce;
  /**
   * @param {string} key
   * @param {string | undefined} at
   * @param {number} limit
   * @param {(late: string) => Overdue} overdue
   * @param {(changed: string, late: string) => Overdue} missing
   */
  const judgeLine = async (key, at, limit, overdue, missing) => {
    if (at !== undefined) {
      const late = now - Date.parse(at);
      out.push(Number.isFinite(late) && late <= limit + tolerance ? { key, fresh: at } : overdue(hoursText(late)));
      return;
    }
    changedOnce ??= configChanged();
    const changed = await changedOnce;
    const late = now - changed;
    if (late > limit + tolerance) out.push(missing(new Date(changed).toISOString(), hoursText(late)));
    else out.push({ key, fresh: 'no line yet' });
  };
  const tolText = hoursText(tolerance);
  if (config.pickupHours !== null) {
    const limit = config.pickupHours * HOUR_MS;
    const limitText = `its interval of ${hoursText(limit)} plus the tolerance of ${tolText}`;
    const title = 'Heartbeat: pickup\'s sweep is overdue';
    await judgeLine(PICKUP_KEY, beat.pickup?.at, limit,
      (late) => ({ key: PICKUP_KEY, title, body: `${markerOf(PICKUP_KEY)}\nGovernor's heartbeat issue ${issue} says pickup last swept the ready tickets at ${beat.pickup?.at}, ${late} ago. That is older than ${limitText}.\n\n${tail}\n` }),
      (changed, late) => ({ key: PICKUP_KEY, title, body: `${markerOf(PICKUP_KEY)}\nGovernor's heartbeat issue ${issue} has no line for pickup, and ${CONFIG_PATH} last changed at ${changed}, ${late} ago. That is older than ${limitText}.\n\n${tail}\n` }));
  }
  for (const { name, days } of config.periodics) {
    const key = periodicKey(name);
    const line = beat.periodics.find((p) => p.name === name);
    const limit = days * DAY_MS;
    const limitText = `its day limit of ${plural(days, 'day', 'days')} plus the tolerance of ${tolText}`;
    const title = `Heartbeat: periodic ${JSON.stringify(name)} is overdue`;
    await judgeLine(key, line?.at, limit,
      (late) => {
        const l = /** @type {PeriodicLine} */ (line);
        // A line from the baseline: governor has read the periodic and never
        // fired it, so its day limit runs from that first read.
        if (l.state === 'not fired') return { key, title, body: `${markerOf(key)}\nGovernor's heartbeat issue ${issue} says governor first read the periodic ${JSON.stringify(name)} at ${l.at}, ${late} ago, and has never fired it. That is older than ${limitText}.\n\n${tail}\n` };
        return { key, title, body: `${markerOf(key)}\nGovernor's heartbeat issue ${issue} says the periodic ${JSON.stringify(name)} last fired at ${l.at}, ${late} ago. That is older than ${limitText}.\n\nIts state: ${STATES[l.state]}${l.session === null ? '' : `, session ${l.session}`}.\n\n${holdText(l)}\n\n${tail}\n` };
      },
      (changed, late) => ({ key, title, body: `${markerOf(key)}\nGovernor's heartbeat issue ${issue} has no line for the periodic ${JSON.stringify(name)}, and ${CONFIG_PATH} last changed at ${changed}, ${late} ago. That is older than ${limitText}. Governor writes a periodic's line when it first reads it, so either governor has not read it since the file listed it, or it could not write the line.\n\n${tail}\n` }));
  }
  return out;
};

/**
 * @typedef {(method: string, path: string, body?: unknown) => Promise<any>} Api
 *   One REST call, its parsed answer; throws on a status that is not 2xx,
 *   with the status on the error.
 * @typedef {{ number: number, title: string, body: string }} Kept
 */

/**
 * The check's open issues, by key: every open issue carrying its marker.
 *
 * @param {Api} api
 * @param {string} repo
 * @returns {Promise<Map<string, Kept>>}
 */
const keptIssues = async (api, repo) => {
  /** @type {Map<string, Kept>} */
  const kept = new Map();
  for (let page = 1; ; page++) {
    /** @type {Array<{ number: number, title: string, body?: string | null, pull_request?: unknown }>} */
    const issues = await api('GET', `/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    for (const i of issues) {
      if (i.pull_request !== undefined) continue;
      const m = KEYED.exec(String(i.body ?? ''));
      if (m !== null && !kept.has(String(m[1]))) kept.set(String(m[1]), { number: i.number, title: i.title, body: String(i.body ?? '') });
    }
    if (issues.length < 100) return kept;
  }
};

/** How many pages of the default branch's history the check reads at most. */
const HISTORY_PAGES = 10;

/**
 * When the config file's last change reached the default branch. A merge
 * commit brings in a branch's commits with the dates they were made, so the
 * commit that changed the file can be older than the merge. The change
 * reached the branch at the oldest commit on the default branch's
 * first-parent line that has that commit in its history. Where that commit
 * is further back than the pages read, its own date stands.
 *
 * @param {Api} api
 * @param {string} repo
 * @returns {Promise<number>}
 */
export const configChangedAt = async (api, repo) => {
  /** @type {Array<{ sha?: string, commit?: { committer?: { date?: string } } }>} */
  const touched = await api('GET', `/repos/${repo}/commits?path=${encodeURIComponent(CONFIG_PATH)}&per_page=1`);
  const made = touched[0];
  const madeAt = Date.parse(String(made?.commit?.committer?.date ?? ''));
  if (!Number.isFinite(madeAt)) throw new Error(`no commit found for ${CONFIG_PATH}`);
  const sha = String(made?.sha ?? '');
  /** @type {Map<string, { at: number, parents: string[] }>} */
  const seen = new Map();
  /** @type {string[]} */
  const order = [];
  for (let page = 1; page <= HISTORY_PAGES && !seen.has(sha); page++) {
    /** @type {Array<{ sha: string, parents?: Array<{ sha: string }>, commit?: { committer?: { date?: string } } }>} */
    const commits = await api('GET', `/repos/${repo}/commits?per_page=100&page=${page}`);
    for (const c of commits) {
      seen.set(c.sha, { at: Date.parse(String(c.commit?.committer?.date ?? '')), parents: (c.parents ?? []).map((p) => p.sha) });
      order.push(c.sha);
    }
    if (commits.length < 100) break;
  }
  if (!seen.has(sha)) return madeAt;
  // Every commit read that has the change in its history. Read oldest first,
  // so one pass covers a listing with each parent after its children, and
  // repeated until nothing changes, so a commit listed out of order is still
  // counted.
  const holds = new Set([sha]);
  const oldestFirst = [...order].reverse();
  for (let grew = true; grew;) {
    grew = false;
    for (const s of oldestFirst) {
      if (!holds.has(s) && /** @type {{ parents: string[] }} */ (seen.get(s)).parents.some((p) => holds.has(p))) {
        holds.add(s);
        grew = true;
      }
    }
  }
  /** @type {string | undefined} */
  let reached;
  for (let s = order[0]; s !== undefined && holds.has(s); s = seen.get(s)?.parents[0]) reached = s;
  const at = reached === undefined ? NaN : Number(seen.get(reached)?.at);
  return Number.isFinite(at) ? Math.max(at, madeAt) : madeAt;
};

/**
 * One run of the check over a served repo. Throws where it cannot list,
 * open, update or close its issues, so the workflow goes red.
 *
 * @param {{ api: Api, repo: string, now: number, toleranceHours: number, labels: string[], log: (line: string) => void }} args
 */
export const check = async ({ api, repo, now, toleranceHours, labels, log }) => {
  const kept = await keptIssues(api, repo);
  /** @param {Overdue} o */
  const keep = async (o) => {
    const had = kept.get(o.key);
    if (had === undefined) {
      const made = await api('POST', `/repos/${repo}/issues`, { title: o.title, body: o.body, labels });
      kept.set(o.key, { number: made.number, title: o.title, body: o.body });
      log(`${o.key}: opened #${made.number}`);
    } else if (had.title !== o.title || had.body !== o.body) {
      await api('PATCH', `/repos/${repo}/issues/${had.number}`, { title: o.title, body: o.body });
      log(`${o.key}: updated #${had.number}`);
    } else log(`${o.key}: #${had.number} still open`);
  };
  /** @param {string} key @param {string} why */
  const close = async (key, why) => {
    const had = kept.get(key);
    if (had === undefined) return;
    kept.delete(key);
    await api('POST', `/repos/${repo}/issues/${had.number}/comments`, { body: why });
    await api('PATCH', `/repos/${repo}/issues/${had.number}`, { state: 'closed', state_reason: 'completed' });
    log(`${key}: closed #${had.number}`);
  };
  /** @param {string} why */
  const fault = (why) => keep({
    key: FAULT_KEY,
    title: 'Heartbeat check: governor\'s heartbeat could not be read',
    body: `${markerOf(FAULT_KEY)}\nThe heartbeat check could not read governor's heartbeat, so it cannot tell whether pickup and the periodics are firing.\n\n${why}\n\nThis issue closes itself once the check reads the heartbeat again.\n`,
  });

  /** @type {string} */
  let text;
  try {
    const file = await api('GET', `/repos/${repo}/contents/${CONFIG_PATH}`);
    text = Buffer.from(String(file.content ?? ''), 'base64').toString('utf8');
  } catch (error) {
    const status = /** @type {{ status?: number }} */ (error).status;
    return fault(status === 404 ? `The default branch has no ${CONFIG_PATH}.` : `Reading ${CONFIG_PATH} from the default branch failed: ${messageOf(error)}`);
  }
  const read = checkConfigOf(text);
  if (!read.ok) return fault(`${read.fault}.`);
  const { config } = read;
  /** @type {Heartbeat} */
  let beat;
  try {
    const issue = await api('GET', `/repos/${repo}/issues/${config.issue}`);
    beat = readHeartbeat(issue.body);
  } catch (error) {
    return fault(`Reading the heartbeat issue #${config.issue} failed: ${messageOf(error)}`);
  }
  /** @type {Array<Overdue | Fresh>} */
  let judged;
  try {
    judged = await judge({
      config,
      beat,
      now,
      toleranceHours,
      configChanged: () => configChangedAt(api, repo),
    });
  } catch (error) {
    return fault(`Reading when ${CONFIG_PATH} last changed failed: ${messageOf(error)}`);
  }
  await close(FAULT_KEY, 'The check reads governor\'s heartbeat again.');
  for (const j of judged) {
    if ('fresh' in j) {
      log(`${j.key}: fresh (${j.fresh})`);
      await close(j.key, `The line is fresh again: ${j.fresh}.`);
    } else await keep(j);
  }
  // A line the file no longer lists, or a feature turned off, has no one
  // left to close its issue but this.
  const judgedKeys = new Set(judged.map((j) => j.key));
  for (const key of [...kept.keys()]) {
    if (key !== FAULT_KEY && !judgedKeys.has(key)) await close(key, `${CONFIG_PATH} no longer lists this line, so the check no longer watches it.`);
  }
};

/**
 * The caller's labels: its input split on commas and new lines.
 *
 * @param {string | undefined} text
 */
export const labelsOf = (text) => String(text ?? '').split(/[,\n]/).map((l) => l.trim()).filter((l) => l !== '');

/**
 * The caller's tolerance, in hours.
 *
 * @param {string | undefined} text
 */
export const toleranceOf = (text) => {
  const n = Number(text);
  if (String(text ?? '').trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`the tolerance is not a number of hours: ${text}`);
  return n;
};

/**
 * The REST calls, on the caller's token.
 *
 * @param {string} base
 * @param {string} token
 * @returns {Api}
 */
const restApi = (base, token) => async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status}`), { status: res.status });
  return res.json();
};

const main = async () => {
  const env = process.env;
  const repo = String(env.GITHUB_REPOSITORY ?? '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY names no repo');
  if (env.GITHUB_TOKEN === undefined || env.GITHUB_TOKEN === '') throw new Error('GITHUB_TOKEN is not set');
  await check({
    api: restApi(env.GITHUB_API_URL ?? 'https://api.github.com', env.GITHUB_TOKEN),
    repo,
    now: Date.now(),
    toleranceHours: toleranceOf(env.HEARTBEAT_TOLERANCE_HOURS),
    labels: labelsOf(env.HEARTBEAT_LABELS),
    log: (line) => console.log(line),
  });
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(messageOf(error));
    process.exitCode = 1;
  });
}
