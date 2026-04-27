import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 10 — Error alert engine
 * -----------------------------
 *
 * Contract pins for `server/alertEngine.ts`:
 *
 *   1. `evaluateAlerts` MUST never throw — alerting is best-effort.
 *   2. SPIKE fires when count(error rows) for source in window >= threshold.
 *   3. FLAPPING fires when count(same-fingerprint rows) in window >= threshold.
 *   4. Cooldown suppresses re-firing for `cooldownSeconds` (DB-backed via
 *      most recent errorAlerts row with same key).
 *   5. When fired, alert MUST insert a row into `errorAlerts`, mirror to
 *      `errorLogs` (level=warn, source=alert.engine), and call notifyOwner.
 *   6. `messageFingerprint` strips numbers and hex ids so retries with
 *      varying ids collapse to the same key.
 *   7. `notify=false` config skips notifyOwner (used by tests / silent runs).
 */

// ---------- Mocks -------------------------------------------------------

const notifySpy = vi.fn();

vi.mock("./_core/notification", () => ({
  notifyOwner: notifySpy,
}));

vi.mock("./db", () => ({
  getDb: vi.fn(),
  readAffectedRows: (result: unknown): number => {
    if (Array.isArray(result)) {
      const first = result[0] as { affectedRows?: number } | undefined;
      return first?.affectedRows ?? 0;
    }
    return (result as { affectedRows?: number } | null)?.affectedRows ?? 0;
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

// Helper: build a chainable fake db that returns canned counts and remembers
// every insert. The detector calls:
//   db.select({...}).from(errorLogs).where(...)            -> rows[]
//   db.select({...}).from(errorAlerts).where(...).orderBy(...).limit(1) -> rows[]
//   db.insert(errorAlerts | errorLogs).values(row)         -> resolves
function makeFakeDb(opts: {
  spikeCount?: number;
  flapCount?: number;
  cooldownActive?: boolean;
}) {
  const inserts: Array<{ table: unknown; row: unknown }> = [];
  let selectCallIdx = 0;
  // Order of select calls inside evaluateAlerts:
  //   0: spike count from errorLogs
  //   1 (if spike fires): cooldown lookup from errorAlerts
  //   2: flap count from errorLogs
  //   3 (if flap fires): cooldown lookup from errorAlerts
  // We can't easily distinguish by table without inspecting args, so we just
  // serve responses in this exact order. Each test sets up the right
  // sequence based on which paths it expects to hit.
  const selectQueue: unknown[][] = [];
  selectQueue.push([{ c: opts.spikeCount ?? 0 }]); // spike count
  if ((opts.spikeCount ?? 0) >= 5) {
    selectQueue.push(opts.cooldownActive ? [{ id: 1 }] : []); // spike cooldown
  }
  selectQueue.push([{ c: opts.flapCount ?? 0 }]); // flap count
  if ((opts.flapCount ?? 0) >= 3) {
    selectQueue.push(opts.cooldownActive ? [{ id: 2 }] : []); // flap cooldown
  }

  const db = {
    select: vi.fn(() => {
      const rows = selectQueue[selectCallIdx] ?? [];
      selectCallIdx += 1;
      // Return a chain that always resolves to `rows`
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
        // For count queries the caller awaits the .where(...) directly. Make
        // it thenable so `await db.select().from().where(...)` works.
        then: (onF: (v: unknown) => void) => onF(rows),
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: (row: unknown) => {
        inserts.push({ table, row });
        return Promise.resolve();
      },
    })),
  };
  return { db, inserts };
}

// ---------- Pure helpers -----------------------------------------------

describe("messageFingerprint", () => {
  it("strips numbers and hex ids so retries collapse", async () => {
    const { messageFingerprint } = await import("./alertEngine");
    const a = messageFingerprint("Twilio 5xx for SM12345abcdef on attempt 3");
    const b = messageFingerprint("Twilio 5xx for SM98765fedcba on attempt 7");
    expect(a).toBe(b);
  });

  it("truncates long messages to 80 chars", async () => {
    const { messageFingerprint } = await import("./alertEngine");
    const out = messageFingerprint("a".repeat(500));
    expect(out.length).toBe(80);
  });
});

// ---------- evaluateAlerts ---------------------------------------------

describe("evaluateAlerts", () => {
  it("never throws when DB is unavailable", async () => {
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { evaluateAlerts } = await import("./alertEngine");
    await expect(
      evaluateAlerts({ source: "X", message: "boom" }),
    ).resolves.toEqual([]);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("never throws when DB rejects", async () => {
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db down"),
    );

    const { evaluateAlerts } = await import("./alertEngine");
    await expect(
      evaluateAlerts({ source: "X", message: "boom" }),
    ).resolves.toEqual([]);
  });

  it("does NOT fire spike below threshold", async () => {
    const { db } = makeFakeDb({ spikeCount: 4, flapCount: 0 });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    const { evaluateAlerts } = await import("./alertEngine");
    const fired = await evaluateAlerts({ source: "X", message: "boom" });
    expect(fired).toEqual([]);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("fires SPIKE when count >= threshold and not cooling down", async () => {
    const { db, inserts } = makeFakeDb({
      spikeCount: 7,
      flapCount: 0,
      cooldownActive: false,
    });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    const { evaluateAlerts } = await import("./alertEngine");
    const fired = await evaluateAlerts({
      source: "TwilioWebhook",
      message: "boom",
    });

    expect(fired).toHaveLength(1);
    expect(fired[0].kind).toBe("spike");
    expect(fired[0].count).toBe(7);
    expect(fired[0].key).toBe("spike:TwilioWebhook");

    // Inserted both: errorAlerts row + errorLogs mirror row
    expect(inserts).toHaveLength(2);
    expect((inserts[0].row as any).kind).toBe("spike");
    expect((inserts[0].row as any).source).toBe("TwilioWebhook");
    expect((inserts[1].row as any).source).toBe("alert.engine");
    expect((inserts[1].row as any).level).toBe("warn");

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0].title).toMatch(/spike/i);
  });

  it("SUPPRESSES spike when cooldown active", async () => {
    const { db, inserts } = makeFakeDb({
      spikeCount: 7,
      flapCount: 0,
      cooldownActive: true,
    });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    const { evaluateAlerts } = await import("./alertEngine");
    const fired = await evaluateAlerts({
      source: "TwilioWebhook",
      message: "boom",
    });

    expect(fired).toEqual([]);
    expect(inserts).toHaveLength(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("fires FLAPPING when same-fingerprint count >= threshold", async () => {
    const { db, inserts } = makeFakeDb({
      spikeCount: 0,
      flapCount: 4,
      cooldownActive: false,
    });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    const { evaluateAlerts } = await import("./alertEngine");
    const fired = await evaluateAlerts({
      source: "drafts.approve",
      message: "TRPCError: rate limited",
    });

    expect(fired).toHaveLength(1);
    expect(fired[0].kind).toBe("flap");
    expect(fired[0].count).toBe(4);
    expect(fired[0].key).toMatch(/^flap:drafts\.approve\|/);

    // Both inserts (alert + mirror) recorded
    expect(inserts).toHaveLength(2);
    expect((inserts[0].row as any).kind).toBe("flap");

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0].title).toMatch(/flapping/i);
  });

  it("respects notify=false (no notifyOwner call)", async () => {
    const { db, inserts } = makeFakeDb({
      spikeCount: 7,
      flapCount: 0,
      cooldownActive: false,
    });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    const { evaluateAlerts, DEFAULT_ALERT_CONFIG } = await import(
      "./alertEngine"
    );
    const fired = await evaluateAlerts(
      { source: "X", message: "boom" },
      { ...DEFAULT_ALERT_CONFIG, notify: false },
    );
    expect(fired).toHaveLength(1);
    expect(inserts).toHaveLength(2); // still persists
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("can fire BOTH spike and flap in one evaluation", async () => {
    const { db, inserts } = makeFakeDb({
      spikeCount: 8,
      flapCount: 5,
      cooldownActive: false,
    });
    const { getDb } = await import("./db");
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    const { evaluateAlerts } = await import("./alertEngine");
    const fired = await evaluateAlerts({
      source: "TwilioWebhook",
      message: "rate limited",
    });

    expect(fired.map((f) => f.kind).sort()).toEqual(["flap", "spike"]);
    // 2 alert rows + 2 mirror rows
    expect(inserts).toHaveLength(4);
    expect(notifySpy).toHaveBeenCalledTimes(2);
  });
});
