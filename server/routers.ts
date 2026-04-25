import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { draftAgentReply, INTENT_LABELS, type Intent } from "./aiAgent";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import {
  appendMessage,
  appendMessageTx,
  appendProcessingLog,
  appendProcessingLogTx,
  appendProcessingLogs,
  appendProcessingLogsTx,
  createEscalation,
  createEscalationTx,
  getConversationById,
  getConversationLogs,
  getConversationMessages,
  getDraftById,
  getLatestPendingDraftForMessage,
  getOpenEscalations,
  getOrCreateConversation,
  getCustomerProfile,
  insertDraft,
  insertDraftTx,
  insertRejection,
  insertRejectionTx,
  insertStyleExample,
  insertStyleExampleTx,
  listConversations,
  listKnowledge,
  listPendingDrafts,
  listRejections,
  listStyleExamples,
  newCorrelationId,
  resetDemoData,
  resolveEscalation,
  supersedeOtherPendingDrafts,
  supersedeOtherPendingDraftsTx,
  transitionDraftStatus,
  transitionDraftStatusTx,
  updateConversationIntent,
  updateConversationIntentTx,
  updateDraftStatusTx,
  updateMessageDelivery,
  updateMessageDeliveryTx,
  upsertKnowledgeChunk,
  withTransaction,
} from "./db";
import type { InsertProcessingLog } from "../drizzle/schema";
import { embedText, isEmbeddingFallbackActive } from "./embeddings";
import { ensureSeeded, getCustomerByPhone } from "./mockCleanCloud";
import { isE164, isLiveMode, sendSms, smsSegmentCount } from "./twilio";
import { seedKnowledgeIfEmpty } from "./knowledgeSeed";
import { callerIp, noteLlmTokenUsage, rateLimit } from "./rateLimit";

async function ensureAllSeeded() {
  await ensureSeeded();
  await seedKnowledgeIfEmpty();
}

/** Rough token estimate for budget tracking. ~4 chars per English token. */
function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4);
}

const ALLOW_DEMO_RESET = process.env.ALLOW_DEMO_RESET === "1";

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
      // Two flavors of "embedding degraded":
      //   - `embeddingMissingKey`: no Forge key, so we *will* fall back. Static.
      //   - `embeddingFallbackActive`: at least one runtime call already fell
      //     back to the deterministic hash-bag (semantic search degraded for
      //     the rest of this process's life). Dynamic, set by embeddings.ts.
      embeddingMissingKey: !process.env.BUILT_IN_FORGE_API_KEY,
      embeddingFallbackActive: isEmbeddingFallbackActive(),
      // Backwards-compatible alias for the existing client.
      embeddingFallback:
        !process.env.BUILT_IN_FORGE_API_KEY || isEmbeddingFallbackActive(),
      allowDemoReset: ALLOW_DEMO_RESET,
    })),
  }),

  conversations: router({
    list: publicProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(200).optional(),
            beforeId: z.number().int().positive().optional(),
          })
          .optional(),
      )
      .query(async ({ input }) => {
        await ensureAllSeeded();
        return listConversations(input);
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
    listPending: publicProcedure
      .input(z.object({ conversationId: z.number().optional() }).optional())
      .query(({ input }) => listPendingDrafts({ conversationId: input?.conversationId })),

    getForMessage: publicProcedure
      .input(z.object({ messageId: z.number() }))
      .query(({ input }) => getLatestPendingDraftForMessage(input.messageId)),

    /**
     * Approve a draft. Production-grade rules:
     *   • Atomic state transition (`pending_approval` → `approved`) via
     *     conditional UPDATE; second concurrent caller gets a 409 CONFLICT.
     *   • Two-phase send: persist outbound row as `queued` BEFORE Twilio,
     *     flip to `sent` (with returned sid) on ok, or `failed` (with error)
     *     and roll the draft back to `pending_approval`.
     *   • Style example only persisted on a successful send (we don't want
     *     to "teach" the model from messages that never reached the customer).
     */
    approve: publicProcedure
      .input(z.object({ draftId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        rateLimit({
          key: `approve:ip:${callerIp(ctx.req)}`,
          max: 60,
          windowMs: 60_000,
          label: "approval",
        });
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

        const correlationId = inbound.correlationId ?? newCorrelationId();
        const live = isLiveMode();
        const conv = await getConversationById(draft.conversationId);

        // ATOMIC: state transition + outbound row insert in one transaction.
        // If the conditional UPDATE matches 0 rows (someone else handled it),
        // we abort BEFORE inserting the outbound message so we never end up
        // with an orphan "queued" outbound for a draft that is no longer ours.
        const txResult = await withTransaction(async (tx) => {
          const moved = await transitionDraftStatusTx(tx, input.draftId, "approved");
          if (!moved) return null;
          const outbound = await appendMessageTx(tx, {
            conversationId: draft.conversationId,
            direction: "outbound",
            sender: "ai",
            body: draft.body,
            intent: draft.intent,
            mode: live ? "live" : "simulator",
            status: live ? "queued" : "sent",
            correlationId,
          });
          return { outbound };
        });
        if (!txResult) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Draft was already handled by another approver",
          });
        }
        const { outbound } = txResult;

        // Phase 2 (live mode only): hand off to Twilio.
        let liveSendInfo: { ok: boolean; sid?: string; error?: string } | null = null;
        if (live) {
          const phone = conv?.phone ?? "";
          const result = await sendSms(phone, draft.body);
          if (result.ok) {
            await updateMessageDelivery(outbound.id, {
              status: "sent",
              twilioSid: result.sid,
            });
            liveSendInfo = { ok: true, sid: result.sid };
          } else {
            // Roll the draft back to pending so the manager sees the failure.
            await updateMessageDelivery(outbound.id, {
              status: "failed",
              sendError: result.error.slice(0, 256),
            });
            // Re-open the draft for retry.
            try {
              const { updateDraftStatus } = await import("./db");
              await updateDraftStatus(draft.id, "pending_approval");
            } catch {
              /* ignore */
            }
            await appendProcessingLog({
              conversationId: draft.conversationId,
              messageId: draft.inboundMessageId,
              step: "send_failed",
              label: `Twilio rejected the message — draft re-opened for retry`,
              detail: { error: result.error, outboundId: outbound.id },
              correlationId,
            });
            throw new TRPCError({
              code: "BAD_GATEWAY",
              message: `Twilio send failed: ${result.error}`,
            });
          }
        }

        await appendProcessingLog({
          conversationId: draft.conversationId,
          messageId: draft.inboundMessageId,
          step: "sent",
          label: live
            ? `Approved & dispatched via Twilio`
            : `Approved & delivered in Simulator Mode`,
          detail: {
            draftId: draft.id,
            outboundId: outbound.id,
            twilioSid: liveSendInfo?.sid ?? null,
          },
          correlationId,
        });

        // Record approved style example (RAG Tier 2). Best-effort: if embedding
        // generation fails we still acknowledge the send — the customer
        // already got the message, we shouldn't 500 on a learning step.
        try {
          const embedding = await embedText(`${inbound.body}\n---\n${draft.body}`);
          await insertStyleExample({
            draftId: draft.id,
            intent: draft.intent,
            customerBody: inbound.body,
            approvedReply: draft.body,
            embedding,
            embeddingDim: embedding.length,
          });
        } catch (err) {
          console.warn("[drafts.approve] style example persist failed:", err);
        }

        return { ok: true, outbound, liveSendInfo, correlationId };
      }),

    /**
     * Reject a draft. Production-grade rules:
     *   • Atomic state transition.
     *   • All side-effects (rejection row, log, regenerated draft, supersede
     *     of any other pending drafts for the same inbound message) happen
     *     under a single end-to-end flow with explicit error propagation.
     */
    reject: publicProcedure
      .input(
        z.object({
          draftId: z.number(),
          category: z
            .enum([
              "wrong_information",
              "tone_too_formal",
              "tone_too_casual",
              "too_long",
              "too_short",
              "missing_context",
              "should_escalate",
              "other",
            ])
            .default("other"),
          reason: z.string().min(1).max(1000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        rateLimit({
          key: `reject:ip:${callerIp(ctx.req)}`,
          max: 60,
          windowMs: 60_000,
          label: "rejection",
        });
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

        const correlationId = inbound.correlationId ?? newCorrelationId();

        // External I/O (embedding) goes BEFORE the transaction so the row
        // lock window is short. The embedding call may take 100–1000ms; we
        // do not want to hold a write transaction open for that long.
        const embedding = await embedText(
          `${inbound.body}\n---\n${draft.body}\n---REASON:${input.reason}`,
        );

        // ATOMIC: transition + supersede siblings + record rejection + log.
        // Either every learning artefact lands or none of them do.
        const txOk = await withTransaction(async (tx) => {
          const moved = await transitionDraftStatusTx(tx, input.draftId, "rejected");
          if (!moved) return false;
          await supersedeOtherPendingDraftsTx(tx, draft.inboundMessageId, draft.id);
          await insertRejectionTx(tx, {
            draftId: draft.id,
            intent: draft.intent,
            customerBody: inbound.body,
            rejectedReply: draft.body,
            category: input.category,
            reason: input.reason,
            embedding,
            embeddingDim: embedding.length,
          });
          await appendProcessingLogTx(tx, {
            conversationId: draft.conversationId,
            messageId: draft.inboundMessageId,
            step: "response_drafted",
            label: `Manager rejected draft — regenerating with feedback`,
            detail: {
              rejectedReply: draft.body,
              reason: input.reason,
              category: input.category,
            },
            correlationId,
          });
          return true;
        });
        if (!txOk) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Draft was already handled by another reviewer",
          });
        }

        // Regenerate.
        const conv = await getConversationById(draft.conversationId);
        const phone = conv?.phone ?? "";
        const nextResult = await draftAgentReply({
          phone,
          body: inbound.body,
          managerRejectReason: `[${input.category}] ${input.reason}`,
          intentOverride: draft.intent as Intent,
        });
        if (nextResult.escalated || !nextResult.reply) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Regeneration returned no draft",
          });
        }
        // ATOMIC: regenerated draft + its step logs commit together.
        const stepLogs: InsertProcessingLog[] = nextResult.steps.map((step) => ({
          conversationId: draft.conversationId,
          messageId: draft.inboundMessageId,
          step: step.step,
          label: step.label,
          detail: (step.detail ?? null) as InsertProcessingLog["detail"],
          correlationId,
        }));
        const newDraft = await withTransaction(async (tx) => {
          const created = await insertDraftTx(tx, {
            conversationId: draft.conversationId,
            inboundMessageId: draft.inboundMessageId,
            intent: nextResult.intent,
            body: nextResult.reply!,
            revision: (draft.revision ?? 1) + 1,
            status: "pending_approval",
            ragContext: nextResult.ragContext,
          });
          await appendProcessingLogsTx(tx, stepLogs);
          return created;
        });

        return { ok: true, newDraft, correlationId };
      }),
  }),

  /* ---------- RAG inspection (read-only for UI panels) ---------- */
  rag: router({
    styleExamples: publicProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(500).optional(),
            beforeId: z.number().int().positive().optional(),
          })
          .optional(),
      )
      .query(({ input }) => listStyleExamples({ limit: input?.limit ?? 100, beforeId: input?.beforeId })),
    rejections: publicProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(500).optional(),
            beforeId: z.number().int().positive().optional(),
          })
          .optional(),
      )
      .query(({ input }) => listRejections({ limit: input?.limit ?? 100, beforeId: input?.beforeId })),
    knowledge: publicProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(500).optional(),
            beforeId: z.number().int().positive().optional(),
          })
          .optional(),
      )
      .query(async ({ input }) => {
        await seedKnowledgeIfEmpty();
        return listKnowledge({ limit: input?.limit ?? 500, beforeId: input?.beforeId });
      }),
    /**
     * Knowledge edits affect every customer's reply — admin-only so a public
     * URL cannot be used to poison the RAG store.
     */
    addKnowledge: adminProcedure
      .input(
        z.object({
          topic: z.string().min(1).max(64),
          title: z.string().min(1).max(256),
          body: z.string().min(1).max(4000),
        }),
      )
      .mutation(async ({ input }) => {
        const embedding = await embedText(`${input.title}\n${input.body}`);
        await upsertKnowledgeChunk({
          topic: input.topic,
          title: input.title,
          body: input.body,
          embedding,
          embeddingDim: embedding.length,
        });
        return { ok: true };
      }),
  }),

  /* ---------- Demo controls ---------- */
  demo: router({
    /**
     * Demolishing all conversation data is destructive. Gated by:
     *   1. Admin role (server-side check via `adminProcedure`).
     *   2. `ALLOW_DEMO_RESET=1` env flag (so production deploys can disable it
     *      entirely without touching code).
     */
    reset: adminProcedure.mutation(async () => {
      if (!ALLOW_DEMO_RESET) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Demo reset disabled in this environment (ALLOW_DEMO_RESET != 1)",
        });
      }
      return resetDemoData();
    }),
  }),

  /* ---------- Customer profile (selected conversation) ---------- */
  customers: router({
    profile: publicProcedure
      .input(z.object({ conversationId: z.number() }))
      .query(({ input }) => getCustomerProfile(input.conversationId)),
  }),

  /* ---------- Simulator inbound message ---------- */
  simulator: router({
    sendMessage: publicProcedure
      .input(
        z.object({
          phone: z.string().min(5).max(32),
          body: z.string().min(1).max(500),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Cost / abuse caps. The simulator endpoint is publicly reachable.
        const ip = callerIp(ctx.req);
        rateLimit({
          key: `simulator:ip:${ip}`,
          max: 30,
          windowMs: 60_000,
          label: "simulator (per IP)",
        });
        rateLimit({
          key: `simulator:ip:${ip}:day`,
          max: 500,
          windowMs: 24 * 60 * 60 * 1000,
          label: "simulator daily (per IP)",
        });
        rateLimit({
          key: `simulator:phone:${input.phone}`,
          max: 5,
          windowMs: 5 * 60_000,
          label: "per-phone (5 / 5 min)",
        });
        // Conservative LLM token budget gate (classifier + generator + RAG).
        noteLlmTokenUsage(estimateTokens(input.body) * 8 + 800);

        if (!isE164(input.phone)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid E.164 phone format: ${input.phone}`,
          });
        }

        await ensureAllSeeded();
        const customer = await getCustomerByPhone(input.phone);
        const conversation = await getOrCreateConversation(
          input.phone,
          customer?.name ?? undefined,
        );
        const correlationId = newCorrelationId();

        // External I/O (LLM agent) BEFORE the transaction so we don't hold
        // a write txn open while waiting on the model.
        let result;
        try {
          result = await draftAgentReply({ phone: input.phone, body: input.body });
        } catch (err) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: err instanceof Error ? err.message : "Agent failed",
          });
        }

        const stepLogs = (inboundId: number): InsertProcessingLog[] =>
          result.steps.map((step) => ({
            conversationId: conversation.id,
            messageId: inboundId,
            step: step.step,
            label: step.label,
            detail: (step.detail ?? null) as InsertProcessingLog["detail"],
            correlationId,
          }));

        // ATOMIC: inbound + step logs + intent update + (escalation OR draft)
        // commit together so a crash mid-turn does not leave orphan rows.
        const turn = await withTransaction(async (tx) => {
          const inbound = await appendMessageTx(tx, {
            conversationId: conversation.id,
            direction: "inbound",
            sender: "customer",
            body: input.body,
            mode: isLiveMode() ? "live" : "simulator",
            status: "sent",
            correlationId,
          });
          await appendProcessingLogsTx(tx, stepLogs(inbound.id));
          await updateConversationIntentTx(tx, conversation.id, result.intent);

          let createdDraftId: number | null = null;
          let escalationId: number | null = null;
          if (result.escalated) {
            await createEscalationTx(tx, {
              conversationId: conversation.id,
              messageId: inbound.id,
              reason: result.escalationReason ?? "Critical message detected",
            });
            escalationId = inbound.id;
          } else if (result.reply) {
            const created = await insertDraftTx(tx, {
              conversationId: conversation.id,
              inboundMessageId: inbound.id,
              intent: result.intent,
              body: result.reply,
              revision: 1,
              status: "pending_approval",
              ragContext: result.ragContext,
            });
            createdDraftId = created.id;
          }
          return { inbound, createdDraftId, escalationId };
        });
        const { inbound, createdDraftId, escalationId } = turn;
        let draftId: number | null = createdDraftId;
        let escalationRow: { id: number } | null =
          escalationId !== null ? { id: escalationId } : null;

        if (!result.escalated && result.reply && draftId !== null) {

          if (process.env.DROPSHOP_AUTO_SEND === "1") {
            // Confidence-auto-send path (off by default for safety). Still
            // honours two-phase send semantics. ATOMIC: state transition +
            // outbound row land together; Twilio call is OUT of the txn.
            const live = isLiveMode();
            const auto = await withTransaction(async (tx) => {
              const moved = await transitionDraftStatusTx(tx, draftId!, "approved");
              if (!moved) return null;
              const outbound = await appendMessageTx(tx, {
                conversationId: conversation.id,
                direction: "outbound",
                sender: "ai",
                body: result.reply!,
                intent: result.intent,
                mode: live ? "live" : "simulator",
                status: live ? "queued" : "sent",
                correlationId,
              });
              return { outbound };
            });
            if (auto && live) {
              const sendResult = await sendSms(input.phone, result.reply);
              await withTransaction(async (tx) => {
                if (sendResult.ok) {
                  await updateMessageDeliveryTx(tx, auto.outbound.id, {
                    status: "sent",
                    twilioSid: sendResult.sid,
                  });
                } else {
                  await updateMessageDeliveryTx(tx, auto.outbound.id, {
                    status: "failed",
                    sendError: sendResult.error.slice(0, 256),
                  });
                  await updateDraftStatusTx(tx, draftId!, "pending_approval");
                }
              });
            }
            if (auto) {
              await appendProcessingLog({
                conversationId: conversation.id,
                messageId: inbound.id,
                step: "sent",
                label: live
                  ? `Auto-sent via Twilio (auto-send mode on)`
                  : `Auto-delivered in Simulator Mode (auto-send mode on)`,
                detail: { reply: result.reply, outboundId: auto.outbound.id },
                correlationId,
              });
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
          smsSegmentEstimate: result.reply ? smsSegmentCount(result.reply) : 0,
          correlationId,
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
export { INTENT_LABELS };
