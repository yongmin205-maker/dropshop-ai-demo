import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins §4.6: `searchPrice` MUST prefer an exact category-enum match over a
 * substring scan, and the substring fallback MUST be capped + reject empty
 * input. We mock the `db` module with a thin in-memory stand-in for the chain
 * methods drizzle uses (`select().from().where()`, `insert().values().on*()`,
 * `delete()`) so we can observe call patterns without booting a real DB.
 */

type Row = Record<string, any>;

function makeDb(rows: Record<string, Row[]>) {
  const calls = { whereCalled: false, lastWhereTable: null as string | null };
  const noopUpsert = {
    values: () => ({
      onDuplicateKeyUpdate: () => Promise.resolve(),
    }),
  };
  const tableNameOf = (t: any): string => {
    // Our schema mock tags each table with `_name`.
    return t?._name ?? "unknown";
  };
  return {
    db: {
      select: () => ({
        from: (t: any) => {
          const tableName = tableNameOf(t);
          const data = rows[tableName] ?? [];
          const thenable: any = {
            then: (resolve: any) => Promise.resolve(data).then(resolve),
            where: (cond: any) => {
              calls.whereCalled = true;
              calls.lastWhereTable = tableName;
              const colName = cond?._col;
              const v = cond?._val;
              const filtered = colName
                ? data.filter((r) => r[colName] === v)
                : data;
              return Promise.resolve(filtered);
            },
            limit: () => thenable,
          };
          return thenable;
        },
      }),
      insert: () => noopUpsert,
      delete: () => Promise.resolve(),
    },
    calls,
  };
}

const SAMPLE = [
  { id: 1, category: "dryClean", itemName: "Dress shirt", priceCents: 700, notes: "Member: $5.95" },
  { id: 2, category: "dryClean", itemName: "Pants / slacks", priceCents: 1100, notes: "Member: $9.35" },
  { id: 3, category: "alteration", itemName: "Hem pants", priceCents: 1500, notes: "Standard hem" },
  { id: 4, category: "alteration", itemName: "Replace zipper (pants)", priceCents: 3500, notes: "Includes zipper" },
  { id: 5, category: "laundry", itemName: "Wash & fold (per lb)", priceCents: 295, notes: "8 lb minimum" },
];

let activeHarness: ReturnType<typeof makeDb>;

vi.mock("./db", () => ({
  getDb: vi.fn(async () => activeHarness.db),
}));

vi.mock("../drizzle/schema", () => ({
  mockPriceList: { _name: "mockPriceList", category: { _col: "category" } },
  mockCustomers: { _name: "mockCustomers" },
  mockOrders: { _name: "mockOrders" },
  pickupRequests: { _name: "pickupRequests" },
}));

// drizzle-orm eq() returns an opaque object — we hand-roll a recognizable shape
// so our makeDb() stub can decode "filter category = X".
vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ _col: col?._col, _val: val }),
  and: (...args: any[]) => args[0],
  desc: (col: any) => col,
  ne: (_col: any, _val: any) => ({}),
  inArray: (_col: any, _vals: any[]) => ({}),
  lt: (_col: any, _val: any) => ({}),
  sql: (_strings: any) => ({}),
}));

beforeEach(() => {
  activeHarness = makeDb({ mockPriceList: SAMPLE });
});
afterEach(() => { vi.clearAllMocks(); vi.resetModules(); });

describe("mockCleanCloud.searchPrice contract", () => {
  it("uses an exact-category WHERE for known categories", async () => {
    const { searchPrice } = await import("./mockCleanCloud");
    const out = await searchPrice("alteration");
    expect(activeHarness.calls.whereCalled).toBe(true);
    expect(activeHarness.calls.lastWhereTable).toBe("mockPriceList");
    expect(out.every((r) => r.category === "alteration")).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("falls back to substring scan for free-text queries", async () => {
    const { searchPrice } = await import("./mockCleanCloud");
    const out = await searchPrice("zipper");
    expect(activeHarness.calls.whereCalled).toBe(false);
    expect(out.some((r) => r.itemName.toLowerCase().includes("zipper"))).toBe(true);
  });

  it("returns [] for an empty/whitespace query without scanning", async () => {
    const { searchPrice } = await import("./mockCleanCloud");
    const out = await searchPrice("   ");
    expect(out).toEqual([]);
    expect(activeHarness.calls.whereCalled).toBe(false);
  });

  it("caps the substring fallback at 25 results", async () => {
    // Build a 50-row pool that all match a noisy "e" substring.
    const huge = Array.from({ length: 50 }, (_, i) => ({
      id: 100 + i,
      category: "dryClean",
      itemName: `entry ${i}`,
      priceCents: 100 + i,
      notes: "exempt",
    }));
    activeHarness = makeDb({ mockPriceList: huge });
    const { searchPrice } = await import("./mockCleanCloud");
    const out = await searchPrice("e");
    expect(out.length).toBeLessThanOrEqual(25);
  });
});
