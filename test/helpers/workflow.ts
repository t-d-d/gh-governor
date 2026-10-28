import { basename, dirname } from 'node:path';
import { REPO_ROOT, repoModel } from './repo-model.ts';

export type { WorkflowStep } from './repo-model.ts';

// Loads a GitHub workflow for a test: the parsed YAML, and a comment-free
// view of the file so assertions read the actual shell commands, not the
// header prose (which can name the very strings under test). Line
// continuations are joined first so a flag split across lines still matches
// as one token.
//
// A view onto the repo model, which reads each workflow once: the parsed
// workflow is shared and frozen.
export function loadWorkflow(path: string): {
  raw: string;
  codeOnly: string;
  workflow: Record<string, any>;
} {
  const { raw, codeOnly, doc } = repoModel(REPO_ROOT, { workflowsDir: dirname(path) }).workflow(basename(path));
  return { raw, codeOnly, workflow: doc };
}
