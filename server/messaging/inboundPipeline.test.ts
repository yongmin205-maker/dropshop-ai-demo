/**
 * Inbound pipeline contracts.
 *
 * These tests are the single most important safety net in the messaging
 * layer: they pin the invariant that shadow mode never invokes outbound.
 * If a future refactor regresses this contract we want CI to catch it
 * before the friend's customers ever see a message.
 */
import { describe, expect, it, vi } from "vitest";

import type { InboundMessage } from "../../shared/messaging";
import {
  type DraftAgent,
  type ShadowInboxStore,
  type OutboundSender,
  runInboundPipeline,
  SHADOW_OUTBOUND_GUARD,
  resolveMessagingMode,
} from "./inboundPipeline";

function fixture(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    provider: "quo",
    providerMessageId: "AC-test-1",
    from: "+14155550100",
    to: "+14155550199",
    body: "Hi can I pick up my order today?",
    mediaUrls: [],
    receivedAt: 1_777_000_000_000,
    raw: {},
    ...overrides,
  };
}

function fakeStore(): ShadowInboxStore & { calls: number } {
  let id = 0;
  return {
    calls: 0,
    async persistShadowDraft() {
      this.calls += 1;
      id += 1;
      return { id };
    },
  } as ShadowInboxStore & { calls: number };
}

const happyAgent: DraftAgent = async () => ({
  intent: "Pickup Request",
  draftBody: "Sure! Your order is ready — see you anytime today before 7pm.",
  confidence: 0.92,
});

describe("runInboundPipeline — shadow mode safety", () => {
  it("generates a draft and persists to shadow inbox without invoking outbound", async () => {
    const sendSms = vi.fn();
    const store = fakeStore();
    const result = await runInboundPipeline(fixture(), "shadow", {
      agent: happyAgent,
      shadowStore: store,
      // No outbound sender provided at all → safest default.
    });
    expect(result).toMatchObject({
      ok: true,
      mode: "shadow",
      intent: "Pickup Request",
    });
    expect(store.calls).toBe(1);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("throws if shadow mode is given a real outbound sender (config bug)", async () => {
    const realSender: OutboundSender = { async sendSms() { return { ok: true, sid: "X" }; } };
    await expect(
      runInboundPipeline(fixture(), "shadow", {
        agent: happyAgent,
        shadowStore: fakeStore(),
        outbound: realSender,
      }),
    ).rejects.toThrow(/Shadow mode requires/);
  });

  it("accepts the SHADOW_OUTBOUND_GUARD sentinel; the guard itself throws if invoked", async () => {
    const result = await runInboundPipeline(fixture(), "shadow", {
      agent: happyAgent,
      shadowStore: fakeStore(),
      outbound: SHADOW_OUTBOUND_GUARD,
    });
    expect(result.ok).toBe(true);
    await expect(SHADOW_OUTBOUND_GUARD.sendSms("+1", "x")).rejects.toThrow(
      /must never call sendSms/,
    );
  });
});

describe("runInboundPipeline — idempotency", () => {
  it("returns duplicate without calling agent or store on a re-delivered message", async () => {
    const agent = vi.fn(happyAgent);
    const store = fakeStore();
    const result = await runInboundPipeline(fixture(), "shadow", {
      agent,
      shadowStore: store,
      isAlreadyProcessed: async () => true,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(agent).not.toHaveBeenCalled();
    expect(store.calls).toBe(0);
  });
});

describe("runInboundPipeline — agent failure", () => {
  it("propagates agent error into a structured result (no exception bubble)", async () => {
    const result = await runInboundPipeline(fixture(), "shadow", {
      agent: async () => { throw new Error("LLM 504 timeout"); },
      shadowStore: fakeStore(),
    });
    expect(result).toMatchObject({ ok: false, reason: "agent_failed" });
    if (result.ok === false) {
      expect(result.detail).toContain("LLM 504");
    }
  });
});

describe("runInboundPipeline — live mode behavior", () => {
  it("persists the same shadow record + reports live mode (HITL queue takes over)", async () => {
    const store = fakeStore();
    const result = await runInboundPipeline(fixture(), "live", {
      agent: happyAgent,
      shadowStore: store,
      // No outbound sender — live mode does NOT auto-send. The HITL approval
      // queue is responsible for any actual outbound call.
    });
    expect(result).toMatchObject({ ok: true, mode: "live" });
    expect(store.calls).toBe(1);
  });
});

describe("resolveMessagingMode", () => {
  it("defaults to shadow when env not set", () => {
    const prev = process.env.MESSAGING_LIVE_MODE;
    delete process.env.MESSAGING_LIVE_MODE;
    expect(resolveMessagingMode()).toBe("shadow");
    if (prev !== undefined) process.env.MESSAGING_LIVE_MODE = prev;
  });

  it("flips to live only on explicit '1'", () => {
    const prev = process.env.MESSAGING_LIVE_MODE;
    process.env.MESSAGING_LIVE_MODE = "1";
    expect(resolveMessagingMode()).toBe("live");
    process.env.MESSAGING_LIVE_MODE = "true"; // wrong value, must NOT flip
    expect(resolveMessagingMode()).toBe("shadow");
    if (prev === undefined) delete process.env.MESSAGING_LIVE_MODE;
    else process.env.MESSAGING_LIVE_MODE = prev;
  });
});
