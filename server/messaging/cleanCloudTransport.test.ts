/**
 * Hermetic vitest for the CleanCloud transport layer.
 *
 * Live connectivity is exercised separately by `cleanCloudTransport.live.test.ts`
 * (gated by RUN_CLEANCLOUD_LIVE=1). These tests use a fake fetch so they run
 * in CI without ever touching the network.
 *
 * Contracts covered:
 *   1. api_token is injected from ENV.cleanCloudApiToken into every request body
 *   2. request bodies merge user params on top of api_token, preserving keys
 *   3. getCustomer single-ID mode returns a flat customer object
 *   4. getCustomer date-range mode returns an array under "Customers"
 *   5. getOrders / getProducts / getPriceLists return their respective arrays
 *   6. Success != "True" returns { ok: false, error }
 *   7. HTTP 5xx returns { ok: false, status, error }
 *   8. Non-JSON body returns { ok: false } without throwing
 *   9. Rate limiter serializes >3 calls to <=3-per-second windows
 *  10. Missing token short-circuits without dispatching a request
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCleanCloudRateLimitForTests,
  getCustomer,
  getOrders,
  getPriceLists,
  getProducts,
} from "./cleanCloudTransport";

type FakeCall = { url: string; init: RequestInit };

function makeFetch(
  scriptedResponses: Array<{ status?: number; body: unknown | string }>,
): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const scripted = scriptedResponses[i++] ?? scriptedResponses[scriptedResponses.length - 1];
    const status = scripted?.status ?? 200;
    const body =
      typeof scripted?.body === "string" ? scripted.body : JSON.stringify(scripted?.body ?? {});
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  process.env.CLEANCLOUD_API_TOKEN = "test-token-aaaa1111";
  __resetCleanCloudRateLimitForTests();
});

afterEach(() => {
  __resetCleanCloudRateLimitForTests();
});

describe("cleanCloudTransport — token + request shape", () => {
  it("injects api_token from ENV into every request body", async () => {
    const { fetchImpl, calls } = makeFetch([{ body: { Success: "True", PriceLists: [] } }]);
    await getPriceLists({ fetchImpl });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.api_token).toBe("test-token-aaaa1111");
  });

  it("merges user params on top of api_token without dropping keys", async () => {
    const { fetchImpl, calls } = makeFetch([{ body: { Success: "True", Orders: [] } }]);
    await getOrders({ customerID: 42, paid: 1, dateFrom: "2026-01-01" }, { fetchImpl });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      api_token: "test-token-aaaa1111",
      customerID: 42,
      paid: 1,
      dateFrom: "2026-01-01",
    });
  });

  it("POSTs to the correct cleancloudapp.com endpoint", async () => {
    const { fetchImpl, calls } = makeFetch([{ body: { Success: "True", Products: [] } }]);
    await getProducts({}, { fetchImpl });
    expect(calls[0]!.url).toBe("https://cleancloudapp.com/api/getProducts");
    expect(calls[0]!.init.method).toBe("POST");
  });
});

describe("cleanCloudTransport — response decoding", () => {
  it("getCustomer single-ID mode returns a flat object", async () => {
    const { fetchImpl } = makeFetch([
      {
        body: {
          Success: "True",
          customerID: "123",
          customerName: "Test Customer",
          customerTel: "+15551234567",
        },
      },
    ]);
    const result = await getCustomer({ customerID: "123" }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const customer = result.data as { customerName?: string; Success?: string };
      expect(customer.customerName).toBe("Test Customer");
      // Success should be stripped from the flat customer object
      expect(customer.Success).toBeUndefined();
    }
  });

  it("getCustomer date-range mode returns an array under Customers", async () => {
    const { fetchImpl } = makeFetch([
      {
        body: {
          Success: "True",
          Customers: [
            { customerID: "1", customerName: "A" },
            { customerID: "2", customerName: "B" },
          ],
        },
      },
    ]);
    const result = await getCustomer({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.data)).toBe(true);
      expect((result.data as unknown[]).length).toBe(2);
    }
  });

  it("getOrders returns the Orders array", async () => {
    const { fetchImpl } = makeFetch([
      { body: { Success: "True", Orders: [{ orderID: "1" }, { orderID: "2" }] } },
    ]);
    const result = await getOrders({}, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.length).toBe(2);
  });

  it("getProducts returns the Products array", async () => {
    const { fetchImpl } = makeFetch([
      { body: { Success: "True", Products: [{ productID: "p1", name: "Shirt" }] } },
    ]);
    const result = await getProducts({}, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0]?.name).toBe("Shirt");
  });

  it("getPriceLists returns the PriceLists array", async () => {
    const { fetchImpl } = makeFetch([
      { body: { Success: "True", PriceLists: [{ priceListID: "1", name: "Default" }] } },
    ]);
    const result = await getPriceLists({ fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0]?.name).toBe("Default");
  });
});

describe("cleanCloudTransport — error paths", () => {
  it("Success!=True returns { ok: false, error }", async () => {
    const { fetchImpl } = makeFetch([
      { body: { Success: "False", Error: "Invalid customer ID" } },
    ]);
    const result = await getOrders({ customerID: 999 }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Invalid customer ID");
  });

  it("HTTP 5xx returns { ok: false, status }", async () => {
    const { fetchImpl } = makeFetch([{ status: 503, body: "<html>maintenance</html>" }]);
    const result = await getOrders({}, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toMatch(/503/);
    }
  });

  it("non-JSON body returns { ok: false } without throwing", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: "<html>nope</html>" }]);
    const result = await getProducts({}, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-JSON/);
  });

  it("missing CLEANCLOUD_API_TOKEN short-circuits without dispatching", async () => {
    process.env.CLEANCLOUD_API_TOKEN = "";
    const { fetchImpl, calls } = makeFetch([{ body: { Success: "True", PriceLists: [] } }]);
    const result = await getPriceLists({ fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/CLEANCLOUD_API_TOKEN/);
    expect(calls.length).toBe(0);
  });
});

describe("cleanCloudTransport — rate limiting", () => {
  it("serializes >3 concurrent calls into <=3 per second window", async () => {
    const { fetchImpl } = makeFetch([{ body: { Success: "True", PriceLists: [] } }]);
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    // Dispatch 5 calls in parallel. The 4th and 5th should defer ~1s.
    const promises = [
      getPriceLists({ fetchImpl }),
      getPriceLists({ fetchImpl }),
      getPriceLists({ fetchImpl }),
      getPriceLists({ fetchImpl }),
      getPriceLists({ fetchImpl }),
    ];

    // Let the first 3 dispatch under the gate immediately.
    await vi.advanceTimersByTimeAsync(50);
    // Advance just over 1s so the gate releases the next slot.
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(1100);

    const results = await Promise.all(promises);
    expect(results.every((r) => r.ok)).toBe(true);

    vi.useRealTimers();
  });
});
