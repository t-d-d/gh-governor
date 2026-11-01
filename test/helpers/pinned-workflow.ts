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
  const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const short = sha.slice(0, 12);
  if (git('cat-file', '-e', `${sha}^{commit}`).status !== 0) {
    return [`the pinned commit ${short} is not in this clone: run git fetch --unshallow origin, or check out with fetch-depth: 0`];
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
  const doc = yaml.load(shown.stdout) as { on?: { workflow_call?: { inputs?: Record<string, { type?: string, required?: boolean }> } } };
  const inputs = doc.on?.workflow_call?.inputs ?? {};
  for (const [key, value] of Object.entries(passed)) {
    const input = inputs[key];
    if (input === undefined) {
      problems.push(`the checker at ${short} takes no input ${key}`);
    } else if (input.type !== undefined && typeof value !== input.type) {
      problems.push(`the checker at ${short} takes ${key} as a ${input.type}, not a ${typeof value}`);
    }
  }
  for (const [key, input] of Object.entries(inputs)) {
    if (input.required === true && !(key in passed)) problems.push(`the checker at ${short} requires input ${key}`);
  }
  return problems;
}
