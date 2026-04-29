import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ----- Twilio adapter is built on top of `./twilio.sendSms`, so mock that.
vi.mock("../twilio", async () => {
  const real = await vi.importActual<typeof import("../twilio")>("../twilio");
  return {
    ...real,
    isLiveMode: vi.fn(() => true), // pretend creds are present for the adapter contract tests
    sendSms: vi.fn(async () => ({ ok: true as const, sid: "SM_FAKE_LIVE" })),
  };
});

import {
  createSimulatorTransport,
  getMessageTransport,
  isTransportLive,
  MessageTransport,
  ShadowGuardTransport,
  simulatorTransport,
  TwilioAdapter,
} from "./transport";
import * as twilio from "../twilio";

describe("MessageTransport — TwilioAdapter", () => {
  beforeEach(() => {
    vi.mocked(twilio.sendSms).mockClear();
  });

  it("delegates to twilio.sendSms and surfaces sid on success", async () => {
    vi.mocked(twilio.sendSms).mockResolvedValueOnce({ ok: true, sid: "SM_OK" });
    const r = await TwilioAdapter.send("+15555550100", "hello");
    expect(r).toEqual({ ok: true, sid: "SM_OK" });
    expect(twilio.sendSms).toHaveBeenCalledWith("+15555550100", "hello");
  });

  it("translates twilio failure into the SendResult vocabulary (retryable=true)", async () => {
    vi.mocked(twilio.sendSms).mockResolvedValueOnce({
      ok: false,
      error: "Twilio 503: service unavailable",
    });
    const r = await TwilioAdapter.send("+15555550100", "hello");
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("503");
    expect(r.code).toBe("twilio_error");
    expect(r.retryable).toBe(true);
  });

  it("has the stable name 'twilio' for processing-log labels", () => {
    expect(TwilioAdapter.name).toBe("twilio");
  });
});

describe("MessageTransport — SimulatorTransport", () => {
  let sim: ReturnType<typeof createSimulatorTransport>;
  beforeEach(() => {
    sim = createSimulatorTransport();
  });

  it("rejects invalid E.164 with retryable=false (programmer error, not transport flake)", async () => {
    const r = await sim.send("not-a-phone", "hi");
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("invalid_phone");
    expect(r.retryable).toBe(false);
    expect(sim.sends).toHaveLength(0);
  });

  it("rejects empty body with retryable=false", async () => {
    const r = await sim.send("+15555550100", "   ");
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("empty_body");
    expect(r.retryable).toBe(false);
  });

  it("records every successful send and returns a SIM-prefixed sid", async () => {
    const r1 = await sim.send("+15555550100", "first");
    const r2 = await sim.send("+15555550101", "second");
    if (!r1.ok || !r2.ok) throw new Error("expected both ok");
    expect(r1.sid.startsWith("SIM")).toBe(true);
    expect(r2.sid.startsWith("SIM")).toBe(true);
    expect(r1.sid).not.toBe(r2.sid);
    expect(sim.sends.map((s) => s.body)).toEqual(["first", "second"]);
  });

  it("isolates sends across transport instances (per-test fresh state)", async () => {
    const a = createSimulatorTransport();
    const b = createSimulatorTransport();
    await a.send("+15555550100", "to-a");
    expect(a.sends).toHaveLength(1);
    expect(b.sends).toHaveLength(0);
  });

  it("reset() clears the send log", async () => {
    await sim.send("+15555550100", "x");
    expect(sim.sends).toHaveLength(1);
    sim.reset();
    expect(sim.sends).toHaveLength(0);
  });

  it("module-level singleton exists and obeys the same contract", async () => {
    simulatorTransport.reset();
    const r = await simulatorTransport.send("+15555550100", "from singleton");
    expect(r.ok).toBe(true);
    expect(simulatorTransport.sends).toHaveLength(1);
    simulatorTransport.reset();
  });
});

describe("MessageTransport — ShadowGuardTransport", () => {
  it("always rejects with shadow_guard code, retryable=false (no Draft re-open)", async () => {
    const r = await ShadowGuardTransport.send("+15555550100", "should never send");
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("shadow_guard");
    expect(r.retryable).toBe(false);
    expect(r.error).toMatch(/shadow mode must never call send/);
  });
});

describe("MessageTransport — getMessageTransport() selector", () => {
  const ORIG_LIVE = process.env.DROPSHOP_LIVE_MODE;

  afterEach(() => {
    if (ORIG_LIVE === undefined) delete process.env.DROPSHOP_LIVE_MODE;
    else process.env.DROPSHOP_LIVE_MODE = ORIG_LIVE;
    vi.mocked(twilio.isLiveMode).mockReturnValue(true);
  });

  it("returns simulator when DROPSHOP_LIVE_MODE is unset (default safe)", () => {
    delete process.env.DROPSHOP_LIVE_MODE;
    const t: MessageTransport = getMessageTransport();
    expect(t.name).toBe("simulator");
  });

  it("returns simulator even with DROPSHOP_LIVE_MODE=1 if Twilio creds missing", () => {
    process.env.DROPSHOP_LIVE_MODE = "1";
    vi.mocked(twilio.isLiveMode).mockReturnValueOnce(false);
    const t = getMessageTransport();
    expect(t.name).toBe("simulator");
  });

  it("returns Twilio adapter only when both flag AND creds are present", () => {
    process.env.DROPSHOP_LIVE_MODE = "1";
    vi.mocked(twilio.isLiveMode).mockReturnValue(true);
    const t = getMessageTransport();
    expect(t.name).toBe("twilio");
  });
});

// ---- isTransportLive() contract tests (post-fix5 follow-up) ----
//
// Why this exists: pre-patch, the operator badge in `config.get.liveMode`
// returned raw `isLiveMode()` (creds only). It could read "live" while the
// transport selector — which also requires the `DROPSHOP_LIVE_MODE=1`
// kill-switch — silently routed sends through the simulator. The badge and
// the actual outbound channel disagreed. `isTransportLive()` is the single
// predicate both ends now consume. These tests pin that they cannot drift.
describe("isTransportLive() — single source of truth for operator badge", () => {
  const ORIG_LIVE = process.env.DROPSHOP_LIVE_MODE;

  afterEach(() => {
    if (ORIG_LIVE === undefined) delete process.env.DROPSHOP_LIVE_MODE;
    else process.env.DROPSHOP_LIVE_MODE = ORIG_LIVE;
    vi.mocked(twilio.isLiveMode).mockReturnValue(true);
  });

  it("is false when DROPSHOP_LIVE_MODE is unset (creds alone is not enough)", () => {
    delete process.env.DROPSHOP_LIVE_MODE;
    vi.mocked(twilio.isLiveMode).mockReturnValue(true);
    expect(isTransportLive()).toBe(false);
  });

  it("is false when kill-switch is set but creds missing", () => {
    process.env.DROPSHOP_LIVE_MODE = "1";
    vi.mocked(twilio.isLiveMode).mockReturnValueOnce(false);
    expect(isTransportLive()).toBe(false);
  });

  it("is true only when both flag AND creds are present", () => {
    process.env.DROPSHOP_LIVE_MODE = "1";
    vi.mocked(twilio.isLiveMode).mockReturnValue(true);
    expect(isTransportLive()).toBe(true);
  });

  it("agrees with getMessageTransport() across the four cells of the truth table", () => {
    // Cell A: no flag, no creds → simulator + isTransportLive=false
    delete process.env.DROPSHOP_LIVE_MODE;
    vi.mocked(twilio.isLiveMode).mockReturnValue(false);
    expect(isTransportLive()).toBe(false);
    expect(getMessageTransport().name).toBe("simulator");

    // Cell B: flag, no creds → simulator + isTransportLive=false
    process.env.DROPSHOP_LIVE_MODE = "1";
    vi.mocked(twilio.isLiveMode).mockReturnValue(false);
    expect(isTransportLive()).toBe(false);
    expect(getMessageTransport().name).toBe("simulator");

    // Cell C: no flag, creds (THIS IS THE PRE-FIX5 BUG CASE) → simulator + false
    delete process.env.DROPSHOP_LIVE_MODE;
    vi.mocked(twilio.isLiveMode).mockReturnValue(true);
    expect(isTransportLive()).toBe(false);
    expect(getMessageTransport().name).toBe("simulator");

    // Cell D: flag + creds → twilio + true
    process.env.DROPSHOP_LIVE_MODE = "1";
    vi.mocked(twilio.isLiveMode).mockReturnValue(true);
    expect(isTransportLive()).toBe(true);
    expect(getMessageTransport().name).toBe("twilio");
  });
});
