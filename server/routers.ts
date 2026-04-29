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
import { isE164, isLiveMode, sendSms, smsSegmentCount } from "./twilio";
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

        // Phase 2 (live mode only): hand off to Twilio. The Twilio HTTP call
        // happens OUTSIDE any open DB transaction (holding a tx open across an
        // upstream RPC would burn a connection for hundreds of ms and risks
        // pool exhaustion under load). Once the carrier answers, we record the
        // outcome inside ONE transaction so the delivery flip, draft re-open
        // (failure case), and processing-log row commit together. Pre-fix/2
        // those writes ran outside any tx — a crash between Twilio ack and
        // the bare `updateMessageDelivery` call left a confirmed-sent SMS
        // visible as `queued` forever, which the stuck-queued-row sweeper
        // then alarmed on.
        let liveSendInfo: { ok: boolean; sid?: string; error?: string } | null = null;
        if (live) {
          const phone = conv?.phone ?? "";
          const sendResult = await sendSms(phone, draft.body);
          const completionCtx = {
            conversationId: draft.conversationId,
            inboundMessageId: draft.inboundMessageId,
            outboundMessageId: outbound.id,
            draftId: draft.id,
            correlationId,
          };
          if (sendResult.ok) {
            await withTransaction(async (tx) => {
              await recordTwoPhaseSendSuccess(tx, {
                ...completionCtx,
                twilioSid: sendResult.sid,
                logLabel: `Approved & dispatched via Twilio`,
              });
            });
            liveSendInfo = { ok: true, sid: sendResult.sid };
          } else {
            // Atomic failure recovery: delivery → failed, draft → pending,
            // audit log all commit together via the shared helper. The throw
            // fires AFTER the tx commits so the caller sees BAD_GATEWAY only
            // once the rollback is durable.
            await withTransaction(async (tx) => {
              await recordTwoPhaseSendFailure(tx, {
                ...completionCtx,
                error: sendResult.error,
                logLabel: `Twilio rejected the message — draft re-opened for retry`,
              });
            });
            throw new TRPCError({
              code: "BAD_GATEWAY",
              message: `Twilio send failed: ${sendResult.error}`,
            });
          }
        } else {
          // Simulator mode: no carrier call, single processing-log write.
          await appendProcessingLog({
            conversationId: draft.conversationId,
            messageId: draft.inboundMessageId,
            step: "sent",
            label: `Approved & delivered in Simulator Mode`,
            detail: {
              draftId: draft.id,
              outboundId: outbound.id,
              twilioSid: null,
            },
            correlationId,
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
                    logLabel: `Auto-sent via Twilio (auto-send mode on)`,
                  });
                } else {
                  await recordTwoPhaseSendFailure(tx, {
                    ...completionCtx,
                    error: sendResult.error,
                    logLabel: `Twilio rejected auto-sent draft — re-opened for manager review`,
                  });
                }
              });
            } else if (auto) {
              // Simulator auto-send: no Twilio call. One ack log row.
              // (Pre-fix/3 the live failure branch ALSO landed here and
              // logged a misleading "sent" row outside the failure tx; the
              // helpers fix that — failure now produces a single send_failed
              // row inside the tx.)
              await appendProcessingLog({
                conversationId: conversation.id,
                messageId: inbound.id,
                step: "sent",
                label: `Auto-delivered in Simulator Mode (auto-send mode on)`,
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
});

export type AppRouter = typeof appRouter;
export { INTENT_LABELS };
