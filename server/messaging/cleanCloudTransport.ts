/**
 * CleanCloud POS — read-only transport layer (Phase 23 Stage 1).
 *
 * Wraps four read-only CleanCloud REST endpoints with: (1) shared rate-limit
 * gate (max 3 requests/sec per CleanCloud's published limit), (2) a thin
 * Result-shaped return so callers don't have to remember the
 * `{ Success: "True", Error: "..." }` envelope, and (3) typed response shapes
 * derived from the public docs at https://cleancloudapp.com/api .
 *
 * Endpoints covered in Stage 1:
 *   - getCustomer    (POST /api/getCustomer)
 *   - getOrders      (POST /api/getOrders)
 *   - getProducts    (POST /api/getProducts)
 *   - getPriceLists  (POST /api/getPriceLists)
 *
 * Live connectivity against the friend's account was verified by
 * `cleanCloudTransport.live.test.ts` on 2026-05-14: token returns
 * `Success: True` for getPriceLists, getOrders, and getProducts.
 *
 * Tests: hermetic vitest in `cleanCloudTransport.test.ts` covers token
 * injection, request body shape, response decoding, rate-limit serialization,
 * and error / network paths.
 *
 * Caller pattern:
 *   const result = await cleanCloud.getOrders({ customerID: "42" });
 *   if (!result.ok) {
 *     // log result.error, fall through to mock or surface to user
 *   } else {
 *     // result.data is typed
 *   }
 */

import { ENV } from "../_core/env";

const BASE = "https://cleancloudapp.com/api";
const RATE_LIMIT_PER_SECOND = 3; // CleanCloud published cap (Grow+).
const REQUEST_TIMEOUT_MS = 10_000;

// ----- Public typed response shapes ----------------------------------------
// CleanCloud's API documentation only lists request parameters, not the
// concrete response field names, so these types are derived from (a) the field
// names used in their request payloads, and (b) a one-off live response sample
// captured during the live connectivity test. We keep them permissive
// (everything optional) so a missing field never crashes the adapter.

export type CleanCloudCustomer = {
  customerID?: string | number;
  customerName?: string;
  customerTel?: string;
  customerEmail?: string;
  customerAddress?: string;
  customerAddressInstructions?: string;
  customerNotes?: string;
  customerGender?: string;
  birthdayDay?: number;
  birthdayMonth?: number;
  marketingOptIn?: 0 | 1 | boolean;
  customerRoute?: string | number;
  customerLat?: number;
  customerLng?: number;
  // Drycleaning preferences (optional, only present if the store has them set)
  starchPreference?: string;
  shirtPreference?: string;
  trouserPreference?: string;
  detergentType?: string;
  detergentScent?: string;
  fabricSoftenerType?: string;
  whitesWashTemp?: string;
  whitesDryerHeat?: string;
  colorsWashTemp?: string;
  colorsDryerHeat?: string;
  loyaltyPoints?: number;
  credit?: number;
  // Allow forward-compatible extras
  [extra: string]: unknown;
};

export type CleanCloudOrder = {
  orderID?: string | number;
  customerID?: string | number;
  status?: number; // 0=Cleaning, 1=Ready, 2=Completed, 4=Awaiting Pickup, 5=Detailing
  finalTotal?: number | string;
  paid?: 0 | 1;
  completed?: 0 | 1;
  pickupDate?: string | number;
  pickupStart?: string;
  pickupEnd?: string;
  delivery?: 0 | 1;
  deliveryDate?: string | number;
  deliveryStart?: string;
  deliveryEnd?: string;
  orderNotes?: string;
  notifyMethod?: number;
  paymentType?: number;
  express?: 0 | 1;
  storeOrder?: 0 | 1;
  storeDropOffDate?: string | number;
  storeReadyByDate?: string | number;
  storeReadyByTime?: string;
  products?: Array<{
    id?: string | number;
    name?: string;
    price?: number | string;
    pieces?: number | string;
    quantity?: number | string;
  }>;
  [extra: string]: unknown;
};

export type CleanCloudProduct = {
  productID?: string | number;
  name?: string;
  price?: number | string;
  category?: string;
  priceListID?: string | number;
  parentID?: string | number;
  upcharges?: Array<{ name?: string; price?: number | string }>;
  [extra: string]: unknown;
};

export type CleanCloudPriceList = {
  priceListID?: string | number;
  name?: string;
  [extra: string]: unknown;
};

// ----- Result envelope ------------------------------------------------------

export type CleanCloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

// ----- Internal rate-limit gate --------------------------------------------
// Serial queue: at most N requests are dispatched per second. We track the
// timestamps of the last `RATE_LIMIT_PER_SECOND` dispatches and, if the oldest
// is < 1s ago, sleep until it ages out. This is a per-process limiter; if the
// app ever runs more than one server instance against the same token, we'd
// need a distributed equivalent.

const recentDispatches: number[] = [];

async function acquireRateSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    // Drop timestamps older than 1s
    while (recentDispatches.length > 0 && recentDispatches[0]! <= now - 1000) {
      recentDispatches.shift();
    }
    if (recentDispatches.length < RATE_LIMIT_PER_SECOND) {
      recentDispatches.push(now);
      return;
    }
    const oldest = recentDispatches[0]!;
    const waitMs = oldest + 1000 - now;
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 5)));
  }
}

// Exposed for tests so they can reset between cases.
export function __resetCleanCloudRateLimitForTests(): void {
  recentDispatches.length = 0;
}

// ----- Low-level POST helper -----------------------------------------------

async function postJson(
  endpoint: string,
  payload: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; tokenOverride?: string } = {},
): Promise<{ status: number; bodyText: string; json: unknown }> {
  const token = opts.tokenOverride ?? ENV.cleanCloudApiToken;
  if (!token) {
    return {
      status: 0,
      bodyText: "",
      json: { Success: "False", Error: "CLEANCLOUD_API_TOKEN is not set" },
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  await acquireRateSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: token, ...payload }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
    return { status: res.status, bodyText, json };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEnvelope<T>(
  raw: unknown,
  status: number,
  bodyText: string,
  successKey: string,
): CleanCloudResult<T> {
  if (status >= 500) {
    return { ok: false, status, error: `CleanCloud HTTP ${status}: ${bodyText.slice(0, 200)}` };
  }
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      status,
      error: `CleanCloud returned non-JSON body (status ${status}): ${bodyText.slice(0, 200)}`,
    };
  }
  const r = raw as { Success?: string; Error?: string } & Record<string, unknown>;
  if (r.Success !== "True") {
    return {
      ok: false,
      status,
      error: typeof r.Error === "string" && r.Error.length > 0 ? r.Error : "Unknown CleanCloud error",
    };
  }
  // Pull the named payload key if present; otherwise pass the whole envelope
  // through (some endpoints return Success + top-level fields).
  if (successKey in r) {
    return { ok: true, data: r[successKey] as T };
  }
  return { ok: true, data: raw as T };
}

// ----- Public endpoints ----------------------------------------------------

export type GetCustomerParams =
  | { customerID: string | number }
  | { dateFrom: string; dateTo: string; excludeDeactivated?: 0 | 1 };

export async function getCustomer(
  params: GetCustomerParams,
  opts: { fetchImpl?: typeof fetch; tokenOverride?: string } = {},
): Promise<CleanCloudResult<CleanCloudCustomer | CleanCloudCustomer[]>> {
  const { status, bodyText, json } = await postJson("getCustomer", params as Record<string, unknown>, opts);
  // Single-ID requests return a flat object; date-range requests return an
  // array. The CleanCloud docs explicitly call this out. Either shape is
  // legal — we hand both back and let the adapter narrow as needed.
  if (status === 200 && json && typeof json === "object" && (json as { Success?: unknown }).Success === "True") {
    const r = json as Record<string, unknown>;
    // Date-range mode → an array lives under one of "Customers" / "customers"
    if (Array.isArray(r.Customers)) {
      return { ok: true, data: r.Customers as CleanCloudCustomer[] };
    }
    if (Array.isArray(r.customers)) {
      return { ok: true, data: r.customers as CleanCloudCustomer[] };
    }
    // Single-customer mode → the customer fields live on the envelope itself
    // (Success + fields). Strip "Success" so callers see a clean customer.
    const { Success: _omit, Error: _omit2, ...rest } = r;
    void _omit;
    void _omit2;
    return { ok: true, data: rest as CleanCloudCustomer };
  }
  return decodeEnvelope<CleanCloudCustomer>(json, status, bodyText, "Customer");
}

export type GetOrdersParams = {
  orderID?: string | number;
  customerID?: string | number;
  routeID?: string | number;
  dateFrom?: string;
  dateTo?: string;
  updatedSecondsAgoFrom?: number;
  status?: number;
  completed?: 0 | 1;
  paid?: 0 | 1;
  sendProductDetails?: 0 | 1;
};

export async function getOrders(
  params: GetOrdersParams = {},
  opts: { fetchImpl?: typeof fetch; tokenOverride?: string } = {},
): Promise<CleanCloudResult<CleanCloudOrder[]>> {
  const { status, bodyText, json } = await postJson(
    "getOrders",
    params as Record<string, unknown>,
    opts,
  );
  if (status === 200 && json && typeof json === "object" && (json as { Success?: unknown }).Success === "True") {
    const r = json as Record<string, unknown>;
    if (Array.isArray(r.Orders)) return { ok: true, data: r.Orders as CleanCloudOrder[] };
    if (Array.isArray(r.orders)) return { ok: true, data: r.orders as CleanCloudOrder[] };
    return { ok: true, data: [] };
  }
  return decodeEnvelope<CleanCloudOrder[]>(json, status, bodyText, "Orders");
}

export type GetProductsParams = {
  priceListID?: string | number;
  sendParents?: 0 | 1;
  sendUpcharges?: 0 | 1;
  inStore?: 0 | 1;
};

export async function getProducts(
  params: GetProductsParams = {},
  opts: { fetchImpl?: typeof fetch; tokenOverride?: string } = {},
): Promise<CleanCloudResult<CleanCloudProduct[]>> {
  const { status, bodyText, json } = await postJson("getProducts", params as Record<string, unknown>, opts);
  if (status === 200 && json && typeof json === "object" && (json as { Success?: unknown }).Success === "True") {
    const r = json as Record<string, unknown>;
    if (Array.isArray(r.Products)) return { ok: true, data: r.Products as CleanCloudProduct[] };
    if (Array.isArray(r.products)) return { ok: true, data: r.products as CleanCloudProduct[] };
    return { ok: true, data: [] };
  }
  return decodeEnvelope<CleanCloudProduct[]>(json, status, bodyText, "Products");
}

export async function getPriceLists(
  opts: { fetchImpl?: typeof fetch; tokenOverride?: string } = {},
): Promise<CleanCloudResult<CleanCloudPriceList[]>> {
  const { status, bodyText, json } = await postJson("getPriceLists", {}, opts);
  if (status === 200 && json && typeof json === "object" && (json as { Success?: unknown }).Success === "True") {
    const r = json as Record<string, unknown>;
    if (Array.isArray(r.PriceLists)) return { ok: true, data: r.PriceLists as CleanCloudPriceList[] };
    if (Array.isArray(r.priceLists)) return { ok: true, data: r.priceLists as CleanCloudPriceList[] };
    if (Array.isArray(r.price_lists)) return { ok: true, data: r.price_lists as CleanCloudPriceList[] };
    return { ok: true, data: [] };
  }
  return decodeEnvelope<CleanCloudPriceList[]>(json, status, bodyText, "PriceLists");
}

// Convenience grouped export so callers can do `import { cleanCloud } from "..."`.
export const cleanCloud = {
  getCustomer,
  getOrders,
  getProducts,
  getPriceLists,
};
