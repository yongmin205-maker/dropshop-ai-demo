/**
 * Server-side adapter contract for inbound messaging providers.
 *
 * A `MessagingInboundAdapter` is the thin translation layer between a vendor
 * (Quo, Twilio, Bandwidth, …) and our provider-agnostic `InboundMessage`. The
 * inbound pipeline never talks to the vendor directly — it asks the adapter
 * to verify the signature and parse the payload.
 *
 * Contract for adapter implementors:
 *   1. `verifySignature` MUST be called BEFORE `parsePayload`. The pipeline
 *      enforces this ordering. If verification fails, the request is rejected
 *      with HTTP 401 and `parsePayload` is never invoked.
 *   2. `verifySignature` operates on the RAW body bytes that came off the
 *      wire. Re-serializing JSON would defeat the HMAC. The Express handler
 *      therefore uses `express.raw({ type: '*\/*' })` for the inbound route.
 *   3. `parsePayload` returns `null` for events the adapter does not handle
 *      (e.g. delivery receipts, read confirmations, status updates). The
 *      pipeline treats `null` as "ack 200, do nothing".
 *   4. Adapters MUST normalize phone numbers to E.164 (`+14155550100`).
 *   5. Adapters MUST NOT throw on malformed payloads — return `null` instead.
 *      Throwing would surface as 500 to the vendor and trigger retries.
 */

import type { InboundMessage, SignatureVerifyResult } from "../../shared/messaging";

export type AdapterHeaders = Record<string, string | string[] | undefined>;

export interface MessagingInboundAdapter {
  /**
   * Stable, lowercase identifier matching `InboundMessage.provider`.
   */
  readonly provider: "quo" | "twilio";

  /**
   * Verify the vendor's signature against the raw request body.
   *
   * @param headers       Lowercased header map from the HTTP request.
   * @param rawBody       The raw request body as received (Buffer-like).
   * @param signingKey    The webhook signing secret. Provided by the caller
   *                       so the adapter never reads env directly (testability).
   * @param nowMs         Current UTC ms. Injected for deterministic replay tests.
   * @param replayWindowMs Optional override for the freshness window.
   *                       Defaults to 5 minutes.
   */
  verifySignature(args: {
    headers: AdapterHeaders;
    rawBody: Buffer | string;
    signingKey: string;
    nowMs: number;
    replayWindowMs?: number;
  }): SignatureVerifyResult;

  /**
   * Translate a verified vendor payload into our normalized type.
   * Returns `null` for events the adapter intentionally ignores.
   */
  parsePayload(args: {
    rawBody: Buffer | string;
    receivedAt: number;
  }): InboundMessage | null;
}

/**
 * Constant-time string compare. The pipeline relies on this everywhere a
 * cryptographic comparison happens.
 *
 * Standard `===` short-circuits on the first differing byte, which leaks
 * timing information that an attacker can exploit to forge signatures
 * byte-by-byte. Always compare HMAC digests through this helper.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
