/**
 * Provider-agnostic inbound pipeline.
 *
 * Sits between the verified-and-normalized `InboundMessage` (output of any
 * adapter) and the rest of our system (dropshopAgent, shadow inbox, optional
 * outbound send).
 *
 * Two modes:
 *   - "shadow": agent generates a draft, persisted into the shadow inbox.
 *     The outbound function is NEVER called. Even if a developer mistakenly
 *     wires it in, the pipeline rejects the call. This mode is the only safe
 *     way to point a real customer phone number at the demo before the friend
 *     has formally approved going live.
 *   - "live":  the draft enters the existing HITL approval queue. Sending is
 *     gated by `MESSAGING_LIVE_MODE=1` AND a per-message human approval.
 *     This pipeline never sends autonomously even in live mode — it just
 *     stops blocking the existing approval-queue flow.
 *
 * Idempotency: callers MUST consult `wasAlreadyProcessed(provider, providerMessageId)`
 * before invoking the pipeline. Quo + Twilio both retry on non-2xx, so a
 * crash-and-recover loop must not produce duplicate drafts.
 */

import type { InboundMessage, MessagingMode } from "../../shared/messaging";

/**
 * Minimal agent contract the pipeline depends on. Concrete agents (DropShop,
 * Salon) implement this. Kept inline so the pipeline does not depend on the
 * agent module's full surface — easier to mock in tests.
 */
export type DraftAgent = (msg: InboundMessage) => Promise<{
  intent: string;
  draftBody: string;
  confidence: number;
}>;

/**
 * Storage adapter for the shadow inbox. The pipeline calls `persistShadowDraft`
 * for both shadow and live mode (live mode just additionally enqueues the
 * existing HITL draft). The DB-backed implementation lives in
 * `server/db.ts` once the schema migration lands; tests inject a fake.
 */
export interface ShadowInboxStore {
  persistShadowDraft(record: {
    inbound: InboundMessage;
    intent: string;
    draftBody: string;
    confidence: number;
    receivedAt: number;
  }): Promise<{ id: number }>;
}

export interface OutboundSender {
  sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string }>;
}

/**
 * Sentinel sender used in shadow mode. If anything tries to actually send,
 * we throw so the test suite catches the bug immediately.
 */
export const SHADOW_OUTBOUND_GUARD: OutboundSender = {
  async sendSms() {
    throw new Error(
      "SHADOW_OUTBOUND_GUARD invoked: shadow mode must never call sendSms. " +
        "If you see this in production, the pipeline mode flipped to 'live' " +
        "without going through the explicit feature flag.",
    );
  },
};

export type PipelineResult =
  | { ok: true; mode: MessagingMode; shadowDraftId: number; intent: string }
  | { ok: false; reason: "duplicate" | "agent_failed"; detail?: string };

export interface PipelineDeps {
  agent: DraftAgent;
  shadowStore: ShadowInboxStore;
  outbound?: OutboundSender; // omitted entirely in shadow mode
  isAlreadyProcessed?: (
    provider: InboundMessage["provider"],
    providerMessageId: string,
  ) => Promise<boolean>;
}

export async function runInboundPipeline(
  msg: InboundMessage,
  mode: MessagingMode,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  if (mode === "shadow" && deps.outbound && deps.outbound !== SHADOW_OUTBOUND_GUARD) {
    throw new Error(
      "Shadow mode requires either no outbound sender or the SHADOW_OUTBOUND_GUARD sentinel.",
    );
  }

  if (deps.isAlreadyProcessed) {
    const dup = await deps.isAlreadyProcessed(msg.provider, msg.providerMessageId);
    if (dup) return { ok: false, reason: "duplicate" };
  }

  let draft: { intent: string; draftBody: string; confidence: number };
  try {
    draft = await deps.agent(msg);
  } catch (err) {
    return {
      ok: false,
      reason: "agent_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const persisted = await deps.shadowStore.persistShadowDraft({
    inbound: msg,
    intent: draft.intent,
    draftBody: draft.draftBody,
    confidence: draft.confidence,
    receivedAt: msg.receivedAt,
  });

  // In shadow mode we deliberately stop here. The friend (operator) reviews
  // drafts in the shadow inbox UI and decides what to do — nothing is sent.
  if (mode === "shadow") {
    return {
      ok: true,
      mode: "shadow",
      shadowDraftId: persisted.id,
      intent: draft.intent,
    };
  }

  // Live mode: in this codebase, "live" still means the draft enters the
  // existing HITL approval queue (drafts.approve mutation). We do NOT auto-send
  // even when mode === "live"; that's the whole point of HITL. The shadow
  // record is kept as an audit trail; the live approval queue picks it up
  // via the same `(provider, providerMessageId)` pair.
  return {
    ok: true,
    mode: "live",
    shadowDraftId: persisted.id,
    intent: draft.intent,
  };
}

/**
 * Resolve the operating mode from env. Default is "shadow" for safety:
 * a misconfigured deploy will not start sending real customer SMS.
 */
export function resolveMessagingMode(): MessagingMode {
  return process.env.MESSAGING_LIVE_MODE === "1" ? "live" : "shadow";
}
