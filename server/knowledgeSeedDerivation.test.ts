import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lock-in test: the derived knowledge chunks for pricing + membership MUST
 * be generated from the constants in `mockCleanCloud.ts` (single source of
 * truth), not duplicated as hand-written strings.
 *
 * If anyone re-introduces hard-coded prices like "Shirt $4.50" or
 * "Silver: $29/mo" in `knowledgeSeed.ts`, this test fails — that was exactly
 * the drift hazard we removed in Sprint 3.
 */
describe("knowledgeSeed source-of-truth contract", () => {
  const knowledgeSeedPath = join(import.meta.dirname, "knowledgeSeed.ts");
  const src = readFileSync(knowledgeSeedPath, "utf8");

  it("imports MEMBERSHIP_INFO and SEED_PRICES from mockCleanCloud", () => {
    expect(src).toMatch(/from "\.\/mockCleanCloud"/);
    expect(src).toMatch(/MEMBERSHIP_INFO/);
    expect(src).toMatch(/SEED_PRICES/);
  });

  it("derives at least one '(POS, derived)' chunk for pricing and membership", () => {
    expect(src).toMatch(/Dry Cleaning Price List \(POS, derived\)/);
    expect(src).toMatch(/Alteration Price List \(POS, derived\)/);
    expect(src).toMatch(/Membership Tiers \(POS, derived\)/);
  });

  it("does NOT contain the legacy hardcoded price/tier strings that drifted", () => {
    expect(src).not.toMatch(/Shirt \$4\.50/);
    expect(src).not.toMatch(/Silver: \$29\/mo/);
    expect(src).not.toMatch(/Gold: \$59\/mo/);
  });
});
