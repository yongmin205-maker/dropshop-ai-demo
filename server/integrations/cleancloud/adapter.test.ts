import { describe, expect, it } from "vitest";
import {
  adaptCustomer,
  adaptOrder,
  adaptProduct,
  extractPaymentsFromOrder,
  normalizeUSPhoneToE164,
  parseCleanCloudTimestamp,
} from "./adapter";

describe("normalizeUSPhoneToE164", () => {
  it("normalizes 10-digit US numbers to +1XXXXXXXXXX", () => {
    expect(normalizeUSPhoneToE164("212-555-0100")).toBe("+12125550100");
    expect(normalizeUSPhoneToE164("(212) 555 0100")).toBe("+12125550100");
    expect(normalizeUSPhoneToE164("2125550100")).toBe("+12125550100");
  });

  it("accepts a leading 1 prefix", () => {
    expect(normalizeUSPhoneToE164("1-212-555-0100")).toBe("+12125550100");
    expect(normalizeUSPhoneToE164("12125550100")).toBe("+12125550100");
  });

  it("returns null for malformed inputs", () => {
    expect(normalizeUSPhoneToE164("555-0100")).toBeNull();
    expect(normalizeUSPhoneToE164("")).toBeNull();
    expect(normalizeUSPhoneToE164(null)).toBeNull();
    expect(normalizeUSPhoneToE164(undefined)).toBeNull();
    expect(normalizeUSPhoneToE164(2125550100 as unknown)).toBeNull();
  });
});

describe("parseCleanCloudTimestamp", () => {
  it("parses Unix-seconds numbers", () => {
    const d = parseCleanCloudTimestamp(1714579200);
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe("2024-05-01T16:00:00.000Z");
  });

  it("parses Unix-millis numbers", () => {
    const d = parseCleanCloudTimestamp(1714579200000);
    expect(d!.toISOString()).toBe("2024-05-01T16:00:00.000Z");
  });

  it("parses 'YYYY-MM-DD HH:MM:SS' as UTC", () => {
    const d = parseCleanCloudTimestamp("2026-05-14 10:30:45");
    expect(d!.toISOString()).toBe("2026-05-14T10:30:45.000Z");
  });

  it("parses date-only strings as midnight UTC", () => {
    const d = parseCleanCloudTimestamp("2026-05-14");
    expect(d!.toISOString()).toBe("2026-05-14T00:00:00.000Z");
  });

  it("returns null for empty / zero / malformed values", () => {
    expect(parseCleanCloudTimestamp(null)).toBeNull();
    expect(parseCleanCloudTimestamp(undefined)).toBeNull();
    expect(parseCleanCloudTimestamp("")).toBeNull();
    expect(parseCleanCloudTimestamp("0")).toBeNull();
    expect(parseCleanCloudTimestamp(0)).toBeNull();
    expect(parseCleanCloudTimestamp("0000-00-00")).toBeNull();
    expect(parseCleanCloudTimestamp("not a date")).toBeNull();
  });
});

describe("adaptCustomer", () => {
  it("maps a fully-populated customer to a vendor-neutral row", () => {
    const row = adaptCustomer({
      customerID: 42,
      customerName: "Alice",
      customerTel: "(212) 555-0100",
      customerEmail: "alice@example.com",
      customerAddress: "123 Broadway, NY",
      customerNotes: "VIP",
      marketingOptIn: 1,
      loyaltyPoints: 50,
      credit: 12.5,
    });
    expect(row).not.toBeNull();
    expect(row!.source).toBe("cleancloud");
    expect(row!.externalId).toBe("42");
    expect(row!.name).toBe("Alice");
    expect(row!.phoneE164).toBe("+12125550100");
    expect(row!.phoneRaw).toBe("(212) 555-0100");
    expect(row!.email).toBe("alice@example.com");
    expect(row!.marketingOptIn).toBe(1);
    expect(row!.loyaltyPoints).toBe(50);
    expect(row!.creditCents).toBe(1250);
    expect(row!.rawPayload).toBeDefined();
  });

  it("returns null when externalId is missing", () => {
    expect(adaptCustomer({})).toBeNull();
    expect(adaptCustomer({ customerID: "" })).toBeNull();
  });

  it("preserves raw phone when normalization fails", () => {
    const row = adaptCustomer({
      customerID: 1,
      customerName: "Bob",
      customerTel: "555-XXXX-test",
    });
    expect(row!.phoneE164).toBeNull();
    expect(row!.phoneRaw).toBe("555-XXXX-test");
  });

  it("defaults marketingOptIn / loyaltyPoints / creditCents to 0 when missing", () => {
    const row = adaptCustomer({ customerID: "9", customerName: "C" });
    expect(row!.marketingOptIn).toBe(0);
    expect(row!.loyaltyPoints).toBe(0);
    expect(row!.creditCents).toBe(0);
  });
});

describe("adaptOrder", () => {
  it("maps order with embedded products into itemsSummary", () => {
    const row = adaptOrder({
      orderID: "100",
      customerID: 42,
      status: 0,
      finalTotal: 24.5,
      paid: 1,
      completed: 0,
      express: 1,
      storeDropOffDate: "2026-05-14 10:00:00",
      pickupDate: "2026-05-16",
      pickupStart: "14:30",
      orderNotes: "Light starch",
      products: [
        { id: "p1", name: "Shirt", price: 6.5, quantity: 2 },
        { id: "p2", name: "Pants", price: 11.5, quantity: 1 },
      ],
    });
    expect(row).not.toBeNull();
    expect(row!.externalId).toBe("100");
    expect(row!.customerExternalId).toBe("42");
    expect(row!.status).toBe("cleaning");
    expect(row!.sourceStatusRaw).toBe("0");
    expect(row!.finalTotalCents).toBe(2450);
    expect(row!.paid).toBe(1);
    expect(row!.completed).toBe(0);
    expect(row!.express).toBe(1);
    expect(row!.placedAt!.toISOString()).toBe("2026-05-14T10:00:00.000Z");
    // pickup window was 2026-05-16 + 14:30 → UTC midnight + 14:30
    expect(row!.pickupAt!.toISOString()).toBe("2026-05-16T14:30:00.000Z");
    expect(row!.notes).toBe("Light starch");
    expect(Array.isArray(row!.itemsSummary)).toBe(true);
    expect((row!.itemsSummary as unknown[]).length).toBe(2);
  });

  it("falls back to date-only pickupAt when pickupStart is missing", () => {
    const row = adaptOrder({
      orderID: 1,
      pickupDate: "2026-05-20",
    });
    expect(row!.pickupAt!.toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("returns null when orderID is missing", () => {
    expect(adaptOrder({})).toBeNull();
  });
});

describe("extractPaymentsFromOrder", () => {
  it("fans out an order.payments[] array into multiple payment rows", () => {
    const rows = extractPaymentsFromOrder({
      orderID: "200",
      customerID: 42,
      // CleanCloud-style embedded payments field (not in the typed CleanCloudOrder
      // surface, but the adapter reads it via rawPayload).
      payments: [
        {
          paymentID: "pay-1",
          paymentType: 1,
          paymentAmount: 10,
          paymentDate: "2026-05-14 11:00:00",
        },
        {
          paymentID: "pay-2",
          paymentType: 4,
          paymentAmount: 5.5,
          paymentDate: "2026-05-14 11:00:00",
          refunded: 1,
        },
      ],
    } as unknown as Parameters<typeof extractPaymentsFromOrder>[0]);
    expect(rows.length).toBe(2);
    expect(rows[0].externalId).toBe("pay-1");
    expect(rows[0].amountCents).toBe(1000);
    expect(rows[0].type).toBe("card");
    expect(rows[0].refunded).toBe(0);
    expect(rows[1].externalId).toBe("pay-2");
    expect(rows[1].amountCents).toBe(550);
    expect(rows[1].type).toBe("stripe");
    expect(rows[1].refunded).toBe(1);
  });

  it("synthesizes a single implicit payment when paid=1 and no payments[]", () => {
    const rows = extractPaymentsFromOrder({
      orderID: 300,
      customerID: 7,
      paid: 1,
      finalTotal: 18,
      paymentType: 0,
      storeDropOffDate: "2026-05-13 09:30:00",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].externalId).toBe("order-300-implicit");
    expect(rows[0].amountCents).toBe(1800);
    expect(rows[0].type).toBe("cash");
    expect(rows[0].paidAt!.toISOString()).toBe("2026-05-13T09:30:00.000Z");
  });

  it("returns no rows for unpaid orders without explicit payments", () => {
    const rows = extractPaymentsFromOrder({
      orderID: 400,
      paid: 0,
      finalTotal: 15,
    });
    expect(rows.length).toBe(0);
  });
});

describe("adaptProduct", () => {
  it("maps a product including price-list scope", () => {
    const row = adaptProduct(
      {
        productID: "p-1",
        name: "Mens Shirt",
        category: "Drycleaning",
        price: 4.5,
        priceListID: "pl-A",
      },
      "pl-A",
    );
    expect(row).not.toBeNull();
    expect(row!.externalId).toBe("p-1");
    expect(row!.name).toBe("Mens Shirt");
    expect(row!.category).toBe("Drycleaning");
    expect(row!.priceCents).toBe(450);
    expect(row!.priceListExternalId).toBe("pl-A");
  });

  it("returns null when productID is missing", () => {
    expect(adaptProduct({})).toBeNull();
  });
});
