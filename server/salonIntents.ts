import { invokeLLM } from "./_core/llm";

/* ============================================================
 * Salon intent classifier
 * ------------------------------------------------------------
 * Mirrors the structure of aiAgent.classifyIntent() but with
 * salon-specific labels and few-shot examples. Like the
 * laundromat classifier, it FAILS SAFE: any parse failure or
 * unknown label is routed to "Critical Escalation" so a human
 * eyes it instead of the bot guessing.
 * ============================================================ */

export const SALON_INTENT_LABELS = [
  "Booking Request",
  "Availability Check",
  "Reschedule",
  "Cancel",
  "Service Question",
  "Pricing",
  "Critical Escalation",
] as const;

export type SalonIntent = (typeof SALON_INTENT_LABELS)[number];

const CLASSIFIER_SYSTEM = `You are an intent classifier for a high-end Korean hair salon.
Classify the customer's SMS into EXACTLY ONE of these intents:

- "Booking Request" — customer wants to book a service at a specific time, OR asks for the next available slot for a specific service ("can I get a cut tomorrow at 2", "book me for a perm Friday afternoon", "any opening for balayage this week").
- "Availability Check" — customer asks generally about availability without proposing a service or time ("are you guys open Sunday?", "do you take walk-ins this evening?").
- "Reschedule" — customer wants to move an existing appointment to a different time ("can we push my Friday color to Saturday").
- "Cancel" — customer wants to cancel an existing appointment ("need to cancel my balayage tomorrow").
- "Service Question" — non-pricing questions about a service ("how long does a perm take", "do you do keratin treatments", "is bleach safe for color-treated hair").
- "Pricing" — questions about prices, deposits, packages, gift cards, or membership.
- "Critical Escalation" — chemical burn, allergic reaction, refund demand, anger over a bad result, accusation (theft, damaged hair), legal threat, anything that should NEVER be auto-answered by a bot.

Be conservative: if a message reports a burn, scalp injury, allergy, hair damage, refund demand, or accusatory tone, classify as "Critical Escalation".

Few-shot examples (study these before classifying):
- "Hi, can I get a cut this Saturday at 2pm?" -> Booking Request
- "Looking for a balayage opening this week, prefer Jisoo" -> Booking Request
- "Any opening for a perm tomorrow?" -> Booking Request
- "Are you open Sunday morning?" -> Availability Check
- "Do you take walk-ins?" -> Availability Check
- "Need to push my Friday color appointment to Saturday same time if possible" -> Reschedule
- "Can we move my Wed perm to next week?" -> Reschedule
- "Please cancel my balayage appointment tomorrow" -> Cancel
- "I won't make my appointment, cancel it" -> Cancel
- "How long does a perm usually take?" -> Service Question
- "Do you do keratin treatments?" -> Service Question
- "How much is a single-process color?" -> Pricing
- "Do you offer gift cards?" -> Pricing
- "My scalp is burning after the perm yesterday" -> Critical Escalation
- "I want a refund, my hair is destroyed" -> Critical Escalation
- "I'm allergic to the bleach you used, calling my lawyer" -> Critical Escalation`;

export async function classifySalonIntent(body: string): Promise<SalonIntent> {
  const res = await invokeLLM({
    messages: [
      { role: "system", content: CLASSIFIER_SYSTEM },
      { role: "user", content: body },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "salon_intent_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            intent: { type: "string", enum: [...SALON_INTENT_LABELS] },
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
    if (SALON_INTENT_LABELS.includes(parsed.intent)) {
      return parsed.intent as SalonIntent;
    }
  } catch {
    /* fall through to fail-safe */
  }
  // Fail-safe: any uncertainty routes to a human.
  return "Critical Escalation";
}
