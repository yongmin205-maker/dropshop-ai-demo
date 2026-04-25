/**
 * PII redaction helpers.
 *
 * The processingLogs table is a public-facing audit trail (the demo dashboard
 * exposes every step). We must NOT persist raw E.164 phone numbers, street
 * addresses, or full customer SMS bodies in plaintext within `detail` JSON.
 *
 * Strategy:
 *   - Phone numbers are reduced to "+•••••••" + last 4 digits.
 *   - Multi-line addresses keep only the city/state suffix when detectable,
 *     otherwise become "[address redacted]".
 *   - Free-text bodies are truncated to 280 chars and any embedded phone /
 *     email patterns inside them are masked.
 *
 * Designed so callers can do:
 *   appendProcessingLog({ ..., detail: redactPII(detail) })
 */

const E164_RE = /\+\d{8,15}/g;
const NA_PHONE_RE = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

export function maskPhone(input: string): string {
  if (!input) return input;
  if (/^\+\d+$/.test(input)) {
    const tail = input.slice(-4);
    return `+•••••${tail}`;
  }
  return input;
}

export function maskAddress(input: string): string {
  if (!input) return input;
  // Strip the street number + street name; keep last comma-separated chunks
  // (typically "City, ST" or "Borough, NY") if present.
  const parts = input.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return `[address redacted], ${parts.slice(-2).join(", ")}`;
  }
  return "[address redacted]";
}

/**
 * Mask phone numbers and email addresses appearing inside a free-text string,
 * and clip to a max length so an attacker cannot inflate log size.
 */
export function redactText(input: string, maxLen = 280): string {
  if (!input) return input;
  const masked = input
    .replace(E164_RE, (m) => maskPhone(m))
    .replace(NA_PHONE_RE, "•••-•••-••••")
    .replace(EMAIL_RE, "[email redacted]");
  if (masked.length <= maxLen) return masked;
  return masked.slice(0, maxLen) + "…";
}

/**
 * Recursively walk a `detail` JSON object and redact obvious PII fields.
 * Keys treated as PII: phone, customerPhone, address, body, customerBody,
 * reply, rejectedReply.
 */
export function redactPII<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactPII(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v == null) {
        out[k] = v;
        continue;
      }
      const lk = k.toLowerCase();
      if (lk === "phone" || lk === "customerphone" || lk === "from" || lk === "to") {
        out[k] = typeof v === "string" ? maskPhone(v) : v;
      } else if (lk === "address") {
        out[k] = typeof v === "string" ? maskAddress(v) : v;
      } else if (
        lk === "body" ||
        lk === "customerbody" ||
        lk === "reply" ||
        lk === "rejectedreply" ||
        lk === "approvedreply" ||
        lk === "reason" ||
        lk === "label"
      ) {
        out[k] = typeof v === "string" ? redactText(v) : v;
      } else {
        out[k] = redactPII(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}
