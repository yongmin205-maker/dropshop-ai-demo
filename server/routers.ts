import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { draftAgentReply, INTENT_LABELS, type Intent } from "./aiAgent";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  appendMessage,
  appendProcessingLog,
  createEscalation,
  getConversationLogs,
  getConversationMessages,
  getDraftById,
  getLatestPendingDraftForMessage,
  getOpenEscalations,
  getOrCreateConversation,
  insertDraft,
  insertRejection,
  insertStyleExample,
  listConversations,
  listKnowledge,
  listPendingDrafts,
  listRejections,
  listStyleExamples,
  resolveEscalation,
  updateConversationIntent,
  updateDraftStatus,
  upsertKnowledgeChunk,
} from "./db";
import { embedText } from "./embeddings";
import { ensureSeeded, getCustomerByPhone } from "./mockCleanCloud";
import { isLiveMode, sendSms } from "./twilio";
import { seedKnowledgeIfEmpty } from "./knowledgeSeed";

async function ensureAllSeeded() {
  await ensureSeeded();
  await seedKnowledgeIfEmpty();
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  config: router({
    get: publicProcedure.query(() => ({
      liveMode: isLiveMode(),
      twilioPhone: process.env.TWILIO_PHONE_NUMBER ?? null,
      autoSend: process.env.DROPSHOP_AUTO_SEND === "1",
    })),
  }),

  conversations: router({
    list: publicProcedure.query(async () => {
      await ensureAllSeeded();
      return listConversations();
    }),
    messages: publicProcedure
      .input(z.object({ conversationId: z.number() }))
      .query(({ input }) => getConversationMessages(input.conversationId)),
    logs: publicProcedure
      .input(z.object({ conversationId: z.number() }))
      .query(({ input }) => getConversationLogs(input.conversationId)),
  }),

  escalations: router({
    list: publicProcedure.query(() => getOpenEscalations()),
    resolve: publicProcedure
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => resolveEscalation(input.id)),
  }),

  /* ---------- Human-in-the-Loop: drafts / approvals / rejections ---------- */
  drafts: router({
    listPending: publicProcedure.query(() => listPendingDrafts()),

    getForMessage: publicProcedure
      .input(z.object({ messageId: z.number() }))
      .query(({ input }) => getLatestPendingDraftForMessage(input.messageId)),

    approve: publicProcedure
      .input(z.object({ draftId: z.number() }))
      .mutation(async ({ input }) => {
        const draft = await getDraftById(input.draftId);
        if (!draft) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Draft not found" });
        }
        if (draft.status !== "pending_approval") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Draft already ${draft.status}`,
          });
        }

        // Load the inbound customer message body
        const inboundRows = await getConversationMessages(draft.conversationId);
        const inbound = inboundRows.find((m) => m.id === draft.inboundMessageId);
        if (!inbound) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Inbound message missing for draft",
          });
        }

        // Persist outbound
        const outbound = await appendMessage({
          conversationId: draft.conversationId,
          direction: "outbound",
          sender: "ai",
          body: draft.body,
          intent: draft.intent,
          mode: isLiveMode() ? "live" : "simulator",
        });
        await updateDraftStatus(draft.id, "approved");
        await appendProcessingLog({
          conversationId: draft.conversationId,
          messageId: draft.inboundMessageId,
          step: "sent",
          label: isLiveMode()
            ? `Approved & dispatched via Twilio`
            : `Approved & delivered in Simulator Mode`,
          detail: { draftId: draft.id, reply: draft.body },
        });

        // Record as style example with embedding
        const embedding = await embedText(
          `${inbound.body}\n---\n${draft.body}`
        );
        await insertStyleExample({
          draftId: draft.id,
          intent: draft.intent,
          customerBody: inbound.body,
          approvedReply: draft.body,
          embedding,
        });

        let liveSendInfo: { ok: boolean; sid?: string; error?: string } | null = null;
        if (isLiveMode()) {
          // Look up customer phone via conversation id
          liveSendInfo = await sendSms(
            (
              await listConversations(500)
            ).find((c) => c.id === draft.conversationId)?.phone ?? "",
            draft.body
          );
        }

        return { ok: true, outbound, liveSendInfo };
      }),

    reject: publicProcedure
      .input(
        z.object({
          draftId: z.number(),
          reason: z.string().min(1).max(1000),
        })
      )
      .mutation(async ({ input }) => {
        const draft = await getDraftById(input.draftId);
        if (!draft) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Draft not found" });
        }
        if (draft.status !== "pending_approval") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Draft already ${draft.status}`,
          });
        }

        const inboundRows = await getConversationMessages(draft.conversationId);
        const inbound = inboundRows.find((m) => m.id === draft.inboundMessageId);
        if (!inbound) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Inbound message missing for draft",
          });
        }

        // Record rejection with embedding
        const embedding = await embedText(
          `${inbound.body}\n---\n${draft.body}\n---REASON:${input.reason}`
        );
        await insertRejection({
          draftId: draft.id,
          intent: draft.intent,
          customerBody: inbound.body,
          rejectedReply: draft.body,
          reason: input.reason,
          embedding,
        });
        await updateDraftStatus(draft.id, "rejected");
        await appendProcessingLog({
          conversationId: draft.conversationId,
          messageId: draft.inboundMessageId,
          step: "response_drafted",
          label: `Manager rejected draft — regenerating with feedback`,
          detail: { rejectedReply: draft.body, reason: input.reason },
        });

        // Regenerate new draft informed by this rejection
        const conv = (await listConversations(500)).find(
          (c) => c.id === draft.conversationId
        );
        const phone = conv?.phone ?? "";
        const nextResult = await draftAgentReply({
          phone,
          body: inbound.body,
          managerRejectReason: input.reason,
          intentOverride: draft.intent as Intent,
        });
        if (nextResult.escalated || !nextResult.reply) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Regeneration returned no draft",
          });
        }
        const newDraft = await insertDraft({
          conversationId: draft.conversationId,
          inboundMessageId: draft.inboundMessageId,
          intent: nextResult.intent,
          body: nextResult.reply,
          revision: (draft.revision ?? 1) + 1,
          status: "pending_approval",
          ragContext: nextResult.ragContext,
        });
        for (const step of nextResult.steps) {
          await appendProcessingLog({
            conversationId: draft.conversationId,
            messageId: draft.inboundMessageId,
            step: step.step,
            label: step.label,
            detail: step.detail ?? null,
          });
        }

        return { ok: true, newDraft };
      }),
  }),

  /* ---------- RAG inspection (read-only for UI panels) ---------- */
  rag: router({
    styleExamples: publicProcedure.query(() => listStyleExamples(100)),
    rejections: publicProcedure.query(() => listRejections(100)),
    knowledge: publicProcedure.query(async () => {
      await seedKnowledgeIfEmpty();
      return listKnowledge();
    }),
    addKnowledge: publicProcedure
      .input(
        z.object({
          topic: z.string().min(1).max(64),
          title: z.string().min(1).max(256),
          body: z.string().min(1).max(4000),
        })
      )
      .mutation(async ({ input }) => {
        const embedding = await embedText(`${input.title}\n${input.body}`);
        await upsertKnowledgeChunk({
          topic: input.topic,
          title: input.title,
          body: input.body,
          embedding,
        });
        return { ok: true };
      }),
  }),

  /* ---------- Simulator inbound message ---------- */
  simulator: router({
    sendMessage: publicProcedure
      .input(
        z.object({
          phone: z.string().min(5).max(32),
          body: z.string().min(1).max(1000),
        })
      )
      .mutation(async ({ input }) => {
        await ensureAllSeeded();
        const customer = await getCustomerByPhone(input.phone);
        const conversation = await getOrCreateConversation(
          input.phone,
          customer?.name ?? undefined
        );

        // 1. Persist inbound
        const inbound = await appendMessage({
          conversationId: conversation.id,
          direction: "inbound",
          sender: "customer",
          body: input.body,
          mode: isLiveMode() ? "live" : "simulator",
        });

        // 2. Draft via agent (RAG-aware)
        let result;
        try {
          result = await draftAgentReply({ phone: input.phone, body: input.body });
        } catch (err) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: err instanceof Error ? err.message : "Agent failed",
          });
        }

        // 3. Log every step
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

        let draftId: number | null = null;
        let escalationRow: { id: number } | null = null;

        if (result.escalated) {
          await createEscalation({
            conversationId: conversation.id,
            messageId: inbound.id,
            reason: result.escalationReason ?? "Critical message detected",
          });
          escalationRow = { id: inbound.id };
        } else if (result.reply) {
          // Stage as pending draft (never auto-send unless DROPSHOP_AUTO_SEND=1)
          const draft = await insertDraft({
            conversationId: conversation.id,
            inboundMessageId: inbound.id,
            intent: result.intent,
            body: result.reply,
            revision: 1,
            status: "pending_approval",
            ragContext: result.ragContext,
          });
          draftId = draft.id;

          if (process.env.DROPSHOP_AUTO_SEND === "1") {
            // Confidence-auto-send path (off by default for safety)
            const outbound = await appendMessage({
              conversationId: conversation.id,
              direction: "outbound",
              sender: "ai",
              body: result.reply,
              intent: result.intent,
              mode: isLiveMode() ? "live" : "simulator",
            });
            await updateDraftStatus(draft.id, "approved");
            await appendProcessingLog({
              conversationId: conversation.id,
              messageId: inbound.id,
              step: "sent",
              label: isLiveMode()
                ? `Auto-sent via Twilio (auto-send mode on)`
                : `Auto-delivered in Simulator Mode (auto-send mode on)`,
              detail: { reply: result.reply, outboundId: outbound.id },
            });
            if (isLiveMode()) {
              await sendSms(input.phone, result.reply);
            }
          }
        }

        return {
          conversationId: conversation.id,
          intent: result.intent,
          inbound,
          escalated: result.escalated,
          escalationReason: result.escalationReason,
          steps: result.steps,
          draftId,
          escalationMessageId: escalationRow?.id ?? null,
          liveMode: isLiveMode(),
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
export { INTENT_LABELS };
