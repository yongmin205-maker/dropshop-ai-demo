import { describe, expect, it } from "vitest";
import { maskAddress, maskPhone, redactPII, redactText } from "./pii";

describe("pii.maskPhone", () => {
  it("masks E.164 phone numbers down to last four digits", () => {
    expect(maskPhone("+15550101001")).toBe("+•••••1001");
    expect(maskPhone("+447700900123")).toBe("+•••••0123");
  });
  it("leaves non-E.164 strings untouched (defensive — caller is wrong)", () => {
    expect(maskPhone("Marie Pierce")).toBe("Marie Pierce");
    expect(maskPhone("")).toBe("");
  });
});

describe("pii.maskAddress", () => {
  it("strips street + number, keeps city/state suffix", () => {
    expect(maskAddress("975 Park Ave, Apt 14D, New York, NY")).toBe(
      "[address redacted], New York, NY",
    );
  });
  it("falls back to a flat redaction marker when there is no comma split", () => {
    expect(maskAddress("123 Main")).toBe("[address redacted]");
  });
});

describe("pii.redactText", () => {
  it("masks E.164 numbers embedded in free text", () => {
    expect(redactText("Call me at +15550101001 today")).toBe(
      "Call me at +•••••1001 today",
    );
  });
  it("masks NA-style phone numbers", () => {
    expect(redactText("Tel 212-555-1234 please")).toBe(
      "Tel •••-•••-•••• please",
    );
  });
  it("masks email addresses", () => {
    expect(redactText("write to alice@example.com if needed")).toBe(
      "write to [email redacted] if needed",
    );
  });
  it("clips to maxLen and appends ellipsis", () => {
    const long = "x".repeat(500);
    const out = redactText(long, 100);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(101);
  });
});

describe("pii.redactPII (object walker)", () => {
  it("redacts known PII keys in nested structures", () => {
    const detail = {
      phone: "+15550101001",
      customer: {
        address: "975 Park Ave, Apt 14D, New York, NY",
        name: "Marie",
      },
      reply: "Hi Marie, your order is ready. Reach me at +15550199999.",
      orders: [
        { customerPhone: "+15550101001", body: "where is my order?" },
      ],
    };
    const out = redactPII(detail) as typeof detail;
    expect(out.phone).toBe("+•••••1001");
    expect(out.customer.address).toBe("[address redacted], New York, NY");
    expect(out.customer.name).toBe("Marie"); // name is NOT considered PII here (already in mockCustomers)
    expect(out.reply).toContain("+•••••9999");
    expect(out.orders[0].customerPhone).toBe("+•••••1001");
  });
  it("passes null and primitives through unchanged", () => {
    expect(redactPII(null)).toBe(null);
    expect(redactPII(42)).toBe(42);
    expect(redactPII(true)).toBe(true);
  });
  it("walks into arrays of strings", () => {
    expect(redactPII(["+15550101001", "ok"])).toEqual(["+•••••1001", "ok"]);
  });
});
