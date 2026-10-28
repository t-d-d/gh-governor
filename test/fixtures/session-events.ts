/**
 * Event pages of `GET /v1/code/sessions/cse_<id>/events?limit=100`, as the
 * deployed dispatcher read them before it added `sort_order=desc`.
 * Measured there: the newest events,
 * newest first, no `has_more`; each event carries `event_id`, `event_type`,
 * `payload`, `created_at`, `processed_at` or `sent_by_account_id`,
 * `sequence_num` and `device_attestation_status`. Inferred, not yet
 * measured: `payload` is the stream message the account's session tools
 * showed under `internal_anthropic_catchall`, with its `type`. The turns are
 * the ones those tools returned on 27 Oct, trimmed and
 * with the reply text rewritten.
 *
 * - A cloud session (session_01CLOUDA): the last `result`
 *   carries the reply, and Stop-hook and end-session events follow it.
 * - A Remote Control session (session_01CLOUDB,
 *   `environment_kind: bridge`): every `result` reads `result: ""` at zero
 *   cost; the reply is the assistant message before it, with a `system` init
 *   event between them.
 */

let sequence = 0;

/** One event as the endpoint answers it. */
export const event = (type: string, created: string, payload: Record<string, unknown>) => {
  sequence += 1;
  return {
    event_id: `ev-${sequence}`,
    event_type: type,
    payload: { type, uuid: `u-${sequence}`, ...payload },
    created_at: created,
    processed_at: created,
    sequence_num: sequence,
    device_attestation_status: 'none',
  };
};

const assistant = (created: string, content: unknown[]) => event('assistant', created, {
  message: { container: null, content, id: `msg-${created}`, model: 'claude-opus-5-5', role: 'assistant', stop_reason: null, type: 'message' },
  parent_tool_use_id: null,
  session_id: 'cse_01X',
});

const result = (created: string, text: string, cost = 1.5) => event('result', created, {
  duration_ms: cost === 0 ? 0 : 6961, is_error: false, num_turns: 1, result: text, session_id: 'cse_01X', stop_reason: 'end_turn', subtype: 'success', total_cost_usd: cost,
});

const hook = (created: string) => event('system', created, { hook_event: 'Stop', hook_name: 'Stop', outcome: 'success', subtype: 'hook_response' });

/** Written oldest first, as a turn runs; answered newest first. */
const page = (data: unknown[]) => ({ data: [...data].reverse() });

const toolUse = { caller: { type: 'direct' }, id: 'toolu_01', input: { command: 'aws logs filter-log-events' }, name: 'Bash', type: 'tool_use' };
const thinking = { signature: 'CAQS', thinking: '', type: 'thinking' };

export const CLOUD_REPLY = 'PR #973 is merged and deployed.\n\nSigning off: #967 is closed and the sweep is archiving.';
export const NOT_SIGNED = 'PR #973 is open and waiting on review. I\'m not signing off.';

/** A cloud session whose last turn signed off. */
export const cloudSignedOff = page([
  result('2026-10-17T19:27:51Z', NOT_SIGNED),
  assistant('2026-10-17T19:28:40Z', [thinking]),
  assistant('2026-10-17T19:28:41Z', [toolUse]),
  assistant('2026-10-17T19:28:54Z', [{ text: CLOUD_REPLY, type: 'text' }]),
  result('2026-10-17T19:28:57Z', CLOUD_REPLY),
  hook('2026-10-17T19:28:57.7Z'),
  event('control_request', '2026-10-17T19:29:10Z', { request: { reason: 'archived', subtype: 'end_session' }, request_id: 'req_01' }),
]);

/** A cloud session signed off once, then prompted again: its newer reply did not. */
export const cloudSignedOffThenNot = page([
  assistant('2026-10-17T19:28:54Z', [{ text: CLOUD_REPLY, type: 'text' }]),
  result('2026-10-17T19:28:57Z', CLOUD_REPLY),
  assistant('2026-10-17T19:40:00Z', [{ text: NOT_SIGNED, type: 'text' }]),
  result('2026-10-17T19:40:02Z', NOT_SIGNED),
]);

export const BRIDGE_REPLY = 'I switched the default AI Task to Claude, and a test request through it worked.\n\n**Signing off.**';

/** A Remote Control session whose last turn signed off. */
export const bridgeSignedOff = page([
  assistant('2026-10-24T08:50:30.1Z', [toolUse]),
  event('user', '2026-10-24T08:50:30.2Z', { message: { content: [{ content: 'The file has been updated.', tool_use_id: 'toolu_01', type: 'tool_result' }], role: 'user' } }),
  assistant('2026-10-24T08:50:36Z', [{ text: BRIDGE_REPLY, type: 'text' }]),
  event('system', '2026-10-24T08:50:36.8Z', { claude_code_version: '2.1.308', subtype: 'init', tools: [] }),
  result('2026-10-24T08:50:36.9Z', '', 0),
  event('control_request', '2026-10-27T11:06:19Z', { request: { reason: 'archived', subtype: 'end_session' }, request_id: 'req_02' }),
]);

/** A Remote Control session whose last turn did not sign off. */
export const bridgeNotSigned = page([
  assistant('2026-10-24T08:50:36Z', [{ text: NOT_SIGNED, type: 'text' }]),
  result('2026-10-24T08:50:36.9Z', '', 0),
]);

/**
 * A Remote Control session's sign-off turn that a served repo's Stop hook
 * continued with a request to archive itself:
 * the sign-off, the request handed back as a prompt, then the reply to it.
 * Inferred, not measured: the request reads as a user message whose content
 * is the hook's text.
 */
export const bridgeAfterRequest = (reply: string) => page([
  assistant('2026-10-27T15:29:00Z', [{ text: BRIDGE_REPLY, type: 'text' }]),
  event('user', '2026-10-27T15:29:01Z', { message: { content: 'Stop hook feedback:\nSigned off. If you have the tool mcp__ccd_session_mgmt__archive_session…', role: 'user' } }),
  assistant('2026-10-27T15:29:05Z', [{ text: reply, type: 'text' }]),
  result('2026-10-27T15:29:06Z', '', 0),
]);

/**
 * A session's events read a page at a time. session_01BRIDGE's
 * last `result` (18 Oct) lay behind some 300 newer events, `active_goal`,
 * `autocompact_state`, `control_request`, `control_response` and the like.
 * The raw endpoint ignores `before_id`: the deployed sweep got the
 * newest page again. The CLI pages it with
 * `?limit=N&sort_order=desc&cursor=<next_cursor>`, and reads `{ data,
 * next_cursor }`, where `next_cursor` "continues with events older than this
 * page" and is absent on the last. `events(cursor)` answers that: the newest
 * `limit` events from where `cursor` points, newest first, with an opaque
 * `next_cursor` that is not an `event_id`, absent on the page holding the
 * session's oldest event.
 */
export const pagedHistory = (written: Array<{ event_id: string }>, limit = 100) => {
  const newestFirst = [...written].reverse();
  const opaque = (from: number) => `c1.${Buffer.from(`offset:${from}`).toString('base64url')}`;
  return (cursor?: string) => {
    const from = cursor === undefined ? 0 : Number(/^offset:(\d+)$/.exec(Buffer.from(cursor.slice('c1.'.length), 'base64url').toString())?.[1]);
    if (!(from <= newestFirst.length) || (cursor !== undefined && opaque(from) !== cursor)) throw new Error(`not a cursor this history handed out: ${cursor}`);
    const next = from + limit;
    return { data: newestFirst.slice(from, next), ...(next < newestFirst.length && { next_cursor: opaque(next) }) };
  };
};

/** `count` control and state events after `at`, as a woken, idle session logs them. */
export const stateEvents = (count: number, at = '2026-10-20T00:00:00Z') => Array.from({ length: count }, (_, i) => {
  const kinds = ['active_goal', 'autocompact_state', 'control_request', 'control_response'];
  const kind = kinds[i % kinds.length]!;
  return event(kind, new Date(Date.parse(at) + i * 1000).toISOString(), { subtype: kind });
});

/** Oldest first: the cloud session's signed-off turn, then 250 state events. */
export const signedOffBehind = [...[...cloudSignedOff.data].reverse(), ...stateEvents(250)] as Array<{ event_id: string }>;
