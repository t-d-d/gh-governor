import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import yaml from 'js-yaml';
import { makeCfnSchema, type Statement, type Substitutions, type Template } from './cfn-schema.ts';
import { REPO_ROOT, deepFreeze, repoModel } from './repo-model.ts';

export { resourcesOfType, type Statement } from './cfn-schema.ts';

// ---------------------------------------------------------------------------
// The CloudFormation-template reader the stack tests share: a template
// loader that tolerates intrinsic tags, and readers for a role's inline
// policies. Substitutions differ per test, so they are a per-call parameter.
// ---------------------------------------------------------------------------

/** AWS's documented example account id, for `${AWS::AccountId}`. */
export const ACCOUNT_ID_PLACEHOLDER = '123456789012';

/**
 * Load and parse a CFN template with the shared intrinsic-tolerant schema.
 *
 * A template in this repo is read through the repo model, so every suite
 * shares one frozen parse of it. One elsewhere, such as a fixture in a temp
 * dir, is parsed here and frozen the same way.
 */
export function loadTemplate(path: string, substitutions: Substitutions = {}): Template {
  const inRepo = relative(REPO_ROOT, path);
  if (!inRepo.startsWith('..') && !isAbsolute(inRepo)) return repoModel().template(inRepo, substitutions);
  return deepFreeze(yaml.load(readFileSync(path, 'utf-8'), {
    schema: makeCfnSchema(substitutions),
  }) as Template);
}

/** A policy field that may be a scalar or a list, as a list. */
export const asList = (value: unknown): string[] =>
  value === undefined ? [] : [value].flat().map(String);

/** Every statement of every inline policy on `logicalId`, a role in `tpl`. */
export function inlinePolicyStatements(tpl: Template, logicalId: string): Statement[] {
  const role = tpl.Resources?.[logicalId];
  if (!role) throw new Error(`${logicalId} is missing from the template`);
  return (role.Properties?.Policies ?? []).flatMap((p) => p.PolicyDocument?.Statement ?? []);
}
