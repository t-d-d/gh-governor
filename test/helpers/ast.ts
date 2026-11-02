/**
 * Reading a module's TypeScript AST, for the fitness tests that check a
 * module's shape.
 */

import ts from 'typescript';

/** Parse `text` as a JavaScript module, with parent links set. */
export const parseJs = (path: string, text: string): ts.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

/**
 * Every node under `node`, depth first, parents before children. It walks
 * the tree once, pushing into one array, with its own stack so neither a
 * deep tree nor a node with many children overflows the call stack.
 */
export const nodes = (node: ts.Node): ts.Node[] => {
  const listed: ts.Node[] = [];
  const pending = [node];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    listed.push(next);
    const children = next.getChildren();
    for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]!);
  }
  return listed;
};
