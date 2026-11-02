/**
 * The PR review runs from each served repo's own `review` settings, and
 * never the repo's code (docs/constraints/dispatcher-review.md):
 *
 * - the dispatcher image carries no repo's checklist or lists: no `.claude/`
 *   path;
 * - the review's modules, and every module they load by relative import,
 *   import no builtin but the few they need, call no global that runs code
 *   (`eval`, `Function`, WebAssembly's compilers, `process.dlopen`,
 *   `process.getBuiltinModule`), and the one process a review turn starts
 *   is the CLI's model run, with no tools;
 * - the factory's file holds its checklist and lists, and its checklist
 *   names the file as the list, the shape the review tests read.
 *
 * What a pass does where `merge` is off, and that the settings checks
 * decide before the model, are driven through the turn in
 * test/dispatch-review.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { nodes, parseJs } from './helpers/ast.ts';
import { factoryFile } from './helpers/factory.ts';
import { importClosure, moduleSpecifiers } from './helpers/imports.ts';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';
import { globMatches, quoted } from '../dispatch/checklist.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const source = (path: string) => parseJs(path, read(path));

const ROOT = join(import.meta.dirname, '..');

/**
 * The builtins the review's modules import today, each in its `node:` form. Any other builtin fails the check, so one a review
 * module comes to need is added here on purpose, in a pull request a person reads. Most others run code: a process, a VM, a fork,
 * an evaluated string, a native library.
 */
const ALLOWED_BUILTINS = new Set(['node:crypto', 'node:util']);

/**
 * A specifier's `node:` form when it names a builtin, or null for a package or a relative path. Every `node:` specifier is a
 * builtin, so a builtin newer than this node still counts. `test` and `sqlite` are builtins only with the prefix: bare, each
 * names a package.
 */
const builtin = (spec: string): string | null => {
  if (spec.startsWith('node:')) return spec;
  return isBuiltin(spec) ? `node:${spec}` : null;
};

/**
 * Each builtin import in every module the entries load by relative import, re-exports and `import()` included: the module's
 * path, the specifier as written, and its `node:` form.
 */
const builtinImports = (root: string, ...entries: string[]) => [...importClosure(root, ...entries)].flatMap((path) =>
  moduleSpecifiers(readFileSync(join(root, path), 'utf8')).flatMap((spec) => {
    const name = builtin(spec);
    return name === null ? [] : [{ path, spec, name }];
  }));

/** Each `path imports spec` that loads a builtin off the allowed list. */
const codeRunners = (root: string, ...entries: string[]) =>
  builtinImports(root, ...entries).filter(({ name }) => !ALLOWED_BUILTINS.has(name)).map(({ path, spec }) => `${path} imports ${spec}`);

/** Every builtin, in its `node:` form, the entries' modules import. */
const builtinsImported = (root: string, ...entries: string[]) => new Set(builtinImports(root, ...entries).map(({ name }) => name));

/**
 * The globals that run code with no import: `eval` and `Function` evaluate a string, `WebAssembly` compiles and runs a program,
 * `process.dlopen` loads a native library, and `process.getBuiltinModule` loads any builtin, `child_process` among them, with no
 * import for the allowed list to see.
 */
const EVALUATORS = new Set([
  'eval', 'Function',
  'WebAssembly.instantiate', 'WebAssembly.compile', 'WebAssembly.instantiateStreaming', 'WebAssembly.compileStreaming',
  'WebAssembly.Module', 'WebAssembly.Instance',
  'process.dlopen', 'process.getBuiltinModule',
]);

/** The names that reach the global object: a leading one is dropped, so `global.eval` reads as `eval`. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global']);

/**
 * The dotted name a call, `new` or tagged template reaches, or null when it is not a plain name: parentheses and `(0, f)`
 * unwrapped, a string index read as a property, and a leading `globalThis.` or `global.` dropped.
 */
const calleeName = (node: ts.Expression): string | null => {
  if (ts.isParenthesizedExpression(node)) return calleeName(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return calleeName(node.right);
  if (ts.isIdentifier(node)) return node.text;
  const property = ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text
      : null;
  if (property === null) return null;
  const object = calleeName((node as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);
  if (object === null) return null;
  return GLOBAL_OBJECTS.has(object) ? property : `${object}.${property}`;
};

/** Each `path:line calls name` where a module the entries load calls, constructs or tags a template with an evaluating global. */
const codeEvaluators = (root: string, ...entries: string[]) => [...importClosure(root, ...entries)].flatMap((path) => {
  const file = parseJs(path, readFileSync(join(root, path), 'utf8'));
  return nodes(file).flatMap((n) => {
    if (!ts.isCallExpression(n) && !ts.isNewExpression(n) && !ts.isTaggedTemplateExpression(n)) return [];
    const name = calleeName(ts.isTaggedTemplateExpression(n) ? n.tag : n.expression);
    if (name === null || !EVALUATORS.has(name)) return [];
    return [`${path}:${file.getLineAndCharacterOfPosition(n.getStart()).line + 1} calls ${name}`];
  });
});

/** The modules a review reads and judges with. */
const REVIEW_MODULES = ['dispatch/review.mjs', 'dispatch/checklist.mjs', 'dispatch/repo-config.mjs', 'dispatch/pr-body.mjs', 'dispatch/webhook/review-comment.mjs'];

describe('fitness: a review runs no served repo\'s code (dispatcher-review.md)', () => {
  test('the task image copies no .claude/ path: each review reads the repo\'s own', () => {
    const copied = [...read('dispatch/Dockerfile').matchAll(/^COPY\s+(.+?)\s+\S+\s*$/gm)].flatMap((m) => m[1]!.split(/\s+/));
    assert.ok(copied.length > 0);
    for (const path of copied) {
      assert.ok(!path.startsWith('.claude/') && path !== '.claude', path);
    }
    assert.ok(!read('.dockerignore').split('\n').some((l) => l.trim().startsWith('!.claude')), 'the build context lets nothing out of .claude');
  });

  test('the check follows a re-export, import(), a side-effect import and a module the entry loads', () => {
    const root = mkdtempSync(join(tmpdir(), 'governor-review-imports-'));
    try {
      const files = {
        'entry.mjs': "export { spawn } from 'node:child_process';\nimport { x } from './lib/inner.mjs';\nexport const y = x;\n",
        'lib/inner.mjs': "import vm from 'node:vm';\nexport * from './deeper.mjs';\nexport const x = vm;\n",
        'lib/deeper.mjs': "export * from 'worker_threads';\nimport 'child_process';\nexport const later = () => import('./latest.mjs');\n",
        'lib/latest.mjs': "export const run = () => import('node:vm');\n",
      };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      assert.deepEqual(codeRunners(root, 'entry.mjs').sort(), ['entry.mjs imports node:child_process', 'lib/deeper.mjs imports child_process', 'lib/deeper.mjs imports worker_threads', 'lib/inner.mjs imports node:vm', 'lib/latest.mjs imports node:vm']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the check refuses cluster, module and inspector: each can fork, load child_process or evaluate code', () => {
    const root = mkdtempSync(join(tmpdir(), 'governor-review-builtins-'));
    try {
      writeFileSync(join(root, 'entry.mjs'), "import cluster from 'node:cluster';\nimport { createRequire } from 'module';\nexport { Session } from 'node:inspector';\nexport const later = () => import('node:inspector/promises');\nexport const x = [cluster, createRequire];\n");
      assert.deepEqual(codeRunners(root, 'entry.mjs').sort(), ['entry.mjs imports module', 'entry.mjs imports node:cluster', 'entry.mjs imports node:inspector', 'entry.mjs imports node:inspector/promises']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the check refuses repl, test and wasi: each evaluates a string, starts a process or runs a program', () => {
    const root = mkdtempSync(join(tmpdir(), 'governor-review-repl-test-wasi-'));
    try {
      writeFileSync(join(root, 'entry.mjs'), "import repl from 'node:repl';\nimport { run } from 'node:test';\nexport { spec } from 'node:test/reporters';\nexport { WASI } from 'wasi';\nexport const later = () => import('repl');\nexport const wasm = () => import('node:wasi');\nexport const x = [repl, run];\n");
      assert.deepEqual(codeRunners(root, 'entry.mjs').sort(), ['entry.mjs imports node:repl', 'entry.mjs imports node:test', 'entry.mjs imports node:test/reporters', 'entry.mjs imports node:wasi', 'entry.mjs imports repl', 'entry.mjs imports wasi']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the check refuses sqlite, whose loadExtension loads a native library, and any builtin off the list', () => {
    const root = mkdtempSync(join(tmpdir(), 'governor-review-sqlite-'));
    try {
      writeFileSync(join(root, 'entry.mjs'), "import { DatabaseSync } from 'node:sqlite';\nimport { createHash } from 'node:crypto';\nimport { format } from 'util';\nimport { z } from 'zod';\nexport { readFile } from 'node:fs';\nexport const later = () => import('node:some-future-builtin');\nexport const x = [DatabaseSync, createHash, format, z];\n");
      assert.deepEqual(codeRunners(root, 'entry.mjs').sort(), ['entry.mjs imports node:fs', 'entry.mjs imports node:some-future-builtin', 'entry.mjs imports node:sqlite']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a package named test or sqlite is not the builtin: only the prefixed name is', () => {
    for (const spec of ['test', 'test/lib', 'sqlite']) assert.equal(builtin(spec), null, spec);
    assert.equal(builtin('node:sqlite'), 'node:sqlite');
    assert.equal(builtin('crypto'), 'node:crypto');
  });

  test('the allowed list holds only builtins the review\'s modules import today', () => {
    assert.deepEqual([...builtinsImported(ROOT, ...REVIEW_MODULES)].sort(), [...ALLOWED_BUILTINS].sort());
  });

  test('the review\'s modules, and every module they load, import nothing that runs code', () => {
    assert.deepEqual(codeRunners(ROOT, ...REVIEW_MODULES), []);
  });

  test('the check finds eval, Function, WebAssembly\'s compilers, and process.dlopen, called, constructed or tagged', () => {
    const root = mkdtempSync(join(tmpdir(), 'governor-review-globals-'));
    try {
      const files = {
        'entry.mjs': "import './lib/inner.mjs';\nexport const a = eval('1');\nexport const b = new Function('return 1');\nexport const c = Function('return 2');\nexport const d = (0, eval)('3');\n",
        'lib/inner.mjs': "export const e = (bytes) => WebAssembly.instantiate(bytes);\nexport const f = (bytes) => globalThis.WebAssembly.compile(bytes);\nexport const g = (m) => process.dlopen(m, 'x.node');\nexport const h = () => globalThis.eval?.('4');\nexport const i = (bytes) => WebAssembly['compile'](bytes);\n",
        'lib/clean.mjs': "export const evaluate = (x) => x;\nexport const j = { eval: 1, Function: 2 };\nexport const k = (o) => o.eval('5');\nexport const l = WebAssembly.validate;\n",
        'lib/more.mjs': "export const o = (bytes) => new WebAssembly.Module(bytes);\nexport const p = (mod) => new globalThis.WebAssembly.Instance(mod);\nexport const q = (r) => WebAssembly.instantiateStreaming(r);\nexport const s = (r) => WebAssembly.compileStreaming(r);\nexport const t = () => global.eval('6');\nexport const u = () => Function`return 7`;\n",
      };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      assert.deepEqual(codeEvaluators(root, 'entry.mjs', 'lib/clean.mjs', 'lib/more.mjs').sort(), [
        'entry.mjs:2 calls eval',
        'entry.mjs:3 calls Function',
        'entry.mjs:4 calls Function',
        'entry.mjs:5 calls eval',
        'lib/inner.mjs:1 calls WebAssembly.instantiate',
        'lib/inner.mjs:2 calls WebAssembly.compile',
        'lib/inner.mjs:3 calls process.dlopen',
        'lib/inner.mjs:4 calls eval',
        'lib/inner.mjs:5 calls WebAssembly.compile',
        'lib/more.mjs:1 calls WebAssembly.Module',
        'lib/more.mjs:2 calls WebAssembly.Instance',
        'lib/more.mjs:3 calls WebAssembly.instantiateStreaming',
        'lib/more.mjs:4 calls WebAssembly.compileStreaming',
        'lib/more.mjs:5 calls eval',
        'lib/more.mjs:6 calls Function',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the check finds process.getBuiltinModule, which loads a builtin with no import', () => {
    const root = mkdtempSync(join(tmpdir(), 'governor-review-getbuiltin-'));
    try {
      writeFileSync(join(root, 'entry.mjs'), "export const a = process.getBuiltinModule('child_process');\nexport const b = globalThis.process.getBuiltinModule('node:vm');\nexport const c = process['getBuiltinModule']('fs');\nexport const d = global.process?.getBuiltinModule?.('wasi');\nexport const e = (o) => o.getBuiltinModule('x');\nexport const f = process.getBuiltinModule;\n");
      assert.deepEqual(codeEvaluators(root, 'entry.mjs').sort(), [
        'entry.mjs:1 calls process.getBuiltinModule',
        'entry.mjs:2 calls process.getBuiltinModule',
        'entry.mjs:3 calls process.getBuiltinModule',
        'entry.mjs:4 calls process.getBuiltinModule',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the review\'s modules, and every module they load, call no global that runs code', () => {
    assert.deepEqual(codeEvaluators(ROOT, ...REVIEW_MODULES), []);
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
