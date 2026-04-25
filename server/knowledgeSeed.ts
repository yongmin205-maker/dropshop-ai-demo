import { embedText } from "./embeddings";
import { getDb, listKnowledge, upsertKnowledgeChunk } from "./db";
import {
  MEMBERSHIP_INFO,
  SEED_PRICES,
  formatCents,
} from "./mockCleanCloud";

/**
 * Tier 1 RAG — editable facts about DropShop. These are seeded once; the
 * manager can add more via the UI. The embedding column is filled at seed
 * time so the retriever can immediately use them.
 */

interface SeedChunk {
  topic: string;
  title: string;
  body: string;
}

/**
 * Derive pricing/membership knowledge chunks from the same constants the
 * mock POS exposes. This eliminates the previous drift hazard where the
 * legacy hand-written pricing/tier chunks encoded numbers that no longer
 * matched `SEED_PRICES`/`MEMBERSHIP_INFO`. Now there is exactly one source.
 */
function derivedSeed(): SeedChunk[] {
  const dryCleanLines = SEED_PRICES.filter((p) => p.category === "dryClean")
    .map((p) => `${p.itemName} ${formatCents(p.priceCents)}`)
    .join(", ");
  const alterationLines = SEED_PRICES.filter((p) => p.category === "alteration")
    .map((p) => `${p.itemName} ${formatCents(p.priceCents)}`)
    .join(", ");
  const laundryLines = SEED_PRICES.filter((p) => p.category === "laundry")
    .map((p) => `${p.itemName} ${formatCents(p.priceCents)}`)
    .join(", ");

  const tiers = MEMBERSHIP_INFO;
  const membershipBody = [
    `${tiers.none.name}: pay-as-you-go (no monthly fee). Benefits: ${tiers.none.benefits.join("; ")}.`,
    `${tiers.silver.name}: ${tiers.silver.monthlyFee}, ${Math.round(tiers.silver.discount * 100)}% off. Benefits: ${tiers.silver.benefits.join("; ")}.`,
    `${tiers.gold.name}: ${tiers.gold.monthlyFee}, ${Math.round(tiers.gold.discount * 100)}% off. Benefits: ${tiers.gold.benefits.join("; ")}.`,
  ].join(" ");

  return [
    {
      topic: "pricing",
      title: "Dry Cleaning Price List (POS, derived)",
      body: `Starting prices: ${dryCleanLines}. Members receive their tier discount automatically.`,
    },
    {
      topic: "pricing",
      title: "Alteration Price List (POS, derived)",
      body: `Starting prices: ${alterationLines}. Final quotes depend on fabric, lining, and complexity.`,
    },
    {
      topic: "pricing",
      title: "Laundry Price List (POS, derived)",
      body: `Starting prices: ${laundryLines}.`,
    },
    {
      topic: "membership",
      title: "Membership Tiers (POS, derived)",
      body: membershipBody,
    },
  ];
}

const STATIC_SEED: SeedChunk[] = [
  {
    topic: "hours",
    title: "Business Hours",
    body:
      "DropShop is open Monday through Friday 7:00 AM – 8:00 PM, Saturday 9:00 AM – 6:00 PM, and closed on Sundays. The same-day express window closes at 11:00 AM on weekdays.",
  },
  {
    topic: "pickup",
    title: "Pickup & Delivery Coverage",
    body:
      "We offer free doorman pickup and delivery for addresses in Manhattan south of 96th Street and select Brooklyn neighborhoods (Williamsburg, Dumbo, Park Slope, Cobble Hill). Outside those zones we still serve but a $7 trip fee applies.",
  },
  {
    topic: "pickup",
    title: "Repeat Pickup Rule",
    body:
      "Returning customers can simply text 'Pickup for [first name]' and we will schedule the next available window at their saved address. Doorman buildings: no need to be home.",
  },
  {
    topic: "policy",
    title: "Turnaround Times",
    body:
      "Standard dry cleaning 48 hours. Same-day available if dropped off by 11:00 AM weekdays ($10 rush fee). Alterations 3–5 business days depending on complexity; rush alterations available upon request.",
  },
  {
    topic: "policy",
    title: "Stain & Up-Charge Policy",
    body:
      "Heavy stains, wedding dresses, silk lining, fur, suede, and leather incur up-charges that are always confirmed with the customer before cleaning begins. We never charge extra silently.",
  },
  // Pricing + membership chunks intentionally removed — they are now derived
  // from `SEED_PRICES` / `MEMBERSHIP_INFO` via `derivedSeed()` so the RAG
  // store and the POS data can never disagree about the numbers we quote.
];

// Compose the canonical seed list from static + derived chunks.
const SEED: SeedChunk[] = [...STATIC_SEED, ...derivedSeed()];

let seedOnce: Promise<void> | null = null;

/**
 * Seed (or refresh) the knowledge base. Cross-instance safe: every chunk is
 * written via `upsertKnowledgeChunk`, which relies on the unique
 * `(topic, title)` index on `knowledgeChunks`. Two pods racing to seed will
 * both succeed; later writes update existing rows in place.
 *
 * The empty-store short-circuit was removed because we now want changes to
 * `MEMBERSHIP_INFO`/`SEED_PRICES` (the single source of truth) to propagate
 * into the derived RAG chunks on the next boot, not just on the very first
 * one.
 */
export async function seedKnowledgeIfEmpty(): Promise<void> {
  if (seedOnce) return seedOnce;
  seedOnce = (async () => {
    const db = await getDb();
    if (!db) return;
    const existing = await listKnowledge();
    const haveByKey = new Set(existing.map((c) => `${c.topic}::${c.title}`));

    for (const chunk of SEED) {
      const key = `${chunk.topic}::${chunk.title}`;
      // Re-embed only when the row is new OR it's a derived ("POS") chunk
      // whose body might have shifted with the constants. Static chunks that
      // already exist are left untouched to avoid burning embedding tokens
      // on every boot.
      const isDerived = chunk.title.includes("(POS, derived)");
      if (haveByKey.has(key) && !isDerived) continue;

      const embedding = await embedText(`${chunk.title}\n${chunk.body}`);
      await upsertKnowledgeChunk({
        topic: chunk.topic,
        title: chunk.title,
        body: chunk.body,
        embedding,
      });
    }
  })().catch((err) => {
    // Allow retries on transient DB hiccup.
    seedOnce = null;
    throw err;
  });
  return seedOnce;
}
