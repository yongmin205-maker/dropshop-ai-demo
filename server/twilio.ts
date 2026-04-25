/**
 * Twilio integration — REST send + inbound webhook signature validation.
 *
 * Production hardening:
 *   • E.164 phone validation before any outbound call (no wasted API calls).
 *   • 8s AbortController timeout on outbound HTTPS to Twilio (no slow-loris).
 *   • Native HMAC-SHA1 signature validation (no SDK dependency) so we can
 *     verify inbound webhooks per Twilio's documented algorithm.
 *   • SMS segment counter so the UI / approval flow can warn before billing.
 */

import { createHmac } from "node:crypto";

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export function isE164(phone: string): boolean {
  return E164_REGEX.test(phone.trim());
}

export function isLiveMode(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER,
  );
}

export function getDemoPhoneNumber(): string | null {
  return process.env.TWILIO_PHONE_NUMBER ?? null;
}

/**
 * Estimate SMS segment count.
 * GSM-7 alphabet = 160 chars / segment, multi-segment = 153 each.
 * Any non-GSM character bumps the whole message to UCS-2 = 70 / 67 each.
 *
 * This is a *conservative* estimate — exact billing comes from Twilio.
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

const TWILIO_TIMEOUT_MS = 8_000;

// §5.2 Hard cap on outbound SMS segments per send. Defends against (a) a
// hallucinated 600-character agent reply that would silently bill 4+ segments,
// (b) a malicious / accidental approve of a giant draft. Override via
// `MAX_SMS_SEGMENTS` env if a campaign legitimately needs more.
const MAX_SMS_SEGMENTS = Math.max(
  1,
  Number(process.env.MAX_SMS_SEGMENTS ?? 4),
);

export type SendResult =
  | { ok: true; sid: string }
  | { ok: false; error: string };

export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (!isLiveMode()) {
    return { ok: false, error: "Live Mode disabled (Twilio creds not set)" };
  }
  if (!isE164(to)) {
    return { ok: false, error: `Invalid E.164 phone: ${to}` };
  }
  if (!body || body.trim().length === 0) {
    return { ok: false, error: "Empty SMS body" };
  }
  const segs = smsSegmentCount(body);
  if (segs > MAX_SMS_SEGMENTS) {
    return {
      ok: false,
      error: `SMS too long: ${segs} segments (max ${MAX_SMS_SEGMENTS}). Shorten the reply or raise MAX_SMS_SEGMENTS.`,
    };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_PHONE_NUMBER!;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: from, Body: body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TWILIO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Twilio ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string };
    if (!json.sid) return { ok: false, error: "Twilio returned no sid" };
    return { ok: true, sid: json.sid };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `Twilio request timed out after ${TWILIO_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate Twilio's `X-Twilio-Signature` header per:
 * https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Algorithm: HMAC-SHA1 of (full URL + concat of sorted "key+value" pairs of POST form fields),
 * base64-encoded, compared against the header.
 *
 * `url` MUST be the exact URL Twilio called, including protocol+host+path+query.
 * Behind a reverse proxy you must reconstruct from `X-Forwarded-Proto` + `X-Forwarded-Host`.
 */
export function validateTwilioSignature(opts: {
  signatureHeader: string | undefined | null;
  url: string;
  params: Record<string, string>;
  authToken?: string;
}): boolean {
  const token = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? "";
  if (!token || !opts.signatureHeader) return false;
  const sortedKeys = Object.keys(opts.params).sort();
  let data = opts.url;
  for (const k of sortedKeys) data += k + opts.params[k];
  const expected = createHmac("sha1", token).update(data).digest("base64");
  // constant-time-ish compare
  if (expected.length !== opts.signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ opts.signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

export function reconstructWebhookUrl(req: {
  protocol: string;
  get: (h: string) => string | undefined;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const fwdProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const fwdHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const proto = fwdProto || req.protocol || "https";
  const host = fwdHost || req.get("host") || "";
  return `${proto}://${host}${req.originalUrl}`;
}
