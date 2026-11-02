/**
 * Governor records every session it starts (docs/constraints/dispatcher-state.md),
 * and the review leans on that record (docs/constraints/dispatcher-review.md):
 * a PR whose session governor started keeps its human-only paths whatever
 * its ticket's label. The launcher (dispatch/launcher.mjs) writes that
 * record for every launch, so a launch that goes around it starts a session
 * nobody records.
 *
 * In dispatch/turn.mjs and dispatch/cli.mjs, only the module-level
 * `realDeps` and `dynamoState`, which define the CLI launch and the record
 * write, and the `cli`, `routine` and `recordSession` options of the one
 * `launcher()` call, may read a `launch`, call `recordSession`, start a
 * routine with `routineLaunch` or reach the launch script through
 * `launcherPath`. The deps `run` hands `turnFor` and the event periodics
 * carry the launcher's `start` as their `launch`, so no module past them
 * holds the CLI launch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const FILES = ['dispatch/turn.mjs', 'dispatch/cli.mjs'];

/** The module-level functions that define the launch and the record write. */
const DEFINERS = new Set(['realDeps', 'dynamoState']);

/** The `launcher()` options that take the CLI launch, the routine launch and the record write. */
const WIRED = new Set(['cli', 'routine', 'recordSession']);

/** The calls that start a session or record one. */
const CALLS = new Set(['recordSession', 'routineLaunch', 'launcherPath']);

const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

/** Every node under `node`, depth first. */
const nodes = (node: ts.Node): ts.Node[] => [node, ...node.getChildren().flatMap(nodes)];

/** Each file's text, read once. */
const TEXT = Object.fromEntries(FILES.map((path) => [path, readFileSync(path, 'utf8')]));
const TURN = TEXT['dispatch/turn.mjs']!;
const CLI = TEXT['dispatch/cli.mjs']!;
const TURN_FILE = parse('dispatch/turn.mjs', TURN);

/** Whether `node` is a call of `launcher(...)`. */
const isLauncherCall = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'launcher';

/** Whether `node` is the module-level declaration of `realDeps` or `dynamoState`. */
const isDefiner = (node: ts.Node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && DEFINERS.has(node.name.text)
  && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent);

/** Whether `node` is the `cli`, `routine` or `recordSession` option of a `launcher()` call. */
const isWired = (node: ts.Node) => ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && WIRED.has(node.name.text)
  && ts.isObjectLiteralExpression(node.parent) && isLauncherCall(node.parent.parent) && node.parent.parent.arguments[0] === node.parent;

/** A read of a `launch`, by `.launch`, `['launch']` or destructuring, or a call that starts or records a session however it is reached. */
const bypasses = (node: ts.Node) => {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'launch') return true;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'launch') return true;
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && (node.propertyName ?? node.name).getText() === 'launch') return true;
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  return name !== null && CALLS.has(name);
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
    if (isDefiner(node) || isWired(node)) return;
    if (isLauncherCall(node)) launchers += 1;
    if (bypasses(node)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${path}:${line + 1}: ${node.getText()}`);
    }
    node.getChildren().forEach(walk);
  };
  walk(file);
  return { found, launchers };
};

/** `text` with `statement` added at the top of the block body of the first arrow function `pick` finds. */
const into = (path: string, text: string, pick: (n: ts.Node) => ts.Expression | undefined, statement: string) => {
  const fn = nodes(parse(path, text)).map(pick).find((e) => e !== undefined);
  assert.ok(fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body), `${path} has the function with a body`);
  const at = fn.body.getStart() + 1;
  return text.slice(0, at) + `\n  ${statement}\n` + text.slice(at);
};

/** The initializer of the variable `name`. */
const variable = (name: string) => (n: ts.Node) => (ts.isVariableDeclaration(n) && n.name.getText() === name ? n.initializer : undefined);

/** The initializer of the property `name` of the `launcher()` call's options. */
const launcherOption = (name: string) => (n: ts.Node) => (ts.isPropertyAssignment(n) && n.name.getText() === name && ts.isObjectLiteralExpression(n.parent) && isLauncherCall(n.parent.parent) ? n.initializer : undefined);

const intoTurnFor = (statement: string) => into('dispatch/turn.mjs', TURN, variable('turnFor'), statement);

/** The text of the `launch` that an object literal of deps ends up with, after every spread before it. */
const launchOf = (deps: ts.Node | undefined) => {
  if (deps === undefined || !ts.isObjectLiteralExpression(deps)) return undefined;
  const last = (is: (p: ts.ObjectLiteralElementLike) => boolean) => deps.properties.reduce((found, p, i) => (is(p) ? i : found), -1);
  const at = last((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'launch');
  return at > last(ts.isSpreadAssignment) ? (deps.properties[at] as ts.PropertyAssignment).initializer.getText() : undefined;
};

describe('fitness: every launch goes through the launcher (dispatcher-review.md)', () => {
  test('turn.mjs and cli.mjs read a launch and start or record a session only in realDeps, dynamoState and the launcher() call\'s options', () => {
    const found = FILES.flatMap((path) => outside(path, TEXT[path]!).found);
    assert.deepEqual(found, []);
  });

  test('turn.mjs builds its launcher in one launcher() call, and defines realDeps and dynamoState', () => {
    assert.equal(outside('dispatch/turn.mjs', TURN).launchers, 1);
    const declared = nodes(TURN_FILE).filter(isDefiner).map((n) => n.name.getText());
    assert.deepEqual(declared.sort(), ['dynamoState', 'realDeps']);
  });

  test('run hands turnFor and the event periodics the launcher\'s start as their launch', () => {
    const calls = nodes(TURN_FILE).filter((n): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'turnFor' || n.expression.text === 'eventPeriodics'));
    assert.deepEqual(calls.map((c) => c.expression.getText()).sort(), ['eventPeriodics', 'turnFor']);
    for (const call of calls) {
      const scope = call.arguments[0];
      const deps = call.expression.getText() === 'turnFor'
        ? call.arguments[1]
        : scope !== undefined && ts.isObjectLiteralExpression(scope)
          ? scope.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'deps')?.initializer
          : undefined;
      assert.equal(launchOf(deps), 'launches.start', call.expression.getText());
    }
  });

  test('a CLI launch in turnFor past the launcher fails it, by a property, an index or destructuring', () => {
    for (const statement of ['void deps.launch(invocation);', 'void deps[\'launch\'](invocation);', 'const { launch } = deps;']) {
      assert.equal(outside('dispatch/turn.mjs', intoTurnFor(statement)).found.length, 1, statement);
    }
  });

  test('a session record in turnFor past the launcher fails it, by deps.state or a bare call', () => {
    assert.equal(outside('dispatch/turn.mjs', intoTurnFor('void deps.state.recordSession(\'https://claude.ai/code/session_x\');')).found.length, 1);
    assert.equal(outside('dispatch/turn.mjs', intoTurnFor('void recordSession(\'https://claude.ai/code/session_x\');')).found.length, 1);
  });

  test('a routine or a launch script started in turnFor past the launcher fails it', () => {
    assert.equal(outside('dispatch/turn.mjs', intoTurnFor('void routineLaunch(deps);')).found.length, 1);
    assert.equal(outside('dispatch/turn.mjs', intoTurnFor('void spawn(\'python3\', [launcherPath()]);')).found.length, 1);
  });

  test('a CLI launch in one of the launcher() call\'s other options fails it', () => {
    assert.equal(outside('dispatch/turn.mjs', into('dispatch/turn.mjs', TURN, launcherOption('suffix'), 'void deps.launch(invocation);')).found.length, 1);
  });

  test('a CLI launch in cli.mjs, through the deps it builds, fails it', () => {
    assert.equal(outside('dispatch/cli.mjs', into('dispatch/cli.mjs', CLI, variable('oneTurn'), 'void deps().launch(eventOf());')).found.length, 1);
  });

  test('a nested realDeps is no definer: a launch inside it fails it', () => {
    assert.equal(outside('dispatch/cli.mjs', into('dispatch/cli.mjs', CLI, variable('oneTurn'), 'const realDeps = () => deps().launch(eventOf());')).found.length, 1);
  });
});
