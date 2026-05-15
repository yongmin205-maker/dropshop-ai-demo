/// <reference types="vitest" />

/**
 * Pure-logic tests for findCustomerByPhoneOrName.
 *
 * Why no integration test against real posCustomers rows: that surface
 * needs a live MySQL with the `mysql.time_zone_*` tables loaded for the
 * aggregate tools to share fixtures with. Phase 25c keeps the DB
 * integration on the deployed side and pins the *classification*
 * logic here. The SQL itself is shape-trivial (one LIKE per branch)
 * so a mis-shape would surface immediately on the deployed sandbox.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({
  getDb: vi.fn(async () => null), // null = "no DB available", tool returns
  // safe-empty per its own contract.
}));

import {
  classifyQuery,
  digitsOnly,
  findCustomerByPhoneOrName,
} from "./findCustomer";

describe("findCustomer.classifyQuery — routes queries into phone/email/name", () => {
  it("treats explicit E.164 as phone", () => {
    expect(classifyQuery("+14155551234")).toBe("phone");
  });
  it("treats US-formatted phone as phone", () => {
    expect(classifyQuery("(415) 555-1234")).toBe("phone");
  });
  it("treats hyphenated phone as phone", () => {
    expect(classifyQuery("415-555-1234")).toBe("phone");
  });
  it("treats anything with @ as email (preempts the phone rule)", () => {
    expect(classifyQuery("hi@dropshop.test")).toBe("email");
  });
  it("treats plain names as name (default)", () => {
    expect(classifyQuery("Andrew Kim")).toBe("name");
  });
  it("treats Korean names as name", () => {
    expect(classifyQuery("김민지")).toBe("name");
  });
  it("treats short numerics as name (too short to be a phone)", () => {
    // Phone heuristic requires ≥6 chars after the first digit; "123" is
    // not a phone.
    expect(classifyQuery("123")).toBe("name");
  });
});

describe("findCustomer.digitsOnly — normalizes any phone surface to digits", () => {
  it("strips spaces, dashes, parens, plus", () => {
    expect(digitsOnly("+1 (415) 555-1234")).toBe("14155551234");
  });
  it("returns empty for non-numeric input", () => {
    expect(digitsOnly("Andrew")).toBe("");
  });
});

describe("findCustomer — tool contract with no DB", () => {
  it("returns safe-empty when getDb is null", async () => {
    const r = await findCustomerByPhoneOrName.invoke(
      { query: "Andrew" },
      { source: "cleancloud", freshnessHint: "test", now: new Date() },
    );
    expect(r.customers).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("inputSchema rejects empty string", () => {
    const r = findCustomerByPhoneOrName.inputSchema.safeParse({ query: "" });
    expect(r.success).toBe(false);
  });

  it("description references Korean keywords the Planner LLM keys on", () => {
    expect(findCustomerByPhoneOrName.description).toMatch(/전화번호|이름|이메일/);
  });
});
