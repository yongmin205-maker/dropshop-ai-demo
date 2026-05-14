/**
 * CleanCloud adapter — translates real CleanCloud POS responses into the same
 * `MockCustomer | MockOrder | MockPrice` shapes the rest of DropShop already
 * understands. This is the seam that lets `mockCleanCloud` helpers swap
 * between the seeded demo data and the friend's real store when
 * `DROPSHOP_USE_REAL_POS=1` is set.
 *
 * Strategy: each helper here returns a plain object that *looks like* a row
 * from the `mockCustomers / mockOrders / mockPriceList` Drizzle tables, so
 * downstream callers (aiAgent.ts, twilioWebhook.ts, routers.ts) don't notice
 * the difference. We do NOT write to the demo DB — the adapter is read-only
 * for Stage 1.
 *
 * Field-mapping notes (derived from the public API docs + the Phase-23
 * connectivity test response):
 *   - CleanCloud `customerTel` is the closest analog to our `phone` (we
 *     normalize to E.164 best-effort; if the store stores 10-digit US
 *     numbers, we prepend "+1").
 *   - Membership tier in CleanCloud is not a single enum field. For Stage 1
 *     we always report `"none"` and let the UI surface real loyalty info
 *     separately in a later stage. (This avoids fabricating a "gold/silver"
 *     classification the store never actually configured.)
 *   - Order `status` in CleanCloud is a numeric enum; we map it to the four
 *     status strings DropShop's UI already renders.
 */

import type { MockCustomer, MockOrder, MockPrice } from "../../drizzle/schema";
import {
  cleanCloud,
  type CleanCloudCustomer,
  type CleanCloudOrder,
  type CleanCloudProduct,
} from "./cleanCloudTransport";

/* ============================================================
 * Helpers — phone normalization + CleanCloud enum decoding
 * ============================================================ */

/**
 * Normalize a phone to E.164 best-effort. CleanCloud stores phones however
 * the store typed them in (often "555-123-4567" or "(555) 123-4567"), so we
 * strip everything non-digit, then prepend "+1" for 10-digit US numbers.
 * 11-digit starting with "1" gets "+" alone. Anything else is returned as a
 * "+"-prefixed best guess so we never silently drop the data.
 */
export function normalizeE164(raw: string | undefined | null): string {
  if (!raw) return "";
  const digits = String(raw).replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 0) return "";
  return `+${digits}`;
}

/**
 * Map CleanCloud's numeric order status to DropShop's 4 canonical strings.
 * CleanCloud reference (from docs page):
 *   0 = Cleaning, 1 = Ready, 2 = Completed, 4 = Awaiting Pickup, 5 = Detailing.
 * We collapse 1 (Ready) into "Ready to Deliver" because that's what our UI
 * shows. Unknown codes fall through to "Cleaning" (the safest default — it
 * never claims an order is done when it isn't).
 */
const CLEANCLOUD_STATUS_MAP: Record<number, MockOrder["status"]> = {
  0: "Cleaning",
  1: "Ready to Deliver",
  2: "Completed",
  4: "Awaiting Pickup",
  5: "Cleaning", // Detailing — still in progress from a customer's POV
};

export function decodeStatus(code: number | undefined): MockOrder["status"] {
  if (code === undefined || code === null) return "Cleaning";
  return CLEANCLOUD_STATUS_MAP[code] ?? "Cleaning";
}

/* ============================================================
 * Customer helpers
 * ============================================================ */

function toMockCustomer(cc: CleanCloudCustomer): MockCustomer {
  const phone = normalizeE164(cc.customerTel);
  const name = typeof cc.customerName === "string" ? cc.customerName : "Unknown";
  // Membership: Stage 1 always reports "none" — see file header.
  const notesParts: string[] = [];
  if (typeof cc.customerNotes === "string" && cc.customerNotes.trim().length > 0) {
    notesParts.push(cc.customerNotes.trim());
  }
  if (typeof cc.starchPreference === "string" && cc.starchPreference.trim().length > 0) {
    notesParts.push(`Starch: ${cc.starchPreference.trim()}`);
  }
  if (typeof cc.shirtPreference === "string" && cc.shirtPreference.trim().length > 0) {
    notesParts.push(`Shirt: ${cc.shirtPreference.trim()}`);
  }
  if (typeof cc.detergentScent === "string" && cc.detergentScent.trim().length > 0) {
    notesParts.push(`Scent: ${cc.detergentScent.trim()}`);
  }
  return {
    // We don't have a stable numeric id for adapter rows — use 0 (unused
    // downstream; intent and SMS flows key off phone, not id).
    id: 0,
    phone,
    name,
    membership: "none",
    address: typeof cc.customerAddress === "string" ? cc.customerAddress : null,
    notes: notesParts.length > 0 ? notesParts.join(" · ") : null,
  } as MockCustomer;
}

/**
 * Find a customer in the real CleanCloud account by phone.
 *
 * CleanCloud's getCustomer takes either `customerID` or `dateFrom/dateTo`.
 * It does NOT support phone lookup directly. The pragmatic workaround for
 * Stage 1 is: pull the last ~12 months of customers in a single call
 * (date-range mode), then scan for a matching normalized phone. CleanCloud
 * date ranges accept large windows.
 *
 * If the store has 50k+ customers this scan would be too slow. For DropShop's
 * single-store scale (hundreds to low thousands) it's fine. We add a
 * 60-second in-process memo to avoid re-pulling on every SMS.
 */
let customersCache: { fetchedAt: number; rows: CleanCloudCustomer[] } | null = null;
const CUSTOMERS_CACHE_TTL_MS = 60_000;

export function __resetCleanCloudAdapterCacheForTests(): void {
  customersCache = null;
}

async function fetchAllCustomersThisYear(): Promise<CleanCloudCustomer[]> {
  if (customersCache && Date.now() - customersCache.fetchedAt < CUSTOMERS_CACHE_TTL_MS) {
    return customersCache.rows;
  }
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const result = await cleanCloud.getCustomer({ dateFrom: oneYearAgo, dateTo: today });
  if (!result.ok) {
    // Don't poison the cache with a failed pull; let the next call retry.
    return [];
  }
  const rows = Array.isArray(result.data) ? result.data : [result.data];
  customersCache = { fetchedAt: Date.now(), rows };
  return rows;
}

export async function realGetCustomerByPhone(phone: string): Promise<MockCustomer | null> {
  const normalized = normalizeE164(phone);
  if (!normalized) return null;
  const rows = await fetchAllCustomersThisYear();
  const match = rows.find((c) => normalizeE164(c.customerTel) === normalized);
  return match ? toMockCustomer(match) : null;
}

/* ============================================================
 * Order helpers
 * ============================================================ */

function toMockOrder(cc: CleanCloudOrder, customerPhoneFallback: string): MockOrder {
  const orderNumber = cc.orderID !== undefined ? String(cc.orderID) : "UNKNOWN";
  const totalCents = (() => {
    const t = cc.finalTotal;
    if (typeof t === "number") return Math.round(t * 100);
    if (typeof t === "string") {
      const parsed = parseFloat(t);
      return isNaN(parsed) ? 0 : Math.round(parsed * 100);
    }
    return 0;
  })();
  const itemsSummary = (() => {
    if (Array.isArray(cc.products) && cc.products.length > 0) {
      return cc.products
        .map((p) => {
          const qty = p.quantity ?? p.pieces ?? 1;
          return `${qty} × ${p.name ?? "item"}`;
        })
        .join(", ");
    }
    if (typeof cc.orderNotes === "string" && cc.orderNotes.length > 0) {
      return cc.orderNotes;
    }
    return "Order details unavailable";
  })();
  const status =
    typeof cc.status === "number" ? decodeStatus(cc.status) : decodeStatus(undefined);
  const etaText = (() => {
    if (status === "Awaiting Pickup" && cc.pickupStart && cc.pickupEnd) {
      return `Pickup ${cc.pickupStart}–${cc.pickupEnd}`;
    }
    if (status === "Ready to Deliver" && cc.deliveryStart && cc.deliveryEnd) {
      return `Out for delivery ${cc.deliveryStart}–${cc.deliveryEnd}`;
    }
    if (cc.storeReadyByDate) {
      return `Ready by ${String(cc.storeReadyByDate)} ${String(cc.storeReadyByTime ?? "").trim()}`.trim();
    }
    return null;
  })();
  return {
    id: 0,
    orderNumber,
    customerPhone: customerPhoneFallback,
    status,
    itemsSummary,
    totalCents,
    etaText,
  } as MockOrder;
}

export async function realGetOrdersByPhone(phone: string): Promise<MockOrder[]> {
  const normalized = normalizeE164(phone);
  if (!normalized) return [];
  // We need the customer's CleanCloud customerID first to scope getOrders.
  const rows = await fetchAllCustomersThisYear();
  const match = rows.find((c) => normalizeE164(c.customerTel) === normalized);
  if (!match || match.customerID === undefined) return [];

  const result = await cleanCloud.getOrders({
    customerID: match.customerID,
    sendProductDetails: 1,
  });
  if (!result.ok) return [];
  return result.data.map((o) => toMockOrder(o, normalized));
}

/* ============================================================
 * Price helpers
 * ============================================================ */

function categoryFromCleanCloud(p: CleanCloudProduct): MockPrice["category"] {
  // CleanCloud's "category" field is a free-text label set by the store
  // (e.g. "Shirts", "Pants", "Alterations", "Wash & Fold"). Map to our 3
  // canonical buckets by keyword. Anything unmatched falls into "dryClean"
  // which is the safest default for a drycleaning shop.
  const name = `${p.category ?? ""} ${p.name ?? ""}`.toLowerCase();
  if (/(alter|hem|zipper|patch|seam|waist)/.test(name)) return "alteration";
  if (/(wash.*fold|wash & fold|laundry)/.test(name)) return "laundry";
  return "dryClean";
}

function toMockPrice(p: CleanCloudProduct): MockPrice {
  const priceCents = (() => {
    const v = p.price;
    if (typeof v === "number") return Math.round(v * 100);
    if (typeof v === "string") {
      const parsed = parseFloat(v);
      return isNaN(parsed) ? 0 : Math.round(parsed * 100);
    }
    return 0;
  })();
  return {
    id: 0,
    category: categoryFromCleanCloud(p),
    itemName: typeof p.name === "string" ? p.name : "Item",
    priceCents,
    notes: null,
  } as MockPrice;
}

let productsCache: { fetchedAt: number; rows: CleanCloudProduct[] } | null = null;
const PRODUCTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — products rarely change

async function fetchAllProducts(): Promise<CleanCloudProduct[]> {
  if (productsCache && Date.now() - productsCache.fetchedAt < PRODUCTS_CACHE_TTL_MS) {
    return productsCache.rows;
  }
  const result = await cleanCloud.getProducts({ sendUpcharges: 1 });
  if (!result.ok) return [];
  productsCache = { fetchedAt: Date.now(), rows: result.data };
  return result.data;
}

const KNOWN_PRICE_CATEGORIES = new Set(["dryClean", "alteration", "laundry"]);

export async function realSearchPrice(query: string): Promise<MockPrice[]> {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return [];
  const products = await fetchAllProducts();
  const mapped = products.map(toMockPrice);
  if (KNOWN_PRICE_CATEGORIES.has(trimmed)) {
    return mapped.filter((p) => p.category === trimmed);
  }
  const q = trimmed.toLowerCase();
  return mapped.filter((p) => p.itemName.toLowerCase().includes(q)).slice(0, 25);
}

export async function realListAllPrices(): Promise<MockPrice[]> {
  const products = await fetchAllProducts();
  return products.map(toMockPrice);
}
