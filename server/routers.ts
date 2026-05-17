import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { draftAgentReply, INTENT_LABELS, type Intent } from "./aiAgent";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { runDailyPull } from "./integrations/cleancloud/pullJob";
import { runBackfill } from "./integrations/cleancloud/backfill";
import {
  runDailyBriefing,
  getLatestBriefing,
  getBriefingByDate,
  listBriefings,
} from "./briefing/dailyBriefing";
import {
  recentSyncLogs,
  latestSyncLogForEndpoint,
} from "./integrations/cleancloud/db";
import { ask as askOwnerAssistant } from "./ownerAssistant/agent";
import {
  appendOwnerMessage,
  createOwnerConversation,
  listOwnerConversations,
  loadOwnerConversation,
} from "./ownerAssistant/db";
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
  updateDraftStatus,
  updateDraftStatusTx,
  updateMessageDelivery,
  updateMessageDeliveryTx,
  upsertKnowledgeChunk,
  withTransaction,
} from "./db";
import type { InsertProcessingLog } from "../drizzle/schema";
import {
  recordTwoPhaseSendFailure,
  recordTwoPhaseSendSuccess,
  SEND_ERROR_MAX,
} from "./messaging/twoPhaseSend";
import { embedText, isEmbeddingFallbackActive } from "./embeddings";
import { ensureSeeded, getCustomerByPhone } from "./mockCleanCloud";
import { isE164, isLiveMode, smsSegmentCount } from "./twilio";
import { getMessageTransport, isTransportLive } from "./messaging/transport";
import { seedKnowledgeIfEmpty } from "./knowledgeSeed";
import { callerIp, noteLlmTokenUsage, rateLimit } from "./rateLimit";
import {
  clearErrorLogs,
  listErrorLogs,
  listErrorSources,
  logServerError,
  purgeOldErrorLogs,
} from "./errorLog";
import { listErrorAlerts, purgeOldErrorAlerts } from "./alertEngine";
import {
  draftSalonReply,
  runGapFillerPipeline,
  runProcessingReminderPipeline,
  type GapFillerDraft,
  type ProcessingReminderDraft,
  type SalonAgentDraftResult,
} from "./salonAgent";
import { SALON_INTENT_LABELS, type SalonIntent } from "./salonIntents";
import {
  DAY_NAMES as SALON_DAY_NAMES,
  findOverlapSlots as findSalonOverlapSlots,
  formatPriceRange,
  formatSlot,
  getSalonCustomerByPhone,
  insertAppointment as insertSalonAppointment,
  listAppointmentsForWeek,
  listServices as listSalonServices,
  listStylists as listSalonStylists,
  resetSalonRuntime,
  type ServiceCategory as SalonServiceCategory,
  type SalonAppointment,
} from "./mockSalon";
import { cleanCloud } from "./messaging/cleanCloudTransport";
import { ENV } from "./_core/env";

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
      // Source of truth = the same predicate the transport selector uses,
      // so the operator badge agrees with what would actually happen on a
      // real send. Pre-patch this returned `isLiveMode()` (creds only) and
      // could disagree with `getMessageTransport()`.
      liveMode: isTransportLive(),
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
    resolve: adminProcedure
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
    approve: adminProcedure
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
        const transport = getMessageTransport();
        const isSimulator = transport.name === "simulator";
        const conv = await getConversationById(draft.conversationId);

        // ATOMIC: state transition + outbound row insert in one transaction.
        // The outbound row always lands as "queued" — the transport's response
        // (real Twilio sid OR synthetic SIM sid) is the source of truth for the
        // sent flip. If the conditional UPDATE matches 0 rows (someone else
        // handled the draft) we abort BEFORE inserting the outbound message
        // so we never orphan a "queued" outbound for a draft that is no
        // longer ours.
        const txResult = await withTransaction(async (tx) => {
          const moved = await transitionDraftStatusTx(tx, input.draftId, "approved");
          if (!moved) return null;
          const outbound = await appendMessageTx(tx, {
            conversationId: draft.conversationId,
            direction: "outbound",
            sender: "ai",
            body: draft.body,
            intent: draft.intent,
            mode: isSimulator ? "simulator" : "live",
            status: "queued",
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

        // Phase 2: hand off to the configured transport. The HTTP / synthetic
        // call happens OUTSIDE any open DB transaction (holding a tx across
        // an upstream RPC burns connections and risks pool exhaustion).
        // Once the transport answers, the outcome is recorded inside ONE
        // transaction via the shared twoPhaseSend helpers so the delivery
        // flip, draft re-open (failure case) and audit log row commit
        // together.
        const phone = conv?.phone ?? "";
        const sendResult = await transport.send(phone, draft.body);
        const completionCtx = {
          conversationId: draft.conversationId,
          inboundMessageId: draft.inboundMessageId,
          outboundMessageId: outbound.id,
          draftId: draft.id,
          correlationId,
        };
        let liveSendInfo: { ok: boolean; sid?: string; error?: string } | null = null;
        if (sendResult.ok) {
          const successLabel = isSimulator
            ? `Delivered in Simulator (no real SMS) · sid ${sendResult.sid}`
            : `Sent via Twilio · sid ${sendResult.sid}`;
          await withTransaction(async (tx) => {
            await recordTwoPhaseSendSuccess(tx, {
              ...completionCtx,
              twilioSid: sendResult.sid,
              logLabel: successLabel,
            });
          });
          liveSendInfo = { ok: true, sid: sendResult.sid };
        } else {
          // Atomic failure recovery: delivery → failed, draft → pending,
          // audit log all commit together. Throw fires AFTER the tx commits
          // so the caller sees BAD_GATEWAY only once the rollback is durable.
          await withTransaction(async (tx) => {
            await recordTwoPhaseSendFailure(tx, {
              ...completionCtx,
              error: sendResult.error,
              logLabel: isSimulator
                ? `Simulator transport rejected the draft — re-opened for retry`
                : `Twilio rejected the message — draft re-opened for retry`,
            });
          });
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message: `${transport.name} send failed: ${sendResult.error}`,
          });
        }

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
          // Best-effort RAG learning step — never block the customer reply on this.
          // Log to admin Errors tab so we still notice persistent embedding failures.
          void logServerError({
            source: "drafts.approve",
            err,
            level: "warn",
            context: { draftId: draft.id, intent: draft.intent },
            correlationId,
          });
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
    reject: adminProcedure
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
    sendMessage: adminProcedure
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
            // Confidence-auto-send path (off by default for safety). Routed
            // through getMessageTransport() so Live and Simulator modes share
            // the same Two-Phase Send shape: queued → sent (with sid) on
            // success, queued → failed + draft re-opened on transport
            // rejection. ATOMIC: state transition + outbound row land
            // together; transport call is OUT of the txn.
            const transport = getMessageTransport();
            const isSimulator = transport.name === "simulator";
            const auto = await withTransaction(async (tx) => {
              const moved = await transitionDraftStatusTx(tx, draftId!, "approved");
              if (!moved) return null;
              const outbound = await appendMessageTx(tx, {
                conversationId: conversation.id,
                direction: "outbound",
                sender: "ai",
                body: result.reply!,
                intent: result.intent,
                mode: isSimulator ? "simulator" : "live",
                status: "queued",
                correlationId,
              });
              return { outbound };
            });
            if (auto) {
              const sendResult = await transport.send(input.phone, result.reply);
              const completionCtx = {
                conversationId: conversation.id,
                inboundMessageId: inbound.id,
                outboundMessageId: auto.outbound.id,
                draftId: draftId!,
                correlationId,
              };
              await withTransaction(async (tx) => {
                if (sendResult.ok) {
                  await recordTwoPhaseSendSuccess(tx, {
                    ...completionCtx,
                    twilioSid: sendResult.sid,
                    logLabel: isSimulator
                      ? `Auto-delivered in Simulator (no real SMS) · sid ${sendResult.sid}`
                      : `Auto-sent via Twilio · sid ${sendResult.sid}`,
                  });
                } else {
                  await recordTwoPhaseSendFailure(tx, {
                    ...completionCtx,
                    error: sendResult.error,
                    logLabel: isSimulator
                      ? `Simulator transport rejected auto-sent draft — re-opened`
                      : `Twilio rejected auto-sent draft — re-opened for manager review`,
                  });
                }
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
          liveMode: isTransportLive(),
          smsSegmentEstimate: result.reply ? smsSegmentCount(result.reply) : 0,
          correlationId,
        };
      }),
  }),
  errorLogs: router({
    /**
     * Filterable list. Empty inputs returns the full newest-first feed (§4.3).
     * `level` and `source` filters compose with AND semantics so the admin can
     * drill from a spike alert down to the exact rows that triggered it.
     */
    list: adminProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(200).optional(),
            beforeId: z.number().int().positive().optional(),
            level: z.enum(["error", "warn"]).optional(),
            source: z.string().min(1).max(128).optional(),
          })
          .optional(),
      )
      .query(async ({ input }) => {
        return listErrorLogs(input ?? {});
      }),
    /** Distinct sources to populate the filter dropdown. */
    sources: adminProcedure.query(async () => {
      return listErrorSources();
    }),
    /** Wipe everything — destructive, used for demo/staging resets. */
    clear: adminProcedure.mutation(async () => {
      const count = await clearErrorLogs();
      return { cleared: count };
    }),
    /**
     * Drop rows older than `olderThanDays` (default 30). Returns affected
     * row counts for both errorLogs and errorAlerts. Idempotent: running
     * twice in a row makes the second call a no-op (count=0).
     */
    purgeOld: adminProcedure
      .input(
        z
          .object({
            olderThanDays: z.number().int().min(1).max(365).optional(),
          })
          .optional(),
      )
      .mutation(async ({ input }) => {
        const days = input?.olderThanDays ?? 30;
        const [logsPurged, alertsPurged] = await Promise.all([
          purgeOldErrorLogs(days),
          purgeOldErrorAlerts(days),
        ]);
        return { logsPurged, alertsPurged, olderThanDays: days };
      }),
    alerts: adminProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .query(async ({ input }) => {
        return listErrorAlerts(input ?? {});
      }),
  }),
  /* ============================================================
   * Pilot 2 — Salon (in-memory, no DB tables)
   * ============================================================
   *
   * The Salon demo is intentionally stateless and read-only on the
   * server side. The UI keeps the conversation transcript locally
   * (this mirrors the Simulator-Mode model the laundromat demo
   * already uses for the customer-facing iPhone), and posts each
   * customer turn to `salon.draft` to get an AI draft. There is
   * NO persisted approval queue — the operator approves in-session,
   * and the demo can be reset with a page refresh.
   */
  salon: router({
    /** List the live (in-memory) week of appointments for the calendar. */
    listAppointments: publicProcedure.query(async () => {
      const [appts, stylists, services] = await Promise.all([
        listAppointmentsForWeek(),
        listSalonStylists(),
        listSalonServices(),
      ]);
      return {
        appointments: appts.map((a) => {
          const svc = services.find((s) => s.category === a.serviceCategory);
          const stylist = stylists.find((s) => s.id === a.stylistId);
          return {
            id: a.id,
            customerId: a.customerId,
            stylistId: a.stylistId,
            stylistName: stylist?.name ?? a.stylistId,
            serviceCategory: a.serviceCategory,
            serviceName: svc?.name ?? a.serviceCategory,
            dayIndex: a.dayIndex,
            dayLabel: SALON_DAY_NAMES[a.dayIndex] ?? `Day ${a.dayIndex}`,
            startMinute: a.startMinute,
            totalMinutes: svc?.totalMinutes ?? 0,
            processingMinutes: svc?.processingMinutes ?? 0,
            label: formatSlot(a.dayIndex, a.startMinute, svc?.totalMinutes ?? 0),
            status: a.status,
          };
        }),
        stylists: stylists.map((s) => ({
          id: s.id,
          name: s.name,
          title: s.title,
          capabilities: s.capabilities,
        })),
        services: services.map((s) => ({
          category: s.category,
          name: s.name,
          totalMinutes: s.totalMinutes,
          processingMinutes: s.processingMinutes,
          price: formatPriceRange(s),
          description: s.description,
        })),
      };
    }),

    /** Look up a customer by phone (used by the simulator to pick a persona). */
    getCustomer: publicProcedure
      .input(z.object({ phone: z.string().min(4) }))
      .query(async ({ input }) => {
        const c = await getSalonCustomerByPhone(input.phone);
        return c ?? null;
      }),

    /** Surface overlap slots for a service category (the killer demo feature). */
    findOverlapSlots: publicProcedure
      .input(
        z.object({
          serviceCategory: z.enum([
            "cut",
            "perm",
            "color",
            "balayage",
            "manicure",
            "pedicure",
            "hairspa",
          ]),
          maxDays: z.number().int().min(1).max(7).optional(),
        }),
      )
      .query(async ({ input }) => {
        const slots = await findSalonOverlapSlots(
          input.serviceCategory as SalonServiceCategory,
          input.maxDays ?? 7,
        );
        return slots.map((s) => ({
          ...s,
          dayLabel: SALON_DAY_NAMES[s.dayIndex] ?? `Day ${s.dayIndex}`,
          label: formatSlot(s.dayIndex, s.startMinute, s.durationMinutes),
        }));
      }),

    /**
     * Closed-loop: operator approved an AI booking draft, materialize
     * it as a real appointment on the in-memory calendar.
     *
     * The agent has already validated the slot fits inside an existing
     * processing window (Overlap Auctioneer) or is otherwise free; this
     * mutation just commits the chosen tuple. We deliberately do NOT
     * re-validate here — the operator's approval is the authoritative
     * sign-off in the HITL model.
     */
    approveBooking: adminProcedure
      .input(
        z.object({
          customerId: z.string().min(1).max(100),
          stylistId: z.enum(["hayley", "jisoo", "soomin"]),
          serviceCategory: z.enum([
            "cut",
            "perm",
            "color",
            "balayage",
            "manicure",
            "pedicure",
            "hairspa",
          ]),
          dayIndex: z.number().int().min(0).max(6),
          startMinute: z.number().int().min(0).max(24 * 60 - 1),
        }),
      )
      .mutation(async ({ input }) => {
        const appt = await insertSalonAppointment({
          customerId: input.customerId,
          stylistId: input.stylistId,
          serviceCategory: input.serviceCategory as SalonServiceCategory,
          dayIndex: input.dayIndex,
          startMinute: input.startMinute,
          status: "confirmed",
        });
        const services = await listSalonServices();
        const svc = services.find((s) => s.category === appt.serviceCategory);
        return {
          appointment: {
            ...appt,
            dayLabel: SALON_DAY_NAMES[appt.dayIndex] ?? `Day ${appt.dayIndex}`,
            label: formatSlot(
              appt.dayIndex,
              appt.startMinute,
              svc?.totalMinutes ?? 0,
            ),
          } satisfies SalonAppointment & { dayLabel: string; label: string },
        };
      }),

    /** Reset the salon demo back to the seeded week (drops runtime appointments). */
    resetDemo: adminProcedure.mutation(async () => {
      await resetSalonRuntime();
      return { ok: true };
    }),

    /**
     * Phase 3 — Gap Filler. Marks the chosen appointment as no_show,
     * ranks top-N waiting-list candidates, and returns one outreach
     * SMS draft per candidate. Each draft carries a `bookingDraft`
     * the UI can submit through `salon.approveBooking` to commit.
     */
    simulateNoShow: adminProcedure
      .input(
        z.object({
          appointmentId: z.string().min(1).max(100),
          topN: z.number().int().min(1).max(5).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const start = Date.now();
        try {
          const result = await runGapFillerPipeline({
            appointmentId: input.appointmentId,
            topN: input.topN,
          });
          const services = await listSalonServices();
          const svc = services.find(
            (s) => s.category === result.freedAppointment.serviceCategory,
          );
          return {
            freedAppointment: {
              ...result.freedAppointment,
              dayLabel:
                SALON_DAY_NAMES[result.freedAppointment.dayIndex] ??
                `Day ${result.freedAppointment.dayIndex}`,
              label: formatSlot(
                result.freedAppointment.dayIndex,
                result.freedAppointment.startMinute,
                svc?.totalMinutes ?? 0,
              ),
            },
            drafts: result.drafts satisfies GapFillerDraft[],
            steps: result.steps,
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          await logServerError({
            level: "error",
            source: "salon.simulateNoShow",
            err,
            context: { appointmentId: input.appointmentId },
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              err instanceof Error
                ? err.message
                : "Gap Filler pipeline failed.",
          });
        }
      }),

    /**
     * Phase 4 — Processing-window reminders. Returns the set of
     * stylist-facing rinse alerts whose processing windows end within
     * `leadMinutes` of the supplied `now` cursor. Pure read — it
     * does NOT mutate appointment state.
     */
    checkProcessingReminders: publicProcedure
      .input(
        z.object({
          dayIndex: z.number().int().min(0).max(6),
          minute: z.number().int().min(0).max(24 * 60 - 1),
          leadMinutes: z.number().int().min(0).max(60).optional(),
        }),
      )
      .query(async ({ input }) => {
        const result = await runProcessingReminderPipeline({
          now: { dayIndex: input.dayIndex, minute: input.minute },
          leadMinutes: input.leadMinutes,
        });
        return {
          reminders: result.reminders satisfies ProcessingReminderDraft[],
          steps: result.steps,
        };
      }),

    /** Generate (do not send) an AI draft for a simulated inbound message. */
    draft: adminProcedure
      .input(
        z.object({
          phone: z.string().min(4),
          body: z.string().min(1).max(2000),
          intentOverride: z.enum([...SALON_INTENT_LABELS]).optional(),
          managerRejectReason: z.string().max(500).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const start = Date.now();
        let result: SalonAgentDraftResult;
        try {
          result = await draftSalonReply({
            phone: input.phone,
            body: input.body,
            intentOverride: input.intentOverride as SalonIntent | undefined,
            managerRejectReason: input.managerRejectReason,
          });
        } catch (err) {
          await logServerError({
            level: "error",
            source: "salon.draft",
            err,
            context: { phone: input.phone, body: input.body.slice(0, 200) },
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Salon draft generation failed.",
          });
        }
        return {
          ...result,
          latencyMs: Date.now() - start,
        };
      }),
  }),

  /* ---------- Phase 23: CleanCloud POS diagnostic (admin-only) ---------- */
  cleancloud: router({
    /**
     * Returns the friend's real account status + a small sample of customers,
     * orders, products, and price lists from CleanCloud. Used by the
     * /cleancloud-test admin panel to visually confirm that the token works
     * and the field mapping looks right BEFORE we flip
     * DROPSHOP_USE_REAL_POS=1 in production.
     *
     * Locked to adminProcedure so a leaked URL can't pull the store's
     * customer list. Truncates each list to 5 rows + slices long strings to
     * keep payloads bounded.
     */
    diagnostic: adminProcedure.query(async () => {
      const tokenSet = ENV.cleanCloudApiToken.length > 0;
      const useRealPos = ENV.useRealPos;
      const out: {
        tokenSet: boolean;
        useRealPos: boolean;
        priceLists: { ok: boolean; count: number; sample: unknown[]; error?: string };
        products: { ok: boolean; count: number; sample: unknown[]; error?: string };
        orders: { ok: boolean; count: number; sample: unknown[]; error?: string };
        customers: { ok: boolean; count: number; sample: unknown[]; error?: string };
      } = {
        tokenSet,
        useRealPos,
        priceLists: { ok: false, count: 0, sample: [] },
        products: { ok: false, count: 0, sample: [] },
        orders: { ok: false, count: 0, sample: [] },
        customers: { ok: false, count: 0, sample: [] },
      };
      if (!tokenSet) {
        return out;
      }
      const today = new Date().toISOString().slice(0, 10);
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      // Serialize the 4 calls. CleanCloud enforces a server-side throttle
      // that treats bursts as one client; Promise.all here tripped
      // "Rate Limit Exceeded" on the friend's account. The local rate
      // limiter inside cleanCloudTransport already paces single-flight
      // serial calls comfortably under 3 req/sec.
      const pricelistsR = await cleanCloud.getPriceLists();
      const productsR = await cleanCloud.getProducts({ sendUpcharges: 0 });
      // Active stores can have hundreds of orders per week — narrow to 3
      // days so the diagnostic always fits in one page.
      const ordersR = await cleanCloud.getOrders({
        dateFrom: threeDaysAgo,
        dateTo: today,
      });
      const customersR = await cleanCloud.getCustomer({
        dateFrom: sevenDaysAgo,
        dateTo: today,
      });
      if (pricelistsR.ok) {
        out.priceLists.ok = true;
        out.priceLists.count = pricelistsR.data.length;
        out.priceLists.sample = pricelistsR.data.slice(0, 10);
      } else {
        out.priceLists.error = pricelistsR.error;
      }
      if (productsR.ok) {
        out.products.ok = true;
        out.products.count = productsR.data.length;
        out.products.sample = productsR.data.slice(0, 5);
      } else {
        out.products.error = productsR.error;
      }
      if (ordersR.ok) {
        out.orders.ok = true;
        out.orders.count = ordersR.data.length;
        out.orders.sample = ordersR.data.slice(0, 5);
      } else {
        out.orders.error = ordersR.error;
      }
      if (customersR.ok) {
        const arr = Array.isArray(customersR.data) ? customersR.data : [customersR.data];
        out.customers.ok = true;
        out.customers.count = arr.length;
        // Redact phone last 4 digits — admins can verify shape without
        // exposing the entire customer list in a screenshot.
        out.customers.sample = arr.slice(0, 5).map((c: Record<string, unknown>) => {
          const tel = typeof c.customerTel === "string" ? c.customerTel : "";
          const masked = tel.length >= 4 ? `${tel.slice(0, -4)}****` : tel;
          return { ...c, customerTel: masked };
        });
      } else {
        out.customers.error = customersR.error;
      }
      return out;
    }),
  }),

  /* ---------- Phase 25a: vendor-neutral mirror admin controls ---------- */
  posMirror: router({
    /**
     * Manually trigger today's pull NOW (instead of waiting for the 03:00 ET
     * cron). Returns the same per-endpoint summary as the cron does. Idempotent
     * because every upsert is keyed on (source, externalId).
     */
    runDailyPullNow: adminProcedure.mutation(async () => {
      const summary = await runDailyPull("manual");
      return summary;
    }),
    /**
     * One-time historical backfill (default 12 months). Walks orders
     * month-by-month so a single bad month doesn't poison the entire job.
     */
    runBackfill: adminProcedure
      .input(
        z.object({
          monthsBack: z.number().int().min(1).max(36).default(12),
        }),
      )
      .mutation(async ({ input }) => {
        const summary = await runBackfill(input.monthsBack);
        return summary;
      }),
    /**
     * Sync status for the admin dashboard. Returns the latest run for each
     * endpoint plus a recent history feed. Owner Assistant calls this to
     * answer "how fresh is this data?".
     */
    syncStatus: adminProcedure.query(async () => {
      const [customers, orders, products, history] = await Promise.all([
        latestSyncLogForEndpoint("cleancloud", "getCustomer"),
        latestSyncLogForEndpoint("cleancloud", "getOrders"),
        latestSyncLogForEndpoint("cleancloud", "getProducts"),
        recentSyncLogs("cleancloud", 20),
      ]);
      return {
        latestByEndpoint: {
          customers,
          orders,
          products,
        },
        recent: history,
      };
    }),
  }),

  /* ---------- Phase 25c: Owner Assistant chat ---------- */
  ownerAssistant: router({
    /**
     * Run one turn of the agent. Creates a conversation row if
     * conversationId is null (first turn). Persists both the user
     * question and the assistant answer + trace, returns the answer +
     * the (possibly new) conversationId so the client can keep the
     * thread open.
     */
    ask: adminProcedure
      .input(
        z.object({
          conversationId: z.number().int().nullable(),
          question: z.string().min(1).max(2000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const ownerOpenId = ctx.user!.openId;

        // 1. Ensure a conversation row. On a brand-new thread we seed
        //    `title` with the first 80 chars of the question so the
        //    sidebar has a meaningful label.
        let conversationId = input.conversationId;
        const isFirstTurn = conversationId === null;
        if (isFirstTurn) {
          const title = input.question.slice(0, 80);
          conversationId = await createOwnerConversation({
            ownerOpenId,
            title,
          });
        }

        // 2. Persist the user message before invoking the agent so a
        //    crash mid-turn still leaves the question visible.
        if (conversationId !== null) {
          await appendOwnerMessage({
            conversationId,
            role: "user",
            contentMarkdown: input.question,
          });
        }

        // 3. Resolve freshness from the latest daily-pull log. The
        //    `getOrders` endpoint is the most relevant for owner
        //    questions about revenue/customers; if it's missing fall
        //    back to a UTC mirror timestamp.
        const resolveFreshnessHint = async (now: Date): Promise<string> => {
          const latest = await latestSyncLogForEndpoint(
            "cleancloud",
            "getOrders",
          );
          if (latest?.finishedAt) {
            return `${latest.finishedAt.toISOString().replace("T", " ").slice(0, 16)} UTC pull 기준`;
          }
          return `${now.toISOString().replace("T", " ").slice(0, 16)} UTC 기준 mirror`;
        };

        // 4. Run the agent. Wrap in try/catch so an LLM 5xx / timeout
        //    doesn't leave an orphan user-message row with no assistant
        //    reply visible in the thread. On failure we persist a
        //    synthetic assistant row carrying the error, then re-throw
        //    so the client toast still fires. Operator UX: they see
        //    "오류: …" in the thread instead of a silently half-turn.
        let answer;
        try {
          answer = await askOwnerAssistant(input.question, {
            resolveFreshnessHint,
          });
        } catch (err) {
          const errorText =
            err instanceof Error ? err.message : String(err);
          if (conversationId !== null) {
            await appendOwnerMessage({
              conversationId,
              role: "assistant",
              contentMarkdown: `오류: ${errorText.slice(0, 500)}`,
              trace: { error: errorText },
              totalLatencyMs: null,
            });
          }
          throw err;
        }

        // 5. Persist the assistant turn with its trace + latency.
        if (conversationId !== null) {
          await appendOwnerMessage({
            conversationId,
            role: "assistant",
            contentMarkdown: answer.answerMarkdown,
            trace: answer.trace,
            totalLatencyMs: answer.trace.totalLatencyMs,
          });
        }

        return {
          conversationId,
          answerMarkdown: answer.answerMarkdown,
          trace: answer.trace,
        };
      }),

    /** Sidebar list — newest conversations first. */
    listConversations: adminProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(50).default(20),
          })
          .default(() => ({ limit: 20 })),
      )
      .query(async ({ ctx, input }) =>
        listOwnerConversations(ctx.user!.openId, input.limit),
      ),

    /** Load a full conversation + its messages for the chat view.
     *  Tenant-scoped: a row whose ownerOpenId doesn't match the caller
     *  returns null exactly like a row that doesn't exist. Phase 25c
     *  is single-tenant, but the helper enforces this now so future
     *  multi-owner work can't accidentally regress cross-owner reads. */
    getConversation: adminProcedure
      .input(
        z.object({
          id: z.number().int(),
          messageLimit: z.number().int().min(1).max(500).optional(),
        }),
      )
      .query(({ ctx, input }) =>
        loadOwnerConversation(input.id, ctx.user!.openId, input.messageLimit),
      ),

    /** Manually-curated seeds for the empty-state of the chat UI. */
    suggestedPrompts: adminProcedure.query(
      () =>
        [
          "최근 2주 동안 단골 손님 동향",
          "지난 달 대비 이번 달 매출 어땠어?",
          "60일 이상 안 온 손님 알려줘",
          "오늘 픽업 예정 몇 건?",
          "지난 주 어떤 요일에 매출이 제일 높았어?",
        ] as const,
    ),
  }),

  /* ---------- Phase 25b: Daily Briefing ---------- */
  briefing: router({
    /** Latest briefing for the admin home card. */
    latest: adminProcedure.query(async () => {
      const row = await getLatestBriefing();
      return row ?? null;
    }),

    /** Specific date — used by history drilldown. */
    byDate: adminProcedure
      .input(z.object({ briefingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
      .query(async ({ input }) => {
        const row = await getBriefingByDate(input.briefingDate);
        return row ?? null;
      }),

    /** Newest-first history list, max 30. */
    list: adminProcedure
      .input(z.object({ limit: z.number().int().min(1).max(30).optional() }).optional())
      .query(async ({ input }) => {
        const limit = input?.limit ?? 30;
        return listBriefings(limit);
      }),

    /** Manual regeneration — overwrites the row for that date. */
    generateNow: adminProcedure
      .input(
        z
          .object({
            briefingDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
          })
          .optional(),
      )
      .mutation(async ({ input }) => {
        const briefingDate =
          input?.briefingDate ??
          (await import("./briefing/scheduledHandler")).yesterdayInNYC();
        return runDailyBriefing({ briefingDate });
      }),
  }),
});

export type AppRouter = typeof appRouter;
export { INTENT_LABELS };
