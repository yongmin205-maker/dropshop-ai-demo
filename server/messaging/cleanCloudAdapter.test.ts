/**
 * Hermetic tests for cleanCloudAdapter.ts pure helpers.
 *
 * The translation layer is the most error-prone seam in Phase 23 — a wrong
 * phone normalization or status code map means the AI agent silently calls
 * the wrong customer or claims an order is ready when it isn't. We pin the
 * mapping rules here so refactors can't drift.
 *
 * We test the adapter helpers in isolation. The transport+network paths
 * already have their own coverage in cleanCloudTransport.test.ts; here we
 * focus on translation contract only.
 */

import { describe, expect, it } from "vitest";
import { decodeStatus, normalizeE164 } from "./cleanCloudAdapter";

describe("cleanCloudAdapter.normalizeE164", () => {
  it("prepends +1 to a 10-digit US number", () => {
    expect(normalizeE164("5551234567")).toBe("+15551234567");
  });

  it("strips formatting from a (555) 123-4567 style number", () => {
    expect(normalizeE164("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeE164("555-123-4567")).toBe("+15551234567");
    expect(normalizeE164("555.123.4567")).toBe("+15551234567");
  });

  it("preserves an 11-digit number starting with 1", () => {
    expect(normalizeE164("15551234567")).toBe("+15551234567");
  });

  it("returns empty string for empty/null/undefined input", () => {
    expect(normalizeE164("")).toBe("");
    expect(normalizeE164(null)).toBe("");
    expect(normalizeE164(undefined)).toBe("");
  });

  it("returns empty string when no digits are present at all", () => {
    expect(normalizeE164("---")).toBe("");
    expect(normalizeE164("abcdef")).toBe("");
  });

  it("falls back to +-prefix best-effort for unusual lengths", () => {
    // 12 digits — could be international (e.g., UK without leading 0).
    // We don't try to guess the country code here; we just keep the data.
    expect(normalizeE164("447911123456")).toBe("+447911123456");
  });

  it("is idempotent: normalizing twice yields the same result", () => {
    const once = normalizeE164("(555) 123-4567");
    const twice = normalizeE164(once);
    expect(twice).toBe(once);
  });
});

describe("cleanCloudAdapter.decodeStatus", () => {
  it("maps 0 to Cleaning", () => {
    expect(decodeStatus(0)).toBe("Cleaning");
  });

  it("maps 1 to Ready to Deliver", () => {
    expect(decodeStatus(1)).toBe("Ready to Deliver");
  });

  it("maps 2 to Completed", () => {
    expect(decodeStatus(2)).toBe("Completed");
  });

  it("maps 4 to Awaiting Pickup", () => {
    expect(decodeStatus(4)).toBe("Awaiting Pickup");
  });

  it("collapses 5 (Detailing) into Cleaning so customers don't see internal jargon", () => {
    expect(decodeStatus(5)).toBe("Cleaning");
  });

  it("defaults unknown numeric codes to the safest value (Cleaning)", () => {
    expect(decodeStatus(99)).toBe("Cleaning");
    expect(decodeStatus(-1)).toBe("Cleaning");
  });

  it("handles undefined/missing status gracefully", () => {
    expect(decodeStatus(undefined)).toBe("Cleaning");
  });
});
