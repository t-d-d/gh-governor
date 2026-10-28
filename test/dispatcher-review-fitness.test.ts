/**
 * The PR review runs from each served repo's own `review` settings, and
 * never the repo's code (docs/constraints/dispatcher-review.md):
 *
 * - the dispatcher image carries no repo's checklist or lists: no `.claude/`
 *   path;
 * - the review's modules start no process, and the one process a review
 *   turn starts is the CLI's model run, with no tools;
 * - the factory's file holds its checklist and lists, and its checklist
 *   names the file as the list, the shape the review tests read.
 *
 * What a pass does where `merge` is off, and that the settings checks
 * decide before the model, are driven through the turn in
 * test/dispatch-review.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { factoryFile } from './helpers/factory.ts';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';
import { globMatches, quoted } from '../dispatch/checklist.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const source = (path: string) => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

/** Every node under `node`, depth first. */
const nodes = (node: ts.Node): ts.Node[] => [node, ...node.getChildren().flatMap(nodes)];

/** The module specifiers a file imports, statically or by `import()`. */
const imports = (path: string) => nodes(source(path)).flatMap((n) => {
  if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) return [n.moduleSpecifier.text];
  if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) return [n.arguments[0].text];
  return [];
});

/** The modules a review reads and judges with. */
const REVIEW_MODULES = ['dispatch/review.mjs', 'dispatch/checklist.mjs', 'dispatch/repo-config.mjs', 'dispatch/pr-body.mjs', 'dispatch/webhook/review-comment.mjs'];

/** What would run code: a process, a VM, an evaluated string. */
const RUNS_CODE = /^(node:)?(child_process|vm|worker_threads)$/;

describe('fitness: a review runs no served repo\'s code (dispatcher-review.md)', () => {
  test('the task image copies no .claude/ path: each review reads the repo\'s own', () => {
    const copied = [...read('dispatch/Dockerfile').matchAll(/^COPY\s+(.+?)\s+\S+\s*$/gm)].flatMap((m) => m[1]!.split(/\s+/));
    assert.ok(copied.length > 0);
    for (const path of copied) {
      assert.ok(!path.startsWith('.claude/') && path !== '.claude', path);
    }
    assert.ok(!read('.dockerignore').split('\n').some((l) => l.trim().startsWith('!.claude')), 'the build context lets nothing out of .claude');
  });

  test('the review\'s modules import nothing that runs code', () => {
    for (const path of REVIEW_MODULES) {
      for (const spec of imports(path)) assert.doesNotMatch(spec, RUNS_CODE, `${path} imports ${spec}`);
    }
  });

  test('the review turn\'s one process is the CLI\'s model run, with no tools', () => {
    const turn = source('dispatch/turn.mjs');
    const review = nodes(turn).find((n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && n.name.getText() === 'review' && ts.isArrowFunction(n.initializer));
    assert.ok(review, 'realDeps has a review run');
    const spawns = nodes(review).filter((n): n is ts.CallExpression => ts.isCallExpression(n) && /^(spawn|spawnSync|exec|execFile|execSync|execFileSync|fork)$/.test(n.expression.getText()));
    assert.equal(spawns.length, 1, spawns.map((s) => s.getText()).join('\n'));
    const [command, args] = spawns[0]!.arguments;
    assert.equal(command?.getText(), "'claude'");
    assert.ok(args && ts.isArrayLiteralExpression(args));
    const words = args.elements.map((e) => e.getText());
    const tools = words.indexOf("'--tools'");
    assert.ok(tools >= 0 && words[tools + 1] === "''", `the run has no tools: ${words.join(' ')}`);
    assert.ok(words.includes("'-p'"), 'a print run, not a session');
  });

  test('the file schema takes no script, hook or command for the review: a check settings cannot express is the repo\'s CI', () => {
    const file = (review: Record<string, unknown>) => JSON.stringify({ environment: 'env_01X', labels: { ready: ['r'], claim: 'c' }, features: { prReview: true }, review: { checklist: 'c', ...review } });
    for (const key of ['script', 'hook', 'command', 'run']) {
      const refused = readConfig(file({ [key]: 'check.sh' }));
      assert.ok(!refused.ok && refused.fault.includes(key), key);
    }
  });
});

describe('the factory\'s review section, the shape the review tests read', () => {
  const factory = readConfig(factoryFile(CONFIG_PATH));
  assert.ok(factory.ok, JSON.stringify(factory));
  const review = factory.config.review!;
  const skill = factoryFile('.claude/skills/pr-review/SKILL.md');
  const test7 = skill.match(/^7\. [\s\S]*?(?=\n\S)/m)?.[0] ?? '';

  test('the factory\'s checklist is its pr-review skill, which its sessions run by hand: one copy', () => {
    assert.deepEqual(review.checklist, { file: '.claude/skills/pr-review/SKILL.md' });
    assert.equal(review.merge, true);
  });

  test('its ticket rules: a mode label, no PRD, no ADR unless readied', () => {
    assert.deepEqual(review.tickets, {
      require: [{ labels: ['mode: afk', 'mode: hitl', 'mode: human'], unless: [] }],
      forbid: [{ labels: ['type: prd'], unless: [] }, { labels: ['type: adr'], unless: ['workflow: ready for development', 'workflow: under development'] }],
    });
    assert.deepEqual(review.decides, ['type: adr']);
  });

  test('it quotes the constraint files, flat, and not their README', () => {
    for (const [path, expected] of [['docs/constraints/auth.md', true], ['docs/constraints/README.md', false], ['docs/constraints/sub/x.md', false], ['docs/auth.md', false]] as const) {
      assert.equal(quoted(review.quote, path), expected, path);
    }
  });

  test('a person\'s ticket clears every human-only entry but the constraint files', () => {
    for (const entry of review.humanOnly) {
      assert.deepEqual(entry.unless, entry.glob.startsWith('docs/constraints/') ? [] : ['mode: hitl', 'mode: human'], entry.glob);
    }
  });

  test('a change to the file holding the lists waits for a person', () => {
    assert.ok(review.humanOnly.some((e) => globMatches(e.glob, CONFIG_PATH)), CONFIG_PATH);
  });

  test('the skill\'s test 7 and By hand name the file as the list, and carry no paths of their own', () => {
    assert.ok(test7.includes('`.github/dispatch.json`'), test7);
    const backticked = [...test7.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    assert.deepEqual(backticked.filter((p) => p !== '.github/dispatch.json' && /[/*]/.test(p)), [], 'a path in the skill is a second list');
    assert.match(skill, /## By hand[\s\S]*\.github\/dispatch\.json/);
  });
});
