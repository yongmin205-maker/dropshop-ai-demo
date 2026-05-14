/**
 * CleanCloud → vendor-neutral status mapping.
 *
 * CleanCloud's getOrders endpoint returns numeric `status` codes. The mapping
 * below comes from the CleanCloud API docs (https://cleancloudapp.com/api)
 * cross-referenced against the live response samples captured during the
 * Phase 23 connectivity test:
 *
 *   0  = Cleaning
 *   1  = Ready
 *   2  = Completed
 *   3  = (unused in current docs — kept as `unknown`)
 *   4  = Awaiting Pickup
 *   5  = Detailing                  (in-progress sub-state of cleaning)
 *   6+ = (reserved — unknown today; if CleanCloud expands the enum we
 *         pick up the new values as `unknown` instead of crashing)
 *
 * The `paid`/`completed` side-flags on the order are NOT used to derive
 * status — they are mirrored separately as their own boolean columns. We
 * keep status purely as the workflow stage so the Owner Assistant can ask
 * "how many orders are still cleaning?" without conflating settlement state.
 *
 * Why "received" exists in the neutral enum but not in CleanCloud's: when
 * we ship our own POS, we want a status for "order placed but not yet
 * touched by staff". CleanCloud collapses that into status=0/Cleaning.
 *
 * Tested by `statusMap.test.ts`.
 */

import type { PosOrderStatus, PosPaymentType } from "../../../drizzle/schema";

export function mapCleanCloudOrderStatus(raw: unknown): PosOrderStatus {
  // CleanCloud returns the field as a number, but JSON sometimes round-trips
  // it as a string — accept both.
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || Number.isNaN(n)) return "unknown";

  switch (n) {
    case 0:
      return "cleaning";
    case 1:
      return "ready";
    case 2:
      return "completed";
    case 4:
      return "ready"; // "Awaiting Pickup" — for the Owner Assistant this is
                     // semantically the same as "ready". If the friend's
                     // workflow actually distinguishes the two we'll split
                     // out a "awaiting_pickup" enum value, but Stage 0 keeps
                     // the surface area small.
    case 5:
      return "cleaning"; // "Detailing" is a sub-stage of cleaning.
    default:
      return "unknown";
  }
}

/**
 * CleanCloud's payment-type integer is loosely documented; what we DO know
 * from live samples + their getPayments docs:
 *   0 = Cash
 *   1 = Card
 *   2 = Account/Credit
 *   3 = Loyalty
 *   4 = Stripe
 *   5 = Square
 *
 * Anything else maps to "other". Missing field → "unknown".
 */
export function mapCleanCloudPaymentType(raw: unknown): PosPaymentType {
  if (raw === undefined || raw === null) return "unknown";
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || Number.isNaN(n)) return "unknown";
  switch (n) {
    case 0:
      return "cash";
    case 1:
      return "card";
    case 2:
      return "credit";
    case 3:
      return "loyalty_points";
    case 4:
      return "stripe";
    case 5:
      return "square";
    default:
      return "other";
  }
}
