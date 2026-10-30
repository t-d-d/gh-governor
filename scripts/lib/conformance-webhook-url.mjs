// webhook-url: the receiver's Function URL, as infra/governor.cfn.yml
// outputs it, against what AWS answers an unsigned caller there.
//
// Whether AWS lets GitHub reach the receiver is a fact of the deployed system.
// The stack test pins the template's two public grants; nothing reads back that
// they admit anyone. When AWS changed what a Function URL needs, the URL
// answered every delivery with a 403 from AWS before the receiver ran: no log
// line, no invocation, no alarm, and the operator learned of it from the
// webhook's Recent Deliveries tab.
//
// The probe is one unsigned POST. The receiver's own refusal of a body it
// cannot verify (401, `signature does not match`, a `webhook-refused` line)
// proves AWS invoked it; anything else never reached it, or reached it and
// failed. The post is the only write, and the receiver starts nothing for it.
//
// The hook-url check posts once, unsigned, to a hook path on the same URL.
// A hook request is routed on its path before any GitHub check, so its own
// 401 proves the path reaches the hook's signature check; anything else is a
// receiver that took, ignored or never saw an unsigned hook.
//
// The `aws` CLI is the reader because governor carries no CloudFormation SDK
// client. The stack arrives in GOVERNOR_STACK, which the deploy sets, so a
// run that names none reports not-applicable out loud (scripts/conformance.mjs).

import { execFileSync } from 'node:child_process';

/** Names the stack the receiver lives in; .github/workflows/deploy.yml sets it. */
export const STACK_VAR = 'GOVERNOR_STACK';
/** The output carrying the receiver's Function URL. */
export const URL_OUTPUT = 'WebhookUrl';
/** What dispatch/webhook/route.mjs answers a delivery it cannot verify. */
export const REFUSAL = { status: 401, body: 'signature does not match' };

/**
 * The hook path the probe posts to, under the URL. A well-formed path, so the
 * receiver reads it as a hook's, whose owner is no one's: a probe that got
 * past the signature would still queue nothing.
 */
export const HOOK_PROBE_PATH = 'hooks/conformance/probe/conformance';

/** Longer than the receiver's 20s Lambda timeout, so a slow receiver still answers. */
const POST_TIMEOUT_MS = 30_000;

/** @typedef {{ status: number, body: string, errorType?: string }} Answer */

/**
 * The findings on what the URL answered an unsigned post.
 *
 * @param {object} sides
 * @param {string | undefined} sides.url - The stack's `URL_OUTPUT`, or
 *   undefined when the stack has no such output.
 * @param {Answer | undefined} sides.answer - What the URL answered; undefined
 *   when there was no URL to post to.
 * @param {string} [sides.stackName]
 * @returns {string[]}
 */
export function dispatchWebhookFindings({ url, answer, stackName = 'the dispatch stack' }) {
  if (url === undefined || answer === undefined) {
    return [
      `${stackName} has no ${URL_OUTPUT} output. The stack was never applied with the receiver, or the `
      + 'output was renamed; there is no URL to post to, and the App\'s webhook has none either',
    ];
  }
  if (answer.status === REFUSAL.status && answer.body === REFUSAL.body) return [];

  const said = `${answer.status}${answer.errorType ? ` ${answer.errorType}` : ''}: ${answer.body.slice(0, 200)}`;
  if (answer.status >= 200 && answer.status < 300) {
    return [
      `${url} accepted an unsigned post (${said}): the receiver is not verifying signatures, so anyone `
      + 'can start a dispatcher task',
    ];
  }
  if (answer.status === 403) {
    return [
      `${url} answered an unsigned post ${said}: AWS refused it, so it never reached the receiver, and `
      + 'neither does any GitHub delivery. Read the live policy (`aws lambda get-policy --function-name '
      + 'governor-webhook`) against AWS\'s urls-auth page: when it lacks a grant '
      + 'infra/governor.cfn.yml holds, deploy the stack again; when it holds them all, AWS has changed '
      + 'what a Function URL needs, and the template needs the new grant',
    ];
  }
  return [
    `${url} answered an unsigned post ${said}, not the receiver's own ${REFUSAL.status} "${REFUSAL.body}". `
    + 'It never reached the receiver, or the receiver failed before verifying it; GitHub\'s deliveries '
    + 'meet the same answer. Read /aws/lambda/governor-webhook',
  ];
}

/**
 * The stack's `URL_OUTPUT`, or undefined when the stack has no such output.
 *
 * @param {string} stackName
 * @returns {string | undefined}
 */
function readWebhookUrl(stackName) {
  const json = execFileSync(
    'aws',
    [
      'cloudformation', 'describe-stacks', '--stack-name', stackName,
      '--query', `Stacks[0].Outputs[?OutputKey=='${URL_OUTPUT}'].OutputValue`, '--output', 'json',
    ],
    { encoding: 'utf-8' },
  );
  // A stack with no Outputs projects to null, not to an empty list.
  const [value] = JSON.parse(json) ?? [];
  return typeof value === 'string' ? value : undefined;
}

/**
 * One unsigned POST of an empty object, the shape of a delivery with no
 * `X-Hub-Signature-256`.
 *
 * @param {string} url
 * @returns {Promise<Answer>}
 */
async function postUnsigned(url) {
  const response = await fetch(url, {
    method: 'POST',
    // The receiver logs the delivery id beside `webhook-refused`, so the
    // nightly's line reads as the probe's rather than a stranger's.
    headers: { 'content-type': 'application/json', 'x-github-delivery': 'conformance-webhook-url' },
    body: '{}',
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  const errorType = response.headers.get('x-amzn-errortype') ?? undefined;
  return { status: response.status, body: await response.text(), ...(errorType ? { errorType } : {}) };
}

/**
 * The runner reports it not applicable, and never calls it, while
 * GOVERNOR_STACK is unset.
 *
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   readUrl?: typeof readWebhookUrl,
 *   post?: typeof postUnsigned,
 * }} options - `env` from the runner; the io from this member's own tests.
 * @returns {Promise<import('../conformance.mjs').CheckOutcome>}
 */
export async function checkDispatchWebhookUrl({ env, ...io }) {
  const stackName = /** @type {string} */ (env[STACK_VAR]);

  const url = (io.readUrl ?? readWebhookUrl)(stackName);
  const answer = url === undefined ? undefined : await (io.post ?? postUnsigned)(url);

  return {
    findings: dispatchWebhookFindings({ url, answer, stackName }),
    // Said out loud on every run, finding or not: the answer is what an
    // operator reading the deploy compares with the hook's Recent Deliveries.
    notes: [`${stackName} ${URL_OUTPUT}: ${url ?? `(no ${URL_OUTPUT} output)`}`
      + (answer ? `; unsigned POST answered ${answer.status}${answer.errorType ? ` ${answer.errorType}` : ''}` : '')],
  };
}

/**
 * The findings on what a hook path answered an unsigned post: none for the
 * receiver's 401, one for anything else.
 *
 * @param {object} sides
 * @param {string | undefined} sides.url - The hook path's URL, or undefined
 *   when the stack has no `URL_OUTPUT`.
 * @param {Answer | undefined} sides.answer
 * @param {string} [sides.stackName]
 * @returns {string[]}
 */
export function hookUrlFindings({ url, answer, stackName = 'the dispatch stack' }) {
  if (url === undefined || answer === undefined) return [`${stackName} has no ${URL_OUTPUT} output, so there is no hook path to post to`];
  if (answer.status === 401) return [];
  const said = `${answer.status}${answer.errorType ? ` ${answer.errorType}` : ''}: ${answer.body.slice(0, 200)}`;
  if (answer.status >= 200 && answer.status < 300) {
    return [`${url} answered an unsigned hook post ${said}, not 401: the receiver is not checking a hook's signature before it answers`];
  }
  return [`${url} answered an unsigned hook post ${said}, not the receiver's 401: a hook request does not reach its signature check. Read /aws/lambda/governor-webhook`];
}

/**
 * The runner reports it not applicable, and never calls it, while
 * GOVERNOR_STACK is unset.
 *
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   readUrl?: typeof readWebhookUrl,
 *   post?: typeof postUnsigned,
 * }} options
 * @returns {Promise<import('../conformance.mjs').CheckOutcome>}
 */
export async function checkHookUrl({ env, ...io }) {
  const stackName = /** @type {string} */ (env[STACK_VAR]);
  const base = (io.readUrl ?? readWebhookUrl)(stackName);
  const url = base === undefined ? undefined : `${base.endsWith('/') ? base : `${base}/`}${HOOK_PROBE_PATH}`;
  const answer = url === undefined ? undefined : await (io.post ?? postUnsigned)(url);
  return {
    findings: hookUrlFindings({ url, answer, stackName }),
    notes: [`unsigned POST to ${url ?? `(no ${URL_OUTPUT} output)`}${answer ? ` answered ${answer.status}` : ''}`],
  };
}
