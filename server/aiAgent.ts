import { invokeLLM } from "./_core/llm";
import {
  formatCents,
  getCustomerByPhone,
  getMembershipInfo,
  getOrdersByPhone,
  listAllPrices,
  searchPrice,
} from "./mockCleanCloud";
import {
  listKnowledge,
  listRejections,
  listStyleExamples,
  listStyleExamplesByPhone,
} from "./db";
import { embedText, topK } from "./embeddings";

/* ============================================================
 * AI Agent — intent classification + RAG-aware draft generation
 * ============================================================ */

export const INTENT_LABELS = [
  "Pickup Request",
  "ETA/Order Status",
  "Alteration Quote",
  "Membership & Pricing",
  "Critical Escalation",
] as const;

export type Intent = (typeof INTENT_LABELS)[number];

export interface AgentStep {
  step:
    | "intent_detected"
    | "mock_api_called"
    | "response_drafted"
    | "sent"
    | "escalated";
  label: string;
  detail?: unknown;
}

export interface RagContext {
  knowledge: Array<{ title: string; body: string; score: number }>;
  styleExamples: Array<{
    intent: string;
    customerBody: string;
    approvedReply: string;
    score: number;
  }>;
  rejectionLessons: Array<{
    intent: string;
    rejectedReply: string;
    reason: string;
    score: number;
  }>;
}

export interface AgentDraftResult {
  intent: Intent;
  reply: string | null; // null when escalated (no draft, only handoff)
  escalated: boolean;
  escalationReason?: string;
  steps: AgentStep[];
  toolContext: Record<string, unknown>;
  ragContext: RagContext;
}

/* ----- Intent classifier ----- */

const CLASSIFIER_SYSTEM = `You are an intent classifier for DropShop, a premium NYC dry-cleaning service.
Classify the customer's SMS into EXACTLY ONE of these intents:

- "Pickup Request" — customer wants their laundry picked up (e.g., "pickup for Marie", "ready for pickup tomorrow").
- "ETA/Order Status" — customer wants to know order status, delivery time, or "where is my laundry".
- "Alteration Quote" — customer asks the price of a repair, hem, zipper, patch, alteration (often with a photo).
- "Membership & Pricing" — questions about regular prices, member rates, plans, discounts, billing.
- "Critical Escalation" — lost item, theft suspicion, damage, anger, refund demand, legal threat, CCTV evidence, or anything that should NEVER be auto-answered by a bot.

Be conservative: if a message reports anything missing, damaged, stolen, or includes accusatory tone, classify as "Critical Escalation".`;

export async function classifyIntent(body: string): Promise<Intent> {
  const res = await invokeLLM({
    messages: [
      { role: "system", content: CLASSIFIER_SYSTEM },
      { role: "user", content: body },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "intent_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            intent: { type: "string", enum: [...INTENT_LABELS] },
          },
          required: ["intent"],
          additionalProperties: false,
        },
      },
    },
  });
  try {
    const content = res.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof content === "string" ? content : "{}");
    if (INTENT_LABELS.includes(parsed.intent)) return parsed.intent as Intent;
  } catch {
    /* fall through */
  }
  // Fail-safe: when classification is uncertain, route to Critical
  // Escalation. The previous default ('Membership & Pricing') was *fail-open*
  // — a theft report whose JSON came back malformed could end up answered
  // as a pricing question. Routing to escalation pages a human instead.
  return "Critical Escalation";
}

/* ----- Reply generator with RAG few-shot ----- */

const BRAND_VOICE = `You are the official SMS assistant for DropShop, a premium NYC dry-cleaning concierge.
Voice: warm, polished, concise, never salesy. Always sign off with a short single-line "— DropShop".
Rules:
- Keep replies under 280 characters when possible.
- Never invent prices, ETAs, or order numbers — use only what the tool data provides.
- Never confirm pickup unless the data shows the customer exists.
- Use the customer's first name if known.
- Use the four exact order statuses verbatim when relevant: Awaiting Pickup, Cleaning, Ready to Deliver, Completed.
- Never apologize excessively; one graceful sentence is enough.`;

function formatRagBlock(rag: RagContext): string {
  const parts: string[] = [];
  if (rag.knowledge.length) {
    parts.push(
      "RELEVANT STORE FACTS (Knowledge Base):\n" +
        rag.knowledge
          .map((k) => `- ${k.title}: ${k.body}`)
          .join("\n")
    );
  }
  if (rag.styleExamples.length) {
    parts.push(
      "APPROVED PAST REPLIES (match this tone, never contradict the prior gold replies):\n" +
        rag.styleExamples
          .map(
            (ex, i) =>
              `Example ${i + 1} [${ex.intent}]\n  Customer: ${ex.customerBody}\n  Approved DropShop reply: ${ex.approvedReply}`
          )
          .join("\n")
    );
  }
  if (rag.rejectionLessons.length) {
    parts.push(
      "LESSONS FROM REJECTED DRAFTS (do NOT repeat these mistakes):\n" +
        rag.rejectionLessons
          .map(
            (r, i) =>
              `Lesson ${i + 1} [${r.intent}]\n  Rejected draft: ${r.rejectedReply}\n  Manager reason: ${r.reason}`
          )
          .join("\n")
    );
  }
  return parts.join("\n\n");
}

export async function retrieveRag(opts: {
  body: string;
  intent: Intent;
  phone?: string;
}): Promise<RagContext> {
  const [allKnowledge, allExamples, allRejections, customerExamples] = await Promise.all([
    listKnowledge(),
    listStyleExamples(),
    listRejections(),
    opts.phone ? listStyleExamplesByPhone(opts.phone) : Promise.resolve([]),
  ]);
  const queryEmb = await embedText(opts.body);

  const kTop = topK(queryEmb, allKnowledge, 3)
    .filter((r) => r.score > 0)
    .map((r) => ({ title: r.title, body: r.body, score: r.score }));

  // Prefer this customer's own approved replies first (true personalization),
  // then same-intent across all customers, then anything as last resort.
  const sameIntentExamples = allExamples.filter((e) => e.intent === opts.intent);
  const examplePool =
    customerExamples.length >= 1
      ? customerExamples
      : sameIntentExamples.length >= 2
        ? sameIntentExamples
        : allExamples;
  const eTop = topK(queryEmb, examplePool, 3)
    .filter((r) => r.score > 0)
    .map((r) => ({
      intent: r.intent,
      customerBody: r.customerBody,
      approvedReply: r.approvedReply,
      score: r.score,
    }));

  const rTop = topK(queryEmb, allRejections, 2)
    .filter((r) => r.score > 0)
    .map((r) => ({
      intent: r.intent,
      rejectedReply: r.rejectedReply,
      reason: r.reason,
      score: r.score,
    }));

  return {
    knowledge: kTop,
    styleExamples: eTop,
    rejectionLessons: rTop,
  };
}

async function generateReply(opts: {
  body: string;
  intent: Intent;
  toolContext: Record<string, unknown>;
  rag: RagContext;
  managerRejectReason?: string; // hint when regenerating after a reject
}): Promise<string> {
  const ragBlock = formatRagBlock(opts.rag);
  const regenHint = opts.managerRejectReason
    ? `\n\nIMPORTANT — the manager just rejected the previous draft with reason: """${opts.managerRejectReason}""". Rewrite the reply so it clearly addresses that feedback.`
    : "";

  const res = await invokeLLM({
    messages: [
      { role: "system", content: BRAND_VOICE },
      {
        role: "user",
        content:
          `Intent: ${opts.intent}\n` +
          `Customer message: """${opts.body}"""\n\n` +
          `Tool data (Mock CleanCloud POS):\n${JSON.stringify(opts.toolContext, null, 2)}\n\n` +
          (ragBlock ? `${ragBlock}\n\n` : "") +
          `Compose the SMS reply for DropShop.${regenHint}`,
      },
    ],
  });
  const out = res.choices?.[0]?.message?.content;
  return typeof out === "string"
    ? out.trim()
    : "Thanks for reaching DropShop. We'll get back to you shortly.\n— DropShop";
}

/* ----- Main entry: draft generation (does NOT send) ----- */

export async function draftAgentReply(opts: {
  phone: string;
  body: string;
  managerRejectReason?: string;
  intentOverride?: Intent;
}): Promise<AgentDraftResult> {
  const steps: AgentStep[] = [];

  const intent = opts.intentOverride ?? (await classifyIntent(opts.body));
  steps.push({
    step: "intent_detected",
    label: `Intent classified as ${intent}`,
    detail: { intent },
  });

  if (intent === "Critical Escalation") {
    const reason =
      "Critical message detected — auto-reply suspended, manager paged.";
    steps.push({
      step: "escalated",
      label: reason,
      detail: { phone: opts.phone, body: opts.body },
    });
    return {
      intent,
      reply: null,
      escalated: true,
      escalationReason: reason,
      steps,
      toolContext: {},
      ragContext: { knowledge: [], styleExamples: [], rejectionLessons: [] },
    };
  }

  // Tool dispatch (mock POS)
  const customer = await getCustomerByPhone(opts.phone);
  const toolContext: Record<string, unknown> = {
    customer: customer
      ? {
          name: customer.name,
          membership: customer.membership,
          address: customer.address,
        }
      : {
          found: false,
          note: "Phone not found in CleanCloud — treat as new lead.",
        },
  };
  steps.push({
    step: "mock_api_called",
    label: customer
      ? `getCustomerByPhone(${opts.phone}) → ${customer.name} [${customer.membership}]`
      : `getCustomerByPhone(${opts.phone}) → not found`,
    detail: toolContext.customer,
  });

  if (intent === "ETA/Order Status" || intent === "Pickup Request") {
    const orders = customer ? await getOrdersByPhone(opts.phone) : [];
    toolContext.orders = orders.map((o) => ({
      orderNumber: o.orderNumber,
      status: o.status,
      itemsSummary: o.itemsSummary,
      total: formatCents(o.totalCents),
      etaText: o.etaText,
    }));
    steps.push({
      step: "mock_api_called",
      label: `getOrdersByPhone(${opts.phone}) → ${orders.length} order(s)`,
      detail: toolContext.orders,
    });
  }

  if (intent === "Alteration Quote") {
    const matches = await searchPrice("alteration");
    toolContext.alterationPrices = matches.map((p) => ({
      item: p.itemName,
      price: formatCents(p.priceCents),
      notes: p.notes,
    }));
    steps.push({
      step: "mock_api_called",
      label: `searchPrice("alteration") → ${matches.length} item(s)`,
      detail: toolContext.alterationPrices,
    });
  }

  if (intent === "Membership & Pricing") {
    const all = await listAllPrices();
    toolContext.priceList = all.map((p) => ({
      category: p.category,
      item: p.itemName,
      price: formatCents(p.priceCents),
      notes: p.notes,
    }));
    toolContext.memberships = {
      none: getMembershipInfo("none"),
      silver: getMembershipInfo("silver"),
      gold: getMembershipInfo("gold"),
    };
    steps.push({
      step: "mock_api_called",
      label: `listAllPrices() + getMembershipInfo(*) → ${all.length} prices, 3 tiers`,
      detail: { count: all.length },
    });
  }

  // RAG retrieval
  const rag = await retrieveRag({ body: opts.body, intent, phone: opts.phone });
  steps.push({
    step: "mock_api_called",
    label: `RAG retrieval → ${rag.knowledge.length} facts, ${rag.styleExamples.length} style examples, ${rag.rejectionLessons.length} rejection lessons`,
    detail: rag,
  });

  const reply = await generateReply({
    body: opts.body,
    intent,
    toolContext,
    rag,
    managerRejectReason: opts.managerRejectReason,
  });
  steps.push({
    step: "response_drafted",
    label: opts.managerRejectReason
      ? `Regenerated DropShop draft (${reply.length} chars) after manager feedback`
      : `Drafted DropShop reply (${reply.length} chars) — awaiting approval`,
    detail: { reply },
  });

  return {
    intent,
    reply,
    escalated: false,
    steps,
    toolContext,
    ragContext: rag,
  };
}

// Backwards compatibility: some existing callers used runAgent.
// In the HITL flow the "run" simply returns the draft; the caller decides
// whether to auto-send (for confidence auto-send mode) or stage for approval.
export const runAgent = draftAgentReply;
