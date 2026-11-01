/**
 * The docs pages: self-contained HTML files in docs/pages/, published with
 * GitHub Pages by .github/workflows/pages.yml. Only a green merge to main
 * that changes the folder or the workflow publishes, and the workflow holds
 * nothing beyond what the Pages actions need.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';

const PAGES_DIR = join(REPO_ROOT, 'docs/pages');
const pages = () => loadWorkflow(resolve(REPO_ROOT, '.github/workflows/pages.yml'));

describe('the pages workflow publishes docs/pages on a green merge to main', () => {
  test('it runs only on a push to main that changes docs/pages or the workflow, with no manual trigger', () => {
    const { workflow } = pages();
    assert.deepEqual(Object.keys(workflow.on), ['push']);
    assert.deepEqual(workflow.on.push.branches, ['main']);
    assert.deepEqual([...workflow.on.push.paths].sort(), ['.github/workflows/pages.yml', 'docs/pages/**']);
  });

  test('it calls the gate first, and publishes only after it passes', () => {
    const { workflow } = pages();
    assert.equal(workflow.jobs.gate?.uses, './.github/workflows/gate.yml');
    assert.equal(workflow.jobs.gate?.secrets, undefined, 'the gate is handed no secret');
    const others = Object.entries(workflow.jobs).filter(([name]) => name !== 'gate');
    assert.equal(others.length, 1, 'one publishing job besides the gate');
    const needs = [others[0]![1].needs].flat();
    assert.ok(needs.includes('gate'), 'the publishing job needs the gate');
  });

  test('it holds only contents: read, pages: write and id-token: write', () => {
    const { workflow } = pages();
    const allowed: Record<string, string> = { contents: 'read', pages: 'write', 'id-token': 'write' };
    const blocks = [workflow.permissions, ...Object.values(workflow.jobs).map((job: any) => job.permissions)];
    for (const block of blocks) {
      if (block === undefined) continue;
      assert.equal(typeof block, 'object', 'permissions are listed, never read-all or write-all');
      for (const [scope, level] of Object.entries(block as Record<string, string>)) {
        if (level === 'none') continue;
        assert.equal(allowed[scope], level, `${scope}: ${level} is not one the workflow may hold`);
      }
    }
  });

  test('it reads no secret or variable', () => {
    const { codeOnly } = pages();
    assert.doesNotMatch(codeOnly, /\bsecrets\b/);
    assert.doesNotMatch(codeOnly, /\bvars\./);
  });

  test("its steps are GitHub's Pages actions, uploading the docs/pages folder", () => {
    const { workflow } = pages();
    const steps = Object.values(workflow.jobs).flatMap((job: any) => job.steps ?? []);
    const uses = steps.map((s: any) => String(s.uses ?? '').replace(/@.*$/, ''));
    for (const action of ['actions/configure-pages', 'actions/upload-pages-artifact', 'actions/deploy-pages']) {
      assert.ok(uses.includes(action), `uses ${action}`);
    }
    const upload = steps.find((s: any) => String(s.uses ?? '').startsWith('actions/upload-pages-artifact@'));
    assert.equal(upload.with?.path, 'docs/pages');
    assert.ok(steps.every((s: any) => s.run === undefined), 'no step runs a build');
  });

  test('the gate and the stack deploy do not publish pages', () => {
    for (const file of ['gate.yml', 'deploy.yml']) {
      const { codeOnly } = loadWorkflow(resolve(REPO_ROOT, '.github/workflows', file));
      assert.doesNotMatch(codeOnly, /pages/, `${file} leaves pages to pages.yml`);
    }
  });
});

describe('the pages folder', () => {
  const htmlFiles = () => readdirSync(PAGES_DIR).filter((name) => name.endsWith('.html'));

  test('holds an index.html that links every other page', () => {
    const files = htmlFiles();
    assert.ok(files.includes('index.html'), 'docs/pages/index.html exists');
    const index = readFileSync(join(PAGES_DIR, 'index.html'), 'utf8');
    const missing = files.filter((name) => name !== 'index.html' && !index.includes(`href="${name}"`));
    assert.deepEqual(missing, [], 'the index lists each page');
  });

  test('holds only HTML files, each self-contained with no outside script or stylesheet', () => {
    const others = readdirSync(PAGES_DIR).filter((name) => !name.endsWith('.html'));
    assert.deepEqual(others, [], 'no build inputs or loose assets');
    for (const name of htmlFiles()) {
      const html = readFileSync(join(PAGES_DIR, name), 'utf8');
      assert.doesNotMatch(html, /<script[^>]*\bsrc=/i, `${name} loads no script file`);
      assert.doesNotMatch(html, /<link[^>]*rel=["']?stylesheet/i, `${name} loads no stylesheet file`);
    }
  });
});
