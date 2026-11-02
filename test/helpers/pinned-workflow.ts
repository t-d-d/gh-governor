import { spawnSync } from 'node:child_process';
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
  if (git('cat-file', '-e', `${sha}^{commit}`).status !== 0) {
    // git refuses --unshallow in a full clone, where a stale origin/main
    // is the only way to lack the pin.
    if (shallow()) {
      return [`the pinned commit ${short} is not in this clone: run git fetch --unshallow origin, or check out with fetch-depth: 0`];
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
      ? `this clone is shallow, so it cannot tell whether the pinned commit ${short} is on ${branch}: run git fetch --unshallow origin, or check out with fetch-depth: 0`
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
