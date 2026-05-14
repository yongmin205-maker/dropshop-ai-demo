import { describe, expect, it } from "vitest";
import {
  mapCleanCloudOrderStatus,
  mapCleanCloudPaymentType,
} from "./statusMap";

describe("mapCleanCloudOrderStatus", () => {
  it("maps documented numeric codes to the neutral enum", () => {
    // From the docs: 0=Cleaning, 1=Ready, 2=Completed, 4=Awaiting Pickup,
    // 5=Detailing. Detailing is treated as a sub-stage of cleaning; awaiting
    // pickup collapses to ready in Stage 0 (see statusMap.ts header comment).
    expect(mapCleanCloudOrderStatus(0)).toBe("cleaning");
    expect(mapCleanCloudOrderStatus(1)).toBe("ready");
    expect(mapCleanCloudOrderStatus(2)).toBe("completed");
    expect(mapCleanCloudOrderStatus(4)).toBe("ready");
    expect(mapCleanCloudOrderStatus(5)).toBe("cleaning");
  });

  it("accepts string-typed numeric codes (JSON round-trip)", () => {
    expect(mapCleanCloudOrderStatus("0")).toBe("cleaning");
    expect(mapCleanCloudOrderStatus("4")).toBe("ready");
  });

  it("falls back to 'unknown' for unrecognized values", () => {
    expect(mapCleanCloudOrderStatus(99)).toBe("unknown");
    expect(mapCleanCloudOrderStatus(null)).toBe("unknown");
    expect(mapCleanCloudOrderStatus(undefined)).toBe("unknown");
    expect(mapCleanCloudOrderStatus("garbage")).toBe("unknown");
    expect(mapCleanCloudOrderStatus({})).toBe("unknown");
  });
});

describe("mapCleanCloudPaymentType", () => {
  it("maps documented payment-type codes", () => {
    expect(mapCleanCloudPaymentType(0)).toBe("cash");
    expect(mapCleanCloudPaymentType(1)).toBe("card");
    expect(mapCleanCloudPaymentType(2)).toBe("credit");
    expect(mapCleanCloudPaymentType(3)).toBe("loyalty_points");
    expect(mapCleanCloudPaymentType(4)).toBe("stripe");
    expect(mapCleanCloudPaymentType(5)).toBe("square");
  });

  it("returns 'unknown' for null/undefined and 'other' for unrecognized numbers", () => {
    expect(mapCleanCloudPaymentType(null)).toBe("unknown");
    expect(mapCleanCloudPaymentType(undefined)).toBe("unknown");
    expect(mapCleanCloudPaymentType(99)).toBe("other");
  });

  it("accepts string-typed numeric codes", () => {
    expect(mapCleanCloudPaymentType("4")).toBe("stripe");
    expect(mapCleanCloudPaymentType("0")).toBe("cash");
  });
});
