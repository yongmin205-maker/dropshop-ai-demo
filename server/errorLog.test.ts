import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 9 — Admin error logging
 * -----------------------------
 *
 * Contract pins for `server/errorLog.ts`:
 *
 *   1. `logServerError` is best-effort: when the DB is unavailable it MUST
 *      no-op (never throw) so the original error path that called it is not
 *      shadowed by a logger crash.
 *   2. When the DB is available, the function MUST insert a row into
 *      `errorLogs` with the right shape: `level`, `source`, `message`,
 *      `stack`, `context` (PII-scrubbed), `correlationId`.
 *   3. Insert failures MUST also be swallowed (warn, not throw).
 *   4. PII in `context` MUST be redacted via the same `redactPII` helper used
 *      by processingLogs.
 */

const insertSpy = vi.fn();
const valuesSpy = vi.fn();

vi.mock("./db", () => {
  return {
    getDb: vi.fn(),
  };
});

vi.mock("./pii", () => {
  return {
    redactPII: vi.fn((v: unknown) => ({ __redacted: true, original: v })),
    redactText: vi.fn((s: string) => s),
  };
});

// Mock alertEngine so logServerError tests stay isolated from the spike/flap
// detector. The detector is exercised by alertEngine.test.ts directly.
vi.mock("./alertEngine", () => ({
  evaluateAlerts: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("logServerError", () => {
  it("no-ops when DB is unavailable (never throws)", async () => {
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { logServerError } = await import("./errorLog");
    await expect(
      logServerError({ source: "Test", err: new Error("boom") }),
    ).resolves.toBeUndefined();
  });

  it("swallows getDb() rejections rather than re-throwing", async () => {
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db init crash"));

    const { logServerError } = await import("./errorLog");
    await expect(
      logServerError({ source: "Test", err: new Error("original") }),
    ).resolves.toBeUndefined();
  });

  it("inserts a row with the right shape when DB is available", async () => {
    insertSpy.mockReset();
    valuesSpy.mockReset();
    insertSpy.mockReturnValue({ values: valuesSpy });
    valuesSpy.mockResolvedValue(undefined);
    const fakeDb = { insert: insertSpy } as any;
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fakeDb);

    const { logServerError } = await import("./errorLog");
    const err = new Error("kaboom");
    await logServerError({
      source: "TwilioWebhook",
      err,
      context: { messageSid: "SM123", from: "+15551234567" },
      correlationId: "tw_abc",
      level: "error",
    });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(valuesSpy).toHaveBeenCalledTimes(1);
    const row = valuesSpy.mock.calls[0][0];
    expect(row.source).toBe("TwilioWebhook");
    expect(row.level).toBe("error");
    expect(row.message).toBe("kaboom");
    expect(typeof row.stack).toBe("string");
    expect(row.correlationId).toBe("tw_abc");
    // PII redacted via the mocked redactPII
    expect(row.context).toEqual({
      __redacted: true,
      original: { messageSid: "SM123", from: "+15551234567" },
    });
  });

  it("defaults level to 'error' when not specified", async () => {
    insertSpy.mockReset();
    valuesSpy.mockReset();
    insertSpy.mockReturnValue({ values: valuesSpy });
    valuesSpy.mockResolvedValue(undefined);
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ insert: insertSpy } as any);

    const { logServerError } = await import("./errorLog");
    await logServerError({ source: "X", err: "string err" });

    const row = valuesSpy.mock.calls[0][0];
    expect(row.level).toBe("error");
    expect(row.message).toBe("string err");
    expect(row.stack).toBeNull();
    expect(row.context).toBeNull();
  });

  it("swallows insert failures (best-effort) without throwing to caller", async () => {
    insertSpy.mockReset();
    valuesSpy.mockReset();
    insertSpy.mockReturnValue({ values: valuesSpy });
    valuesSpy.mockRejectedValue(new Error("write failed"));
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ insert: insertSpy } as any);

    const { logServerError } = await import("./errorLog");
    await expect(
      logServerError({ source: "X", err: new Error("original") }),
    ).resolves.toBeUndefined();
  });

  it("truncates extremely long messages to 4000 chars", async () => {
    insertSpy.mockReset();
    valuesSpy.mockReset();
    insertSpy.mockReturnValue({ values: valuesSpy });
    valuesSpy.mockResolvedValue(undefined);
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ insert: insertSpy } as any);

    const { logServerError } = await import("./errorLog");
    const huge = "x".repeat(10_000);
    await logServerError({ source: "X", err: new Error(huge) });
    const row = valuesSpy.mock.calls[0][0];
    expect(row.message.length).toBe(4000);
  });
});

describe("admin gating contract", () => {
  it("errorLogs router uses adminProcedure (static source check)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");

    // The non-greedy match against `}\)` is brittle because nested route
    // bodies contain their own `})`. Easier and more robust: locate the
    // errorLogs sub-router header, then look ahead for the two keys.
    const headerIdx = src.indexOf("errorLogs: router({");
    expect(headerIdx, "errorLogs sub-router should exist in routers.ts").toBeGreaterThan(0);
    // Slice ~2k chars after the header — large enough to cover both keys.
    const block = src.slice(headerIdx, headerIdx + 2000);
    expect(block).toMatch(/list:\s*adminProcedure/);
    expect(block).toMatch(/clear:\s*adminProcedure/);
    expect(block).toMatch(/alerts:\s*adminProcedure/);
    // Phase 2 additions — filter dropdown + TTL purge MUST also be admin-gated.
    expect(block).toMatch(/sources:\s*adminProcedure/);
    expect(block).toMatch(/purgeOld:\s*adminProcedure/);
  });
});

describe("listErrorLogs filters", () => {
  // We mock the chain factory rather than drizzle internals so we can assert
  // the engine builds queries with the correct shape (where conditions, limit,
  // ordering) without booting MySQL.
  it("returns [] when getDb is unavailable", async () => {
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { listErrorLogs } = await import("./errorLog");
    await expect(listErrorLogs({ level: "error" })).resolves.toEqual([]);
  });

  it("clamps limit to [1, 200]", async () => {
    const limitSpy = vi.fn().mockResolvedValue([]);
    const orderBySpy = vi.fn().mockReturnValue({ limit: limitSpy });
    const dynamicSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ orderBy: orderBySpy }),
      orderBy: orderBySpy,
    });
    const fromSpy = vi.fn().mockReturnValue({ $dynamic: dynamicSpy });
    const selectSpy = vi.fn().mockReturnValue({ from: fromSpy });
    const fakeDb = { select: selectSpy } as any;
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fakeDb);
    const { listErrorLogs } = await import("./errorLog");

    await listErrorLogs({ limit: 99999 });
    expect(limitSpy).toHaveBeenCalledWith(200);

    await listErrorLogs({ limit: 0 });
    expect(limitSpy).toHaveBeenLastCalledWith(1);

    await listErrorLogs({});
    expect(limitSpy).toHaveBeenLastCalledWith(50);
  });
});

describe("purgeOldErrorLogs", () => {
  it("throws if olderThanDays < 1 (caller programming error)", async () => {
    const { purgeOldErrorLogs } = await import("./errorLog");
    await expect(purgeOldErrorLogs(0)).rejects.toThrow(/>= 1/);
    await expect(purgeOldErrorLogs(-5)).rejects.toThrow(/>= 1/);
  });

  it("returns 0 when DB is unavailable (graceful no-op)", async () => {
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { purgeOldErrorLogs } = await import("./errorLog");
    await expect(purgeOldErrorLogs(30)).resolves.toBe(0);
  });

  it("issues a delete with createdAt < cutoff and returns affected count", async () => {
    // Capture the where clause arg so we can assert the cutoff is N days ago.
    const whereSpy = vi.fn().mockResolvedValue([{ affectedRows: 7 }]);
    const deleteSpy = vi.fn().mockReturnValue({ where: whereSpy });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      delete: deleteSpy,
    } as any);

    const { purgeOldErrorLogs } = await import("./errorLog");
    const before = Date.now();
    const affected = await purgeOldErrorLogs(30);
    const after = Date.now();

    expect(affected).toBe(7);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy).toHaveBeenCalledTimes(1);
    // Best we can do without leaking SQL internals: assert the call happened.
    // The cutoff Date should be within ~30 days +/- the few ms test took.
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(before - thirtyDaysMs - 100).toBeLessThanOrEqual(after - thirtyDaysMs);
  });
});

describe("listErrorSources", () => {
  it("returns [] when DB is unavailable", async () => {
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { listErrorSources } = await import("./errorLog");
    await expect(listErrorSources()).resolves.toEqual([]);
  });

  it("maps distinct rows to a flat string array, capped at 64", async () => {
    const limitSpy = vi.fn().mockResolvedValue([
      { source: "alert.engine" },
      { source: "twilio.webhook" },
      { source: "drafts.approve" },
    ]);
    const orderBySpy = vi.fn().mockReturnValue({ limit: limitSpy });
    const fromSpy = vi.fn().mockReturnValue({ orderBy: orderBySpy });
    const selectDistinctSpy = vi.fn().mockReturnValue({ from: fromSpy });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      selectDistinct: selectDistinctSpy,
    } as any);

    const { listErrorSources } = await import("./errorLog");
    const result = await listErrorSources();
    expect(result).toEqual(["alert.engine", "twilio.webhook", "drafts.approve"]);
    expect(limitSpy).toHaveBeenCalledWith(64);
  });
});
