import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isE164, smsSegmentCount, validateTwilioSignature } from "./twilio";

describe("twilio.isE164", () => {
  it("accepts proper E.164 numbers", () => {
    expect(isE164("+15550101003")).toBe(true);
    expect(isE164("+821023456789")).toBe(true);
  });

  it("rejects malformed numbers", () => {
    expect(isE164("15550101003")).toBe(false); // missing +
    expect(isE164("+0123456789")).toBe(false); // leading 0
    expect(isE164("+12")).toBe(false); // too short
    expect(isE164("garbage")).toBe(false);
    expect(isE164("")).toBe(false);
  });
});

describe("twilio.smsSegmentCount", () => {
  it("returns 0 for empty body", () => {
    expect(smsSegmentCount("")).toBe(0);
  });

  it("counts ASCII as GSM-7 (160 / 153 chars per segment)", () => {
    expect(smsSegmentCount("Hi there!")).toBe(1);
    expect(smsSegmentCount("a".repeat(160))).toBe(1);
    expect(smsSegmentCount("a".repeat(161))).toBe(2);
    expect(smsSegmentCount("a".repeat(160 + 153))).toBe(3);
  });

  it("counts Unicode as UCS-2 (70 / 67 chars per segment)", () => {
    // Korean characters force UCS-2.
    expect(smsSegmentCount("안녕")).toBe(1);
    expect(smsSegmentCount("안".repeat(70))).toBe(1);
    expect(smsSegmentCount("안".repeat(71))).toBe(2);
  });
});

describe("twilio.validateTwilioSignature", () => {
  const url = "https://example.com/api/twilio/sms";
  const params = {
    From: "+15550101003",
    To: "+15559990000",
    Body: "hello world",
    MessageSid: "SM1234567890abcdef",
  };
  const token = "test-auth-token-secret";

  function expectedSignature(): string {
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const k of sortedKeys) data += k + (params as Record<string, string>)[k];
    return createHmac("sha1", token).update(data).digest("base64");
  }

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = token;
  });
  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("accepts a correctly signed request", () => {
    const sig = expectedSignature();
    expect(
      validateTwilioSignature({ signatureHeader: sig, url, params, authToken: token }),
    ).toBe(true);
  });

  it("rejects when the signature header is missing", () => {
    expect(
      validateTwilioSignature({ signatureHeader: undefined, url, params, authToken: token }),
    ).toBe(false);
  });

  it("rejects when the body has been tampered with", () => {
    const sig = expectedSignature();
    const tampered = { ...params, Body: "REFUND ME $500" };
    expect(
      validateTwilioSignature({ signatureHeader: sig, url, params: tampered, authToken: token }),
    ).toBe(false);
  });

  it("rejects when the auth token is wrong", () => {
    const sig = expectedSignature();
    expect(
      validateTwilioSignature({
        signatureHeader: sig,
        url,
        params,
        authToken: "wrong-token",
      }),
    ).toBe(false);
  });

  it("rejects when the URL Twilio called differs (e.g. wrong proxy host)", () => {
    const sig = expectedSignature();
    expect(
      validateTwilioSignature({
        signatureHeader: sig,
        url: "https://attacker.example.com/api/twilio/sms",
        params,
        authToken: token,
      }),
    ).toBe(false);
  });
});
