/**
 * Provider-agnostic inbound messaging types.
 *
 * Lives in `shared/` so both server (adapters, pipeline) and client (shadow
 * inbox UI) speak the same vocabulary. Concrete vendor SDKs / payloads are
 * NEVER imported from here — adapters do the translation.
 *
 * Design intent:
 *   - Stay in front of vendor lock-in. Today: Quo (formerly OpenPhone) +
 *     Twilio. Tomorrow: Bandwidth, Telnyx, Sinch — all collapse to this type.
 *   - Carry enough metadata that the agent + retrieval layers can do their
 *     job without re-querying the provider.
 *   - Preserve `raw` so audits / debugging never lose vendor-specific signal.
 */

export type MessagingProvider = "quo" | "twilio";

/**
 * One inbound message, normalized.
 *
 * - `provider` + `providerMessageId` together form a globally unique idempotency
 *   key. The pipeline MUST refuse to process the same `(provider, providerMessageId)`
 *   twice (replay / retry / accidental double-delivery).
 * - `from` / `to` are E.164 (`+14155550100`). Adapters that receive non-E.164
 *   numbers MUST normalize before constructing this type.
 * - `body` is the human-readable text. May be empty for media-only messages.
 * - `mediaUrls` is empty for text-only messages. Each entry is a fully
 *   resolvable HTTPS URL the agent can hand to vision / file-handling tools.
 * - `receivedAt` is a UTC Unix timestamp in milliseconds (matches the
 *   project-wide datetime convention).
 * - `conversationId` / `contactId` are vendor-specific opaque identifiers
 *   when the provider exposes them (Quo does, Twilio doesn't). Useful for
 *   cross-referencing inside the vendor UI but not used for routing.
 * - `raw` is the original payload, retained for audit trails.
 */
export type InboundMessage = {
  provider: MessagingProvider;
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
  receivedAt: number;
  conversationId?: string;
  contactId?: string;
  raw: unknown;
};

/**
 * Result type for adapter signature verification. Discriminated so the caller
 * can log a precise rejection reason without grepping error strings.
 */
export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason };

export type SignatureFailureReason =
  | "missing_header"
  | "missing_key"
  | "malformed_header"
  | "bad_signature"
  | "stale_timestamp"
  | "future_timestamp";

/**
 * Mode flag for the inbound pipeline.
 *
 * - "shadow": agent generates drafts, persists to a shadow inbox, but the
 *   outbound adapter is never invoked. Safe to point a real customer phone
 *   number at this mode.
 * - "live":  agent drafts go through the existing HITL approval queue; only
 *   after explicit human approval does the outbound adapter send. Enabling
 *   live mode requires both a feature flag (`MESSAGING_LIVE_MODE=1`) and an
 *   admin-approved configuration row.
 */
export type MessagingMode = "shadow" | "live";
