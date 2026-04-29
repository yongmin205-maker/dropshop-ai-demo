/**
 * Direct integration tests for the DropShop tRPC procedures via
 * `appRouter.createCaller`. Before this file `routers.ts` showed 0% function
 * coverage in the audit because every other test reached the routers only
 * indirectly (through helper modules they happen to import). These cases
 * exercise the procedures themselves so that contract regressions —
 * input/output shapes, env-driven flags, and error paths — fail fast.
 *
 * We deliberately scope the suite to procedures with **no LLM dependency**:
 *   • `config.get` (pure env contract)
 *   • `escalations.list` / `drafts.listPending` / `customers.profile`
 *     (DB read paths with predictable fallbacks when DB is unavailable)
 *   • `escalations.resolve` and `demo.reset` admin gating
 *
 * The bigger procedures that depend on `aiAgent.runAgent` are already covered
 * by `runAgent.test.ts` and `correlationAndSupersede.test.ts`, so we don't
 * duplicate that surface here.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Block real DB access for every case in this file. Each test then layers
// per-call return values via `mockResolvedValueOnce`. (Procedures should be
// resilient to DB-unavailable for read paths.)
// Approve-flow stubs used by the fix/4 simulator-sid regression.
const approveStub = {
  draft: {
    id: 9001,
    conversationId: 7,
    inboundMessageId: 70,
    intent: "Pickup Request" as const,
    body: "your pickup is confirmed.\n— DropShop",
    status: "pending_approval" as const,
    correlationId: "corr-test",
    revision: 1,
  },
  inbound: {
    id: 70,
    conversationId: 7,
    direction: "inbound" as const,
    sender: "customer",
    body: "Pickup for Marie please",
    correlationId: "corr-test",
  },
  conversation: { id: 7, phone: "+15555550100", customerName: "Marie" },
};

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  let outboundSeq = 5000;
  return {
    ...actual,
    getDb: vi.fn(async () => null),
    listConversations: vi.fn(async () => []),
    getConversationMessages: vi.fn(async () => [approveStub.inbound]),
    getConversationLogs: vi.fn(async () => []),
    getOpenEscalations: vi.fn(async () => []),
    listPendingDrafts: vi.fn(async () => []),
    getCustomerProfile: vi.fn(async () => null),
    resolveEscalation: vi.fn(async () => undefined),
    resetDemoData: vi.fn(async () => ({ ok: true })),
    // Approve path: DB helpers are stubbed so the call goes through the
    // transport seam without needing a real MySQL.
    getDraftById: vi.fn(async () => approveStub.draft),
    getConversationById: vi.fn(async () => approveStub.conversation),
    newCorrelationId: vi.fn(() => "corr-test"),
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __mockTx: true }),
    ),
    transitionDraftStatusTx: vi.fn(async () => approveStub.draft),
    appendMessageTx: vi.fn(async () => ({ id: ++outboundSeq })),
    updateMessageDeliveryTx: vi.fn(async () => undefined),
    updateDraftStatusTx: vi.fn(async () => undefined),
    appendProcessingLogTx: vi.fn(async () => undefined),
    appendProcessingLog: vi.fn(async () => undefined),
    insertStyleExample: vi.fn(async () => ({ id: 1 })),
  };
});

// embeddings is best-effort inside drafts.approve; stub the call.
vi.mock("./embeddings", () => ({
  embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
  topK: vi.fn(() => []),
  ragRetrievalDefaults: vi.fn(() => ({
    topKKnowledge: 3,
    topKExamples: 3,
    topKRejections: 3,
    minScore: 0.1,
  })),
  isEmbeddingFallbackActive: vi.fn(() => false),
}));

// Skip seeding side effects so tests stay isolated from the real DB.
vi.mock("./mockCleanCloud", () => ({
  ensureSeeded: vi.fn(async () => undefined),
  getCustomerByPhone: vi.fn(async () => null),
}));
vi.mock("./mockSalon", () => ({
  ensureSalonSeeded: vi.fn(async () => undefined),
}));
vi.mock("./knowledgeSeed", () => ({
  seedKnowledgeIfEmpty: vi.fn(async () => undefined),
}));

import { fromPartial } from "@total-typescript/shoehorn";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthUser = NonNullable<TrpcContext["user"]>;

function makePublicCaller() {
  return appRouter.createCaller(
    fromPartial<TrpcContext>({
      user: null,
      req: fromPartial<TrpcContext["req"]>({
        protocol: "https",
        headers: {},
        ip: "127.0.0.1",
      }),
      res: fromPartial<TrpcContext["res"]>({ clearCookie: () => {} }),
    }),
  );
}

function makeAdminCaller() {
  const user: AuthUser = {
    id: 1,
    openId: "admin",
    email: "admin@dropshop.test",
    name: "Admin",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return appRouter.createCaller(
    fromPartial<TrpcContext>({
      user,
      req: fromPartial<TrpcContext["req"]>({
        protocol: "https",
        headers: {},
        ip: "127.0.0.1",
      }),
      res: fromPartial<TrpcContext["res"]>({ clearCookie: () => {} }),
    }),
  );
}

beforeAll(() => {
  // Make sure config.get sees a deterministic baseline.
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  delete process.env.DROPSHOP_AUTO_SEND;
  process.env.BUILT_IN_FORGE_API_KEY = "present";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dropshop router — config.get", () => {
  it("reports simulator-only mode and surfaces autoSend / embedding flags", async () => {
    const caller = makePublicCaller();
    const cfg = await caller.config.get();
    expect(cfg.liveMode).toBe(false);
    expect(cfg.twilioPhone).toBeNull();
    expect(cfg.autoSend).toBe(false);
    // Forge key was set in beforeAll so the missing-key flag is false.
    expect(cfg.embeddingMissingKey).toBe(false);
    // The legacy alias must always be present so the existing client doesn't crash.
    expect(typeof cfg.embeddingFallback).toBe("boolean");
    expect(typeof cfg.allowDemoReset).toBe("boolean");
  });

  it("flips embeddingMissingKey when no Forge key is configured", async () => {
    const original = process.env.BUILT_IN_FORGE_API_KEY;
    delete process.env.BUILT_IN_FORGE_API_KEY;
    try {
      const caller = makePublicCaller();
      const cfg = await caller.config.get();
      expect(cfg.embeddingMissingKey).toBe(true);
      // The compound `embeddingFallback` must reflect the key-missing case.
      expect(cfg.embeddingFallback).toBe(true);
    } finally {
      if (original !== undefined) process.env.BUILT_IN_FORGE_API_KEY = original;
    }
  });
});

describe("dropshop router — read paths return safe empties when DB is unavailable", () => {
  it("escalations.list returns [] (does not throw) when getDb resolves null", async () => {
    const caller = makePublicCaller();
    const out = await caller.escalations.list();
    expect(out).toEqual([]);
  });

  it("drafts.listPending accepts an optional conversationId and returns []", async () => {
    const caller = makePublicCaller();
    const all = await caller.drafts.listPending();
    expect(all).toEqual([]);
    const filtered = await caller.drafts.listPending({ conversationId: 42 });
    expect(filtered).toEqual([]);
  });

  it("conversations.list seeds + returns [] when DB unavailable", async () => {
    const caller = makePublicCaller();
    const out = await caller.conversations.list();
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([]);
  });

  it("customers.profile returns null for unknown conversationId", async () => {
    const caller = makePublicCaller();
    const profile = await caller.customers.profile({ conversationId: 999 });
    expect(profile).toBeNull();
  });
});

describe("dropshop router — admin gating", () => {
  // NOTE: prior to fix/1-admin-procedures the only owner-side mutation locked
  // to adminProcedure was demo.reset; drafts/simulator/escalations were
  // publicProcedure and the originGuard suffix policy (ADR 0003) admitted any
  // *.manus.space subdomain. A neighbouring Manus app the Owner visits could
  // therefore fire approve / reject / resolve / sendMessage cross-origin and,
  // in Live Mode, send real SMS. The pin below blocks that path.

  it("escalations.resolve rejects unauthenticated callers (was publicProcedure pre-fix/1)", async () => {
    const caller = makePublicCaller();
    await expect(caller.escalations.resolve({ id: 12345 })).rejects.toThrow();
  });

  it("escalations.resolve still works for the Owner (admin role)", async () => {
    const caller = makeAdminCaller();
    await expect(caller.escalations.resolve({ id: 12345 })).resolves.toBeUndefined();
  });

  it("drafts.approve rejects unauthenticated callers", async () => {
    const caller = makePublicCaller();
    await expect(caller.drafts.approve({ draftId: 1 })).rejects.toThrow();
  });

  it("drafts.reject rejects unauthenticated callers", async () => {
    const caller = makePublicCaller();
    await expect(
      caller.drafts.reject({ draftId: 1, category: "other", reason: "x" }),
    ).rejects.toThrow();
  });

  it("simulator.sendMessage rejects unauthenticated callers", async () => {
    const caller = makePublicCaller();
    await expect(
      caller.simulator.sendMessage({ phone: "+15555550100", body: "hi" }),
    ).rejects.toThrow();
  });

  it("demo.reset rejects unauthenticated callers", async () => {
    const caller = makePublicCaller();
    await expect(caller.demo.reset()).rejects.toThrow();
  });

  it("demo.reset rejects with FORBIDDEN when ALLOW_DEMO_RESET is not set", async () => {
    delete process.env.ALLOW_DEMO_RESET;
    // adminProcedure short-circuits non-admins, so we go through admin caller.
    const caller = makeAdminCaller();
    await expect(caller.demo.reset()).rejects.toThrow(/ALLOW_DEMO_RESET/);
  });
});

describe("dropshop router — drafts.approve transport migration (fix/4)", () => {
  // The pin: in Simulator Mode (no Twilio creds, no DROPSHOP_LIVE_MODE) the
  // approve flow now goes through getMessageTransport()/SimulatorTransport
  // and returns a synthetic SIM-prefixed sid, NOT a Twilio call. Pre-fix/4
  // the simulator branch bypassed the transport seam entirely and returned
  // liveSendInfo:null. This ensures we did the migration without re-mocking
  // ./twilio for every router test that exercises approve.
  it("returns a SIM-prefixed sid in Simulator Mode", async () => {
    delete process.env.DROPSHOP_LIVE_MODE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    const caller = makeAdminCaller();
    const result = await caller.drafts.approve({ draftId: 9001 });
    expect(result.ok).toBe(true);
    expect(result.liveSendInfo?.sid).toMatch(/^SIM/);
  });
});
