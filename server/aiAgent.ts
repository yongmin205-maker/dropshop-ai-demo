import { invokeLLM } from "./_core/llm";
import {
  formatCents,
  getCustomerByPhone,
  getMembershipInfo,
  getOrdersByPhone,
  listAllPrices,
  searchPrice,
} from "./mockCleanCloud";

/* ============================================================
 * AI Agent — intent classification + DropShop reply generation
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

export interface AgentResult {
  intent: Intent;
  reply: string | null; // null when escalated (no auto-reply)
  escalated: boolean;
  escalationReason?: string;
  steps: AgentStep[];
  toolContext: Record<string, unknown>;
}

/* ----- Intent classifier (LLM with strict JSON schema) ----- */

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
            intent: {
              type: "string",
              enum: [...INTENT_LABELS],
            },
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
    // fall through
  }
  return "Membership & Pricing";
}

/* ----- Reply generator ----- */

const BRAND_VOICE = `You are the official SMS assistant for DropShop, a premium NYC dry-cleaning concierge.
Voice: warm, polished, concise, never salesy. Always sign off with a short single-line "— DropShop".
Rules:
- Keep replies under 280 characters when possible.
- Never invent prices, ETAs, or order numbers — use only what the tool data provides.
- Never confirm pickup unless the data shows the customer exists.
- Use the customer's first name if you know it.
- Use the four exact order statuses verbatim when relevant: Awaiting Pickup, Cleaning, Ready to Deliver, Completed.
- Never apologize excessively. One graceful sentence is enough.`;

async function generateReply(opts: {
  body: string;
  intent: Intent;
  toolContext: Record<string, unknown>;
}): Promise<string> {
  const res = await invokeLLM({
    messages: [
      { role: "system", content: BRAND_VOICE },
      {
        role: "user",
        content: `Intent: ${opts.intent}
Customer message: """${opts.body}"""
Tool data (mock CleanCloud POS):
${JSON.stringify(opts.toolContext, null, 2)}

Compose the SMS reply.`,
      },
    ],
  });
  const out = res.choices?.[0]?.message?.content;
  return typeof out === "string"
    ? out.trim()
    : "Thanks for reaching DropShop. We'll get back to you shortly.\n— DropShop";
}

/* ----- Main entry ----- */

export async function runAgent(opts: {
  phone: string;
  body: string;
}): Promise<AgentResult> {
  const steps: AgentStep[] = [];

  const intent = await classifyIntent(opts.body);
  steps.push({
    step: "intent_detected",
    label: `Intent classified as ${intent}`,
    detail: { intent },
  });

  // Critical Escalation — never auto-reply
  if (intent === "Critical Escalation") {
    const reason = "Critical message detected — auto-reply suspended, manager paged.";
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
    };
  }

  // Tool dispatch
  const customer = await getCustomerByPhone(opts.phone);
  const toolContext: Record<string, unknown> = {
    customer: customer
      ? {
          name: customer.name,
          membership: customer.membership,
          address: customer.address,
        }
      : { found: false, note: "Phone not found in CleanCloud — treat as new lead." },
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

  const reply = await generateReply({
    body: opts.body,
    intent,
    toolContext,
  });
  steps.push({
    step: "response_drafted",
    label: `Drafted DropShop reply (${reply.length} chars)`,
    detail: { reply },
  });

  return {
    intent,
    reply,
    escalated: false,
    steps,
    toolContext,
  };
}
