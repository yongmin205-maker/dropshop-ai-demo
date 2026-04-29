/**
 * MessageTransport — the seam between "we want to send an SMS" and "what
 * actually happens on the wire".
 *
 * Why this module exists (see CODE_AUDIT §5.3 Candidate 2 + ADR 0008):
 *
 *   - Before this module the choice between calling Twilio for real and
 *     not-calling-anything-because-creds-are-missing was buried inside
 *     `sendSms()`. The Simulator path was modeled as "live mode disabled"
 *     and surfaced as a fake `{ ok: false, error: "Live Mode disabled" }`
 *     to callers, which conflated *intentional Simulator behaviour* with
 *     *transport failure*. Tests had to `vi.mock("./twilio")` wholesale to
 *     get past it.
 *
 *   - This module defines a single `MessageTransport` interface with two
 *     real Adapters today (`TwilioAdapter`, `SimulatorAdapter`) and a
 *     defensive `ShadowGuardTransport` for any path that should *never*
 *     send. Callers depend on the interface; the boot-time
 *     `getMessageTransport()` picks the correct Adapter once.
 *
 *   - Adding OpenPhone or Nextiva later is one new file
 *     (`OpenPhoneAdapter` implementing `MessageTransport`) plus one line
 *     in `getMessageTransport()`. Caller code does not change.
 *
 * Result vocabulary:
 *
 *   { ok: true,  sid }
 *     The carrier accepted the message and assigned it an external id.
 *
 *   { ok: false, error, code, retryable }
 *     The carrier (or the local guard layer) rejected. `retryable` lets
 *     `twoPhaseSend.recordTwoPhaseSendFailure` decide whether to re-open
 *     the originating Draft (retryable=true) or mark it permanently
 *     dropped (retryable=false, future work — today we always re-open).
 */

import { isE164, isLiveMode, sendSms as twilioSendSms } from "../twilio";

export type SendResult =
  | { ok: true; sid: string }
  | { ok: false; error: string; code?: string; retryable?: boolean };

export interface MessageTransport {
  /** Stable name used in processingLog labels and metrics. */
  readonly name: "twilio" | "simulator" | "shadow-guard" | (string & {});
  send(to: string, body: string): Promise<SendResult>;
}

// ---------- Twilio (live carrier) ----------

export const TwilioAdapter: MessageTransport = {
  name: "twilio",
  async send(to, body) {
    const result = await twilioSendSms(to, body);
    if (result.ok) return { ok: true, sid: result.sid };
    return { ok: false, error: result.error, code: "twilio_error", retryable: true };
  },
};

// ---------- Simulator (in-process; default for the demo) ----------

let simulatorSeq = 0;

/** Synthetic SID prefix so it is obvious in logs that no carrier was hit. */
const SIMULATOR_SID_PREFIX = "SIM";

export interface SimulatorTransport extends MessageTransport {
  readonly name: "simulator";
  /** Read-only view of every send made through this transport. */
  readonly sends: ReadonlyArray<{ to: string; body: string; sid: string; at: number }>;
  /** Test helper: clear the recorded send log. */
  reset(): void;
}

/**
 * Build a simulator transport. The default singleton (`simulatorTransport`)
 * is used by `getMessageTransport()`; tests construct their own to avoid
 * cross-test bleed.
 */
export function createSimulatorTransport(): SimulatorTransport {
  const sends: Array<{ to: string; body: string; sid: string; at: number }> = [];
  return {
    name: "simulator",
    get sends() {
      return sends;
    },
    reset() {
      sends.length = 0;
    },
    async send(to, body) {
      if (!isE164(to)) {
        return {
          ok: false,
          error: `Invalid E.164 phone: ${to}`,
          code: "invalid_phone",
          retryable: false,
        };
      }
      if (!body || body.trim().length === 0) {
        return {
          ok: false,
          error: "Empty SMS body",
          code: "empty_body",
          retryable: false,
        };
      }
      simulatorSeq += 1;
      const sid = `${SIMULATOR_SID_PREFIX}${Date.now()}${simulatorSeq.toString().padStart(4, "0")}`;
      sends.push({ to, body, sid, at: Date.now() });
      return { ok: true, sid };
    },
  };
}

export const simulatorTransport: SimulatorTransport = createSimulatorTransport();

// ---------- Shadow guard (any send is a programmer error) ----------

/**
 * Used by `inboundPipeline.ts` shadow-mode paths. If anything routes a send
 * through here it is a bug — shadow inbound webhooks must never reply. We
 * surface as a hard rejection with `retryable=false` so the failure branch
 * does not re-open a Draft for human re-send.
 */
export const ShadowGuardTransport: MessageTransport = {
  name: "shadow-guard",
  async send(to, body) {
    return {
      ok: false,
      error:
        "SHADOW_OUTBOUND_GUARD invoked: shadow mode must never call send. " +
        `to=${to} body_len=${body.length}`,
      code: "shadow_guard",
      retryable: false,
    };
  },
};

// ---------- Boot-time selector ----------

/**
 * Returns the transport this process should use for "real" sends.
 *
 * Selection rules (kept deliberately simple):
 *
 *   1. If Twilio creds are present (`isLiveMode()` true) AND the explicit
 *      kill-switch `DROPSHOP_LIVE_MODE` is set to `1` → TwilioAdapter.
 *   2. Otherwise → `simulatorTransport`.
 *
 * The two-flag rule (creds AND kill-switch) is intentional: it is too easy
 * to leak Twilio creds into a dev/preview env and start sending to real
 * customers. Both must be present.
 */
/**
 * Boot-time predicate: true iff the active transport will hit a real
 * carrier. The same two-flag rule as `getMessageTransport()` (Twilio creds
 * present AND `DROPSHOP_LIVE_MODE=1`).
 *
 * Surface this through `config.get.liveMode` so the operator-facing badge
 * agrees with the transport that will actually run. Pre-patch the badge
 * read raw `isLiveMode()` (creds only), so a process with creds but no
 * kill-switch advertised "live" while transport silently used the
 * simulator — a confusing dual reality.
 */
export function isTransportLive(): boolean {
  return process.env.DROPSHOP_LIVE_MODE === "1" && isLiveMode();
}

export function getMessageTransport(): MessageTransport {
  if (isTransportLive()) return TwilioAdapter;
  return simulatorTransport;
}
