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
    // Phase 25-verify-2: numeric-string Unix epoch (e.g. "1778846675").
    // CleanCloud returns these as strings throughout; without this branch
    // every `placedAt`/`paidAt` came back null.
    if (/^\d{6,}$/.test(v)) {
      const num = Number(v);
      const ms = num < 1e12 ? num * 1000 : num;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
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
 * Combine CleanCloud's `pickupDate` / `deliveryDate` with optional time
 * window string (`pickupTime` / `deliveryTime`) into a single UTC Date.
 *
 * Phase 25-verify-2 (real-shape fix): observed shapes are:
 *   - `pickupDate`: Unix seconds (e.g. "1779192000") OR "YYYY-MM-DD"
 *   - `pickupTime`: "6pm-8pm", "14:00-16:00", "0-0", ""
 * If `date` is a Unix timestamp it already includes the slot start, so we
 * use it as-is. If it's a date-only string we try to parse the time prefix
 * (`6pm` → 18:00, `14:00` → 14:00) and combine; otherwise just date+midnight.
 */
function combinePickupWindow(
  date: unknown,
  timeWindow: unknown,
): Date | null {
  // Unix epoch (number or numeric string > 0) → already a full timestamp.
  if (
    typeof date === "number" ||
    (typeof date === "string" && /^\d{6,}$/.test(date) && date !== "0")
  ) {
    return parseCleanCloudTimestamp(date);
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return parseCleanCloudTimestamp(date);
  }
  if (typeof timeWindow !== "string" || timeWindow === "" || timeWindow === "0-0") {
    return parseCleanCloudTimestamp(date);
  }
  // "6pm-8pm" → start "6pm" → 18:00
  // "14:00-16:00" → start "14:00" → 14:00
  const start = timeWindow.split("-")[0]?.trim() ?? "";
  const hhmm = parseTimePrefix(start);
  if (!hhmm) return parseCleanCloudTimestamp(date);
  return parseCleanCloudTimestamp(`${date} ${hhmm}:00`);
}

function parseTimePrefix(s: string): string | null {
  if (!s) return null;
  // "14:00" or "14:00:00"
  const m24 = s.match(/^(\d{1,2}):(\d{2})/);
  if (m24) {
    const hh = m24[1]!.padStart(2, "0");
    return `${hh}:${m24[2]}`;
  }
  // "6pm", "6 pm", "6:30pm"
  const m12 = s.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m12) {
    let hh = Number(m12[1]);
    const mm = m12[2] ?? "00";
    const mer = m12[3]!;
    if (mer === "pm" && hh < 12) hh += 12;
    if (mer === "am" && hh === 12) hh = 0;
    return `${String(hh).padStart(2, "0")}:${mm}`;
  }
  return null;
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
  // Phase 25-verify-2 (real-shape fix): CleanCloud `getCustomer` returns
  // capitalised keys: ID, Name, Tel, Email, Address, Notes, plus camelCase
  // marketingOptIn, loyaltyPointsAvailable, creditAvailable. Earlier code
  // looked at `customerID/customerName/...` which never existed in real
  // responses → every customer was dropped and the mirror stayed empty.
  const s = src as unknown as Record<string, unknown>;
  const externalId = toStringId(s.ID ?? s.customerID);
  if (!externalId) return null;
  const phoneRaw =
    typeof s.Tel === "string" && s.Tel.length > 0
      ? (s.Tel as string)
      : typeof s.customerTel === "string" && (s.customerTel as string).length > 0
        ? (s.customerTel as string)
        : null;
  const phoneE164 = normalizeUSPhoneToE164(phoneRaw);
  const name =
    (typeof s.Name === "string" && (s.Name as string)) ||
    (typeof s.customerName === "string" && (s.customerName as string)) ||
    null;
  const email =
    (typeof s.Email === "string" && (s.Email as string).length > 0
      ? (s.Email as string)
      : null) ??
    (typeof s.customerEmail === "string" && (s.customerEmail as string).length > 0
      ? (s.customerEmail as string)
      : null);
  const address =
    (typeof s.Address === "string" && (s.Address as string).length > 0
      ? (s.Address as string)
      : null) ??
    (typeof s.customerAddress === "string" && (s.customerAddress as string).length > 0
      ? (s.customerAddress as string)
      : null);
  const notes =
    (typeof s.Notes === "string" && (s.Notes as string).length > 0
      ? (s.Notes as string)
      : null) ??
    (typeof s.customerNotes === "string" && (s.customerNotes as string).length > 0
      ? (s.customerNotes as string)
      : null);
  return {
    source: SOURCE,
    externalId,
    name,
    phoneE164,
    phoneRaw,
    email,
    address,
    notes,
    marketingOptIn: toBoolInt(s.marketingOptIn),
    loyaltyPoints: toIntSafe(s.loyaltyPointsAvailable ?? s.loyaltyPoints, 0),
    creditCents: toCents(s.creditAvailable ?? s.credit),
    rawPayload: src as unknown,
  };
}

export function adaptOrder(src: CleanCloudOrder): InsertPosOrder | null {
  // Phase 25-verify-2 (real-shape fix): observed `getOrders` payload uses
  // `id` (not orderID), `total` (not finalTotal), `notes` (not orderNotes),
  // `createdDate` for placedAt, `pickupDate/Time` Unix-epoch + slot string,
  // and embedded `products[].pricePerUnit`. Previously every order's id
  // looked up the missing `orderID` key, returned null, and got dropped.
  const s = src as unknown as Record<string, unknown>;
  const externalId = toStringId(s.id ?? s.orderID);
  if (!externalId) return null;
  const productsRaw = (s.products ?? []) as Array<Record<string, unknown>>;
  const itemsSummary = Array.isArray(productsRaw)
    ? productsRaw.map((p) => ({
        externalId: toStringId(p.id) ?? null,
        name: typeof p.name === "string" ? (p.name as string) : null,
        priceCents: toCents(p.pricePerUnit ?? p.price),
        quantity: toIntSafe(p.quantity ?? p.pieces, 1),
      }))
    : [];
  const totalRaw = s.total ?? s.finalTotal;
  const isCompleted =
    s.completed === 1 ||
    s.completed === "1" ||
    (typeof s.completedDate !== "undefined" &&
      s.completedDate !== "0" &&
      s.completedDate !== 0 &&
      s.completedDate !== null &&
      s.completedDate !== "");
  return {
    source: SOURCE,
    externalId,
    customerExternalId: toStringId(s.customerID),
    status: mapCleanCloudOrderStatus(s.status as number | undefined),
    sourceStatusRaw:
      s.status === undefined || s.status === null
        ? null
        : String(s.status),
    finalTotalCents: toCents(totalRaw),
    paid: toBoolInt(s.paid),
    completed: isCompleted ? 1 : 0,
    express: toBoolInt(s.express),
    // Prefer createdDate (real placed-at). Fall back to storeDropOffDate for
    // any future API change that re-introduces it.
    placedAt:
      parseCleanCloudTimestamp(s.createdDate) ??
      parseCleanCloudTimestamp(s.storeDropOffDate) ??
      null,
    pickupAt:
      combinePickupWindow(s.pickupDate, s.pickupTime ?? s.pickupStart) ?? null,
    deliveryAt:
      combinePickupWindow(s.deliveryDate, s.deliveryTime ?? s.deliveryStart) ?? null,
    notes:
      typeof s.notes === "string" && (s.notes as string).length > 0
        ? (s.notes as string)
        : typeof s.orderNotes === "string" && (s.orderNotes as string).length > 0
          ? (s.orderNotes as string)
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
  // Phase 25-verify-2 (real-shape fix): same key migration as adaptOrder.
  // CleanCloud's getOrders does NOT include an embedded payments[] array
  // in the responses we've observed; instead each order has top-level
  // paid/paymentType/paymentTime/total. We synthesize one implicit payment
  // row per paid order using `paymentTime` (Unix seconds) for paidAt.
  const s = src as unknown as Record<string, unknown>;
  const orderExternalId = toStringId(s.id ?? s.orderID);
  if (!orderExternalId) return [];
  const customerExternalId = toStringId(s.customerID);

  const arr = s.payments;
  if (Array.isArray(arr) && arr.length > 0) {
    const out: InsertPosPayment[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      const externalId = toStringId(p.paymentID ?? p.id);
      if (!externalId) continue;
      out.push({
        source: SOURCE,
        externalId,
        orderExternalId,
        customerExternalId,
        amountCents: toCents(p.paymentAmount ?? p.amount),
        type: mapCleanCloudPaymentType(p.paymentType),
        sourceTypeRaw:
          p.paymentType === undefined || p.paymentType === null
            ? null
            : String(p.paymentType),
        refunded: toBoolInt(p.refunded),
        paidAt:
          parseCleanCloudTimestamp(p.paymentDate ?? p.paymentTime) ?? null,
        rawPayload: p as unknown,
      });
    }
    return out;
  }

  // Fallback: paid=1 + total > 0 → synthesize one implicit payment.
  const totalRaw = s.total ?? s.finalTotal;
  if (toBoolInt(s.paid) === 1 && toCents(totalRaw) > 0) {
    return [
      {
        source: SOURCE,
        externalId: `order-${orderExternalId}-implicit`,
        orderExternalId,
        customerExternalId,
        amountCents: toCents(totalRaw),
        type: mapCleanCloudPaymentType(s.paymentType),
        sourceTypeRaw:
          s.paymentType === undefined || s.paymentType === null
            ? null
            : String(s.paymentType),
        refunded: 0,
        paidAt:
          parseCleanCloudTimestamp(s.paymentTime ?? s.createdDate ?? s.storeDropOffDate) ?? null,
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
  // Phase 25-verify-2 (real-shape fix): real `getProducts` payload uses
  // `id` (not productID), `parent` (not parentID), no `category` field —
  // there's `section` instead. Earlier code dropped every product.
  const s = src as unknown as Record<string, unknown>;
  const externalId = toStringId(s.id ?? s.productID);
  if (!externalId) return null;
  return {
    source: SOURCE,
    externalId,
    priceListExternalId:
      priceListExternalId ?? toStringId(s.priceListID),
    name: typeof s.name === "string" && (s.name as string).length > 0 ? (s.name as string) : "",
    category:
      typeof s.category === "string" && (s.category as string).length > 0
        ? (s.category as string)
        : typeof s.section === "string" && (s.section as string).length > 0
          ? (s.section as string)
          : null,
    priceCents: toCents(s.price),
    parentExternalId: toStringId(s.parent ?? s.parentID),
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
  const p = pl as unknown as Record<string, unknown>;
  return toStringId(p.id ?? p.priceListID);
}
