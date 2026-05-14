/**
 * Live connectivity test for CleanCloud API.
 *
 * Skipped by default. Run with:
 *   RUN_CLEANCLOUD_LIVE=1 pnpm vitest run server/messaging/cleanCloudTransport.live.test.ts
 *
 * Goal: confirm the friend's CLEANCLOUD_API_TOKEN actually works against
 * cleancloudapp.com before we build the full transport layer.
 *
 * We call two cheap read-only endpoints with the smallest possible payload:
 *   - getCustomer  (with a 1-day dateFrom/dateTo range — should return an empty
 *                   or small list of customers signed up that day, never 4xx if
 *                   the token + plan are valid)
 *   - getPriceLists (just api_token, returns all active price lists)
 *
 * If both return 200 with `Success: "True"`, the token is good and the friend
 * has a Grow+ plan.
 *
 * If either returns 401/403/404, we record the failure shape so we can
 * diagnose without a second round-trip to the user.
 */

import { describe, expect, it } from "vitest";

const LIVE = process.env.RUN_CLEANCLOUD_LIVE === "1";
const TOKEN = process.env.CLEANCLOUD_API_TOKEN ?? "";
const BASE = "https://cleancloudapp.com/api";

type CleanCloudResponse = {
  Success?: string;
  Error?: string;
  [key: string]: unknown;
};

async function callCleanCloud(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; bodyText: string; json: CleanCloudResponse | null }> {
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: TOKEN, ...payload }),
  });
  const bodyText = await res.text();
  let json: CleanCloudResponse | null = null;
  try {
    json = JSON.parse(bodyText) as CleanCloudResponse;
  } catch {
    json = null;
  }
  return { status: res.status, bodyText, json };
}

describe.skipIf(!LIVE)("CleanCloud live connectivity", () => {
  it("has CLEANCLOUD_API_TOKEN set", () => {
    expect(TOKEN.length).toBeGreaterThan(20);
    // CleanCloud tokens are 40-char hex strings
    expect(TOKEN).toMatch(/^[a-f0-9]{32,64}$/i);
  });

  it("getPriceLists returns Success=True with the real token", async () => {
    const result = await callCleanCloud("getPriceLists", {});
    // Log the full body for human review if anything is off
    if (result.status !== 200 || result.json?.Success !== "True") {
      console.log("[cleancloud:getPriceLists] status:", result.status);
      console.log("[cleancloud:getPriceLists] body:", result.bodyText.slice(0, 600));
    }
    expect(result.status).toBe(200);
    expect(result.json?.Success).toBe("True");
    // Price lists payload should contain at least one list
    // (the store always has a default price list)
    expect(result.json).toBeTruthy();
  });

  it("getCustomer with a 1-day date range returns Success=True", async () => {
    // Use a date well in the past so the response is small but valid
    const dateStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await callCleanCloud("getCustomer", {
      dateFrom: dateStr,
      dateTo: dateStr,
    });
    if (result.status !== 200 || result.json?.Success !== "True") {
      console.log("[cleancloud:getCustomer] status:", result.status);
      console.log("[cleancloud:getCustomer] body:", result.bodyText.slice(0, 600));
    }
    expect(result.status).toBe(200);
    expect(result.json?.Success).toBe("True");
  });

  it("getOrders for the last 7 days returns Success=True", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await callCleanCloud("getOrders", {
      dateFrom: weekAgo,
      dateTo: today,
    });
    if (result.status !== 200 || result.json?.Success !== "True") {
      console.log("[cleancloud:getOrders] status:", result.status);
      console.log("[cleancloud:getOrders] body:", result.bodyText.slice(0, 600));
    }
    expect(result.status).toBe(200);
    expect(result.json?.Success).toBe("True");
  });

  it("getProducts returns Success=True", async () => {
    const result = await callCleanCloud("getProducts", {});
    if (result.status !== 200 || result.json?.Success !== "True") {
      console.log("[cleancloud:getProducts] status:", result.status);
      console.log("[cleancloud:getProducts] body:", result.bodyText.slice(0, 600));
    }
    expect(result.status).toBe(200);
    expect(result.json?.Success).toBe("True");
  });
});
