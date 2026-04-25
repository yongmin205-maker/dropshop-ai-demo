/**
 * Shared SMS segment estimator used by both `server/twilio.ts` (authoritative
 * billing-cap enforcement) and `client/src/pages/Home.tsx` (operator hint on
 * the Approval Queue). Keeping a single implementation prevents the UI from
 * giving the operator a green-light estimate that the server then refuses.
 *
 * GSM-7 alphabet  = 160 chars in a single segment, 153 each in multi-segment.
 * Any non-GSM char (emoji, Chinese, accented chars beyond the GSM set, etc.)
 * bumps the whole message to UCS-2 = 70 single / 67 multi.
 *
 * This is a conservative estimate — exact billing always comes from Twilio.
 */
export function smsSegmentCount(body: string): number {
  if (!body) return 0;
  const isGsm = /^[\x00-\x7F\u00A3\u00A5\u00E0\u00E8\u00E9\u00EC\u00F2\u00F9\u20AC]*$/.test(body);
  const len = body.length;
  if (isGsm) {
    if (len <= 160) return 1;
    return Math.ceil(len / 153);
  }
  if (len <= 70) return 1;
  return Math.ceil(len / 67);
}
