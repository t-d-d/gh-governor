/**
 * Governor records every session it starts, and the review leans on that
 * record (docs/constraints/dispatcher-review.md): a PR whose session
 * governor started keeps its human-only paths whatever its ticket's label.
 * The launcher (dispatch/launcher.mjs) writes that record for every launch,
 * so a launch that goes around it starts a session nobody records.
 *
 * In dispatch/turn.mjs and dispatch/cli.mjs, only `realDeps` and
 * `dynamoState`, which define the CLI launch and the record write, and the
 * one `launcher()` call that receives them, may read `deps.launch` or call
 * `recordSession`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const FILES = ['dispatch/turn.mjs', 'dispatch/cli.mjs'];

/** The functions that define the launch and the record write. */
const DEFINERS = new Set(['realDeps', 'dynamoState']);

const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

/** Every node under `node`, depth first. */
const nodes = (node: ts.Node): ts.Node[] => [node, ...node.getChildren().flatMap(nodes)];

/** Whether `node` is a call of `launcher(...)`. */
const isLauncherCall = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'launcher';

/** Whether `node` is the declaration of `realDeps` or `dynamoState`. */
const isDefiner = (node: ts.Node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && DEFINERS.has(node.name.text);

/** A read of `deps.launch`, or a call of `recordSession` however it is reached. */
const bypasses = (node: ts.Node) => {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'launch' && node.expression.getText() === 'deps') return true;
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === 'recordSession') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'recordSession');
};

/**
 * Each launch or record outside the launcher in `text`, as `path:line: code`,
 * and the number of `launcher()` calls found.
 */
const outside = (path: string, text: string) => {
  const file = parse(path, text);
  const found: string[] = [];
  let launchers = 0;
  const walk = (node: ts.Node) => {
    if (isDefiner(node)) return;
    if (isLauncherCall(node)) {
      launchers += 1;
      return;
    }
    if (bypasses(node)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${path}:${line + 1}: ${node.getText()}`);
    }
    node.getChildren().forEach(walk);
  };
  walk(file);
  return { found, launchers };
};

/** turn.mjs with `statement` added at the top of `turnFor`'s body. */
const intoTurnFor = (statement: string) => {
  const text = readFileSync('dispatch/turn.mjs', 'utf8');
  const turnFor = nodes(parse('dispatch/turn.mjs', text)).find((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText() === 'turnFor');
  assert.ok(turnFor?.initializer && ts.isArrowFunction(turnFor.initializer) && ts.isBlock(turnFor.initializer.body), 'turn.mjs has a turnFor with a body');
  const at = turnFor.initializer.body.getStart() + 1;
  return text.slice(0, at) + `\n  ${statement}\n` + text.slice(at);
};

describe('fitness: every launch goes through the launcher (dispatcher-review.md)', () => {
  test('turn.mjs and cli.mjs read deps.launch and call recordSession only in realDeps, dynamoState and the launcher() call', () => {
    const found = FILES.flatMap((path) => outside(path, readFileSync(path, 'utf8')).found);
    assert.deepEqual(found, []);
  });

  test('turn.mjs builds its launcher in one launcher() call, and defines realDeps and dynamoState', () => {
    const text = readFileSync('dispatch/turn.mjs', 'utf8');
    assert.equal(outside('dispatch/turn.mjs', text).launchers, 1);
    const declared = nodes(parse('dispatch/turn.mjs', text)).filter(isDefiner).map((n) => (n as ts.VariableDeclaration).name.getText());
    assert.deepEqual(declared.sort(), ['dynamoState', 'realDeps']);
  });

  test('a CLI launch in turnFor past the launcher fails it', () => {
    assert.equal(outside('dispatch/turn.mjs', intoTurnFor('void deps.launch(invocation);')).found.length, 1);
  });

  test('a session record in turnFor past the launcher fails it, by deps.state or a bare call', () => {
    assert.equal(outside('dispatch/turn.mjs', intoTurnFor('void deps.state.recordSession(\'https://claude.ai/code/session_x\');')).found.length, 1);
    assert.equal(outside('dispatch/turn.mjs', intoTurnFor('void recordSession(\'https://claude.ai/code/session_x\');')).found.length, 1);
  });
});
