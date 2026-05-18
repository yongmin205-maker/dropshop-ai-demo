/**
 * Tests for runBackfill (Phase 25-verify revision).
 *
 * What we're guarding against:
 *   - The original bug: a 200-OK CleanCloud response that contains
 *     `{Error: "..."}` was treated as success-with-empty-array, so the
 *     backfill silently wrote 0 rows and left every posSyncLog row with
 *     `finishedAt = NULL`. The new code MUST: (a) emit at least one
 *     getCustomer / getOrders / getProducts sync_log row each, (b) finish
 *     every row (no NULL finishedAt), (c) bisect on the
 *     "too many orders" envelope rather than treating it as a hard fail.
 */

import { describe, expect, it, vi } from "vitest";
import { runBackfill, rollingWindows } from "./backfill";
import type { BackfillDeps } from "./backfill";

function makeDeps(overrides: Partial<BackfillDeps> = {}) {
  const calls = {
    customers: 0,
    orders: 0,
    products: 0,
    syncStarts: [] as Array<{ endpoint: string; from: Date | null; to: Date | null }>,
    syncFinishes: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  };
  let nextLogId = 1;

  const deps: BackfillDeps = {
    now: () => new Date(Date.UTC(2026, 4, 18)), // 2026-05-18 UTC
    getCustomer: vi.fn(async () => {
      calls.customers += 1;
      return {
        ok: true as const,
        data: [{ customerID: 1, customerName: "Alice", customerTel: "212-555-0100" }],
      };
    }),
    getOrders: vi.fn(async () => {
      calls.orders += 1;
      return {
        ok: true as const,
        data: [{ orderID: "o-1", customerID: 1, status: 0, finalTotal: 10, paid: 1 }],
      };
    }),
    getProducts: vi.fn(async () => {
      calls.products += 1;
      return {
        ok: true as const,
        data: [{ productID: "pr-1", name: "Shirt", price: 4.5 }],
      };
    }),
    upsertCustomers: vi.fn(async (rows) => rows.length),
    upsertOrders: vi.fn(async (rows) => rows.length),
    upsertPayments: vi.fn(async (rows) => rows.length),
    upsertProducts: vi.fn(async (rows) => rows.length),
    diffProductsAndRecordChanges: vi.fn(async () => 0),
    startSyncLog: vi.fn(async (row) => {
      calls.syncStarts.push({
        endpoint: row.endpoint,
        from: row.windowFrom ?? null,
        to: row.windowTo ?? null,
      });
      return nextLogId++;
    }),
    finishSyncLog: vi.fn(async (id, patch) => {
      calls.syncFinishes.push({ id, patch });
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("rollingWindows", () => {
  it("emits contiguous, non-overlapping windows oldest-first", () => {
    const from = new Date(Date.UTC(2026, 4, 1));
    const to = new Date(Date.UTC(2026, 4, 22));
    const wins = rollingWindows(from, to, 7);
    expect(wins).toHaveLength(3);
    expect(wins[0].from.getTime()).toBe(from.getTime());
    expect(wins[0].to.getTime()).toBe(from.getTime() + 7 * 86400_000);
    expect(wins[1].from.getTime()).toBe(wins[0].to.getTime());
    expect(wins[2].to.getTime()).toBe(to.getTime());
  });

  it("returns no windows when from >= to", () => {
    const d = new Date();
    expect(rollingWindows(d, d, 7)).toEqual([]);
  });
});

describe("runBackfill", () => {
  it("calls getCustomer, getOrders and getProducts at least once each and finishes every sync_log row", async () => {
    const { deps, calls } = makeDeps();
    const summary = await runBackfill(1, deps); // 1 month → small but non-empty

    expect(calls.customers).toBeGreaterThanOrEqual(1);
    expect(calls.orders).toBeGreaterThanOrEqual(1);
    expect(calls.products).toBe(1);

    // Every started log must be finished — the original bug left them at NULL.
    expect(calls.syncFinishes.length).toBe(calls.syncStarts.length);

    expect(summary.customers.upserted).toBeGreaterThan(0);
    expect(summary.orders.upserted).toBeGreaterThan(0);
    expect(summary.products.upserted).toBeGreaterThan(0);
    expect(summary.errors).toEqual([]);
  });

  it("uses 30-day customer windows and 7-day order windows by default", async () => {
    const { deps, calls } = makeDeps();
    await runBackfill(1, deps);

    const customerStarts = calls.syncStarts.filter((s) => s.endpoint === "getCustomer");
    const orderStarts = calls.syncStarts.filter((s) => s.endpoint === "getOrders");

    expect(customerStarts.length).toBeGreaterThanOrEqual(1);
    expect(orderStarts.length).toBeGreaterThan(customerStarts.length);

    // First order window should be 7 days wide.
    const first = orderStarts[0];
    if (first.from && first.to) {
      const span = (first.to.getTime() - first.from.getTime()) / 86400_000;
      expect(span).toBeCloseTo(7, 1);
    }
  });

  it("bisects when getOrders returns the 'too many orders' cap envelope", async () => {
    let callCount = 0;
    const getOrders = vi.fn(async () => {
      callCount += 1;
      // First call (full 7-day window) returns the cap error so we should
      // see the recursion split it into two smaller windows.
      if (callCount === 1) {
        return {
          ok: false as const,
          status: 200,
          error: "Requesting too many orders in one request. You must narrow or restructure your request.",
        };
      }
      return { ok: true as const, data: [] };
    });
    const { deps } = makeDeps({ getOrders });

    const summary = await runBackfill(1, deps);
    // The same week was attempted at least 3 times: once full, twice halved.
    expect(callCount).toBeGreaterThanOrEqual(3);
    // The cap error itself is not a final failure — it's recorded as a bisect
    // marker, then the children resolve. Final summary should not list the
    // cap error in `errors[]` because the children succeeded.
    expect(summary.errors.find((e) => /too many orders/i.test(e.message))).toBeUndefined();
  });

  it("records and finishes a sync_log even when getOrders returns a hard error after exhausting bisection", async () => {
    const getOrders = vi.fn(async () => ({
      ok: false as const,
      status: 200,
      error: "Some hard error not related to capacity",
    }));
    const { deps, calls } = makeDeps({ getOrders });

    const summary = await runBackfill(1, deps);
    expect(summary.orders.windowsFailed).toBeGreaterThan(0);
    expect(summary.errors.some((e) => /Some hard error/.test(e.message))).toBe(true);
    expect(calls.syncFinishes.length).toBe(calls.syncStarts.length);
  });

  it("records the products error and continues when getProducts fails", async () => {
    const getProducts = vi.fn(async () => ({
      ok: false as const,
      status: 200,
      error: "products endpoint down",
    }));
    const { deps } = makeDeps({ getProducts });

    const summary = await runBackfill(1, deps);
    expect(summary.products.error).toBe("products endpoint down");
    // Other endpoints still ran:
    expect(summary.customers.upserted).toBeGreaterThan(0);
    expect(summary.orders.upserted).toBeGreaterThan(0);
  });

  it("never leaves a sync_log finishedAt unset (no NULL rows)", async () => {
    // Simulate the original failure: getCustomer + getOrders both fail with
    // an envelope, so every started row goes through the error path.
    const failing = vi.fn(async () => ({
      ok: false as const,
      status: 200,
      error: "boom",
    }));
    const { deps, calls } = makeDeps({ getCustomer: failing, getOrders: failing });

    await runBackfill(1, deps);
    // 1:1 finish-to-start ratio is the regression net for the original bug.
    expect(calls.syncFinishes.length).toBe(calls.syncStarts.length);
  });
});
