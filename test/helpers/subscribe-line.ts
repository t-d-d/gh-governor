/**
 * A `governor:subscribe` line, as a body written before governor stopped
 * reading them may still carry one. Governor names nobody by it and never
 * reads it as the owner (dispatch/webhook/subscribe.mjs); the tests build
 * bodies with it to show that.
 */
export const subscribeLine = (session: string, events?: readonly string[]) =>
  `<!-- governor:subscribe ${session}${events ? ` events=${events.join(',')}` : ''} -->`;
