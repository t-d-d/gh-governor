/**
 * The read-back on the App's webhook subscription. Every served repo's
 * events reach the receiver through the App's one webhook, and the events it
 * subscribes to are ticked by hand in the App's settings: the API cannot
 * write them, so no deploy does, and an event left unticked is one the
 * receiver never hears, with no error anywhere. So the deploy reads them
 * back (scripts/conformance.mjs); what is pure (the verdict, the read it
 * makes, and the slug the deploy names) is pinned here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runsScript } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';
import { HOOK_EVENTS } from '../dispatch/webhook/route.mjs';
import { APP_SLUG_VAR, checkDispatchAppEvents, dispatchAppEventFindings } from '../scripts/lib/conformance-app-events.mjs';
import { CHECKS, runCheck } from '../scripts/conformance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_YML = resolve(repoRoot, '.github/workflows/deploy.yml');

describe('app-events — the verdict', () => {
  test('an App subscribed to every event the receiver routes reports nothing, whatever else it subscribes to', () => {
    assert.deepEqual(dispatchAppEventFindings({ slug: 'governor-app', events: [...HOOK_EVENTS] }), []);
    assert.deepEqual(dispatchAppEventFindings({ slug: 'governor-app', events: ['push', ...[...HOOK_EVENTS].reverse()] }), []);
  });

  test('an event the receiver routes and the App does not deliver is a finding naming it', () => {
    const findings = dispatchAppEventFindings({ slug: 'governor-app', events: HOOK_EVENTS.filter((e) => e !== 'workflow_job') });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, /workflow_job/);
    assert.match(findings[0]!, /governor-app/);
  });

  test('an App GitHub does not answer for is a finding', () => {
    assert.equal(dispatchAppEventFindings({ slug: 'governor-app', events: undefined }).length, 1);
  });

  // The operator reads these in the deploy's log (CLAUDE.md § Writing).
  test('every finding is written without an em dash', () => {
    const findings = [
      ...dispatchAppEventFindings({ slug: 'governor-app', events: undefined }),
      ...dispatchAppEventFindings({ slug: 'governor-app', events: [] }),
    ];
    assert.equal(findings.length, 2);
    for (const finding of findings) assert.ok(!finding.includes('\u2014'), finding);
  });
});

describe('app-events — the run', () => {
  const check = CHECKS.find((c) => c.id === 'app-events')!;
  const runWith = (slug: string | undefined, io: Omit<Parameters<typeof checkDispatchAppEvents>[0], 'env'>) => runCheck(
    { ...check, run: (options) => checkDispatchAppEvents({ ...options, ...io }) },
    slug === undefined ? {} : { [APP_SLUG_VAR]: slug },
  );

  test('no App named is not-applicable, out loud, and reads nothing', async () => {
    let read = 0;
    const outcome = await runWith(undefined, { readEvents: async () => { read++; return [...HOOK_EVENTS]; } });
    assert.match(String((outcome as { skipped?: string }).skipped), new RegExp(APP_SLUG_VAR));
    assert.equal(read, 0);
  });

  test('reads the named App\'s events, and fails on one the receiver routes and it lacks', async () => {
    const read: string[] = [];
    const ok = await runWith('governor-app', { readEvents: async (slug: string) => { read.push(slug); return [...HOOK_EVENTS]; } }) as { findings: string[], notes?: string[] };
    assert.deepEqual(ok.findings, []);
    assert.deepEqual(ok.notes, [`governor-app delivers: ${[...HOOK_EVENTS].sort().join(', ')}`], 'what GitHub answered is said out loud, finding or not');
    assert.deepEqual(read, ['governor-app']);
    const outcome = await runWith('governor-app', { readEvents: async () => ['issues'] }) as { findings: string[] };
    assert.equal(outcome.findings.length, 1);
  });

  test('the default read is GitHub\'s public App endpoint, under a timeout', async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ slug: 'governor-app', events: [...HOOK_EVENTS] }), { status: 200 });
    }) as typeof fetch;
    try {
      assert.deepEqual((await runWith('governor-app', {}) as { findings: string[] }).findings, []);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(seen.map((s) => s.url), ['https://api.github.com/apps/governor-app']);
    assert.ok(seen[0]!.init?.signal instanceof AbortSignal, 'the read carries a timeout');
  });
});

describe('app-events — the App the deploy names', () => {
  test('is the repository variable, after the App\'s webhook is pointed', () => {
    const { workflow } = loadWorkflow(DEPLOY_YML);
    const steps = workflow.jobs?.deploy?.steps ?? [];
    const read = steps.findIndex(runsScript('scripts/conformance.mjs'));
    assert.ok(read > steps.findIndex(runsScript('scripts/point-app-webhook.mjs')));
    assert.equal(steps[read]?.env?.[APP_SLUG_VAR], '${{ vars.APP_SLUG }}');
  });
});
