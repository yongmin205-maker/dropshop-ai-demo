/**
 * dailyMetrics.test.ts — pure function tests for computeDailyMetrics
 * + nycDateToBusinessDayStart timezone helper. No DB.
 */
import { describe, it, expect } from "vitest";
import {
  computeDailyMetrics,
  nycDateToBusinessDayStart,
} from "./dailyMetrics";
import type { PosOrder } from "../../drizzle/schema";

function order(overrides: Partial<PosOrder>): PosOrder {
  return {
    id: 1,
    source: "cleancloud",
    externalId: "ext-1",
    customerExternalId: null,
    status: "received",
    sourceStatus: null,
    finalTotalCents: 1000,
    paid: 0,
    completed: 0,
    express: 0,
    placedAt: new Date("2026-05-01T12:00:00Z"),
    pickupAt: null,
    deliveryAt: null,
    notes: null,
    rawPayload: null,
    firstSeenAt: new Date("2026-05-01T12:00:00Z"),
    lastSeenAt: new Date("2026-05-01T12:00:00Z"),
    ...overrides,
  } as PosOrder;
}

const PERIOD_START = new Date("2026-05-15T08:00:00Z").getTime();
const PERIOD_END = new Date("2026-05-16T08:00:00Z").getTime();

describe("nycDateToBusinessDayStart", () => {
  it("returns 04:00 EDT (08:00 UTC) for a summer date", () => {
    expect(nycDateToBusinessDayStart("2026-07-15").toISOString()).toBe(
      "2026-07-15T08:00:00.000Z",
    );
  });

  it("returns 04:00 EST (09:00 UTC) for a winter date", () => {
    expect(nycDateToBusinessDayStart("2026-01-15").toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
  });

  it("handles a post-DST-spring-forward date", () => {
    expect(nycDateToBusinessDayStart("2026-03-09").toISOString()).toBe(
      "2026-03-09T08:00:00.000Z",
    );
  });
});

describe("computeDailyMetrics", () => {
  it("returns zeros on empty input", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.orderCount).toBe(0);
    expect(m.revenueCents).toBe(0);
    expect(m.avgOrderCents).toBe(0);
    expect(m.uniqueCustomerCount).toBe(0);
    expect(m.revenueDeltaPct).toBeNull();
    expect(m.orderCountDeltaPct).toBeNull();
    expect(m.topSpenders).toEqual([]);
  });

  it("sums revenue, computes average, finds largest order", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, finalTotalCents: 2000 }),
        order({ id: 2, finalTotalCents: 3000 }),
        order({ id: 3, finalTotalCents: 1000 }),
      ],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.orderCount).toBe(3);
    expect(m.revenueCents).toBe(6000);
    expect(m.avgOrderCents).toBe(2000);
    expect(m.largestOrderCents).toBe(3000);
  });

  it("counts paid and express flags", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, paid: 1, express: 0 }),
        order({ id: 2, paid: 1, express: 1 }),
        order({ id: 3, paid: 0, express: 1 }),
      ],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.paidCount).toBe(2);
    expect(m.expressCount).toBe(2);
  });

  it("classifies returning vs new customers (and dedupes)", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, customerExternalId: "C1" }),
        order({ id: 2, customerExternalId: "C2" }),
        order({ id: 3, customerExternalId: "C2" }),
        order({ id: 4, customerExternalId: "C3" }),
      ],
      knownCustomerExternalIds: new Set(["C1"]),
    });
    expect(m.uniqueCustomerCount).toBe(3);
    expect(m.returningCustomerCount).toBe(1);
    expect(m.newCustomerCount).toBe(2);
  });

  it("ignores orders missing customerExternalId in classification", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, customerExternalId: null }),
        order({ id: 2, customerExternalId: "C1" }),
      ],
      knownCustomerExternalIds: new Set(["C1"]),
    });
    expect(m.uniqueCustomerCount).toBe(1);
    expect(m.returningCustomerCount).toBe(1);
    expect(m.newCustomerCount).toBe(0);
  });

  it("computes positive day-over-day delta", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, finalTotalCents: 6000 }),
        order({ id: 2, finalTotalCents: 6000 }),
      ],
      prevOrders: [order({ id: 99, finalTotalCents: 6000 })],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.revenueDeltaPct).toBe(100);
    expect(m.orderCountDeltaPct).toBe(100);
  });

  it("computes negative day-over-day delta", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [order({ id: 1, finalTotalCents: 8000 })],
      prevOrders: [
        order({ id: 99, finalTotalCents: 5000 }),
        order({ id: 98, finalTotalCents: 5000 }),
      ],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.revenueDeltaPct).toBe(-20);
    expect(m.orderCountDeltaPct).toBe(-50);
  });

  it("returns null delta when prev day was empty", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [order({ id: 1, finalTotalCents: 5000 })],
      prevOrders: [],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.revenueDeltaPct).toBeNull();
    expect(m.orderCountDeltaPct).toBeNull();
  });

  it("counts pickups in the day after the briefing window", () => {
    const tomorrowMid = new Date(PERIOD_END + 12 * 60 * 60 * 1000);
    const dayAfter = new Date(PERIOD_END + 36 * 60 * 60 * 1000);
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, pickupAt: tomorrowMid }),
        order({ id: 2, pickupAt: tomorrowMid }),
        order({ id: 3, pickupAt: dayAfter }),
        order({ id: 4, pickupAt: null }),
      ],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.pickupTomorrowCount).toBe(2);
  });

  it("ranks top 3 spenders descending", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, customerExternalId: "A", finalTotalCents: 1000 }),
        order({ id: 2, customerExternalId: "B", finalTotalCents: 5000 }),
        order({ id: 3, customerExternalId: "C", finalTotalCents: 3000 }),
        order({ id: 4, customerExternalId: "D", finalTotalCents: 4000 }),
        order({ id: 5, customerExternalId: "B", finalTotalCents: 2000 }),
      ],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.topSpenders).toHaveLength(3);
    expect(m.topSpenders[0]).toEqual({
      externalId: "B",
      revenueCents: 7000,
      orderCount: 2,
    });
    expect(m.topSpenders[1].externalId).toBe("D");
    expect(m.topSpenders[2].externalId).toBe("C");
  });

  it("handles null finalTotalCents as zero", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, finalTotalCents: null as unknown as number }),
        order({ id: 2, finalTotalCents: 5000 }),
      ],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.revenueCents).toBe(5000);
    expect(m.avgOrderCents).toBe(2500);
  });

  it("preserves period bounds + briefingDate in output", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.briefingDate).toBe("2026-05-15");
    expect(m.periodStartMs).toBe(PERIOD_START);
    expect(m.periodEndMs).toBe(PERIOD_END);
  });
});


describe("computeDailyMetrics — dowVsAvg", () => {
  it("returns null when no dowSamples passed", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [order({ id: 1, finalTotalCents: 5000 })],
      knownCustomerExternalIds: new Set(),
    });
    expect(m.dowVsAvg).toBeNull();
  });

  it("computes positive delta vs DOW baseline", () => {
    // Today: $100 over 5 orders. Baseline 4 same-DOW samples avg $50/2.5 → today is +100% rev, +100% orders.
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [
        order({ id: 1, finalTotalCents: 2000 }),
        order({ id: 2, finalTotalCents: 2000 }),
        order({ id: 3, finalTotalCents: 2000 }),
        order({ id: 4, finalTotalCents: 2000 }),
        order({ id: 5, finalTotalCents: 2000 }),
      ],
      knownCustomerExternalIds: new Set(),
      dowSamples: [
        { revenueCents: 5000, orderCount: 3 },
        { revenueCents: 5000, orderCount: 2 },
        { revenueCents: 5000, orderCount: 3 },
        { revenueCents: 5000, orderCount: 2 },
      ],
    });
    expect(m.dowVsAvg).not.toBeNull();
    expect(m.dowVsAvg!.sampleCount).toBe(4);
    expect(m.dowVsAvg!.avgRevenueCents).toBe(5000);
    expect(m.dowVsAvg!.avgOrderCount).toBe(2.5);
    expect(m.dowVsAvg!.revenueDeltaPct).toBe(100);
    expect(m.dowVsAvg!.orderCountDeltaPct).toBe(100);
  });

  it("computes negative delta vs DOW baseline", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [order({ id: 1, finalTotalCents: 1000 })],
      knownCustomerExternalIds: new Set(),
      dowSamples: [
        { revenueCents: 4000, orderCount: 4 },
        { revenueCents: 4000, orderCount: 4 },
      ],
    });
    expect(m.dowVsAvg!.avgRevenueCents).toBe(4000);
    expect(m.dowVsAvg!.revenueDeltaPct).toBe(-75);
    expect(m.dowVsAvg!.orderCountDeltaPct).toBe(-75);
  });

  it("delta pct is null when baseline avg is 0", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [order({ id: 1, finalTotalCents: 1000 })],
      knownCustomerExternalIds: new Set(),
      dowSamples: [{ revenueCents: 0, orderCount: 0 }],
    });
    expect(m.dowVsAvg!.avgRevenueCents).toBe(0);
    expect(m.dowVsAvg!.revenueDeltaPct).toBeNull();
    expect(m.dowVsAvg!.orderCountDeltaPct).toBeNull();
  });

  it("empty dowSamples array → still null (no baseline)", () => {
    const m = computeDailyMetrics("2026-05-15", PERIOD_START, PERIOD_END, {
      orders: [order({ id: 1, finalTotalCents: 1000 })],
      knownCustomerExternalIds: new Set(),
      dowSamples: [],
    });
    expect(m.dowVsAvg).toBeNull();
  });
});
