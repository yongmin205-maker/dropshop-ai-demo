import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("§5.2 sendSms segment cap", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+15555550100";
    delete process.env.MAX_SMS_SEGMENTS;
    vi.resetModules();
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    delete process.env.MAX_SMS_SEGMENTS;
    vi.resetModules();
  });

  it("rejects bodies that exceed the default 4-segment cap before calling Twilio", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const { sendSms, smsSegmentCount } = await import("./twilio");
    // 5 segments worth of GSM text: 4*153 + 10 = 622 chars.
    const huge = "a".repeat(4 * 153 + 10);
    expect(smsSegmentCount(huge)).toBeGreaterThan(4);
    const res = await sendSms("+15550101234", huge);
    expect(res.ok).toBe(false);
    expect(res.ok || (!res.ok && res.error)).toBeTruthy();
    if (!res.ok) {
      expect(res.error).toMatch(/SMS too long/i);
      expect(res.error).toMatch(/max 4/);
    }
    // Critical: the cap is enforced *before* fetch — no Twilio bill incurred.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("respects MAX_SMS_SEGMENTS env override", async () => {
    process.env.MAX_SMS_SEGMENTS = "2";
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const { sendSms } = await import("./twilio");
    // 3 segments: 153*2 + 10 = 316 chars
    const med = "a".repeat(153 * 2 + 10);
    const res = await sendSms("+15550101234", med);
    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows messages within the cap to reach fetch", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ sid: "SMtest" }), { status: 200 }),
    ) as any;
    const { sendSms } = await import("./twilio");
    const res = await sendSms("+15550101234", "Hi, your order is ready");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sid).toBe("SMtest");
  });
});
