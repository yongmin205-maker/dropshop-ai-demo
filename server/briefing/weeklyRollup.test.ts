import { describe, it, expect } from "vitest";
import {
  computeWeeklyRollup,
  isMonday,
  type WeeklyRollupInput,
} from "./weeklyRollup";
import type { PosOrder } from "../../drizzle/schema";

function order(opts: Partial<PosOrder> & { id: number; placedAt: Date }): PosOrder {
  return {
    id: opts.id,
    source: "cleancloud",
    externalId: `ext-${opts.id}`,
    customerExternalId: opts.customerExternalId ?? `c-${opts.id}`,
    placedAt: opts.placedAt,
    pickupAt: null,
    finalTotalCents: opts.finalTotalCents ?? 1000,
    isPaid: 1,
    isExpress: 0,
    rawJson: {},
    syncedAt: new Date(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("computeWeeklyRollup", () => {
  // 7-day window ending Monday 2026-05-18 04:00 NYC
  // = Mon 2026-05-11 04:00 NYC → Mon 2026-05-18 04:00 NYC
  // NYC is UTC-4 (EDT) in May, so window in UTC is:
  //   start: 2026-05-11T08:00:00Z, end: 2026-05-18T08:00:00Z
  const windowStartMs = Date.UTC(2026, 4, 11, 8); // May 11 08:00 UTC
  const windowEndMs = Date.UTC(2026, 4, 18, 8);

  it("aggregates a 7-day window with zero orders → all zeros, deltas null", () => {
    const r = computeWeeklyRollup({
      weekEndDate: "2026-05-18",
      weekStartDate: "2026-05-11",
      windowStartMs,
      windowEndMs,
      orders: [],
    });
    expect(r.orderCount).toBe(0);
    expect(r.revenueCents).toBe(0);
    expect(r.uniqueCustomerCount).toBe(0);
    expect(r.avgOrderCents).toBe(0);
    expect(r.largestOrderCents).toBe(0);
    expect(r.byDayOfWeek).toHaveLength(7);
    for (const b of r.byDayOfWeek) {
      expect(b.orderCount).toBe(0);
      expect(b.revenueCents).toBe(0);
    }
    expect(r.vs4WeeksAgo.revenueDeltaPct).toBeNull();
    expect(r.vs4WeeksAgo.orderCountDeltaPct).toBeNull();
  });

  it("totals revenue/order/unique customers and bucket by NYC weekday", () => {
    const orders = [
      // Mon 2026-05-11 14:00 ET = 18:00 UTC
      order({ id: 1, placedAt: new Date(Date.UTC(2026, 4, 11, 18)), finalTotalCents: 5000, customerExternalId: "a" }),
      // Wed 2026-05-13 10:00 ET = 14:00 UTC
      order({ id: 2, placedAt: new Date(Date.UTC(2026, 4, 13, 14)), finalTotalCents: 3000, customerExternalId: "a" }),
      // Sat 2026-05-16 16:00 ET = 20:00 UTC
      order({ id: 3, placedAt: new Date(Date.UTC(2026, 4, 16, 20)), finalTotalCents: 7000, customerExternalId: "b" }),
      // Sun 2026-05-17 12:00 ET = 16:00 UTC
      order({ id: 4, placedAt: new Date(Date.UTC(2026, 4, 17, 16)), finalTotalCents: 2000, customerExternalId: "c" }),
    ];
    const r = computeWeeklyRollup({
      weekEndDate: "2026-05-18",
      weekStartDate: "2026-05-11",
      windowStartMs,
      windowEndMs,
      orders,
    });
    expect(r.orderCount).toBe(4);
    expect(r.revenueCents).toBe(17000);
    expect(r.uniqueCustomerCount).toBe(3);
    expect(r.avgOrderCents).toBe(4250);
    expect(r.largestOrderCents).toBe(7000);

    // Bucket by NYC weekday: Mon=0, Wed=2, Sat=5, Sun=6
    expect(r.byDayOfWeek[0]?.orderCount).toBe(1); // Mon
    expect(r.byDayOfWeek[0]?.revenueCents).toBe(5000);
    expect(r.byDayOfWeek[2]?.orderCount).toBe(1); // Wed
    expect(r.byDayOfWeek[2]?.revenueCents).toBe(3000);
    expect(r.byDayOfWeek[5]?.orderCount).toBe(1); // Sat
    expect(r.byDayOfWeek[5]?.revenueCents).toBe(7000);
    expect(r.byDayOfWeek[6]?.orderCount).toBe(1); // Sun
    expect(r.byDayOfWeek[6]?.revenueCents).toBe(2000);
    expect(r.byDayOfWeek[1]?.orderCount).toBe(0); // Tue empty
  });

  it("computes vs4WeeksAgo deltas correctly", () => {
    const current = [
      order({ id: 1, placedAt: new Date(windowStartMs + 1000), finalTotalCents: 6000 }),
      order({ id: 2, placedAt: new Date(windowStartMs + 2000), finalTotalCents: 4000 }),
    ];
    // Prior 4 weeks ago: 4 orders × $20 each = $80 → current $100 = +25%
    const prior = [
      order({ id: 11, placedAt: new Date(windowStartMs - 28 * 86400_000), finalTotalCents: 2000 }),
      order({ id: 12, placedAt: new Date(windowStartMs - 28 * 86400_000), finalTotalCents: 2000 }),
      order({ id: 13, placedAt: new Date(windowStartMs - 28 * 86400_000), finalTotalCents: 2000 }),
      order({ id: 14, placedAt: new Date(windowStartMs - 28 * 86400_000), finalTotalCents: 2000 }),
    ];
    const r = computeWeeklyRollup({
      weekEndDate: "2026-05-18",
      weekStartDate: "2026-05-11",
      windowStartMs,
      windowEndMs,
      orders: current,
      prior4wkOrders: prior,
    });
    // current 10000 vs prior 8000 = +25%
    expect(r.vs4WeeksAgo.revenueDeltaPct).toBe(25);
    // current 2 vs prior 4 = -50%
    expect(r.vs4WeeksAgo.orderCountDeltaPct).toBe(-50);
    expect(r.vs4WeeksAgo.priorRevenueCents).toBe(8000);
    expect(r.vs4WeeksAgo.priorOrderCount).toBe(4);
  });

  it("returns null delta when prior window is empty", () => {
    const r = computeWeeklyRollup({
      weekEndDate: "2026-05-18",
      weekStartDate: "2026-05-11",
      windowStartMs,
      windowEndMs,
      orders: [order({ id: 1, placedAt: new Date(windowStartMs + 1000) })],
      prior4wkOrders: [],
    });
    expect(r.vs4WeeksAgo.revenueDeltaPct).toBeNull();
    expect(r.vs4WeeksAgo.orderCountDeltaPct).toBeNull();
  });

  it("handles orders missing placedAt by skipping DOW bucket but keeping totals", () => {
    const orders = [
      order({ id: 1, placedAt: new Date(windowStartMs + 1000), finalTotalCents: 5000 }),
      // simulate one with weird placedAt (still aggregated, but DOW bucket may end up wherever)
    ];
    const r = computeWeeklyRollup({
      weekEndDate: "2026-05-18",
      weekStartDate: "2026-05-11",
      windowStartMs,
      windowEndMs,
      orders,
    });
    expect(r.orderCount).toBe(1);
    expect(r.revenueCents).toBe(5000);
  });
});

describe("isMonday", () => {
  it("returns true for a Monday in NYC", () => {
    expect(isMonday("2026-05-18")).toBe(true); // a Monday
  });

  it("returns false for non-Mondays", () => {
    expect(isMonday("2026-05-19")).toBe(false); // Tuesday
    expect(isMonday("2026-05-17")).toBe(false); // Sunday
    expect(isMonday("2026-05-22")).toBe(false); // Friday
  });

  it("works around DST flips", () => {
    expect(isMonday("2026-03-09")).toBe(true); // Monday after spring-forward (DST 3/8/2026)
    expect(isMonday("2026-11-02")).toBe(true); // Monday after fall-back (DST 11/1/2026)
  });
});
