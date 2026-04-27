/**
 * Two-phase send: shared completion helpers for the success and failure
 * branches that land *after* an outbound row has already been written as
 * `queued` and Twilio has answered.
 *
 * Three places need exactly this completion logic, with the same atomicity
 * contract (delivery flip + draft re-open commit together):
 *
 *   1. `drafts.approve` (manual approval path in `server/routers.ts`)
 *   2. `simulator.sendMessage` auto-send branch (also in `routers.ts`)
 *   3. `twilioWebhook` auto-send branch (in `server/twilioWebhook.ts`)
 *
 * Before this module they each reinvented the same 4-step failure recovery
 * (delivery → failed, draft → pending_approval, processingLog → send_failed,
 * + variable error string truncation), which made it easy for one path to
 * drift relative to the others. Centralizing here means a future change to
 * how we record a Twilio failure is a one-line edit instead of three.
 *
 * The "should I throw or swallow" decision is *intentionally* left to each
 * caller — it has different semantics in each place:
 *   - `drafts.approve` throws BAD_GATEWAY back to the manager UI.
 *   - `simulator.*` and webhook auto-send simply log + return (they are
 *     fire-and-forget from the SMS sender's perspective).
 */

import {
  appendProcessingLogTx,
  type DbTx,
  updateDraftStatusTx,
  updateMessageDeliveryTx,
} from "../db";

/** Maximum length we persist for any Twilio error string. */
export const SEND_ERROR_MAX = 256;

export type SendCompletionContext = {
  conversationId: number;
  inboundMessageId: number;
  outboundMessageId: number;
  draftId: number;
  correlationId: string;
};

/**
 * Success branch: outbound row → `sent` (with sid) + processingLog → `sent`.
 * Caller passes a label that describes which path produced the send
 * (e.g. "Approved & dispatched via Twilio" vs
 * "Auto-sent via Twilio (auto-send mode)").
 */
export async function recordTwoPhaseSendSuccess(
  tx: DbTx,
  ctx: SendCompletionContext & { twilioSid: string; logLabel: string },
): Promise<void> {
  await updateMessageDeliveryTx(tx, ctx.outboundMessageId, {
    status: "sent",
    twilioSid: ctx.twilioSid,
  });
  await appendProcessingLogTx(tx, {
    conversationId: ctx.conversationId,
    messageId: ctx.inboundMessageId,
    step: "sent",
    label: ctx.logLabel,
    detail: {
      draftId: ctx.draftId,
      outboundId: ctx.outboundMessageId,
      twilioSid: ctx.twilioSid,
    },
    correlationId: ctx.correlationId,
  });
}

/**
 * Failure branch: outbound row → `failed` (truncated error), draft re-opened
 * to `pending_approval` so the manager UI surfaces it again, and a
 * `send_failed` processingLog row records the upstream error for the audit
 * trail. All three writes commit atomically inside the supplied tx.
 */
export async function recordTwoPhaseSendFailure(
  tx: DbTx,
  ctx: SendCompletionContext & { error: string; logLabel: string },
): Promise<void> {
  await updateMessageDeliveryTx(tx, ctx.outboundMessageId, {
    status: "failed",
    sendError: ctx.error.slice(0, SEND_ERROR_MAX),
  });
  await updateDraftStatusTx(tx, ctx.draftId, "pending_approval");
  await appendProcessingLogTx(tx, {
    conversationId: ctx.conversationId,
    messageId: ctx.inboundMessageId,
    step: "send_failed",
    label: ctx.logLabel,
    detail: {
      error: ctx.error,
      outboundId: ctx.outboundMessageId,
      draftId: ctx.draftId,
    },
    correlationId: ctx.correlationId,
  });
}
