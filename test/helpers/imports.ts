/**
 * What a module imports, read off its AST: the specifiers it loads, and the
 * repo paths it reaches through relative imports.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import * as acorn from 'acorn';

/** Every module specifier a source loads, read off the AST: static, re-export, side-effect and dynamic. */
export const moduleSpecifiers = (source: string): string[] => {
  const specs: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; source?: { type?: string; value?: unknown } };
    if (
      (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression')
      && n.source?.type === 'Literal' && typeof n.source.value === 'string'
    ) specs.push(n.source.value);
    for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) walk(child);
  };
  walk(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  return specs;
};

/** Every relative module specifier a source loads. */
export const relativeImports = (source: string): string[] => moduleSpecifiers(source).filter((spec) => /^\.{1,2}\//.test(spec));

/** Every repo path, relative to `root`, the entries load, each entry included, following relative imports. */
export const importClosure = (root: string, ...entries: string[]): Set<string> => {
  const seen = new Set<string>();
  const walk = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(resolve(root, path), 'utf8');
    for (const spec of relativeImports(source)) walk(relative(root, resolve(root, dirname(path), spec)));
  };
  for (const entry of entries) walk(entry);
  return seen;
};
