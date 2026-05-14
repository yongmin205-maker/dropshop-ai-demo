import { describe, expect, it, vi } from "vitest";
import { runDailyPull, toCleanCloudDate } from "./pullJob";
import type { PullJobDeps } from "./pullJob";

/**
 * Build a deps bundle with stubs for every external dependency.
 * Each stub captures its call args so we can assert on them.
 */
function makeDeps(overrides: Partial<PullJobDeps> = {}) {
  const calls: {
    customers: number;
    orders: number;
    products: number;
    upserts: { customers: number; orders: number; payments: number; products: number };
    syncStarts: number;
    syncFinishes: Array<{ id: number; patch: Record<string, unknown> }>;
    diffs: number;
  } = {
    customers: 0,
    orders: 0,
    products: 0,
    upserts: { customers: 0, orders: 0, payments: 0, products: 0 },
    syncStarts: 0,
    syncFinishes: [],
    diffs: 0,
  };

  let nextLogId = 1000;
  const deps: PullJobDeps = {
    now: () => new Date("2026-05-14T07:00:00Z"), // 03:00 EDT (UTC-4)
    getCustomer: vi.fn(async () => {
      calls.customers += 1;
      return {
        ok: true as const,
        data: [
          {
            customerID: 1,
            customerName: "Alice",
            customerTel: "212-555-0100",
            marketingOptIn: 1,
          },
          {
            customerID: 2,
            customerName: "Bob",
            customerTel: "212-555-0200",
          },
        ],
      };
    }),
    getOrders: vi.fn(async () => {
      calls.orders += 1;
      return {
        ok: true as const,
        data: [
          {
            orderID: "o-100",
            customerID: 1,
            status: 0,
            finalTotal: 25,
            paid: 1,
            payments: [
              { paymentID: "p-1", paymentType: 1, paymentAmount: 25 },
            ],
          },
          {
            orderID: "o-101",
            customerID: 2,
            status: 1,
            finalTotal: 10,
            paid: 0,
          },
        ],
      };
    }),
    getProducts: vi.fn(async () => {
      calls.products += 1;
      return {
        ok: true as const,
        data: [
          { productID: "pr-1", name: "Shirt", price: 4.5 },
          { productID: "pr-2", name: "Pants", price: 9 },
        ],
      };
    }),
    upsertCustomers: vi.fn(async (rows) => {
      calls.upserts.customers = rows.length;
      return rows.length;
    }),
    upsertOrders: vi.fn(async (rows) => {
      calls.upserts.orders = rows.length;
      return rows.length;
    }),
    upsertPayments: vi.fn(async (rows) => {
      calls.upserts.payments = rows.length;
      return rows.length;
    }),
    upsertProducts: vi.fn(async (rows) => {
      calls.upserts.products = rows.length;
      return rows.length;
    }),
    diffProducts: vi.fn(async () => {
      calls.diffs += 1;
      return 0;
    }),
    startSyncLog: vi.fn(async () => {
      calls.syncStarts += 1;
      return nextLogId++;
    }),
    finishSyncLog: vi.fn(async (id, patch) => {
      calls.syncFinishes.push({ id, patch });
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("toCleanCloudDate", () => {
  it("formats UTC dates as 'YYYY-MM-DD HH:MM:SS'", () => {
    expect(toCleanCloudDate(new Date("2026-05-14T07:00:00Z"))).toBe(
      "2026-05-14 07:00:00",
    );
  });
});

describe("runDailyPull", () => {
  it("invokes all three endpoints, upserts everything, and writes 3 sync_log rows", async () => {
    const { deps, calls } = makeDeps();
    const summary = await runDailyPull("daily_pull_03am_et", deps);

    expect(calls.customers).toBe(1);
    expect(calls.orders).toBe(1);
    expect(calls.products).toBe(1);

    expect(summary.customers.fetched).toBe(2);
    expect(summary.customers.upserted).toBe(2);
    expect(summary.orders.fetched).toBe(2);
    expect(summary.orders.upserted).toBe(2);
    // o-100 has explicit payment row, o-101 is unpaid → 1 implicit, 1 zero.
    // The implicit-payment branch only fires when paid=1, so we should see
    // exactly the payments[] entry (1 row), not a synthesized one.
    expect(summary.orders.paymentsUpserted).toBe(1);
    expect(summary.products.fetched).toBe(2);
    expect(summary.products.upserted).toBe(2);

    expect(calls.syncStarts).toBe(3);
    expect(calls.syncFinishes.length).toBe(3);
    // No errors set on any sync log finish.
    for (const f of calls.syncFinishes) {
      expect(f.patch.error ?? null).toBeNull();
    }
  });

  it("isolates failures: a failed orders pull does not block products", async () => {
    const { deps } = makeDeps({
      getOrders: vi.fn(async () => ({
        ok: false as const,
        error: "rate limited",
      })),
    });
    const summary = await runDailyPull("daily_pull_03am_et", deps);
    expect(summary.orders.error).toBe("rate limited");
    expect(summary.orders.fetched).toBe(0);
    expect(summary.products.fetched).toBe(2); // products still pulled
    expect(summary.customers.fetched).toBe(2); // customers still pulled
  });

  it("uses a 28-hour overlap window relative to `now`", async () => {
    const { deps } = makeDeps();
    const captured: { from?: string; to?: string } = {};
    deps.getOrders = vi.fn(async (params) => {
      captured.from = (params as { dateFrom?: string }).dateFrom;
      captured.to = (params as { dateTo?: string }).dateTo;
      return { ok: true as const, data: [] };
    });
    await runDailyPull("daily_pull_03am_et", deps);
    // `now` was stubbed to 2026-05-14T07:00:00Z. 28h earlier = 2026-05-13T03:00:00Z
    expect(captured.to).toBe("2026-05-14 07:00:00");
    expect(captured.from).toBe("2026-05-13 03:00:00");
  });

  it("calls diffProducts BEFORE upsertProducts so the diff sees previous state", async () => {
    const callOrder: string[] = [];
    const { deps } = makeDeps({
      diffProducts: vi.fn(async () => {
        callOrder.push("diff");
        return 1;
      }),
      upsertProducts: vi.fn(async (rows) => {
        callOrder.push("upsert");
        return rows.length;
      }),
    });
    await runDailyPull("daily_pull_03am_et", deps);
    expect(callOrder).toEqual(["diff", "upsert"]);
  });

  it("survives a thrown exception in one endpoint and still runs the others", async () => {
    const { deps } = makeDeps({
      getCustomer: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const summary = await runDailyPull("daily_pull_03am_et", deps);
    expect(summary.customers.error).toBe("boom");
    expect(summary.orders.fetched).toBe(2);
    expect(summary.products.fetched).toBe(2);
  });
});
