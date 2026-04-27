/* ============================================================
 * Salon demo scenarios — preset customer messages
 * ------------------------------------------------------------
 * Mirrors shared/scenarios.ts in shape so the salon UI can use
 * the same one-tap "preset bubble" pattern as the laundromat.
 * ============================================================ */

export interface SalonPresetScenario {
  id: string;
  label: string;
  body: string;
  customerPhone: string; // matches a mockSalon SEED_CUSTOMERS phone (or unknown)
  customerId: string; // matches a mockSalon SEED_CUSTOMERS.id (used by closed-loop approveBooking)
  customerName: string;
  /** Visual hint for the bubble dot color */
  tone: "sage" | "terracotta" | "rose" | "ink";
  /** Why this scenario showcases the AI's value (shown as caption) */
  caption: string;
}

export const SALON_PRESET_SCENARIOS: SalonPresetScenario[] = [
  {
    id: "overlap-cut",
    label: "Cut booking → Overlap slot",
    body: "Hi! Looking for a cut sometime this week, the sooner the better.",
    customerPhone: "+15550201003", // Emily Park
    customerId: "c-emily",
    customerName: "Emily Park",
    tone: "sage",
    caption: "Killer demo: AI offers a slot inside another customer's perm processing window.",
  },
  {
    id: "vip-balayage",
    label: "VIP balayage rebook",
    body: "Need my balayage refresh next weekend, prefer Jisoo if she's around.",
    customerPhone: "+15550201002", // Sarah Lee
    customerId: "c-sarah",
    customerName: "Sarah Lee (VIP)",
    tone: "terracotta",
    caption: "VIP context surfaces — AI prioritizes Jisoo and references the 4-week cadence.",
  },
  {
    id: "reschedule",
    label: "Reschedule existing perm",
    body: "Hey, can we move my Wednesday perm to next week? Same time if possible.",
    customerPhone: "+15550201001", // Jessica Kim
    customerId: "c-jessica",
    customerName: "Jessica Kim",
    tone: "ink",
    caption: "AI looks up the existing appointment and proposes a swap.",
  },
  {
    id: "pricing",
    label: "Pricing inquiry",
    body: "How much for a single-process color these days?",
    customerPhone: "+15550201004", // Cindy Choi
    customerId: "c-cindy",
    customerName: "Cindy Choi (new)",
    tone: "sage",
    caption: "AI quotes the catalog price band — no hallucination.",
  },
  {
    id: "critical",
    label: "Allergic reaction (Critical)",
    body: "My scalp is burning and red after yesterday's perm — what do I do??",
    customerPhone: "+15550201001",
    customerId: "c-jessica",
    customerName: "Jessica Kim",
    tone: "rose",
    caption: "Critical Escalation — auto-reply suspended, manager paged immediately.",
  },
];
