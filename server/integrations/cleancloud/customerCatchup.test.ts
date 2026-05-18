/**
 * Contract tests for runCustomerCatchup — orphan detection + per-ID fetch +
 * upsert + concurrency + error tolerance.
 *
 * We inject every external dependency (findOrphanIds, getCustomer,
 * upsertCustomers, startSyncLog, finishSyncLog) so the test never hits a real
 * DB or HTTP endpoint.
 */
import { describe, it, expect, vi } from "vitest";
import { runCustomerCatchup } from "./customerCatchup";

function okCustomer(id: string, name: string) {
  return {
    ok: true as const,
    data: { ID: id, Name: name, Tel: "+15555550100", Email: null },
    statusCode: 200,
  };
}

function makeDeps(overrides: Parameters<typeof runCustomerCatchup>[1] = {}) {
  return {
    findOrphanIds: vi.fn(async () => ["A", "B", "C"]),
    getCustomer: vi.fn(async ({ customerID }: { customerID: string }) =>
      okCustomer(customerID, `Name ${customerID}`),
    ),
    upsertCustomers: vi.fn(async (rows: unknown[]) => rows.length),
    startSyncLog: vi.fn(async () => 1),
    finishSyncLog: vi.fn(async () => {}),
    concurrency: 2,
    ...overrides,
  };
}

describe("runCustomerCatchup", () => {
  it("returns zero counts when no orphans are found", async () => {
    const deps = makeDeps({ findOrphanIds: vi.fn(async () => []) });
    const result = await runCustomerCatchup("manual", deps);
    expect(result.orphansFound).toBe(0);
    expect(result.fetched).toBe(0);
    expect(result.upserted).toBe(0);
    expect(deps.getCustomer).not.toHaveBeenCalled();
    expect(deps.upsertCustomers).not.toHaveBeenCalled();
    expect(deps.startSyncLog).toHaveBeenCalledOnce();
    expect(deps.finishSyncLog).toHaveBeenCalledWith(1, {
      rowsFetched: 0,
      rowsUpserted: 0,
    });
  });

  it("fetches each orphan exactly once and upserts the resulting rows", async () => {
    const deps = makeDeps();
    const result = await runCustomerCatchup("manual", deps);
    expect(result.orphansFound).toBe(3);
    expect(result.fetched).toBe(3);
    expect(result.upserted).toBe(3);
    expect(deps.getCustomer).toHaveBeenCalledTimes(3);
    expect(deps.upsertCustomers).toHaveBeenCalledOnce();
    const upsertedRows = (deps.upsertCustomers as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertedRows).toHaveLength(3);
    expect(upsertedRows.map((r: { externalId: string }) => r.externalId).sort()).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("collects per-ID errors but continues processing the remaining IDs", async () => {
    const deps = makeDeps({
      getCustomer: vi.fn(async ({ customerID }: { customerID: string }) => {
        if (customerID === "B")
          return { ok: false as const, error: "404 not found", statusCode: 404 };
        return okCustomer(customerID, `Name ${customerID}`);
      }),
    });
    const result = await runCustomerCatchup("manual", deps);
    expect(result.orphansFound).toBe(3);
    expect(result.fetched).toBe(2); // A and C succeeded
    expect(result.upserted).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      customerExternalId: "B",
      message: expect.stringContaining("404"),
    });
  });

  it("respects concurrency cap (no more than N inflight at once)", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const deps = makeDeps({
      findOrphanIds: vi.fn(async () => Array.from({ length: 10 }, (_, i) => `ID${i}`)),
      concurrency: 3,
      getCustomer: vi.fn(async ({ customerID }: { customerID: string }) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inflight--;
        return okCustomer(customerID, `Name ${customerID}`);
      }),
    });
    const result = await runCustomerCatchup("manual", deps);
    expect(result.fetched).toBe(10);
    expect(maxInflight).toBeLessThanOrEqual(3);
  });

  it("survives a thrown error inside getCustomer (records error, doesn't crash)", async () => {
    const deps = makeDeps({
      getCustomer: vi.fn(async ({ customerID }: { customerID: string }) => {
        if (customerID === "A") throw new Error("network blip");
        return okCustomer(customerID, `Name ${customerID}`);
      }),
    });
    const result = await runCustomerCatchup("manual", deps);
    expect(result.orphansFound).toBe(3);
    expect(result.fetched).toBe(2);
    expect(result.errors.find((e) => e.customerExternalId === "A")?.message).toContain(
      "network blip",
    );
  });

  it("writes a single sync_log row per run (start + finish), even with errors", async () => {
    const deps = makeDeps({
      getCustomer: vi.fn(async () => {
        throw new Error("upstream down");
      }),
      findOrphanIds: vi.fn(async () => ["X"]),
    });
    await runCustomerCatchup("manual", deps);
    expect(deps.startSyncLog).toHaveBeenCalledOnce();
    expect(deps.finishSyncLog).toHaveBeenCalledOnce();
  });

  it("propagates findOrphanIds rejection by recording it as an error and finishing the log", async () => {
    const deps = makeDeps({
      findOrphanIds: vi.fn(async () => {
        throw new Error("db unreachable");
      }),
    });
    const result = await runCustomerCatchup("manual", deps);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("db unreachable");
    expect(deps.finishSyncLog).toHaveBeenCalledWith(1, {
      error: expect.stringContaining("db unreachable"),
    });
  });
});
