/**
 * Quo (formerly OpenPhone) inbound webhook adapter.
 *
 * Reference: https://support.quo.com/core-concepts/integrations/webhooks
 *
 * Signature algorithm (verbatim from the docs):
 *   1. Header `openphone-signature`: `<scheme>;<version>;<timestamp>;<sig>`
 *      e.g. `hmac;1;1639710054089;mw1K4fvh5m9XzsGon4C5N3KvL0bkmPZSAyb/9Vms2Qo=`
 *   2. `signedData = `${timestamp}.${rawJsonBodyWithNoWhitespaceTrim}``
 *      We use the request body bytes verbatim as received (Quo guarantees
 *      it sends compact JSON; the docs warn against re-serializing).
 *   3. `key = base64Decode(signingKey)` — used as binary HMAC key.
 *   4. `expected = HMAC-SHA256(key, signedData)` base64-encoded.
 *   5. Compare expected vs provided in constant time.
 *
 * Replay defense: timestamps older than 5 minutes (or in the future by
 * more than 1 minute, allowing for small clock drift) are rejected.
 *
 * Header name: the docs prefix is still "openphone-" even after the Quo
 * rebrand — Quo confirms backwards compatibility on `openphone-signature`.
 * We accept both `openphone-signature` and `quo-signature` (forward compat).
 */

import { createHmac } from "node:crypto";

import type { InboundMessage } from "../../shared/messaging";
import {
  type AdapterHeaders,
  type MessagingInboundAdapter,
  constantTimeEqual,
  DEFAULT_REPLAY_WINDOW_MS,
} from "./types";

const FUTURE_DRIFT_TOLERANCE_MS = 60 * 1000; // 1 minute

function pickHeader(headers: AdapterHeaders, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function bodyToString(rawBody: Buffer | string): string {
  return typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
}

/**
 * Normalize a phone number to E.164. Quo always sends E.164 (`+14155550100`),
 * but defensive trimming lets us survive edge cases where a vendor leaks
 * a trailing whitespace or includes display formatting in a future revision.
 */
function normalizePhone(input: unknown): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed.replace(/[^\d+]/g, "");
  // Best-effort fallback: bare 10/11-digit US number → +1...
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

export const quoAdapter: MessagingInboundAdapter = {
  provider: "quo",

  verifySignature({ headers, rawBody, signingKey, nowMs, replayWindowMs }) {
    if (!signingKey) return { ok: false, reason: "missing_key" };
    const sigHeader =
      pickHeader(headers, "openphone-signature") ??
      pickHeader(headers, "quo-signature");
    if (!sigHeader) return { ok: false, reason: "missing_header" };

    const fields = sigHeader.split(";");
    if (fields.length !== 4) return { ok: false, reason: "malformed_header" };
    const [scheme, version, timestampStr, providedDigest] = fields;
    if (scheme !== "hmac" || version !== "1") {
      return { ok: false, reason: "malformed_header" };
    }

    const timestamp = Number(timestampStr);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return { ok: false, reason: "malformed_header" };
    }

    const window = replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    const age = nowMs - timestamp;
    if (age > window) return { ok: false, reason: "stale_timestamp" };
    if (age < -FUTURE_DRIFT_TOLERANCE_MS) {
      return { ok: false, reason: "future_timestamp" };
    }

    // Per docs: `signedData = timestamp + "." + rawBody`. The body is used
    // exactly as received (no re-serialization).
    const bodyStr = bodyToString(rawBody);
    const signedData = `${timestampStr}.${bodyStr}`;

    // Per docs: signing key is base64-decoded, then used as a *binary string*
    // (NOT as raw bytes via Buffer). The reference Node.js example does:
    //   Buffer.from(signingKey, 'base64').toString('binary')
    // We replicate that to match the docs sample byte-for-byte.
    const signingKeyBinary = Buffer.from(signingKey, "base64").toString("binary");

    const expected = createHmac("sha256", signingKeyBinary)
      .update(Buffer.from(signedData, "utf8"))
      .digest("base64");

    if (!constantTimeEqual(expected, providedDigest)) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: true };
  },

  parsePayload({ rawBody, receivedAt }) {
    let event: unknown;
    try {
      event = JSON.parse(bodyToString(rawBody));
    } catch {
      return null;
    }
    if (!event || typeof event !== "object") return null;
    const evObj = event as Record<string, unknown>;

    if (evObj.type !== "message.received") {
      // Other events (message.delivered, call.*, contact.*) are out of scope
      // for the inbound-message pipeline. Returning null = ack 200, no-op.
      return null;
    }

    const data = evObj.data as Record<string, unknown> | undefined;
    const obj = data?.object as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") return null;

    const providerMessageId = typeof obj.id === "string" ? obj.id : null;
    const from = normalizePhone(obj.from);
    const to = normalizePhone(obj.to);
    if (!providerMessageId || !from || !to) return null;

    const body = typeof obj.body === "string" ? obj.body : "";
    const mediaUrlsRaw = Array.isArray(obj.media)
      ? (obj.media as Array<Record<string, unknown>>)
          .map((m) => (typeof m.url === "string" ? m.url : null))
          .filter((u): u is string => Boolean(u))
      : Array.isArray(obj.mediaUrls)
        ? (obj.mediaUrls as unknown[]).filter(
            (u): u is string => typeof u === "string",
          )
        : [];

    const conversationId =
      typeof obj.conversationId === "string" ? obj.conversationId : undefined;
    const contactId =
      typeof obj.contactId === "string" ? obj.contactId : undefined;

    const inbound: InboundMessage = {
      provider: "quo",
      providerMessageId,
      from,
      to,
      body,
      mediaUrls: mediaUrlsRaw,
      receivedAt,
      conversationId,
      contactId,
      raw: event,
    };
    return inbound;
  },
};
