/**
 * The read-back on the receiver's Function URL. Whether AWS admits GitHub to
 * the URL is a fact of the deployed system: the stack test pins the
 * template's two public grants, and AWS has once refused every delivery with
 * a 403 before the receiver ran, with no log line and no alarm. So the
 * deploy reads it back (scripts/conformance.mjs); what is pure (the verdict
 * on an answer, the names the check reads by, the post it makes) is pinned
 * here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_ID_PLACEHOLDER, loadTemplate } from './helpers/cfn.ts';
import { appliesStack, runsScript } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';
import { handle } from '../dispatch/webhook/route.mjs';
import {
  STACK_VAR, URL_OUTPUT, REFUSAL,
  checkDispatchWebhookUrl, dispatchWebhookFindings,
} from '../scripts/lib/conformance-webhook-url.mjs';
import { CHECKS, runCheck } from '../scripts/conformance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STACK_CFN = resolve(repoRoot, 'infra/governor.cfn.yml');
const DEPLOY_YML = resolve(repoRoot, '.github/workflows/deploy.yml');

const URL = 'https://abc123.lambda-url.us-east-1.on.aws/';

describe('webhook-url — the verdict on the answer', () => {
  test('the receiver\'s own refusal reports nothing', () => {
    assert.deepEqual(dispatchWebhookFindings({ url: URL, answer: { status: REFUSAL.status, body: REFUSAL.body } }), []);
  });

  test('AWS refuses before the receiver runs', () => {
    const findings = dispatchWebhookFindings({
      url: URL,
      answer: {
        status: 403,
        body: '{"Message":"Forbidden. For troubleshooting Function URL authorization issues, see: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html"}',
        errorType: 'AccessDeniedException',
      },
    });
    assert.equal(findings.length, 1, findings.join('\n'));
    assert.match(findings[0]!, /403/);
    assert.match(findings[0]!, /AccessDeniedException/);
    assert.match(findings[0]!, /never reached the receiver/);
    // The template holding both grants is not enough: AWS has moved the rules
    // once, so the finding points at the live policy, not only an apply.
    assert.match(findings[0]!, /get-policy/);
  });

  test('a receiver that crashes is a finding too', () => {
    const findings = dispatchWebhookFindings({ url: URL, answer: { status: 502, body: 'Internal Server Error' } });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, /502/);
  });

  test('a 401 that is not the receiver\'s words is not the receiver\'s refusal', () => {
    const findings = dispatchWebhookFindings({ url: URL, answer: { status: 401, body: 'Unauthorized' } });
    assert.equal(findings.length, 1);
  });

  test('an answer that ACCEPTS an unsigned post is the worst finding of all', () => {
    const findings = dispatchWebhookFindings({ url: URL, answer: { status: 202, body: 'started arn:...' } });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, /unsigned/);
  });

  test('no URL output is a finding, with nothing posted', () => {
    const findings = dispatchWebhookFindings({ url: undefined, answer: undefined, stackName: 'governor' });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!, new RegExp(URL_OUTPUT));
  });

  // The operator reads these in the deploy's log (CLAUDE.md § Writing).
  test('every finding is written without an em dash', () => {
    const findings = [
      { url: undefined, answer: undefined },
      { url: URL, answer: { status: 202, body: 'started' } },
      { url: URL, answer: { status: 403, body: 'Forbidden' } },
      { url: URL, answer: { status: 502, body: 'Internal Server Error' } },
    ].flatMap((sides) => dispatchWebhookFindings(sides));
    assert.equal(findings.length, 4);
    for (const finding of findings) assert.ok(!finding.includes('\u2014'), finding);
  });
});

describe('webhook-url — REFUSAL is what the receiver answers an unsigned post', () => {
  test('the receiver, handed the same post, answers REFUSAL and queues nothing', async () => {
    let queued = 0;
    const logged: string[] = [];
    const answer = await handle({ headers: { 'content-type': 'application/json' }, body: '{}' }, {
      secret: async () => 'the-stack-key',
      owners: ['acme'],
      appId: undefined,
      enqueue: async () => { queued++; return 'm-1'; },
      log: (event: string) => { logged.push(event); },
    });
    assert.deepEqual(answer, { statusCode: REFUSAL.status, body: REFUSAL.body });
    assert.equal(queued, 0);
    assert.deepEqual(logged, ['webhook-refused']);
  });
});

describe('webhook-url — the run', () => {
  // The registered check, run as the runner runs it, with the stack named (or
  // not) and the io swapped for the test's.
  const runWith = (stack: string | undefined, io: Omit<Parameters<typeof checkDispatchWebhookUrl>[0], 'env'>) => {
    const check = CHECKS.find((c) => c.id === 'webhook-url')!;
    return runCheck(
      { ...check, run: (options) => checkDispatchWebhookUrl({ ...options, ...io }) },
      stack === undefined ? {} : { [STACK_VAR]: stack },
    );
  };

  test('no stack named is not-applicable, out loud, and posts nothing', async () => {
    let posted = 0;
    const outcome = await runWith(undefined, {
      readUrl: () => URL,
      post: async () => { posted++; return { status: 401, body: REFUSAL.body }; },
    });
    assert.match(String((outcome as { skipped?: string }).skipped), new RegExp(STACK_VAR));
    assert.equal(posted, 0);
  });

  test('it posts once, unsigned, to the stack\'s URL, and passes on the refusal', async () => {
    const read: string[] = [];
    const posts: string[] = [];
    const outcome = await runWith('governor', {
      readUrl: (stack: string) => { read.push(stack); return URL; },
      post: async (url: string) => { posts.push(url); return { status: REFUSAL.status, body: REFUSAL.body }; },
    });
    assert.deepEqual(read, ['governor']);
    assert.deepEqual(posts, [URL]);
    assert.deepEqual((outcome as { findings: string[] }).findings, []);
    assert.deepEqual((outcome as { notes?: string[] }).notes, [`governor ${URL_OUTPUT}: ${URL}; unsigned POST answered ${REFUSAL.status}`], 'what the URL answered is said out loud, finding or not');
  });

  test('a 403 fails the run', async () => {
    const outcome = await runWith('governor', {
      readUrl: () => URL,
      post: async () => ({ status: 403, body: '{"Message":"Forbidden."}', errorType: 'AccessDeniedException' }),
    }) as { findings: string[] };
    assert.equal(outcome.findings.length, 1);
  });

  test('a stack with no URL output posts nothing and fails', async () => {
    let posted = 0;
    const outcome = await runWith('governor', {
      readUrl: () => undefined,
      post: async () => { posted++; return { status: 401, body: REFUSAL.body }; },
    }) as { findings: string[] };
    assert.equal(posted, 0);
    assert.equal(outcome.findings.length, 1);
  });

  test('the default post carries no signature, so the receiver cannot verify it', async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(REFUSAL.body, { status: REFUSAL.status });
    }) as typeof fetch;
    try {
      const outcome = await runWith('governor', { readUrl: () => URL });
      assert.deepEqual((outcome as { findings: string[] }).findings, []);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, URL);
    assert.equal(seen[0]!.init?.method, 'POST');
    const headers = new Headers(seen[0]!.init?.headers);
    assert.equal(headers.get('x-hub-signature-256'), null);
    // A URL that never answers fails the check rather than hanging the nightly.
    assert.ok(seen[0]!.init?.signal instanceof AbortSignal, 'the post carries a timeout');
  });
});

// A rename on either side fails here rather than reading nothing after a deploy.
const stackTemplate = loadTemplate(STACK_CFN, { 'AWS::AccountId': ACCOUNT_ID_PLACEHOLDER });
const { workflow } = loadWorkflow(DEPLOY_YML);
const steps = workflow.jobs?.deploy?.steps ?? [];
const readStep = steps.find(runsScript('scripts/conformance.mjs'));

describe('webhook-url — the names the check reads by', () => {
  test('the output is the receiver\'s Function URL', () => {
    const output = stackTemplate.Outputs?.[URL_OUTPUT];
    assert.ok(output, `${URL_OUTPUT} is not an output of the stack`);
    assert.equal(output.Value, '${WebhookUrl.FunctionUrl}');
    assert.equal(stackTemplate.Resources?.['WebhookUrl']?.Type, 'AWS::Lambda::Url');
  });

  test('the stack the deploy reads back is the one it applies', () => {
    const stack = String((readStep?.env ?? {})[STACK_VAR] ?? '');
    assert.ok(stack, `the read-back step names no ${STACK_VAR}`);
    const apply = steps.find(appliesStack('governor'));
    // Ends at whitespace, not `\b`: `-` is a non-word character, so `\b` would
    // let `governor` match an applied `governor-v2`.
    assert.match(apply?.run ?? '', new RegExp(`^\\s*--stack-name ${stack}(?=\\s|$)`, 'm'), `${stack} is not the stack the deploy applies`);
  });
});
