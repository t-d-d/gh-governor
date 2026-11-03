/**
 * The gate workflow, .github/workflows/gate.yml. It gates pull requests, not
 * branch pushes. A pull request from a branch here and a fork's pull request
 * are gated by the same run, and main is gated by deploy.yml and pages.yml,
 * which call it before they publish.
 *
 * It used to run on a push to a branch here as well, and skip its pull
 * request job for that branch so as not to gate a commit twice. GitHub
 * reports a skipped job as a passed check of the same name, so every pull
 * request carried a second `gate` check that read as passed while the real
 * one was still running. A reader of the head's checks could take it for a
 * finished gate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';

const WORKFLOWS = resolve(REPO_ROOT, '.github/workflows');
const load = (file: string) => loadWorkflow(resolve(WORKFLOWS, file)).workflow;
const gate = () => load('gate.yml');

// The events a workflow's `on:` names, in any of the three shapes it takes.
function events(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on as Record<string, unknown>);
}

const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target'];

describe('the gate runs once per pull request', () => {
  test('it is triggered by a pull request and a call, not by a push', () => {
    assert.deepEqual(events(gate().on).sort(), ['pull_request', 'workflow_call']);
  });

  test('its jobs carry no condition, so none reports a skipped check', () => {
    for (const [id, job] of Object.entries(gate().jobs as Record<string, Record<string, unknown>>)) {
      assert.equal(job.if, undefined, `gate.yml job ${id} has an if:`);
    }
  });

  test('no other workflow a pull request runs has a job whose check is named gate', () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f) && f !== 'gate.yml');
    const clashes: string[] = [];
    for (const file of files) {
      const workflow = load(file);
      if (!events(workflow.on).some((e) => PULL_REQUEST_EVENTS.includes(e))) continue;
      for (const [id, job] of Object.entries(workflow.jobs as Record<string, Record<string, unknown>>)) {
        // A job's check is named by its `name:`, or by its id when it has none.
        if ((job.name ?? id) === 'gate') clashes.push(`${file}: ${id}`);
      }
    }
    assert.deepEqual(clashes, []);
  });

  test('deploy.yml and pages.yml call it before they publish', () => {
    for (const file of ['deploy.yml', 'pages.yml']) {
      assert.equal(load(file).jobs.gate?.uses, './.github/workflows/gate.yml', `${file} calls the gate`);
    }
  });
});
