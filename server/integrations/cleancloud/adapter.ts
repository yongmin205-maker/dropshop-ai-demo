/**
 * CleanCloud → vendor-neutral row adapter (Phase 25a).
 *
 * Pure functions only. They take a CleanCloud API response object and
 * return an `InsertPos*` row ready for upsert. No DB calls, no fetch,
 * no logging — easy to unit-test with hand-built fixtures.
 *
 * Defensive parsing: every field is optional in `CleanCloud*` types
 * (the docs only list request params, not response shapes), so we treat
 * each conversion as best-effort. A missing field never throws — we either
 * leave the column null or default it to a safe zero.
 *
 * One non-trivial choice: `placedAt`/`pickupAt`/`deliveryAt`. CleanCloud
 * mixes formats: sometimes Unix-seconds, sometimes "YYYY-MM-DD HH:MM:SS"
 * UTC strings, sometimes "YYYY-MM-DD" with a separate `pickupStart` time.
 * We try all three in order and fall back to null.
 *
 * Tested by `adapter.test.ts`.
 */

import type {
  CleanCloudCustomer,
  CleanCloudOrder,
  CleanCloudPriceList,
  CleanCloudProduct,
} from "../../messaging/cleanCloudTransport";
import type {
  InsertPosCustomer,
  InsertPosOrder,
  InsertPosPayment,
  InsertPosProduct,
} from "../../../drizzle/schema";
import {
  mapCleanCloudOrderStatus,
  mapCleanCloudPaymentType,
} from "./statusMap";

const SOURCE = "cleancloud" as const;

/* ----- helpers --------------------------------------------------------- */

function toStringId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return String(v);
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function toCents(v: unknown): number {
  // CleanCloud returns dollars as either a number (e.g. 12.5) or a string
  // ("12.50"). Convert to integer cents, defaulting to 0 on garbage.
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toBoolInt(v: unknown): number {
  // 0/1 column. Accept 0/1 numbers, "0"/"1" strings, true/false booleans.
  if (v === 1 || v === "1" || v === true) return 1;
  return 0;
}

function toIntSafe(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/**
 * Parse CleanCloud's date/timestamp fields into JS Date (UTC).
 *
 * Accepts:
 *   - Unix seconds (e.g. 1714579200)
 *   - Unix milliseconds
 *   - "YYYY-MM-DD HH:MM:SS"      (assumed UTC)
 *   - "YYYY-MM-DD"               (assumed midnight UTC)
 *   - ISO strings ("2026-05-14T03:00:00Z" etc.)
 *
 * Returns null on anything else, including "0", "" and "0000-00-00".
 */
export function parseCleanCloudTimestamp(v: unknown): Date | null {
  if (v === null || v === undefined || v === "" || v === 0 || v === "0") {
    return null;
  }
  if (typeof v === "number") {
    // Heuristic: anything < year 3000 in seconds is seconds; otherwise ms.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    if (v.startsWith("0000")) return null;
    // "YYYY-MM-DD HH:MM:SS" (no T separator) → treat as UTC by appending Z.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
      const d = new Date(`${v.replace(" ", "T")}Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(`${v}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Combine CleanCloud's `pickupDate` (date only) + `pickupStart` (HH:MM)
 * into a single UTC Date. Falls back to date-only if start time is missing.
 */
function combinePickupWindow(
  date: unknown,
  startTime: unknown,
): Date | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return parseCleanCloudTimestamp(date);
  }
  if (typeof startTime !== "string" || !/^\d{2}:\d{2}/.test(startTime)) {
    return parseCleanCloudTimestamp(date);
  }
  return parseCleanCloudTimestamp(`${date} ${startTime.slice(0, 5)}:00`);
}

/**
 * Best-effort E.164 normalization for US numbers. Anything that doesn't
 * cleanly normalize is returned as null and the caller stores the raw
 * input in `phoneRaw` for display.
 */
export function normalizeUSPhoneToE164(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/* ----- adapters -------------------------------------------------------- */

export function adaptCustomer(
  src: CleanCloudCustomer,
): InsertPosCustomer | null {
  const externalId = toStringId(src.customerID);
  if (!externalId) return null;
  const phoneRaw =
    typeof src.customerTel === "string" && src.customerTel.length > 0
      ? src.customerTel
      : null;
  const phoneE164 = normalizeUSPhoneToE164(phoneRaw);
  return {
    source: SOURCE,
    externalId,
    name: typeof src.customerName === "string" ? src.customerName : null,
    phoneE164,
    phoneRaw,
    email:
      typeof src.customerEmail === "string" && src.customerEmail.length > 0
        ? src.customerEmail
        : null,
    address:
      typeof src.customerAddress === "string" && src.customerAddress.length > 0
        ? src.customerAddress
        : null,
    notes:
      typeof src.customerNotes === "string" && src.customerNotes.length > 0
        ? src.customerNotes
        : null,
    marketingOptIn: toBoolInt(src.marketingOptIn),
    loyaltyPoints: toIntSafe(src.loyaltyPoints, 0),
    creditCents: toCents(src.credit),
    rawPayload: src as unknown,
  };
}

export function adaptOrder(src: CleanCloudOrder): InsertPosOrder | null {
  const externalId = toStringId(src.orderID);
  if (!externalId) return null;
  const itemsSummary = Array.isArray(src.products)
    ? src.products.map((p) => ({
        externalId: toStringId(p.id) ?? null,
        name: typeof p.name === "string" ? p.name : null,
        priceCents: toCents(p.price),
        quantity: toIntSafe(p.quantity ?? p.pieces, 1),
      }))
    : [];
  return {
    source: SOURCE,
    externalId,
    customerExternalId: toStringId(src.customerID),
    status: mapCleanCloudOrderStatus(src.status),
    sourceStatusRaw:
      src.status === undefined || src.status === null
        ? null
        : String(src.status),
    finalTotalCents: toCents(src.finalTotal),
    paid: toBoolInt(src.paid),
    completed: toBoolInt(src.completed),
    express: toBoolInt(src.express),
    placedAt: parseCleanCloudTimestamp(src.storeDropOffDate) ?? null,
    pickupAt: combinePickupWindow(src.pickupDate, src.pickupStart) ?? null,
    deliveryAt:
      combinePickupWindow(src.deliveryDate, src.deliveryStart) ?? null,
    notes:
      typeof src.orderNotes === "string" && src.orderNotes.length > 0
        ? src.orderNotes
        : null,
    itemsSummary,
    rawPayload: src as unknown,
  };
}

/**
 * CleanCloud embeds payments inside the order payload as `order.payments`
 * (an array of `{ paymentID, paymentType, paymentAmount, paymentDate, ... }`).
 * If that array is present, we fan it out into one InsertPosPayment per
 * entry. If it's missing, we fall back to inferring a single payment row
 * from `paid=1` + `finalTotal` + `paymentType` (CleanCloud's getOrders
 * returns these top-level fields when payments[] isn't expanded).
 */
export function extractPaymentsFromOrder(
  src: CleanCloudOrder,
): InsertPosPayment[] {
  const orderExternalId = toStringId(src.orderID);
  if (!orderExternalId) return [];
  const customerExternalId = toStringId(src.customerID);

  const arr = (src as Record<string, unknown>).payments;
  if (Array.isArray(arr) && arr.length > 0) {
    const out: InsertPosPayment[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      const externalId = toStringId(p.paymentID);
      if (!externalId) continue;
      out.push({
        source: SOURCE,
        externalId,
        orderExternalId,
        customerExternalId,
        amountCents: toCents(p.paymentAmount),
        type: mapCleanCloudPaymentType(p.paymentType),
        sourceTypeRaw:
          p.paymentType === undefined || p.paymentType === null
            ? null
            : String(p.paymentType),
        refunded: toBoolInt(p.refunded),
        paidAt: parseCleanCloudTimestamp(p.paymentDate) ?? null,
        rawPayload: p as unknown,
      });
    }
    return out;
  }

  // Fallback: paid=1 → synthesize one payment row keyed by orderID so that
  // re-pulling the same order is idempotent.
  if (toBoolInt(src.paid) === 1 && toCents(src.finalTotal) > 0) {
    return [
      {
        source: SOURCE,
        externalId: `order-${orderExternalId}-implicit`,
        orderExternalId,
        customerExternalId,
        amountCents: toCents(src.finalTotal),
        type: mapCleanCloudPaymentType(src.paymentType),
        sourceTypeRaw:
          src.paymentType === undefined || src.paymentType === null
            ? null
            : String(src.paymentType),
        refunded: 0,
        paidAt: parseCleanCloudTimestamp(src.storeDropOffDate) ?? null,
        rawPayload: { _inferred: true, source: src } as unknown,
      },
    ];
  }
  return [];
}

export function adaptProduct(
  src: CleanCloudProduct,
  priceListExternalId?: string | null,
): InsertPosProduct | null {
  const externalId = toStringId(src.productID);
  if (!externalId) return null;
  return {
    source: SOURCE,
    externalId,
    priceListExternalId:
      priceListExternalId ?? toStringId(src.priceListID),
    name: typeof src.name === "string" && src.name.length > 0 ? src.name : "",
    category:
      typeof src.category === "string" && src.category.length > 0
        ? src.category
        : null,
    priceCents: toCents(src.price),
    parentExternalId: toStringId(src.parentID),
    rawPayload: src as unknown,
  };
}

/**
 * Resolve a price list id from the response payload (some responses include
 * the priceList object inline; otherwise return null and the caller relies
 * on whatever was passed in).
 */
export function readPriceListId(
  pl: CleanCloudPriceList | undefined,
): string | null {
  if (!pl) return null;
  return toStringId(pl.priceListID);
}
