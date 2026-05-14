/* ============================================================
 * Phase 22b — Salon Smart-Slot suggestion
 * ------------------------------------------------------------
 *
 * Why this module exists
 *   The pre-existing `findOverlapSlots` in `mockSalon.ts` answers a
 *   different question: "where can we fit a short service inside an
 *   ongoing customer's processing window?" That's the salon's signature
 *   "no wait" feature.
 *
 *   But for the *common* booking ask ("can I get a perm tomorrow?")
 *   we want the opposite: of all the LEGAL start times in the next 7
 *   days, which ones pack the day cleanly so the operator doesn't
 *   end up with orphan 15- and 30-min gaps that never fill?
 *
 *   That's what this module does. It's pure, deterministic, easy to
 *   reason about, and intentionally has zero DB dependency — exactly
 *   the same shape as Phase-1 `mockSalon.findOverlapSlots`.
 *
 * The scoring function (locked in PHASE22_DECISIONS.md §Q2)
 *
 *     score = gap_before × 1.0  +  gap_after × 0.6
 *
 *   Lower is better:
 *     - `gap_before` matters more because it's TRAPPED between two
 *       bookings and likely lost forever.
 *     - `gap_after` is open-ended (a walk-in or another booking can
 *       still fill it later in the day), so we weight it half.
 *
 *   "Gap" is measured in 15-minute slot units (the existing salon
 *   granularity) and capped at SLOT_LOOKAHEAD_MINUTES so that an empty
 *   afternoon doesn't penalize a morning candidate unfairly.
 *
 * What this module does NOT do
 *   - It does not hold slots (Ticketmaster pattern). That ships in a
 *     follow-up phase (22b-2 / 22c) along with the `salon_slot_holds`
 *     table and the SELECT FOR UPDATE atomic-hold flow.
 *   - It does not call the LLM. The salon agent layer is the only
 *     consumer of the LLM in Pilot 2.
 *   - It does not mutate state. Pure function in, ranked array out.
 *
 * ============================================================ */

import type { SalonAppointment, ServiceCategory, StylistId } from "./mockSalon";
import {
  CLOSE_MINUTE,
  OPEN_MINUTE,
  SEED_STYLISTS,
  SLOT_GRANULARITY,
  getService,
  listAppointmentsForWeek,
} from "./mockSalon";

/** Cap on how far before/after a candidate we look. Empty late evening
 *  shouldn't make a 11:00 candidate look worse than a 13:15 one. */
export const SLOT_LOOKAHEAD_MINUTES = 240;

/** Weight applied to `gap_after`. See PHASE22_DECISIONS.md §Q2. */
export const GAP_AFTER_WEIGHT = 0.6;

/** Maximum candidates returned. UI shows exactly 3 cards. */
export const TOP_N_DEFAULT = 3;

export interface SmartSlot {
  stylistId: StylistId;
  stylistName: string;
  dayIndex: number;
  /** Wall-clock minute (e.g. 13:15 = 795). */
  startMinute: number;
  /** End minute = startMinute + service.totalMinutes. */
  endMinute: number;
  /** Service the customer asked for. */
  serviceCategory: ServiceCategory;
  /** Lower is better. See module docstring for the formula. */
  score: number;
  /** Component breakdown for debugging + UI tooltip. */
  gapBeforeMinutes: number;
  gapAfterMinutes: number;
  /**
   * Short human label that the UI uses as a chip:
   *   "Perfect fit"     score === 0
   *   "Good fit"        score < 30
   *   "Open afternoon"  otherwise
   * Phrasing locked at module level so all callers stay consistent.
   */
  reason: "Perfect fit" | "Good fit" | "Open window";
  /**
   * If the candidate happens to ALSO fit inside an existing customer's
   * processing window (Pilot 2 §1 "overlap auctioneer" feature), we
   * surface that fact so the operator + LLM can lead with it. Optional.
   */
  hostAppointmentId?: string;
  hostServiceCategory?: ServiceCategory;
}

export interface SuggestSlotsOptions {
  /** Service the customer asked for. Required. */
  serviceCategory: ServiceCategory;
  /** Optional: how many candidates to return. Defaults to TOP_N_DEFAULT. */
  topN?: number;
  /** Optional cursor — only consider slots starting at/after this point. */
  now?: { dayIndex: number; minute: number };
  /** Optional: filter to a specific stylist (e.g. customer.preferredStylist). */
  stylistId?: StylistId;
  /** Optional: limit search to the next N days (1..7). Defaults to 7. */
  maxDays?: number;
  /**
   * Optional: pre-fetched week of appointments. Lets unit tests inject
   * synthetic timelines without mutating the shared seed array.
   */
  weekAppointments?: SalonAppointment[];
}

/* ----- helpers (exported for tests) ----- */

/**
 * Compute the gap (in minutes) from `candidateStart` back to the END of
 * the nearest earlier booking on the same stylist+day. Returns the open
 * hour wall (`startMinute - OPEN_MINUTE`) if nothing comes before, and
 * caps the value at SLOT_LOOKAHEAD_MINUTES so empty mornings don't
 * dominate the score.
 */
export function gapBefore(
  candidateStart: number,
  dayAppointments: SalonAppointment[],
  service: { totalMinutes: number },
): number {
  void service; // reserved for future per-service buffer logic
  let nearestEnd = OPEN_MINUTE;
  for (const a of dayAppointments) {
    // Existing schema doesn't store endMinute, so we look it up via service
    // duration. Caller (suggestOptimalSlots) computes that and passes it
    // via the shared lookup below.
    const aEnd = appointmentEnd(a);
    if (aEnd <= candidateStart && aEnd > nearestEnd) nearestEnd = aEnd;
  }
  const raw = candidateStart - nearestEnd;
  return Math.min(SLOT_LOOKAHEAD_MINUTES, Math.max(0, raw));
}

/** Symmetric of gapBefore, looking forward to the next booking's start. */
export function gapAfter(
  candidateEnd: number,
  dayAppointments: SalonAppointment[],
): number {
  let nearestStart = CLOSE_MINUTE;
  for (const a of dayAppointments) {
    if (a.startMinute >= candidateEnd && a.startMinute < nearestStart) {
      nearestStart = a.startMinute;
    }
  }
  const raw = nearestStart - candidateEnd;
  return Math.min(SLOT_LOOKAHEAD_MINUTES, Math.max(0, raw));
}

/**
 * The score, isolated so tests can pin the formula independently of
 * the slot generator + ranker.
 */
export function scoreSlot(gapBeforeMin: number, gapAfterMin: number): number {
  return gapBeforeMin * 1.0 + gapAfterMin * GAP_AFTER_WEIGHT;
}

/** Convert a raw score into the UI chip label. */
export function reasonForScore(
  score: number,
): "Perfect fit" | "Good fit" | "Open window" {
  if (score === 0) return "Perfect fit";
  if (score < 30) return "Good fit";
  return "Open window";
}

/**
 * Cached per-call appointment-end lookup. We compute service durations
 * eagerly so gapBefore can stay synchronous.
 */
const _apptEndCache = new WeakMap<SalonAppointment, number>();
function appointmentEnd(a: SalonAppointment): number {
  const cached = _apptEndCache.get(a);
  if (cached !== undefined) return cached;
  return a.startMinute; // fallback: should be overwritten before use
}

/* ----- main entry point ----- */

export async function suggestOptimalSlots(
  opts: SuggestSlotsOptions,
): Promise<SmartSlot[]> {
  const service = await getService(opts.serviceCategory);
  if (!service) return [];

  const maxDays = Math.max(1, Math.min(7, opts.maxDays ?? 7));
  const topN = Math.max(1, Math.min(10, opts.topN ?? TOP_N_DEFAULT));

  const week =
    opts.weekAppointments ?? (await listAppointmentsForWeek());
  // Annotate each appointment with its true end so gapBefore/gapAfter
  // are O(N) over the day.
  for (const appt of week) {
    if (_apptEndCache.has(appt)) continue;
    const apptSvc = await getService(appt.serviceCategory);
    _apptEndCache.set(
      appt,
      appt.startMinute + (apptSvc?.totalMinutes ?? service.totalMinutes),
    );
  }

  const candidates: SmartSlot[] = [];
  const eligibleStylists = SEED_STYLISTS.filter((s) => {
    if (!s.capabilities.includes(opts.serviceCategory)) return false;
    if (opts.stylistId && s.id !== opts.stylistId) return false;
    return true;
  });

  for (let day = 0; day < maxDays; day++) {
    const dayAppts = week.filter((a) => a.dayIndex === day);

    for (const stylist of eligibleStylists) {
      const stylistAppts = dayAppts.filter(
        (a) => a.stylistId === stylist.id && a.status !== "no_show",
      );

      for (
        let start = OPEN_MINUTE;
        start + service.totalMinutes <= CLOSE_MINUTE;
        start += SLOT_GRANULARITY
      ) {
        const end = start + service.totalMinutes;

        // 1) Future cursor.
        if (opts.now) {
          if (
            day < opts.now.dayIndex ||
            (day === opts.now.dayIndex && start < opts.now.minute)
          ) {
            continue;
          }
        }

        // 2) Conflict check — candidate must not overlap any existing
        //    booking on this stylist+day.
        const conflict = stylistAppts.some((a) => {
          const aEnd = appointmentEnd(a);
          return start < aEnd && end > a.startMinute;
        });
        if (conflict) continue;

        // 3) Score it.
        const gBefore = gapBefore(start, stylistAppts, service);
        const gAfter = gapAfter(end, stylistAppts);
        const score = scoreSlot(gBefore, gAfter);

        // 4) Optional: is this candidate ALSO sitting inside a host's
        //    processing window? That's the overlap auctioneer's signature
        //    "no wait" placement.
        let hostId: string | undefined;
        let hostSvcCat: ServiceCategory | undefined;
        for (const host of stylistAppts) {
          const hostSvc = await getService(host.serviceCategory);
          if (!hostSvc || hostSvc.processingMinutes <= 0) continue;
          const activePrep =
            Math.max(0, hostSvc.totalMinutes - hostSvc.processingMinutes) / 2;
          const procStart = host.startMinute + activePrep;
          const procEnd = procStart + hostSvc.processingMinutes;
          if (start >= procStart && end <= procEnd) {
            hostId = host.id;
            hostSvcCat = host.serviceCategory;
            break;
          }
        }

        candidates.push({
          stylistId: stylist.id,
          stylistName: stylist.name,
          dayIndex: day,
          startMinute: start,
          endMinute: end,
          serviceCategory: opts.serviceCategory,
          score,
          gapBeforeMinutes: gBefore,
          gapAfterMinutes: gAfter,
          reason: reasonForScore(score),
          hostAppointmentId: hostId,
          hostServiceCategory: hostSvcCat,
        });
      }
    }
  }

  // Stable sort by (score asc, day asc, start asc) so the ranking is
  // deterministic for tests + demo.
  candidates.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
    return a.startMinute - b.startMinute;
  });

  return candidates.slice(0, topN);
}
