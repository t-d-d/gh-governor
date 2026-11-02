/**
 * Reading a module's TypeScript AST, for the fitness tests that check a
 * module's shape.
 */

import ts from 'typescript';

/** Parse `text` as a JavaScript module, with parent links set. */
export const parseJs = (path: string, text: string): ts.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

/** Every node under `node`, depth first. */
export const nodes = (node: ts.Node): ts.Node[] => [node, ...node.getChildren().flatMap(nodes)];
