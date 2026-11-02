/**
 * The gate workflow, .github/workflows/gate.yml. A branch pushed to this
 * repo is gated by its push run, so a pull request from that branch does not
 * gate the same commit a second time. A fork's pull request has no push run
 * here, so its pull request run gates it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';

const gate = () => loadWorkflow(resolve(REPO_ROOT, '.github/workflows/gate.yml')).workflow;

// Evaluates the gate job's `if:` for one event. It knows only the shape the
// condition is written in, so a condition in any other shape fails the test
// rather than passing by accident.
function gateRuns(event: {
  event_name: string,
  head_repo?: string,
}): boolean {
  const condition = gate().jobs.gate.if as string | undefined;
  if (condition === undefined) return true;
  const expected = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository";
  assert.equal(condition.trim(), expected, 'the gate job condition is the one this test evaluates');
  const repository = 'acme/factory';
  return event.event_name !== 'pull_request' || event.head_repo !== repository;
}

describe('the gate runs once per commit', () => {
  test('it is triggered by a push to any branch but main, a pull request, and a call', () => {
    const { on } = gate();
    assert.deepEqual(Object.keys(on).sort(), ['pull_request', 'push', 'workflow_call']);
    assert.deepEqual(on.push['branches-ignore'], ['main']);
  });

  test('a push to a branch here runs the gate, and so does a caller on main', () => {
    // A called workflow sees its caller's event: deploy.yml and pages.yml run on push.
    assert.equal(gateRuns({ event_name: 'push' }), true);
  });

  test('a pull request from a branch here does not run it a second time', () => {
    assert.equal(gateRuns({ event_name: 'pull_request', head_repo: 'acme/factory' }), false);
  });

  test("a fork's pull request is still gated", () => {
    assert.equal(gateRuns({ event_name: 'pull_request', head_repo: 'someone/factory' }), true);
  });
});
