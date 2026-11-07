import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// What is wrong with a caller's `with:` against a reusable workflow as it is
// at the commit the caller pins, read from this clone's git history. Each
// problem is one sentence; none means the pin is on `main` and takes every
// input passed, with the type it declares, and every input it requires.
//
// A clone without the pinned commit or the main ref is a problem too, never a
// pass: the gate's checkout fetches the whole history for this.
export function pinnedInputProblems({ cwd, main, sha, path, passed }: {
  cwd: string,
  main: string,
  sha: string,
  path: string,
  passed: Record<string, unknown>,
}): string[] {
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (run.error !== undefined) throw run.error;
    return run;
  };
  const short = sha.slice(0, 12);
  const shallow = () => git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true';
  const unshallow = 'run git fetch --unshallow origin, or check out with fetch-depth: 0';
  if (git('cat-file', '-e', `${sha}^{commit}`).status !== 0) {
    // git refuses --unshallow in a full clone, where a stale origin/main
    // is the only way to lack the pin.
    if (shallow()) {
      return [`the pinned commit ${short} is not in this clone: ${unshallow}`];
    }
    return [`the pinned commit ${short} is not in this clone: run git fetch origin`];
  }
  if (git('rev-parse', '--verify', '--quiet', `${main}^{commit}`).status !== 0) {
    return [`there is no ${main} in this clone: run git fetch origin main`];
  }
  const problems: string[] = [];
  if (git('merge-base', '--is-ancestor', sha, main).status !== 0) {
    // A shallow clone can hold the pin and main without the history that
    // joins them, so a failed check there says nothing about the pin.
    const branch = main.replace(/^origin\//, '');
    problems.push(shallow()
      ? `this clone is shallow, so it cannot tell whether the pinned commit ${short} is on ${branch}: ${unshallow}`
      : `the pinned commit ${short} is not on ${branch}`);
  }
  const shown = git('show', `${sha}:${path}`);
  if (shown.status !== 0) return [...problems, `the pinned commit ${short} has no ${path}`];
  let doc: unknown;
  try {
    doc = yaml.load(shown.stdout);
  } catch (error) {
    return [...problems, `${path} at ${short} is not valid YAML: ${(error as Error).message.split('\n')[0]}`];
  }
  const on = (doc as { on?: unknown } | null | undefined)?.on;
  const callable = on === 'workflow_call'
    || (Array.isArray(on) && on.includes('workflow_call'))
    || (isMapping(on) && Object.hasOwn(on, 'workflow_call'));
  if (!callable) return [...problems, `${path} at ${short} is not a reusable workflow: it has no on: workflow_call`];
  const call = isMapping(on) ? on.workflow_call : undefined;
  const declared = isMapping(call) ? call.inputs ?? {} : {};
  // GitHub rejects a workflow whose inputs, or any one input, are declared
  // as anything but a mapping, such as `labels: string`, so a caller fails
  // whatever it passes.
  if (!isMapping(declared)) return [...problems, `the checker at ${short} declares its inputs as ${kind(declared)}, not a mapping`];
  const inputs: Record<string, { type?: unknown, required?: unknown }> = {};
  for (const [key, input] of Object.entries(declared)) {
    if (isMapping(input)) inputs[key] = input;
    else problems.push(`the checker at ${short} declares input ${key} as ${kind(input)}, not a mapping`);
  }
  for (const [key, value] of Object.entries(passed)) {
    if (Object.hasOwn(declared, key) && !Object.hasOwn(inputs, key)) continue;
    const input = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
    if (input === undefined) {
      problems.push(`the checker at ${short} takes no input ${key}`);
    } else if (input.type !== undefined && typeof value !== input.type && !isExpression(value)) {
      problems.push(`the checker at ${short} takes ${key} as a ${String(input.type)}, not ${value === null ? 'null' : `a ${typeof value}`}`);
    }
  }
  for (const [key, input] of Object.entries(inputs)) {
    if (input.required === true && !Object.hasOwn(passed, key)) problems.push(`the checker at ${short} requires input ${key}`);
  }
  return problems;
}

// YAML reads a mapping as a plain object, and a timestamp as a Date, which
// is an object too but not a mapping.
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  return `a ${typeof value}`;
}

// YAML reads a `${{ ... }}` expression as a string, and GitHub evaluates it
// before it checks the input's type, so it can stand for any type. Only a
// value that is one whole expression counts: text around or between
// expressions makes GitHub join them into a string.
function isExpression(value: unknown): boolean {
  return typeof value === 'string' && /^\s*\$\{\{(?:(?!\}\})[\s\S])*\}\}\s*$/.test(value);
}

// What stops the heartbeat checker a workflow carries at a pinned commit from
// reading a served repo's config file, given as `config`, at
// .github/governor.json. The workflow writes its checker out from a quoted
// CHECKER heredoc and runs that, so this loads the same text and runs its
// `check` against a fake GitHub that serves the file at that path and at no
// other. Reading the heartbeat issue the file names shows the checker found
// and accepted the file, whichever of its versions it is. None means it did.
export async function pinnedCheckerReadProblems({ cwd, sha, path, config }: {
  cwd: string,
  sha: string,
  path: string,
  config: string,
}): Promise<string[]> {
  const short = sha.slice(0, 12);
  const shown = spawnSync('git', ['show', `${sha}:${path}`], { cwd, encoding: 'utf8' });
  if (shown.status !== 0) return [`the pinned commit ${short} has no ${path}`];
  let doc: unknown;
  try {
    doc = yaml.load(shown.stdout);
  } catch (error) {
    return [`${path} at ${short} is not valid YAML: ${(error as Error).message.split('\n')[0]}`];
  }
  const jobs = isMapping(doc) && isMapping(doc.jobs) ? Object.values(doc.jobs) : [];
  const runs = jobs.flatMap((job) => (isMapping(job) && Array.isArray(job.steps) ? job.steps : []))
    .map((step: unknown) => (isMapping(step) ? step.run : undefined))
    .filter((run): run is string => typeof run === 'string');
  const text = runs.map((run) => /<<'CHECKER'\n([\s\S]*?)\nCHECKER\n/.exec(run)?.[1]).find((t) => t !== undefined);
  if (text === undefined) return [`${path} at ${short} carries no heartbeat checker in a quoted CHECKER heredoc`];
  const dir = mkdtempSync(join(tmpdir(), 'pinned-checker-'));
  try {
    const file = join(dir, `heartbeat-check-${short}.mjs`);
    writeFileSync(file, `${text}\n`);
    let check: (args: Record<string, unknown>) => Promise<unknown>;
    try {
      ({ check } = await import(pathToFileURL(file).href) as { check: typeof check });
      if (typeof check !== 'function') throw new Error('it exports no check function');
    } catch (error) {
      return [`the heartbeat checker at ${short} does not load: ${(error as Error).message.split('\n')[0]}`];
    }
    const repo = 'acme/factory';
    const issue = (JSON.parse(config) as { heartbeat?: { issue?: unknown } }).heartbeat?.issue;
    const missing: string[] = [];
    const opened: string[] = [];
    let readIssue = false;
    const notFound = (what: string) => Object.assign(new Error(`HTTP 404 for ${what}`), { status: 404 });
    const api = async (method: string, route: string, body?: { title?: string }) => {
      const url = new URL(route, 'https://api.invalid');
      const contents = new RegExp(`^/repos/${repo}/contents/(.+)$`).exec(url.pathname);
      if (method === 'GET' && contents !== null) {
        const wanted = decodeURIComponent(contents[1] ?? '');
        if (wanted !== '.github/governor.json') {
          missing.push(wanted);
          throw notFound(wanted);
        }
        return { encoding: 'base64', content: Buffer.from(config).toString('base64') };
      }
      if (method === 'GET' && url.pathname === `/repos/${repo}/issues/${String(issue)}`) {
        readIssue = true;
        return { number: issue, body: '' };
      }
      if (method === 'GET') return [];
      if (method === 'POST' && url.pathname === `/repos/${repo}/issues`) opened.push(String(body?.title));
      return { number: 900, state: 'open', ...body };
    };
    let threw: unknown;
    try {
      await check({ api, repo, now: Date.now(), toleranceHours: 3, labels: [], log: () => {} });
    } catch (error) {
      threw = error;
    }
    if (readIssue && missing.length === 0) return [];
    const why = missing.length > 0
      ? `it read ${missing.join(', ')}, which the starter kit does not have`
      : threw !== undefined
        ? `it threw ${(threw as Error).message}`
        : `it opened ${opened.length === 0 ? 'nothing' : opened.map((t) => JSON.stringify(t)).join(', ')}`;
    return [`the heartbeat checker at ${short} did not read .github/governor.json through to heartbeat issue ${String(issue)}: ${why}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
