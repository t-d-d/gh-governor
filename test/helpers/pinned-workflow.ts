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
  if (git('cat-file', '-e', `${sha}^{commit}`).status !== 0) {
    // git refuses --unshallow in a full clone, where a stale origin/main
    // is the only way to lack the pin.
    if (git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true') {
      return [`the pinned commit ${short} is not in this clone: run git fetch --unshallow origin, or check out with fetch-depth: 0`];
    }
    return [`the pinned commit ${short} is not in this clone: run git fetch origin`];
  }
  if (git('rev-parse', '--verify', '--quiet', `${main}^{commit}`).status !== 0) {
    return [`there is no ${main} in this clone: run git fetch origin main`];
  }
  const problems: string[] = [];
  if (git('merge-base', '--is-ancestor', sha, main).status !== 0) {
    problems.push(`the pinned commit ${short} is not on ${main.replace(/^origin\//, '')}`);
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
    || (typeof on === 'object' && on !== null && !Array.isArray(on) && Object.hasOwn(on, 'workflow_call'));
  if (!callable) return [...problems, `${path} at ${short} is not a reusable workflow: it has no on: workflow_call`];
  type Input = { type?: string, required?: boolean } | null;
  const call = typeof on === 'object' && on !== null && !Array.isArray(on)
    ? (on as { workflow_call?: { inputs?: Record<string, Input> | null } | null }).workflow_call
    : undefined;
  const inputs = call?.inputs ?? {};
  for (const [key, value] of Object.entries(passed)) {
    const input = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
    if (input === undefined || input === null) {
      problems.push(`the checker at ${short} takes no input ${key}`);
    } else if (input.type !== undefined && typeof value !== input.type && !isExpression(value)) {
      problems.push(`the checker at ${short} takes ${key} as a ${input.type}, not ${value === null ? 'null' : `a ${typeof value}`}`);
    }
  }
  for (const [key, input] of Object.entries(inputs)) {
    if (input?.required === true && !Object.hasOwn(passed, key)) problems.push(`the checker at ${short} requires input ${key}`);
  }
  return problems;
}

// YAML reads a `${{ ... }}` expression as a string, and GitHub evaluates it
// before it checks the input's type, so it can stand for any type.
function isExpression(value: unknown): boolean {
  return typeof value === 'string' && /^\s*\$\{\{[\s\S]*\}\}\s*$/.test(value);
}
