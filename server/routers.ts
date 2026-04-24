import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { runAgent } from "./aiAgent";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  appendMessage,
  appendProcessingLog,
  createEscalation,
  getConversationLogs,
  getConversationMessages,
  getOpenEscalations,
  getOrCreateConversation,
  listConversations,
  resolveEscalation,
  updateConversationIntent,
} from "./db";
import { ensureSeeded, getCustomerByPhone } from "./mockCleanCloud";
import { isLiveMode, sendSms } from "./twilio";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
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
    })),
  }),

  conversations: router({
    list: publicProcedure.query(async () => {
      await ensureSeeded();
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

  simulator: router({
    /** Inbound message arrives from the simulator phone */
    sendMessage: publicProcedure
      .input(
        z.object({
          phone: z.string().min(5).max(32),
          body: z.string().min(1).max(1000),
        }),
      )
      .mutation(async ({ input }) => {
        await ensureSeeded();
        const customer = await getCustomerByPhone(input.phone);
        const conversation = await getOrCreateConversation(input.phone, customer?.name ?? undefined);

        // 1. Persist inbound message
        const inbound = await appendMessage({
          conversationId: conversation.id,
          direction: "inbound",
          sender: "customer",
          body: input.body,
          mode: isLiveMode() ? "live" : "simulator",
        });

        // 2. Run agent
        let result;
        try {
          result = await runAgent({ phone: input.phone, body: input.body });
        } catch (err) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: err instanceof Error ? err.message : "Agent failed",
          });
        }

        // 3. Persist processing log steps
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

        let outboundMessage = null;
        let liveSendInfo: { ok: boolean; sid?: string; error?: string } | null = null;

        if (result.escalated) {
          await createEscalation({
            conversationId: conversation.id,
            messageId: inbound.id,
            reason: result.escalationReason ?? "Critical message detected",
          });
        } else if (result.reply) {
          // Persist outbound AI reply
          outboundMessage = await appendMessage({
            conversationId: conversation.id,
            direction: "outbound",
            sender: "ai",
            body: result.reply,
            intent: result.intent,
            mode: isLiveMode() ? "live" : "simulator",
          });
          await appendProcessingLog({
            conversationId: conversation.id,
            messageId: inbound.id,
            step: "sent",
            label: isLiveMode()
              ? `SMS dispatched via Twilio to ${input.phone}`
              : `Reply delivered in Simulator Mode`,
            detail: { reply: result.reply },
          });

          // If Live Mode, attempt actual SMS dispatch
          if (isLiveMode()) {
            liveSendInfo = await sendSms(input.phone, result.reply);
          }
        }

        return {
          conversationId: conversation.id,
          intent: result.intent,
          inbound,
          outbound: outboundMessage,
          escalated: result.escalated,
          escalationReason: result.escalationReason,
          steps: result.steps,
          liveMode: isLiveMode(),
          liveSendInfo,
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
