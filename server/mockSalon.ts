/* ============================================================
 * Mock Salon POS — in-memory seed data + query helpers
 * ============================================================
 *
 * Why in-memory (not DB-backed like mockCleanCloud)?
 *   - Pilot 2 (Salon) demo is exploratory; we have not committed to a
 *     real customer yet. Adding 5 new tables + migrations for a demo
 *     that may pivot is over-engineering.
 *   - Once a real salon partner signs on, this module's *interface*
 *     stays the same — we just swap the data source from constants
 *     to Drizzle queries (mirroring mockCleanCloud).
 *   - All helpers are pure async functions to keep that future swap
 *     mechanical: today they resolve in <1ms; tomorrow they hit DB.
 *
 * Time model
 *   - All times are minutes-since-epoch-of-the-demo-week (mod 10080).
 *   - Day index 0 = Monday. Slot granularity 15 minutes.
 *   - Helpers expose conversion to Date / "Sat 14:00" labels.
 */

export type StylistId = "hayley" | "jisoo" | "soomin";

export interface SalonStylist {
  id: StylistId;
  name: string;
  title: string;
  hourlyRateUsd: number;
  /** Service categories this stylist can perform */
  capabilities: ReadonlyArray<ServiceCategory>;
  bio: string;
}

export type ServiceCategory =
  | "cut"
  | "perm"
  | "color"
  | "balayage"
  | "manicure"
  | "pedicure"
  | "hairspa";

export interface SalonService {
  category: ServiceCategory;
  name: string;
  /** Total chair time in minutes (active + processing) */
  totalMinutes: number;
  /**
   * Processing time in minutes — interval during which the stylist
   * is *not* hands-on with this customer (e.g. perm solution
   * developing). Other customers can be slotted into this gap if
   * the stylist is capable of the second service.
   */
  processingMinutes: number;
  priceLowUsd: number;
  priceHighUsd: number;
  description: string;
}

export interface SalonCustomer {
  id: string;
  phone: string;
  name: string;
  vipTier: "none" | "regular" | "vip";
  preferredStylist?: StylistId;
  notes: string;
  noShowCount: number;
}

export interface SalonAppointment {
  id: string;
  customerId: string;
  stylistId: StylistId;
  serviceCategory: ServiceCategory;
  /** Day index 0=Mon..6=Sun (current demo week) */
  dayIndex: number;
  /** Start time in minutes from midnight (e.g. 14:00 = 840) */
  startMinute: number;
  status: "confirmed" | "tentative" | "completed";
}

/** Open hours: 10:00–20:00 daily. */
export const OPEN_MINUTE = 10 * 60;
export const CLOSE_MINUTE = 20 * 60;
export const SLOT_GRANULARITY = 15;

export const SEED_STYLISTS: SalonStylist[] = [
  {
    id: "hayley",
    name: "Hayley Park",
    title: "Senior Stylist",
    hourlyRateUsd: 80,
    capabilities: ["cut", "perm", "color", "balayage", "hairspa"],
    bio: "10+ years. Editorial + bridal specialist.",
  },
  {
    id: "jisoo",
    name: "Jisoo Min",
    title: "Color Specialist",
    hourlyRateUsd: 70,
    capabilities: ["cut", "color", "balayage", "hairspa"],
    bio: "Balayage and gloss treatments. Trained in Tokyo.",
  },
  {
    id: "soomin",
    name: "Soomin Yoon",
    title: "Junior Stylist",
    hourlyRateUsd: 50,
    capabilities: ["cut", "manicure", "pedicure", "hairspa"],
    bio: "Quick cuts, blow-dries, and nail services.",
  },
];

export const SEED_SERVICES: SalonService[] = [
  {
    category: "cut",
    name: "Cut & Style",
    totalMinutes: 45,
    processingMinutes: 0,
    priceLowUsd: 40,
    priceHighUsd: 80,
    description: "Wash, cut, and blow-dry style.",
  },
  {
    category: "perm",
    name: "Perm",
    totalMinutes: 180,
    processingMinutes: 90,
    priceLowUsd: 120,
    priceHighUsd: 200,
    description: "Includes 90-min processing window where stylist is free.",
  },
  {
    category: "color",
    name: "Single-Process Color",
    totalMinutes: 150,
    processingMinutes: 60,
    priceLowUsd: 100,
    priceHighUsd: 250,
    description: "60-min processing window — stylist available for short services.",
  },
  {
    category: "balayage",
    name: "Balayage",
    totalMinutes: 240,
    processingMinutes: 120,
    priceLowUsd: 250,
    priceHighUsd: 400,
    description: "Hand-painted highlights with 2-hour processing window.",
  },
  {
    category: "manicure",
    name: "Classic Manicure",
    totalMinutes: 40,
    processingMinutes: 0,
    priceLowUsd: 25,
    priceHighUsd: 40,
    description: "File, cuticle, polish.",
  },
  {
    category: "pedicure",
    name: "Spa Pedicure",
    totalMinutes: 50,
    processingMinutes: 0,
    priceLowUsd: 35,
    priceHighUsd: 50,
    description: "Soak, exfoliation, polish.",
  },
  {
    category: "hairspa",
    name: "Hair Spa Treatment",
    totalMinutes: 30,
    processingMinutes: 0,
    priceLowUsd: 50,
    priceHighUsd: 50,
    description: "Deep conditioning + scalp massage.",
  },
];

export const SEED_CUSTOMERS: SalonCustomer[] = [
  {
    id: "c-jessica",
    phone: "+15550201001",
    name: "Jessica Kim",
    vipTier: "regular",
    preferredStylist: "hayley",
    notes: "Monthly perm + color. Allergic to ammonia bleach.",
    noShowCount: 0,
  },
  {
    id: "c-sarah",
    phone: "+15550201002",
    name: "Sarah Lee",
    vipTier: "vip",
    preferredStylist: "jisoo",
    notes: "VIP — color every 4 weeks, balayage seasonally.",
    noShowCount: 0,
  },
  {
    id: "c-emily",
    phone: "+15550201003",
    name: "Emily Park",
    vipTier: "none",
    preferredStylist: "soomin",
    notes: "Cut every 6 weeks. Walk-in friendly.",
    noShowCount: 0,
  },
  {
    id: "c-cindy",
    phone: "+15550201004",
    name: "Cindy Choi",
    vipTier: "none",
    notes: "First-time customer (referred by Jessica).",
    noShowCount: 0,
  },
  {
    id: "c-jihoon",
    phone: "+15550201005",
    name: "Jihoon Park",
    vipTier: "none",
    preferredStylist: "soomin",
    notes: "Frequent no-show — prompt for deposit.",
    noShowCount: 1,
  },
  {
    id: "c-yeonhee",
    phone: "+15550201006",
    name: "Yeonhee Jung",
    vipTier: "vip",
    preferredStylist: "hayley",
    notes: "VIP — averages $300+ per visit.",
    noShowCount: 0,
  },
  {
    id: "c-olivia",
    phone: "+15550201007",
    name: "Olivia Choi",
    vipTier: "regular",
    preferredStylist: "hayley",
    notes: "Wedding in 8 weeks — multiple bookings active.",
    noShowCount: 0,
  },
];

/**
 * Demo-week appointments (5 confirmed). Times chosen so the overlap
 * auctioneer has obvious gaps to exploit:
 *
 *   - Sarah's Saturday balayage (10:00–14:00) on Jisoo has 2h
 *     processing → another customer can be slotted with Jisoo
 *     somewhere in 11:00–13:00 for a short service like cut/manicure.
 *   - Jessica's Wednesday perm (13:00–16:00) on Hayley has 90-min
 *     processing → Hayley free 14:30–16:00 for cut.
 */
export const SEED_APPOINTMENTS: SalonAppointment[] = [
  {
    id: "appt-1",
    customerId: "c-jessica",
    stylistId: "hayley",
    serviceCategory: "perm",
    dayIndex: 2, // Wed
    startMinute: 13 * 60, // 13:00
    status: "confirmed",
  },
  {
    id: "appt-2",
    customerId: "c-sarah",
    stylistId: "jisoo",
    serviceCategory: "balayage",
    dayIndex: 5, // Sat
    startMinute: 10 * 60, // 10:00
    status: "confirmed",
  },
  {
    id: "appt-3",
    customerId: "c-emily",
    stylistId: "soomin",
    serviceCategory: "cut",
    dayIndex: 1, // Tue
    startMinute: 18 * 60, // 18:00
    status: "confirmed",
  },
  {
    id: "appt-4",
    customerId: "c-yeonhee",
    stylistId: "hayley",
    serviceCategory: "color",
    dayIndex: 4, // Fri
    startMinute: 11 * 60, // 11:00
    status: "confirmed",
  },
  {
    id: "appt-5",
    customerId: "c-olivia",
    stylistId: "hayley",
    serviceCategory: "balayage",
    dayIndex: 6, // Sun
    startMinute: 12 * 60, // 12:00
    status: "tentative",
  },
];

/* ----- query helpers ----- */

export async function getSalonCustomerByPhone(
  phone: string,
): Promise<SalonCustomer | null> {
  return SEED_CUSTOMERS.find((c) => c.phone === phone) ?? null;
}

export async function getStylist(id: StylistId): Promise<SalonStylist | null> {
  return SEED_STYLISTS.find((s) => s.id === id) ?? null;
}

export async function getService(
  category: ServiceCategory,
): Promise<SalonService | null> {
  return SEED_SERVICES.find((s) => s.category === category) ?? null;
}

export async function listAppointmentsForWeek(): Promise<SalonAppointment[]> {
  // Returns a defensive copy so callers can sort/mutate without affecting
  // the seed source. Ordering is "as-stored" — UI sorts by day+start.
  return SEED_APPOINTMENTS.map((a) => ({ ...a }));
}

export async function listAppointmentsForCustomer(
  customerId: string,
): Promise<SalonAppointment[]> {
  return SEED_APPOINTMENTS.filter((a) => a.customerId === customerId).map(
    (a) => ({ ...a }),
  );
}

export async function listServices(): Promise<SalonService[]> {
  return SEED_SERVICES.map((s) => ({ ...s }));
}

export async function listStylists(): Promise<SalonStylist[]> {
  return SEED_STYLISTS.map((s) => ({ ...s }));
}

/* ----- overlap auctioneer (the killer feature) ----- */

export interface OverlapSlot {
  stylistId: StylistId;
  stylistName: string;
  dayIndex: number;
  /** Start of the candidate slot in minutes from midnight */
  startMinute: number;
  /** Length of the available gap in minutes */
  durationMinutes: number;
  /**
   * The "host" appointment this gap is carved from (the appointment
   * that is currently in its processing window, freeing the stylist).
   * Useful for the UI to highlight "Sarah's color processing
   * 11:00-12:30" alongside the candidate slot.
   */
  hostAppointmentId: string;
  hostCustomerId: string;
  hostServiceCategory: ServiceCategory;
}

/**
 * Find slots where a stylist is available *during another customer's
 * processing time*. This is the magic — competitors don't surface
 * these because their schedulers treat appointments as opaque blocks.
 *
 * @param requestedService   What the new customer wants
 * @param maxDays            How many days into the demo week to scan (default 7)
 * @param now                Optional: filter out slots that started before `now`
 *                           Caller passes `{ dayIndex, minute }` if scoping
 *                           to "from now onwards".
 */
export async function findOverlapSlots(
  requestedService: ServiceCategory,
  maxDays = 7,
  now?: { dayIndex: number; minute: number },
): Promise<OverlapSlot[]> {
  const service = await getService(requestedService);
  if (!service) return [];
  // Overlap requires the requested service to fit *inside* a host's
  // processing gap. If the requested service itself has no end-to-end
  // active time available, we still need it to be short enough to fit.
  const requiredMinutes = service.totalMinutes - service.processingMinutes;
  if (requiredMinutes <= 0) return [];

  const slots: OverlapSlot[] = [];
  const stylists = SEED_STYLISTS;

  for (const appt of SEED_APPOINTMENTS) {
    if (appt.status !== "confirmed") continue;
    if (appt.dayIndex >= maxDays) continue;
    const hostService = await getService(appt.serviceCategory);
    if (!hostService || hostService.processingMinutes <= 0) continue;
    // Processing window: the middle slice of the host appointment.
    // Convention: active prep at the start, processing in the middle,
    // brief active finish at the end. We model the processing window
    // as [start + active_prep .. start + active_prep + processing).
    const activePrep = Math.max(
      0,
      hostService.totalMinutes - hostService.processingMinutes,
    ) / 2;
    const procStart = appt.startMinute + activePrep;
    const procEnd = procStart + hostService.processingMinutes;

    for (const stylist of stylists) {
      // Only consider the *same* stylist (they're the one freed by
      // their own customer's processing time).
      if (stylist.id !== appt.stylistId) continue;
      if (!stylist.capabilities.includes(requestedService)) continue;

      // Does the requested service fit inside the processing window?
      if (procEnd - procStart < requiredMinutes) continue;

      // Filter against "now" if caller scopes future-only.
      if (now) {
        if (
          appt.dayIndex < now.dayIndex ||
          (appt.dayIndex === now.dayIndex && procStart < now.minute)
        ) {
          continue;
        }
      }

      slots.push({
        stylistId: stylist.id,
        stylistName: stylist.name,
        dayIndex: appt.dayIndex,
        startMinute: procStart,
        durationMinutes: hostService.processingMinutes,
        hostAppointmentId: appt.id,
        hostCustomerId: appt.customerId,
        hostServiceCategory: appt.serviceCategory,
      });
    }
  }
  return slots;
}

/* ----- formatting helpers (used by both server and UI) ----- */

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${suffix}`;
}

export function formatSlot(
  dayIndex: number,
  startMinute: number,
  durationMinutes: number,
): string {
  const day = DAY_NAMES[dayIndex] ?? `Day ${dayIndex}`;
  return `${day} ${formatMinute(startMinute)} – ${formatMinute(startMinute + durationMinutes)}`;
}

export function formatPriceRange(svc: SalonService): string {
  if (svc.priceLowUsd === svc.priceHighUsd) return `$${svc.priceLowUsd}`;
  return `$${svc.priceLowUsd}–$${svc.priceHighUsd}`;
}


/* ----- demo-only mutations (in-memory; resets on server restart) ----- */

let _apptCounter = SEED_APPOINTMENTS.length;
const _runtimeAppointments: SalonAppointment[] = [];

/**
 * Append a freshly-confirmed appointment to the current week.
 * Used by the closed-loop demo: when an operator clicks "Approve & Send"
 * on an AI-drafted booking, the agent calls this to materialize the
 * booking on the timeline. Lives in memory; refresh = clean slate.
 */
export async function insertAppointment(
  input: Omit<SalonAppointment, "id"> & { id?: string },
): Promise<SalonAppointment> {
  const id = input.id ?? `appt-runtime-${++_apptCounter}`;
  const appt: SalonAppointment = {
    id,
    customerId: input.customerId,
    stylistId: input.stylistId,
    serviceCategory: input.serviceCategory,
    dayIndex: input.dayIndex,
    startMinute: input.startMinute,
    status: input.status ?? "confirmed",
  };
  // Keep both arrays in sync so the existing query helpers (which read
  // SEED_APPOINTMENTS) and any future runtime-only readers see it.
  SEED_APPOINTMENTS.push(appt);
  _runtimeAppointments.push(appt);
  return { ...appt };
}

/**
 * Reset the demo back to the seed week. Useful for the "Reset demo"
 * button in the UI.
 */
export async function resetSalonRuntime(): Promise<void> {
  // Drop runtime-added appointments from SEED_APPOINTMENTS.
  for (const appt of _runtimeAppointments) {
    const idx = SEED_APPOINTMENTS.indexOf(appt);
    if (idx >= 0) SEED_APPOINTMENTS.splice(idx, 1);
  }
  _runtimeAppointments.length = 0;
}

export function _getRuntimeAppointmentCount(): number {
  return _runtimeAppointments.length;
}
