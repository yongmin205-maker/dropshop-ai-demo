/**
 * Tests for runBackfill (Phase 25-verify revision + review-pass fixes).
 *
 * What we're guarding against:
 *   - The original bug: a 200-OK CleanCloud response that contains
 *     `{Error: "..."}` was treated as success-with-empty-array, so the
 *     backfill silently wrote 0 rows and left every posSyncLog row with
 *     `finishedAt = NULL`. The new code MUST: (a) emit at least one
 *     getCustomer / getOrders / getProducts sync_log row each, (b) finish
 *     every row (no NULL finishedAt), (c) bisect on the
 *     "too many orders" envelope rather than treating it as a hard fail.
 *
 *   - Review-pass additions: bisection-depth exhaustion path (Agent C #1),
 *     multi-month loop arithmetic (Agent C #2), single-object response
 *     shape (Agent C #3), mid-loop DB failure (Agent C #4), adapter-null
 *     counting honesty (Agent C #5), year-boundary monthsBack math (Agent
 *     C #6), and the inverted `from > to` range (Agent C #7). Concurrent-
 *     invocation behavior (Agent C #8) is router-layer; not exercised here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Silence the backfill's console.info/warn/error so test output stays
// readable. Errors that matter are surfaced via summary.errors.
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

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

  // Agent C #7. The `<=` guard at backfill.ts already handles this, but no
  // test pinned it — a future refactor that flips to `<` would let inverted
  // ranges through and silently produce garbage windows. Cheap regression
  // net to close the only gap in rollingWindows coverage.
  it("returns no windows when from > to (inverted range)", () => {
    const later = new Date(Date.UTC(2026, 4, 22));
    const earlier = new Date(Date.UTC(2026, 4, 1));
    expect(rollingWindows(later, earlier, 7)).toEqual([]);
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

  // Review-pass fix: test name claimed 30-day customer width but the old
  // assertion only checked the order window's 7d. Now both are pinned.
  it("uses 30-day customer windows and 7-day order windows by default", async () => {
    const { deps, calls } = makeDeps();
    await runBackfill(1, deps);

    const customerStarts = calls.syncStarts.filter((s) => s.endpoint === "getCustomer");
    const orderStarts = calls.syncStarts.filter((s) => s.endpoint === "getOrders");

    expect(customerStarts.length).toBeGreaterThanOrEqual(1);
    expect(orderStarts.length).toBeGreaterThan(customerStarts.length);

    // First order window should be 7 days wide.
    const firstOrder = orderStarts[0];
    if (firstOrder.from && firstOrder.to) {
      const span = (firstOrder.to.getTime() - firstOrder.from.getTime()) / 86400_000;
      expect(span).toBeCloseTo(7, 1);
    }
    // First customer window should be 30 days wide (or shorter if it's the
    // clamped final window, but with monthsBack=1 the first/only window can
    // be either the full 30d or the clamped span — assert it's ≤30 and >0).
    const firstCustomer = customerStarts[0];
    if (firstCustomer.from && firstCustomer.to) {
      const span = (firstCustomer.to.getTime() - firstCustomer.from.getTime()) / 86400_000;
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(30);
    }
    // If there's more than one customer window (e.g. monthsBack ≥ 2), the
    // first (oldest) one must be exactly 30 days — only the *last* window
    // gets clamped to `overallTo`.
    if (customerStarts.length >= 2) {
      const first = customerStarts[0];
      if (first.from && first.to) {
        const span = (first.to.getTime() - first.from.getTime()) / 86400_000;
        expect(span).toBeCloseTo(30, 5);
      }
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

  // Review-pass rename: the pre-fix test was misleadingly named
  // "after exhausting bisection" but its envelope wasn't a cap error, so
  // bisection never even triggered. The depth-exhaustion path is now
  // covered by the dedicated test below. This test stays as the hard-error
  // (no-bisection) regression net.
  it("records and finishes a sync_log when getOrders returns a non-cap hard error", async () => {
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
    // Hard errors that are NOT cap errors must not trigger bisection — the
    // call count is exactly one per order window (no extra recursion).
    expect(getOrders.mock.calls.length).toBe(
      calls.syncStarts.filter((s) => s.endpoint === "getOrders").length,
    );
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

  /* ----- Review-pass new cases (Agent C) ------------------------------ */

  // Agent C #1. The pre-review test #6 claimed to cover "exhausting
  // bisection" but its envelope wasn't a cap error, so the recursion path
  // never fired. A recursion-control regression would have shipped
  // undetected. This test feeds a persistent cap error and verifies (a)
  // recursion terminates at maxBisectDepth, (b) the cap-error leaf hits
  // `windowsFailed`, (c) parent rows that bisected finish cleanly with no
  // error string (so the admin UI doesn't show them red — Agent B finding
  // 5), (d) every started log finishes.
  it("hits maxBisectDepth and records the cap error as a final failure", async () => {
    const getOrders = vi.fn(async () => ({
      ok: false as const,
      status: 200,
      error: "Requesting too many orders in one request. You must narrow or restructure your request.",
    }));
    const { deps, calls } = makeDeps({ getOrders });

    // maxBisectDepth=2 → parent + 2 children + 4 grandchildren = 7 getOrders
    // calls per parent week. Bounded.
    const summary = await runBackfill(1, { ...deps, maxBisectDepth: 2 });

    // Recursion terminated.
    expect(getOrders.mock.calls.length).toBeLessThan(200);
    // Cap errors surfaced at the leaves.
    expect(summary.orders.windowsFailed).toBeGreaterThan(0);
    expect(
      summary.errors.some((e) => /too many orders/i.test(e.message)),
    ).toBe(true);
    // Every started sync_log row finished.
    expect(calls.syncFinishes.length).toBe(calls.syncStarts.length);
    // Parents that bisected finished with rowsFetched=0 + no error (per
    // Agent B finding 5 fix). Leaves at the depth limit finished with the
    // raw cap error string.
    const errorFinishes = calls.syncFinishes.filter(
      (f) => typeof f.patch.error === "string",
    );
    const cleanBisectFinishes = calls.syncFinishes.filter(
      (f) =>
        f.patch.error === undefined &&
        f.patch.rowsFetched === 0 &&
        f.patch.rowsUpserted === 0,
    );
    expect(errorFinishes.length).toBeGreaterThan(0); // leaf failures
    expect(cleanBisectFinishes.length).toBeGreaterThan(0); // bisected parents
  });

  // Agent C #2. Existing tests only used monthsBack=1, so multi-month loop
  // arithmetic was never exercised. With now=2026-05-18 and the off-by-one
  // fix (Agent A #1: dropped the `-1`), monthsBack=6 yields overallFrom =
  // 2025-11-01 UTC. Span ≈ 199 days → ⌈199/30⌉ = 7 customer windows,
  // ⌈199/7⌉ = 29 order windows.
  it("walks 6 months of windows with the expected post-fix counts", async () => {
    const { deps, calls } = makeDeps();
    const summary = await runBackfill(6, deps);

    const customerStarts = calls.syncStarts.filter((s) => s.endpoint === "getCustomer");
    const orderStarts = calls.syncStarts.filter((s) => s.endpoint === "getOrders");

    // Post off-by-one fix: monthsBack=6 from 2026-05-18 → overallFrom 2025-11-01.
    expect(customerStarts.length).toBe(7);
    expect(orderStarts.length).toBe(29);

    expect(customerStarts[0].from?.toISOString().slice(0, 10)).toBe("2025-11-01");
    const lastOrder = orderStarts[orderStarts.length - 1];
    expect(lastOrder.to?.toISOString().slice(0, 19)).toBe("2026-05-18T23:59:59");

    expect(calls.syncFinishes.length).toBe(calls.syncStarts.length);
    expect(summary.errors).toEqual([]);
  });

  // Agent C #3. backfill.ts:147 wraps a non-array result.data in a 1-element
  // array — single-customer envelope leaking out of date-range mode. Pre-
  // Agent-A-finding-3-fix this could happen on an empty range (the transport
  // returned `{}`). Post-fix, the transport returns `[]` for an empty range,
  // so this branch is only hit if CleanCloud ever returns a true single-
  // object response in date-range mode (defensive). Pin the wrap.
  it("survives getCustomer returning a single object instead of an array", async () => {
    const getCustomer = vi.fn(async () => ({
      ok: true as const,
      // Single object, NOT wrapped in an array — CleanCloud quirk.
      data: { customerID: 42, customerName: "Solo", customerTel: "212-555-9999" } as unknown as never,
    }));
    const upsertCustomers = vi.fn(async (rows: unknown[]) => rows.length);
    const { deps } = makeDeps({ getCustomer, upsertCustomers });

    const summary = await runBackfill(1, deps);
    // Each customer window should have called upsertCustomers with exactly
    // one row (the wrapped single object).
    expect(upsertCustomers).toHaveBeenCalled();
    for (const call of upsertCustomers.mock.calls) {
      expect((call[0] as unknown[]).length).toBe(1);
    }
    expect(summary.customers.upserted).toBeGreaterThanOrEqual(1);
    expect(summary.customers.windowsFailed).toBe(0);
  });

  // Agent C #4. The happy-path tests stub upserts as identity. A real
  // failure mode is a transient DB error mid-loop — verify: (a) earlier
  // windows still completed, (b) the failing window's sync_log finishes
  // with the thrown error, (c) subsequent windows continue (no abort).
  it("records the DB error on the failing window and continues subsequent windows", async () => {
    let upsertCalls = 0;
    const upsertOrders = vi.fn(async (rows: unknown[]) => {
      upsertCalls += 1;
      if (upsertCalls === 2) throw new Error("ER_LOCK_WAIT_TIMEOUT");
      return (rows as unknown[]).length;
    });
    const { deps, calls } = makeDeps({ upsertOrders });

    const summary = await runBackfill(1, deps);

    // The bad week pushed an error, but the run continued (others completed).
    expect(summary.orders.windowsFailed).toBe(1);
    expect(summary.orders.windowsCompleted).toBeGreaterThan(0);
    expect(
      summary.errors.some(
        (e) => e.endpoint === "getOrders" && /ER_LOCK_WAIT_TIMEOUT/.test(e.message),
      ),
    ).toBe(true);
    // No NULL finishes.
    expect(calls.syncFinishes.length).toBe(calls.syncStarts.length);
    // The failing log finished with the error patched in.
    const errorFinishes = calls.syncFinishes.filter(
      (f) => typeof f.patch.error === "string" && /ER_LOCK_WAIT_TIMEOUT/.test(f.patch.error as string),
    );
    expect(errorFinishes.length).toBe(1);
  });

  // Agent C #5. adaptCustomer returns null when customerID is missing/null.
  // `backfill.ts:150` filters those out, but `summary.customers.upserted`
  // comes from the upsert helper's return — pin that the helper sees only
  // post-filter rows, and rowsFetched in the sync_log carries the pre-
  // filter (API) count for honest "fetched vs upserted" reporting.
  it("counts only post-filter rows in summary.customers.upserted (nulls excluded)", async () => {
    const getCustomer = vi.fn(async () => ({
      ok: true as const,
      data: [
        { customerID: 1, customerName: "Alice", customerTel: "212-555-0100" },
        { customerName: "NoID-1" }, // adaptCustomer returns null
        { customerID: 2, customerName: "Bob", customerTel: "212-555-0200" },
        { customerID: null, customerName: "NoID-2" }, // also null
      ],
    }));
    const upsertCustomers = vi.fn(async (rows: unknown[]) => rows.length);
    const { deps, calls } = makeDeps({ getCustomer, upsertCustomers });

    const summary = await runBackfill(1, deps);

    // upsertCustomers was called with only the 2 valid rows per window.
    for (const call of upsertCustomers.mock.calls) {
      expect((call[0] as unknown[]).length).toBe(2);
    }
    // Per-window finish row: rowsFetched=4 (pre-filter), rowsUpserted=2.
    const customerFinishes = calls.syncFinishes.filter(
      (f) => f.patch.rowsFetched === 4,
    );
    expect(customerFinishes.length).toBeGreaterThan(0);
    for (const f of customerFinishes) {
      expect(f.patch.rowsUpserted).toBe(2);
    }
    // Summary aggregate is post-filter (sum of upserted across windows).
    expect(summary.customers.upserted).toBe(customerFinishes.length * 2);
  });

  // Agent C #6. startOfMonthUTC relies on JS Date's negative-month wrap
  // (e.g. Date.UTC(2026, -10, 1) → 2025-02-01). Post off-by-one fix
  // (Agent A #1), now=2026-02-15 with monthsBack=12 yields overallFrom =
  // 2025-02-01 UTC. Pre-fix this was 2025-03-01 (the off-by-one). Pinning
  // the post-fix value catches both a future fix-rollback and any
  // accidental clamp at month 0.
  it("startOfMonthUTC correctly handles year-boundary straddles (Feb 2026, 12 months back)", async () => {
    const { deps, calls } = makeDeps({
      now: () => new Date(Date.UTC(2026, 1, 15)), // 2026-02-15 UTC
    });

    await runBackfill(12, deps);

    const customerStarts = calls.syncStarts.filter((s) => s.endpoint === "getCustomer");
    // Post-fix expected: 12 months back from Feb 2026 → 2025-02-01.
    expect(customerStarts[0].from?.toISOString().slice(0, 10)).toBe("2025-02-01");
    // Last window ends at 2026-02-15 23:59:59 UTC.
    const lastCustomer = customerStarts[customerStarts.length - 1];
    expect(lastCustomer.to?.toISOString().slice(0, 19)).toBe("2026-02-15T23:59:59");
  });
});
