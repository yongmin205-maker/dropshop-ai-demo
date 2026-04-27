import { describe, it, expect } from "vitest";
import { intentTone } from "./intentTone";

/**
 * intentTone — pure-function smoke tests.
 *
 * Locks the badge palette so a future refactor can't quietly desaturate
 * Critical Escalation (rose) into something that no longer screams "this
 * is a 911 case". The function is the single source of truth for intent
 * colors after CODE_AUDIT P1, so a change here is a deliberate brand call.
 */
describe("intentTone", () => {
  it("returns the rose palette for Critical Escalation", () => {
    const cls = intentTone("Critical Escalation");
    expect(cls).toContain("rose");
    expect(cls).toContain("border-");
    expect(cls).toContain("text-");
    expect(cls).toContain("bg-");
  });

  it("returns distinct palettes per known intent", () => {
    const palettes = new Set([
      intentTone("Critical Escalation"),
      intentTone("Pickup Request"),
      intentTone("ETA/Order Status"),
      intentTone("Alteration Quote"),
      intentTone("Membership & Pricing"),
    ]);
    expect(palettes.size).toBe(5);
  });

  it("falls back to a neutral palette for unknown / null / undefined", () => {
    const fallback = intentTone(undefined);
    expect(fallback).toBe(intentTone(null));
    expect(fallback).toBe(intentTone("something the AI invented"));
    expect(fallback).toContain("muted-foreground");
  });

  it("returns a non-empty string for every input shape", () => {
    for (const v of [
      "Critical Escalation",
      "Pickup Request",
      "ETA/Order Status",
      "Alteration Quote",
      "Membership & Pricing",
      "weird",
      "",
      null,
      undefined,
    ] as const) {
      expect(intentTone(v).length).toBeGreaterThan(0);
    }
  });
});
