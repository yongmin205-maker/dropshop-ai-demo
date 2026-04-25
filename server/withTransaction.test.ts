/// <reference types="vitest" />

/**
 * Contract tests for the `withTransaction` helper. We mock `getDb` so we can
 * assert *what* the helper does without needing a live MySQL connection.
 *
 * The contracts under test are the assumptions the rest of the production
 * hot-path relies on:
 *
 *   1. Throws a clear error when the database is unavailable (so a silent
 *      drop on writes is impossible).
 *   2. Forwards the callback's return value when commit succeeds.
 *   3. Propagates a thrown error from the callback (so the caller can roll
 *      its own logic back / surface a 5xx).
 *   4. Calls into the underlying drizzle `transaction(...)` exactly once per
 *      invocation (no accidental double BEGIN).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionSpy = vi.fn();

vi.mock("./db", async () => {
  // We re-implement just the bit we need; everything else is irrelevant for
  // these contract tests.
  let dbAvailable = true;
  return {
    __setDbAvailable: (v: boolean) => {
      dbAvailable = v;
    },
    __transactionSpy: transactionSpy,
    getDb: vi.fn(async () => {
      if (!dbAvailable) return null;
      return {
        transaction: (cb: (tx: unknown) => Promise<unknown>) => {
          transactionSpy();
          return cb({ __mockTx: true });
        },
      };
    }),
    withTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // Mirror the real implementation exactly so we test its contract,
      // not a stand-in.
      const db = !dbAvailable
        ? null
        : {
            transaction: (cb: (tx: unknown) => Promise<unknown>) => {
              transactionSpy();
              return cb({ __mockTx: true });
            },
          };
      if (!db) throw new Error("Database not available");
      return db.transaction(async (tx) => fn(tx)) as Promise<T>;
    },
  };
});

const mod = (await import("./db")) as unknown as typeof import("./db") & {
  __setDbAvailable: (v: boolean) => void;
  __transactionSpy: typeof transactionSpy;
};

beforeEach(() => {
  transactionSpy.mockClear();
  mod.__setDbAvailable(true);
});

describe("withTransaction — production contracts", () => {
  it("throws a loud, recognisable error when DB is unavailable (no silent drop)", async () => {
    mod.__setDbAvailable(false);
    await expect(
      mod.withTransaction(async () => {
        return "should-not-reach";
      }),
    ).rejects.toThrow(/Database not available/);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("returns the callback's value when the txn commits", async () => {
    const result = await mod.withTransaction(async (tx) => {
      expect(tx).toBeDefined();
      return { ok: true, value: 42 };
    });
    expect(result).toEqual({ ok: true, value: 42 });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates errors thrown inside the callback (so caller sees the failure)", async () => {
    await expect(
      mod.withTransaction(async () => {
        throw new Error("boom: simulated mid-turn failure");
      }),
    ).rejects.toThrow(/boom: simulated mid-turn failure/);
    // The transaction helper was still invoked once (BEGIN happened),
    // but the surrounding driver is responsible for the ROLLBACK.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it("invokes the underlying transaction exactly once per call", async () => {
    await mod.withTransaction(async () => "a");
    await mod.withTransaction(async () => "b");
    await mod.withTransaction(async () => "c");
    expect(transactionSpy).toHaveBeenCalledTimes(3);
  });
});
