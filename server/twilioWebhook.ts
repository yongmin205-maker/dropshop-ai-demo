import type { Express, Request, Response } from "express";
import { draftAgentReply } from "./aiAgent";
import {
  appendMessage,
  appendMessageTx,
  appendProcessingLog,
  appendProcessingLogTx,
  appendProcessingLogs,
  appendProcessingLogsTx,
  createEscalation,
  createEscalationTx,
  getMessageByTwilioSid,
  getOrCreateConversation,
  insertDraft,
  insertDraftTx,
  transitionDraftStatus,
  transitionDraftStatusTx,
  updateConversationIntent,
  updateConversationIntentTx,
  updateDraftStatusTx,
  updateMessageDelivery,
  updateMessageDeliveryTx,
  withTransaction,
} from "./db";
import { ensureSeeded, getCustomerByPhone } from "./mockCleanCloud";
import {
  isE164,
  isLiveMode,
  reconstructWebhookUrl,
  sendSms,
  validateTwilioSignature,
} from "./twilio";
import type { InsertProcessingLog } from "../drizzle/schema";

/**
 * Inbound Twilio webhook. Hardened for production:
 *
 *   1. **Signature validation** — Reject any POST whose `X-Twilio-Signature`
 *      header does not match the HMAC-SHA1 of (URL + sorted form fields).
 *      Any unauthenticated caller hitting this URL gets a 403.
 *
 *   2. **Idempotency** — Twilio retries on 5xx / network blip. We store the
 *      Twilio `MessageSid` on `messages` (UNIQUE), and short-circuit when we
 *      see a sid we have already processed.
 *
 *   3. **Human-in-the-Loop by default** — Even in live mode the agent's
 *      reply is staged as a `pending_approval` draft. A real customer reply
 *      ONLY goes out when (a) a manager clicks Approve, OR (b) the operator
 *      has explicitly opted into auto-send by setting `DROPSHOP_AUTO_SEND=1`.
 *
 *   4. **Two-phase send** for the auto-send fallback path: persist outbound
 *      as `queued` first, then flip to `sent` (with the returned Twilio sid)
 *      only on successful delivery. Failures are surfaced via
 *      `processingLogs.step="send_failed"` and the draft is reopened for the
 *      manager to retry.
 *
 *   5. **Escalations bypass auto-send** — A "Critical" intent never auto-replies
 *      under any setting. Human is always in the loop for those.
 */
export function registerTwilioWebhook(app: Express) {
  app.post("/api/twilio/sms", async (req: Request, res: Response) => {
    if (!isLiveMode()) {
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    // ---- 1. Signature validation ----
    const params: Record<string, string> = {};
    if (req.body && typeof req.body === "object") {
      for (const [k, v] of Object.entries(req.body)) {
        params[k] = String(v);
      }
    }
    const url = reconstructWebhookUrl(req as unknown as Parameters<typeof reconstructWebhookUrl>[0]);
    const sigOk = validateTwilioSignature({
      signatureHeader: req.headers["x-twilio-signature"] as string | undefined,
      url,
      params,
    });
    if (!sigOk) {
      // Use 403 (not 200 empty) so any misconfigured proxy / unauthenticated
      // caller is loud and visible in metrics.
      res.status(403).type("text/plain").send("Twilio signature mismatch");
      return;
    }

    const from = String(params.From ?? "").trim();
    const body = String(params.Body ?? "").trim();
    const messageSid = String(params.MessageSid ?? "").trim();

    if (!from || !body) {
      res.status(400).send("Missing From or Body");
      return;
    }
    if (!isE164(from)) {
      res.status(400).send("From is not E.164");
      return;
    }

    // ---- 2. Idempotency ----
    if (messageSid) {
      const existing = await getMessageByTwilioSid(messageSid);
      if (existing) {
        // Already processed; tell Twilio "ok" so it stops retrying.
        res.status(200).type("text/xml").send("<Response/>");
        return;
      }
    }

    try {
      await ensureSeeded();
      const customer = await getCustomerByPhone(from);
      const conversation = await getOrCreateConversation(from, customer?.name ?? undefined);
      const correlationId = `tw_${messageSid || Date.now().toString(36)}`;

      // External I/O (LLM agent) BEFORE the transaction so we don't hold a
      // write txn open while waiting on the model.
      const result = await draftAgentReply({ phone: from, body });

      // ATOMIC: persist inbound + step logs + intent + (escalation OR draft)
      // commit together so a crash mid-turn cannot orphan rows.
      const turn = await withTransaction(async (tx) => {
        const inbound = await appendMessageTx(tx, {
          conversationId: conversation.id,
          direction: "inbound",
          sender: "customer",
          body,
          mode: "live",
          status: "sent",
          twilioSid: messageSid || null,
          correlationId,
        });
        const stepLogs: InsertProcessingLog[] = result.steps.map((step) => ({
          conversationId: conversation.id,
          messageId: inbound.id,
          step: step.step,
          label: step.label,
          detail: (step.detail ?? null) as InsertProcessingLog["detail"],
          correlationId,
        }));
        await appendProcessingLogsTx(tx, stepLogs);
        await updateConversationIntentTx(tx, conversation.id, result.intent);

        let createdDraftId: number | null = null;
        if (result.escalated) {
          await createEscalationTx(tx, {
            conversationId: conversation.id,
            messageId: inbound.id,
            reason: result.escalationReason ?? "Critical message detected",
          });
        } else if (result.reply) {
          const draft = await insertDraftTx(tx, {
            conversationId: conversation.id,
            inboundMessageId: inbound.id,
            intent: result.intent,
            body: result.reply,
            revision: 1,
            status: "pending_approval",
            ragContext: result.ragContext,
          });
          createdDraftId = draft.id;
        }
        return { inbound, createdDraftId };
      });
      const inbound = turn.inbound;

      if (result.escalated) {
        // Escalations never auto-reply.
      } else if (result.reply && turn.createdDraftId !== null) {
        const draftId = turn.createdDraftId;

        // Auto-send only if the operator explicitly opted in.
        if (process.env.DROPSHOP_AUTO_SEND === "1") {
          // ATOMIC: state transition + outbound queue row in one txn.
          const auto = await withTransaction(async (tx) => {
            const moved = await transitionDraftStatusTx(tx, draftId, "approved");
            if (!moved) return null;
            const outbound = await appendMessageTx(tx, {
              conversationId: conversation.id,
              direction: "outbound",
              sender: "ai",
              body: result.reply!,
              intent: result.intent,
              mode: "live",
              status: "queued",
              correlationId,
            });
            return { outbound };
          });
          if (!auto) {
            await appendProcessingLog({
              conversationId: conversation.id,
              messageId: inbound.id,
              step: "send_failed",
              label: "Auto-send aborted: draft no longer pending",
              detail: { draftId },
              correlationId,
            });
          } else {
            // Phase 2: hand to Twilio (OUT of the transaction).
            const sendResult = await sendSms(from, result.reply);
            await withTransaction(async (tx) => {
              if (sendResult.ok) {
                await updateMessageDeliveryTx(tx, auto.outbound.id, {
                  status: "sent",
                  twilioSid: sendResult.sid,
                });
                await appendProcessingLogTx(tx, {
                  conversationId: conversation.id,
                  messageId: inbound.id,
                  step: "sent",
                  label: `Auto-sent via Twilio (auto-send mode)`,
                  detail: { outboundId: auto.outbound.id, twilioSid: sendResult.sid },
                  correlationId,
                });
              } else {
                await updateMessageDeliveryTx(tx, auto.outbound.id, {
                  status: "failed",
                  sendError: sendResult.error.slice(0, 256),
                });
                await updateDraftStatusTx(tx, draftId, "pending_approval");
                await appendProcessingLogTx(tx, {
                  conversationId: conversation.id,
                  messageId: inbound.id,
                  step: "send_failed",
                  label: "Twilio rejected auto-sent draft — re-opened for manager review",
                  detail: { error: sendResult.error, outboundId: auto.outbound.id },
                  correlationId,
                });
              }
            });
          }
        } else {
          // Default safe path: leave the draft pending for a manager.
          await appendProcessingLog({
            conversationId: conversation.id,
            messageId: inbound.id,
            step: "response_drafted",
            label: "Draft awaiting manager approval (HITL)",
            detail: { draftId },
            correlationId,
          });
        }
      }

      res.status(200).type("text/xml").send("<Response/>");
    } catch (err) {
      console.error("[TwilioWebhook] error", err);
      // Return 500 so Twilio retries — combined with idempotency above this is
      // safe (the duplicate sid will be a no-op).
      res.status(500).type("text/xml").send("<Response/>");
    }
  });
}
