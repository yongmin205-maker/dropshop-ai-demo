import { describe, expect, it } from "vitest";
import { INTENT_LABELS } from "./aiAgent";
import { MEMBERSHIP_INFO, SEED_ORDERS, formatCents } from "./mockCleanCloud";

describe("AI agent contracts", () => {
  it("exposes exactly the five required intent labels", () => {
    expect(INTENT_LABELS).toEqual([
      "Pickup Request",
      "ETA/Order Status",
      "Alteration Quote",
      "Membership & Pricing",
      "Critical Escalation",
    ]);
  });

  it("seeds orders using exactly the four required statuses", () => {
    const allowed = new Set([
      "Awaiting Pickup",
      "Cleaning",
      "Ready to Deliver",
      "Completed",
    ]);
    for (const order of SEED_ORDERS) {
      expect(allowed.has(order.status)).toBe(true);
    }
    // ensure all four statuses appear at least once in the seed
    const present = new Set(SEED_ORDERS.map((o) => o.status));
    for (const s of allowed) {
      expect(present.has(s)).toBe(true);
    }
  });

  it("provides three membership tiers with discount semantics", () => {
    expect(Object.keys(MEMBERSHIP_INFO).sort()).toEqual(["gold", "none", "silver"]);
    expect(MEMBERSHIP_INFO.gold.discount).toBeGreaterThan(MEMBERSHIP_INFO.silver.discount);
    expect(MEMBERSHIP_INFO.silver.discount).toBeGreaterThan(MEMBERSHIP_INFO.none.discount);
  });

  it("formats cents into US currency string", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1995)).toBe("$19.95");
    expect(formatCents(700)).toBe("$7.00");
  });
});
