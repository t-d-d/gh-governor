/**
 * The fire kinds that start sessions (schedule, hook, unblocked and dispatch)
 * move out of `turnFor` into planners of their own, each called as
 * `(invocation, ctx)`. Before they move, `turnFor` builds that
 * `ctx`, one `TurnContext`, and the four branches read the turn's values
 * from it alone: the readers, the configs, the served repos, the prompts,
 * the delivery, the state, the launcher's `start`, the clock, the log and
 * the cap. A branch that reaches past it to `deps` or to one of `turnFor`'s
 * closures holds something a planner could not be handed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { nodes, parseJs } from './helpers/ast.ts';

const PATH = 'dispatch/turn.mjs';
const TURN = readFileSync(PATH, 'utf8');

/** What the branches reach only through the context: `deps`, and the closures and scope `turnFor` holds them in. */
const PAST_CONTEXT = new Set([
  'deps', 'readerFor', 'getReader', 'configOf', 'served', 'bare', 'prompts', 'delivery', 'start', 'beats',
  'original', 'account', 'storeIfRefreshed', 'finder', 'sessionsFinder', 'budgeted',
]);

/** `turnFor`'s arrow function. */
const turnForOf = (file: ts.SourceFile) => {
  const fn = nodes(file).map((n) => (ts.isVariableDeclaration(n) && n.name.getText() === 'turnFor' ? n.initializer : undefined)).find((e) => e !== undefined);
  assert.ok(fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body), `${PATH} has turnFor with a body`);
  return fn.body;
};

/** The if-else chain in `turnFor` that plans the schedule, hook, unblocked and dispatch fires. */
const branchesOf = (body: ts.Block) => {
  const found = body.statements.filter((s): s is ts.IfStatement => ts.isIfStatement(s) && s.expression.getText() === 'invocation.kind === \'schedule\'');
  assert.equal(found.length, 1, 'turnFor has one if-else chain that starts at the schedule fire');
  const chain = found[0]!;
  let text = '';
  for (let at: ts.Statement | undefined = chain; at !== undefined && ts.isIfStatement(at); at = at.elseStatement) text += `${at.expression.getText()}\n`;
  for (const kind of ['hook', 'unblocked', 'dispatch']) assert.match(text, new RegExp(`'${kind}'`), `the chain carries the ${kind} branch`);
  return chain;
};

/** Whether `id` names a variable, rather than a property read off something or a property's key. */
const isReference = (id: ts.Identifier) => {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  // A name the branch binds for itself is its own, not the closure's.
  if ((ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === id) return false;
  // The key of `{ prompts: own } = ctx` names a property of ctx, not the closure.
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  return true;
};

/** Each reference in `text`'s branches to something the context should carry, as `line: name`. */
const pastContext = (text: string) => {
  const file = parseJs(PATH, text);
  const chain = branchesOf(turnForOf(file));
  return nodes(chain)
    .filter((n): n is ts.Identifier => ts.isIdentifier(n) && PAST_CONTEXT.has(n.text) && isReference(n))
    .map((n) => `${file.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.text}`);
};

/** `TURN` with `statement` put at the top of the schedule branch. */
const intoSchedule = (statement: string) => {
  const chain = branchesOf(turnForOf(parseJs(PATH, TURN)));
  assert.ok(ts.isBlock(chain.thenStatement));
  const at = chain.thenStatement.getStart() + 1;
  return TURN.slice(0, at) + `\n    ${statement}\n` + TURN.slice(at);
};

describe('turnFor builds one TurnContext for the fire kinds that start sessions', () => {
  test('turnFor declares ctx once', () => {
    const body = turnForOf(parseJs(PATH, TURN));
    const declared = nodes(body).filter((n) => ts.isVariableDeclaration(n) && n.name.getText() === 'ctx');
    assert.equal(declared.length, 1);
  });

  test('the schedule, hook, unblocked and dispatch branches reach deps and the turn\'s closures only through ctx', () => {
    assert.deepEqual(pastContext(TURN), []);
  });

  test('a branch that reads deps, a closure or a destructured value past ctx fails the check', () => {
    for (const statement of ['deps.log(\'x\', {});', 'void readerFor(\'acme/factory\');', 'void prompts;', 'const { log } = deps;', 'void { prompts };']) {
      assert.equal(pastContext(intoSchedule(statement)).length, 1, statement);
    }
  });

  test('a read through ctx passes the check', () => {
    for (const statement of ['ctx.log(\'x\', {});', 'void ctx.readerFor(\'acme/factory\');', 'const { log, prompts } = ctx;', 'const { prompts: own } = ctx;']) {
      assert.deepEqual(pastContext(intoSchedule(statement)), [], statement);
    }
  });
});

/** The statements of the branch in `turnFor`'s chain whose condition is `kind`'s. */
const branchOf = (text: string, kind: string) => {
  for (let at: ts.Statement | undefined = branchesOf(turnForOf(parseJs(PATH, text))); at !== undefined && ts.isIfStatement(at); at = at.elseStatement) {
    if (at.expression.getText() !== `invocation.kind === '${kind}'`) continue;
    assert.ok(ts.isBlock(at.thenStatement));
    return at.thenStatement.statements.map((s) => s.getText());
  }
  assert.fail(`turnFor's chain has no ${kind} branch`);
};

/** `TURN` with `statement` put at the top of `kind`'s branch. */
const intoBranch = (kind: string, statement: string) => {
  // The schedule branch opens the chain, so no `else` comes before it.
  if (kind === 'schedule') return intoSchedule(statement);
  const at = TURN.indexOf('{', TURN.indexOf(`} else if (invocation.kind === '${kind}')`, TURN.indexOf('const turnFor = '))) + 1;
  return TURN.slice(0, at) + `\n    ${statement}\n` + TURN.slice(at);
};

describe('turnFor\'s schedule, hook, unblocked and dispatch branches are one planner call each', () => {
  const PLANNERS = { schedule: 'planSweep', hook: 'planHook', unblocked: 'planUnblocked', dispatch: 'planDispatch' };
  /** Whether `kind`'s branch in `text` is its planner's call alone. */
  const oneCall = (text: string, kind: string, planner: string) => {
    const statements = branchOf(text, kind);
    return statements.length === 1 && statements[0] === `planned = await ${planner}(invocation, ctx);`;
  };

  test('each branch hands the fire and ctx to its planner, and does nothing else', () => {
    for (const [kind, planner] of Object.entries(PLANNERS)) assert.ok(oneCall(TURN, kind, planner), kind);
  });

  test('a branch that plans anything itself fails the check', () => {
    for (const [kind, planner] of Object.entries(PLANNERS)) {
      assert.equal(oneCall(intoBranch(kind, 'plan.push(entry);'), kind, planner), false, kind);
    }
  });
});

/** The mutable variables the planning branches once shared in `turnFor`, now each planner's `Plan`. */
const SHARED = ['plan', 'only', 'unread', 'periodicsUnread', 'waitsUnread', 'hooksUnrecorded', 'sweepsUnread', 'swept', 'cut', 'held', 'row', 'endedByRepo'];

/** The names `turnFor`'s own body declares at its top level, outside the functions nested in it. */
const declaredAtTop = (body: ts.Block) => body.statements
  .filter(ts.isVariableStatement)
  .flatMap((s) => s.declarationList.declarations)
  .flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : nodes(d.name).filter(ts.isIdentifier).map((n) => n.text)));

describe('turnFor hands every plan to launchPlan, and keeps none of its state', () => {
  test('turnFor declares none of the shared variables', () => {
    const declared = declaredAtTop(turnForOf(parseJs(PATH, TURN)));
    assert.deepEqual(declared.filter((name) => SHARED.includes(name)), []);
  });

  test('a shared variable declared in turnFor again fails the check', () => {
    const body = turnForOf(parseJs(PATH, TURN));
    const at = body.getStart() + 1;
    const text = TURN.slice(0, at) + '\n  let swept = 0;\n' + TURN.slice(at);
    assert.deepEqual(declaredAtTop(turnForOf(parseJs(PATH, text))).filter((name) => SHARED.includes(name)), ['swept']);
  });

  test('turnFor calls launchPlan once', () => {
    const calls = nodes(turnForOf(parseJs(PATH, TURN))).filter((n) => ts.isCallExpression(n) && n.expression.getText() === 'launchPlan');
    assert.equal(calls.length, 1);
  });
});
