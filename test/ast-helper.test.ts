import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { nodes, parseJs } from './helpers/ast.ts';

/** A chain of `depth` stand-in nodes, each the only child of the one above. */
const chain = (depth: number): ts.Node => {
  let node = { getChildren: () => [] } as unknown as ts.Node;
  for (let i = 1; i < depth; i += 1) {
    const child = node;
    node = { getChildren: () => [child] } as unknown as ts.Node;
  }
  return node;
};

describe('nodes', () => {
  it('lists every node depth first, parents before children', () => {
    const kinds = nodes(parseJs('m.js', 'f(1);')).map((n) => ts.SyntaxKind[n.kind]);
    assert.deepEqual(kinds, ['SourceFile', 'SyntaxList', 'ExpressionStatement', 'CallExpression', 'Identifier', 'OpenParenToken', 'SyntaxList', 'FirstLiteralToken', 'CloseParenToken', 'SemicolonToken', 'EndOfFileToken']);
  });

  it('walks a tree once, so a chain 100000 deep lists each node once', () => {
    const top = chain(100_000);
    const listed = nodes(top);
    assert.equal(listed.length, 100_000);
    assert.equal(listed[0], top);
    assert.equal(new Set(listed).size, 100_000);
  });
});
