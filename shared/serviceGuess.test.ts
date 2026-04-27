import { describe, it, expect } from "vitest";
import { guessSalonService, SALON_SERVICE_KEYWORDS } from "./serviceGuess";

/**
 * serviceGuess — single source of truth shared between the salon agent on
 * the server and the optimistic Booking Draft preview on the client.
 *
 * Tests below lock down the precedence rules that prevent the most common
 * miscategorizations seen in real salon SMS traffic:
 *   • "balayage" must beat "color" (balayage uses bleach + tone, totally
 *     different price tier — caught here so the optimistic UI doesn't
 *     mis-label the booking before the LLM responds).
 *   • "perm" must beat "cut" because "magic perm" mentions can also include
 *     the words "style" or "trim" in the same SMS body.
 */
describe("guessSalonService", () => {
  it("returns null for empty or unrelated text", () => {
    expect(guessSalonService("")).toBeNull();
    expect(guessSalonService("hi can you call me back later")).toBeNull();
  });

  it("matches each canonical service keyword", () => {
    expect(guessSalonService("I want a haircut")).toBe("cut");
    expect(guessSalonService("any time for a perm tomorrow?")).toBe("perm");
    expect(guessSalonService("single process color touch up")).toBe("color");
    expect(guessSalonService("can I get balayage highlights")).toBe("balayage");
    expect(guessSalonService("just manicure please")).toBe("manicure");
    expect(guessSalonService("pedi at 3pm?")).toBe("pedicure");
    expect(guessSalonService("scalp treatment")).toBe("hairspa");
  });

  it("prefers balayage over color when both keywords appear", () => {
    expect(guessSalonService("I want balayage and a color touch up")).toBe(
      "balayage",
    );
  });

  it("prefers perm over cut when both keywords appear", () => {
    expect(guessSalonService("can I get a magic perm and a quick trim")).toBe(
      "perm",
    );
  });

  it("is case-insensitive", () => {
    expect(guessSalonService("PEDICURE PLEASE")).toBe("pedicure");
    expect(guessSalonService("BLOW dry?")).toBe("cut");
  });

  it("exposes the keyword table for external inspection", () => {
    expect(Object.keys(SALON_SERVICE_KEYWORDS)).toEqual(
      expect.arrayContaining([
        "cut",
        "perm",
        "color",
        "balayage",
        "manicure",
        "pedicure",
        "hairspa",
      ]),
    );
  });
});
