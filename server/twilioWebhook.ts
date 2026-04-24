import type { Express, Request, Response } from "express";
import { runAgent } from "./aiAgent";
import {
  appendMessage,
  appendProcessingLog,
  createEscalation,
  getOrCreateConversation,
  updateConversationIntent,
} from "./db";
import { ensureSeeded, getCustomerByPhone } from "./mockCleanCloud";
import { isLiveMode, sendSms } from "./twilio";

/**
 * Register a Twilio-compatible inbound SMS webhook at /api/twilio/sms.
 * Twilio POSTs application/x-www-form-urlencoded with at least { From, Body }.
 * We respond with empty TwiML so Twilio does not auto-reply for us.
 */
export function registerTwilioWebhook(app: Express) {
  app.post("/api/twilio/sms", async (req: Request, res: Response) => {
    const from = String(req.body?.From ?? "");
    const body = String(req.body?.Body ?? "");

    if (!isLiveMode()) {
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }
    if (!from || !body) {
      res.status(400).send("Missing From or Body");
      return;
    }

    try {
      await ensureSeeded();
      const customer = await getCustomerByPhone(from);
      const conversation = await getOrCreateConversation(from, customer?.name ?? undefined);

      const inbound = await appendMessage({
        conversationId: conversation.id,
        direction: "inbound",
        sender: "customer",
        body,
        mode: "live",
      });

      const result = await runAgent({ phone: from, body });

      for (const step of result.steps) {
        await appendProcessingLog({
          conversationId: conversation.id,
          messageId: inbound.id,
          step: step.step,
          label: step.label,
          detail: step.detail ?? null,
        });
      }
      await updateConversationIntent(conversation.id, result.intent);

      if (result.escalated) {
        await createEscalation({
          conversationId: conversation.id,
          messageId: inbound.id,
          reason: result.escalationReason ?? "Critical message detected",
        });
      } else if (result.reply) {
        await appendMessage({
          conversationId: conversation.id,
          direction: "outbound",
          sender: "ai",
          body: result.reply,
          intent: result.intent,
          mode: "live",
        });
        await appendProcessingLog({
          conversationId: conversation.id,
          messageId: inbound.id,
          step: "sent",
          label: `SMS dispatched via Twilio to ${from}`,
          detail: { reply: result.reply },
        });
        await sendSms(from, result.reply);
      }

      // Always return empty TwiML so Twilio doesn't double-send
      res.status(200).type("text/xml").send("<Response/>");
    } catch (err) {
      console.error("[TwilioWebhook] error", err);
      res.status(500).type("text/xml").send("<Response/>");
    }
  });
}
