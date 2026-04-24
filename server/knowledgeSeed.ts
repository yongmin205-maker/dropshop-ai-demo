import { embedText } from "./embeddings";
import { getDb, listKnowledge, upsertKnowledgeChunk } from "./db";

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

const SEED: SeedChunk[] = [
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
    topic: "membership",
    title: "Membership Tiers",
    body:
      "None (pay-as-you-go, list prices). Silver: $29/mo, 10% off dry cleaning and alterations, one free pickup/week. Gold: $59/mo, 20% off everything, unlimited pickups, priority turnaround.",
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
  {
    topic: "pricing",
    title: "Common Alteration Prices (starting)",
    body:
      "Hemming pants $15, shortening dress $25, replacing zipper on pants $35, jacket zipper replacement $85, patching jeans from $20. Final quotes depend on fabric, lining, and complexity.",
  },
  {
    topic: "pricing",
    title: "Common Dry Cleaning Prices (starting)",
    body:
      "Shirt $4.50, blouse $8, pants $10, 2-piece suit $22, dress $18, wool coat $28, comforter $45. Members receive 10% (Silver) or 20% (Gold) off.",
  },
];

let seedOnce: Promise<void> | null = null;

export async function seedKnowledgeIfEmpty(): Promise<void> {
  if (seedOnce) return seedOnce;
  seedOnce = (async () => {
    const db = await getDb();
    if (!db) return;
    const existing = await listKnowledge();
    if (existing.length > 0) return;

    for (const chunk of SEED) {
      const embedding = await embedText(`${chunk.title}\n${chunk.body}`);
      await upsertKnowledgeChunk({
        topic: chunk.topic,
        title: chunk.title,
        body: chunk.body,
        embedding,
      });
    }
  })();
  return seedOnce;
}
