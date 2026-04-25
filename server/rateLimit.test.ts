import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetRateLimitState,
  callerIp,
  noteLlmTokenUsage,
  rateLimit,
} from "./rateLimit";

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimitState());
  afterEach(() => __resetRateLimitState());

  it("allows traffic up to the configured max within the window", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(() =>
        rateLimit({ key: "k", max: 5, windowMs: 60_000, label: "test" }),
      ).not.toThrow();
    }
  });

  it("throws TOO_MANY_REQUESTS once max is exceeded", () => {
    for (let i = 0; i < 3; i += 1) {
      rateLimit({ key: "k2", max: 3, windowMs: 60_000 });
    }
    let caught: unknown;
    try {
      rateLimit({ key: "k2", max: 3, windowMs: 60_000, label: "k2" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("TOO_MANY_REQUESTS");
    expect((caught as TRPCError).message).toContain("k2");
  });

  it("isolates buckets by key", () => {
    rateLimit({ key: "alice", max: 1, windowMs: 60_000 });
    expect(() =>
      rateLimit({ key: "bob", max: 1, windowMs: 60_000 }),
    ).not.toThrow();
    expect(() =>
      rateLimit({ key: "alice", max: 1, windowMs: 60_000 }),
    ).toThrow();
  });
});

describe("noteLlmTokenUsage", () => {
  beforeEach(() => __resetRateLimitState());
  afterEach(() => __resetRateLimitState());

  it("permits usage under the daily cap", () => {
    expect(() => noteLlmTokenUsage(1_000, 10_000)).not.toThrow();
    expect(() => noteLlmTokenUsage(8_999, 10_000)).not.toThrow();
  });

  it("blocks usage that would exceed the daily cap", () => {
    noteLlmTokenUsage(8_000, 10_000);
    expect(() => noteLlmTokenUsage(3_000, 10_000)).toThrow(
      /Daily LLM token budget reached/,
    );
  });
});

describe("callerIp", () => {
  it("prefers the first entry in X-Forwarded-For when present", () => {
    expect(
      callerIp({
        ip: "127.0.0.1",
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      }),
    ).toBe("1.2.3.4");
  });

  it("falls back to req.ip when no proxy header is present", () => {
    expect(callerIp({ ip: "10.0.0.5", headers: {} })).toBe("10.0.0.5");
  });

  it("returns 'unknown' when nothing is available", () => {
    expect(callerIp({ headers: {} })).toBe("unknown");
  });
});
