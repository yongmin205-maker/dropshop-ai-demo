import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_INFO,
  SEED_CUSTOMERS,
  SEED_ORDERS,
  SEED_PRICES,
  formatCents,
  getMembershipInfo,
} from "./mockCleanCloud";

describe("Mock CleanCloud — seed data shape", () => {
  it("every seed customer has phone, name, and a valid membership tier", () => {
    const validTiers = new Set(["none", "silver", "gold"]);
    for (const c of SEED_CUSTOMERS) {
      expect(c.phone).toMatch(/^\+\d{8,}$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(validTiers.has(c.membership)).toBe(true);
    }
  });

  it("every seed order references a known customer phone and uses an allowed status", () => {
    const phones = new Set(SEED_CUSTOMERS.map((c) => c.phone));
    const allowed = new Set(["Awaiting Pickup", "Cleaning", "Ready to Deliver", "Completed"]);
    for (const o of SEED_ORDERS) {
      expect(phones.has(o.customerPhone)).toBe(true);
      expect(allowed.has(o.status)).toBe(true);
      expect(o.orderNumber).toMatch(/^DS-\d+$/);
      expect(typeof o.totalCents).toBe("number");
    }
  });

  it("price list covers dryClean, alteration, and laundry categories", () => {
    const cats = new Set(SEED_PRICES.map((p) => p.category));
    expect(cats.has("dryClean")).toBe(true);
    expect(cats.has("alteration")).toBe(true);
    expect(cats.has("laundry")).toBe(true);
  });

  it("membership info helper returns benefit list and consistent discount ordering", () => {
    expect(getMembershipInfo("none").benefits.length).toBeGreaterThan(0);
    expect(getMembershipInfo("silver").benefits.length).toBeGreaterThan(0);
    expect(getMembershipInfo("gold").benefits.length).toBeGreaterThan(0);
    expect(MEMBERSHIP_INFO.gold.discount).toBeGreaterThan(MEMBERSHIP_INFO.silver.discount);
  });

  it("formatCents formats USD correctly", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(700)).toBe("$7.00");
    expect(formatCents(12345)).toBe("$123.45");
  });
});
