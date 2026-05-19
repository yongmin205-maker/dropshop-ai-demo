import { describe, expect, it } from "vitest";
import { compareTimeWindows, resolveWindows } from "./compare";

const MAY_FROM = "2026-05-01T00:00:00.000Z";
const MAY_18 = "2026-05-19T00:00:00.000Z"; // exclusive end → covers 5/1..5/18 (18 days)
const APR_FROM = "2026-04-01T00:00:00.000Z";
const APR_FULL_END = "2026-05-01T00:00:00.000Z";
const APR_18 = "2026-04-19T00:00:00.000Z"; // matches 18-day span for fair-pace

describe("resolveWindows", () => {
  it("returns both windows unchanged when mode is as-given", () => {
    const r = resolveWindows(
      { from: APR_FROM, to: APR_FULL_END },
      { from: MAY_FROM, to: MAY_18 },
      "as-given",
    );
    expect(r.truncated).toBe(false);
    expect(r.effectiveWindowA.to).toBe(APR_FULL_END);
    expect(r.effectiveWindowB.to).toBe(MAY_18);
  });

  it("returns both unchanged when windows already span equal duration", () => {
    const r = resolveWindows(
      { from: APR_FROM, to: APR_18 },
      { from: MAY_FROM, to: MAY_18 },
      "fair-pace",
    );
    expect(r.truncated).toBe(false);
    expect(r.spanDays).toBe(18);
  });

  it("truncates the longer window down to the shorter span in fair-pace mode", () => {
    // windowA is 30 days (Apr full), windowB is 18 days (May MTD).
    const r = resolveWindows(
      { from: APR_FROM, to: APR_FULL_END },
      { from: MAY_FROM, to: MAY_18 },
      "fair-pace",
    );
    expect(r.truncated).toBe(true);
    expect(r.spanDays).toBe(18);
    expect(r.effectiveWindowA.from).toBe(APR_FROM);
    // windowA gets cut to 18 days starting Apr 1 → ends Apr 19.
    expect(r.effectiveWindowA.to).toBe(APR_18);
    expect(r.effectiveWindowB.from).toBe(MAY_FROM);
    expect(r.effectiveWindowB.to).toBe(MAY_18);
  });

  it("anchors each truncation at its own from, not at the other window", () => {
    const r = resolveWindows(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" }, // 31 days
      { from: "2026-03-01T00:00:00.000Z", to: "2026-03-11T00:00:00.000Z" }, // 10 days
      "fair-pace",
    );
    expect(r.truncated).toBe(true);
    expect(r.spanDays).toBe(10);
    expect(r.effectiveWindowA.from).toBe("2026-01-01T00:00:00.000Z");
    expect(r.effectiveWindowA.to).toBe("2026-01-11T00:00:00.000Z");
    expect(r.effectiveWindowB.from).toBe("2026-03-01T00:00:00.000Z");
    expect(r.effectiveWindowB.to).toBe("2026-03-11T00:00:00.000Z");
  });
});

describe("compareTimeWindows tool contract", () => {
  it("exposes mode in argsExample so the planner has a fair-pace template", () => {
    expect(compareTimeWindows.argsExample).toMatchObject({
      mode: "fair-pace",
      metric: "revenue",
    });
  });

  it("description explicitly tells the planner to use fair-pace for in-progress windows", () => {
    expect(compareTimeWindows.description).toMatch(/fair-pace/);
    expect(compareTimeWindows.description).toMatch(/지난달 vs 이번달/);
  });

  it("inputSchema accepts mode optionally and defaults to as-given when omitted", () => {
    const parsed = compareTimeWindows.inputSchema.parse({
      windowA: { from: APR_FROM, to: APR_FULL_END },
      windowB: { from: MAY_FROM, to: MAY_18 },
      metric: "revenue",
    });
    // either undefined or "as-given" — both are acceptable since field is optional with default.
    expect(parsed.mode === undefined || parsed.mode === "as-given").toBe(true);
  });

  it("inputSchema rejects unknown mode values", () => {
    const bad = compareTimeWindows.inputSchema.safeParse({
      windowA: { from: APR_FROM, to: APR_FULL_END },
      windowB: { from: MAY_FROM, to: MAY_18 },
      metric: "revenue",
      mode: "naive",
    });
    expect(bad.success).toBe(false);
  });
});
