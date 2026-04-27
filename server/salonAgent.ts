import { invokeLLM } from "./_core/llm";
import {
  DAY_NAMES,
  findOverlapSlots,
  formatPriceRange,
  formatSlot,
  getSalonCustomerByPhone,
  getService,
  listAppointmentsForCustomer,
  listServices,
  listStylists,
  type OverlapSlot,
  type ServiceCategory,
  type SalonStylist,
} from "./mockSalon";
import {
  SALON_INTENT_LABELS,
  type SalonIntent,
  classifySalonIntent,
} from "./salonIntents";
import { guessSalonService } from "../shared/serviceGuess";

/* ============================================================
 * Salon Agent — intent classification + draft generation
 * ------------------------------------------------------------
 * Mirrors aiAgent.draftAgentReply():
 *   1. classify intent (with fail-safe escalation)
 *   2. tool dispatch (lookup customer, services, overlap slots)
 *   3. generate reply (LLM with brand voice + tool context)
 *
 * The KEY differentiator vs aiAgent is the overlap auctioneer:
 * for booking-related intents we eagerly call findOverlapSlots()
 * and surface those candidate slots to the LLM. The reply is
 * instructed to mention the overlap window explicitly so the
 * customer (and the demo audience) sees the "magic" — the AI
 * is squeezing a 45-min cut into another customer's perm
 * processing window, something competitors don't surface.
 * ============================================================ */

export interface SalonAgentStep {
  step:
    | "intent_detected"
    | "mock_api_called"
    | "overlap_search"
    | "response_drafted"
    | "escalated";
  label: string;
  detail?: unknown;
}

export interface SalonAgentDraftResult {
  intent: SalonIntent;
  reply: string | null; // null when escalated
  escalated: boolean;
  escalationReason?: string;
  steps: SalonAgentStep[];
  toolContext: Record<string, unknown>;
  /**
   * Overlap slots surfaced to the LLM (and the demo UI). The UI
   * highlights these in the CalendarTimeline as dashed green boxes
   * stacked on top of the host appointment's processing window.
   */
  overlapSlots: OverlapSlot[];
}

const BRAND_VOICE = `You are the official SMS assistant for a high-end Korean hair salon.
Voice: warm, modern, concise, never pushy. Bilingual-friendly (English first, with a short Korean echo only if the customer wrote in Korean). Always sign off with a single line "— the salon".
Rules:
- Keep replies under 320 characters when possible.
- Never invent prices, stylist names, or appointment times — use only what the tool data provides.
- Never confirm a booking unless the data shows a real candidate slot.
- Use the customer's first name if known.
- When overlap slots are available for a booking request, lead with the soonest one and explicitly explain that this slot opens up during another customer's processing window — that framing is the salon's signature "no wait" experience.
- For Critical Escalation cases, do not draft any reply (the system will return null).`;

/* ----- Intent → service guess (lightweight regex over message body) ----- */
// Backed by `shared/serviceGuess` so the client and server can never drift.
export function guessServiceCategory(body: string): ServiceCategory | null {
  return guessSalonService(body) as ServiceCategory | null;
}

/* ----- Tool context formatter ----- */

function formatToolBlock(toolContext: Record<string, unknown>): string {
  return JSON.stringify(toolContext, null, 2);
}

function formatOverlapBlock(slots: OverlapSlot[]): string {
  if (slots.length === 0) return "";
  return (
    "OVERLAP SLOTS — these are open windows during another customer's processing time:\n" +
    slots
      .slice(0, 4)
      .map(
        (s, i) =>
          `${i + 1}. ${formatSlot(s.dayIndex, s.startMinute, s.durationMinutes)} with ${s.stylistName} (during a customer's ${s.hostServiceCategory} processing)`,
      )
      .join("\n")
  );
}

async function generateReply(opts: {
  body: string;
  intent: SalonIntent;
  toolContext: Record<string, unknown>;
  overlapSlots: OverlapSlot[];
  managerRejectReason?: string;
}): Promise<string> {
  const overlapBlock = formatOverlapBlock(opts.overlapSlots);
  const regenHint = opts.managerRejectReason
    ? `\n\nIMPORTANT — the manager just rejected the previous draft with reason: """${opts.managerRejectReason}""". Rewrite the reply so it clearly addresses that feedback.`
    : "";

  const res = await invokeLLM({
    messages: [
      { role: "system", content: BRAND_VOICE },
      {
        role: "user",
        content:
          `Intent: ${opts.intent}\n` +
          `Customer message: """${opts.body}"""\n\n` +
          `Tool data:\n${formatToolBlock(opts.toolContext)}\n\n` +
          (overlapBlock ? `${overlapBlock}\n\n` : "") +
          `Compose the SMS reply for the salon.${regenHint}`,
      },
    ],
  });
  const out = res.choices?.[0]?.message?.content;
  return typeof out === "string"
    ? out.trim()
    : "Thanks for reaching the salon. We'll get back to you shortly.\n— the salon";
}

/* ----- Main entry: draft generation ----- */

export interface DraftSalonReplyOpts {
  phone: string;
  body: string;
  managerRejectReason?: string;
  intentOverride?: SalonIntent;
  /**
   * Optional "now" cursor for findOverlapSlots filtering. The demo
   * UI may pass a fixed Mon 09:00 so the overlap suggestions are
   * deterministic regardless of wall-clock.
   */
  now?: { dayIndex: number; minute: number };
}

export async function draftSalonReply(
  opts: DraftSalonReplyOpts,
): Promise<SalonAgentDraftResult> {
  const steps: SalonAgentStep[] = [];

  const intent = opts.intentOverride ?? (await classifySalonIntent(opts.body));
  steps.push({
    step: "intent_detected",
    label: `Intent classified as ${intent}`,
    detail: { intent },
  });

  if (intent === "Critical Escalation") {
    const reason =
      "Critical message detected — auto-reply suspended, manager paged.";
    steps.push({
      step: "escalated",
      label: reason,
      detail: { phone: opts.phone, body: opts.body },
    });
    return {
      intent,
      reply: null,
      escalated: true,
      escalationReason: reason,
      steps,
      toolContext: {},
      overlapSlots: [],
    };
  }

  /* ----- tool dispatch ----- */

  const customer = await getSalonCustomerByPhone(opts.phone);
  const toolContext: Record<string, unknown> = {
    customer: customer
      ? {
          name: customer.name,
          vipTier: customer.vipTier,
          preferredStylist: customer.preferredStylist,
          notes: customer.notes,
          noShowCount: customer.noShowCount,
        }
      : {
          found: false,
          note: "Phone not found in salon CRM — treat as new lead.",
        },
  };
  steps.push({
    step: "mock_api_called",
    label: customer
      ? `getSalonCustomerByPhone(${opts.phone}) → ${customer.name} [${customer.vipTier}]`
      : `getSalonCustomerByPhone(${opts.phone}) → not found`,
    detail: toolContext.customer,
  });

  // Always include the live stylist roster + service catalog so the LLM
  // never invents names, prices, or capabilities.
  const [stylists, services] = await Promise.all([
    listStylists(),
    listServices(),
  ]);
  toolContext.stylists = stylists.map((s: SalonStylist) => ({
    id: s.id,
    name: s.name,
    title: s.title,
    capabilities: s.capabilities,
  }));
  toolContext.serviceCatalog = services.map((s) => ({
    category: s.category,
    name: s.name,
    totalMinutes: s.totalMinutes,
    processingMinutes: s.processingMinutes,
    price: formatPriceRange(s),
    description: s.description,
  }));
  steps.push({
    step: "mock_api_called",
    label: `listStylists() + listServices() → ${stylists.length} stylists, ${services.length} services`,
    detail: { stylistCount: stylists.length, serviceCount: services.length },
  });

  /* ----- intent-specific tool dispatch ----- */

  if (intent === "Reschedule" || intent === "Cancel") {
    const appts = customer
      ? await listAppointmentsForCustomer(customer.id)
      : [];
    toolContext.existingAppointments = appts.map((a) => ({
      id: a.id,
      stylistId: a.stylistId,
      service: a.serviceCategory,
      when: formatSlot(a.dayIndex, a.startMinute, 0).split(" – ")[0],
      status: a.status,
    }));
    steps.push({
      step: "mock_api_called",
      label: `listAppointmentsForCustomer(${customer?.id ?? "unknown"}) → ${appts.length} appt(s)`,
      detail: toolContext.existingAppointments,
    });
  }

  /* ----- overlap auctioneer (the killer feature) ----- */

  let overlapSlots: OverlapSlot[] = [];
  if (intent === "Booking Request" || intent === "Availability Check") {
    const guessed = guessServiceCategory(opts.body);
    if (guessed) {
      overlapSlots = await findOverlapSlots(guessed, 7, opts.now);
      const svc = await getService(guessed);
      toolContext.requestedService = svc
        ? {
            category: svc.category,
            name: svc.name,
            totalMinutes: svc.totalMinutes,
            price: formatPriceRange(svc),
          }
        : null;
      toolContext.overlapSlots = overlapSlots.slice(0, 4).map((s) => ({
        stylistName: s.stylistName,
        when: formatSlot(s.dayIndex, s.startMinute, s.durationMinutes),
        hostService: s.hostServiceCategory,
      }));
      steps.push({
        step: "overlap_search",
        label: `findOverlapSlots(${guessed}) → ${overlapSlots.length} candidate slot(s)`,
        detail: toolContext.overlapSlots,
      });
    } else {
      steps.push({
        step: "overlap_search",
        label: `findOverlapSlots skipped — no service keyword detected in message`,
      });
    }
  }

  const reply = await generateReply({
    body: opts.body,
    intent,
    toolContext,
    overlapSlots,
    managerRejectReason: opts.managerRejectReason,
  });
  steps.push({
    step: "response_drafted",
    label: opts.managerRejectReason
      ? `Regenerated salon draft (${reply.length} chars) after manager feedback`
      : `Drafted salon reply (${reply.length} chars) — awaiting approval`,
    detail: { reply },
  });

  return {
    intent,
    reply,
    escalated: false,
    steps,
    toolContext,
    overlapSlots,
  };
}

// Re-export for downstream convenience
export { SALON_INTENT_LABELS, DAY_NAMES, type SalonIntent };


/* ============================================================
 * Phase 3 — Gap Filler outreach drafting
 * ------------------------------------------------------------
 * Given a freed appointment slot and a ranked list of candidate
 * customers, generate one short SMS draft per candidate. Each
 * draft is keyed to that candidate's history (VIP framing for
 * tier=vip, "we noticed you usually book..." for service-fit).
 *
 * The pipeline is deterministic when invokeLLM is mocked, and
 * each draft is wrapped with the metadata the UI needs to commit
 * the booking via the existing `salon.approveBooking` mutation
 * (customerId + stylistId + serviceCategory + dayIndex + start).
 * ============================================================ */

import {
  findGapFillerCandidates,
  findProcessingWindowsEndingSoon,
  getService as getServiceFn,
  formatMinute,
  formatPriceRange as formatPriceRangeFn,
  markAppointmentNoShow,
  type GapFillerCandidate,
  type ProcessingReminder,
  type SalonAppointment,
  type SalonCustomer,
} from "./mockSalon";

export interface GapFillerDraft {
  candidate: GapFillerCandidate;
  reply: string;
  /** Booking we will commit if the operator approves this draft. */
  bookingDraft: {
    customerId: string;
    stylistId: SalonAppointment["stylistId"];
    serviceCategory: SalonAppointment["serviceCategory"];
    dayIndex: number;
    startMinute: number;
  };
}

export interface GapFillerResult {
  freedAppointment: SalonAppointment;
  drafts: GapFillerDraft[];
  steps: SalonAgentStep[];
}

const GAP_FILLER_VOICE = `${BRAND_VOICE}
You are now writing a one-time, time-sensitive outreach SMS to a single customer.
- Open with their first name.
- State the freed slot clearly (day + time).
- Mention a soft incentive (e.g. "this week only — 30% off") only when the customer is VIP or has a no-show penalty (to win them back).
- Keep it under 240 characters.
- Do not mention the no-show customer by name.`;

async function generateGapFillerReply(opts: {
  candidate: GapFillerCandidate;
  freedAppointment: SalonAppointment;
  serviceLabel: string;
  priceLabel: string;
  whenLabel: string;
}): Promise<string> {
  const incentive =
    opts.candidate.vipTier === "vip"
      ? "(VIP-only: 30% off this slot if you can take it)"
      : "(20% off if you can grab it today)";
  const res = await invokeLLM({
    messages: [
      { role: "system", content: GAP_FILLER_VOICE },
      {
        role: "user",
        content:
          `Customer: ${opts.candidate.customerName} (${opts.candidate.vipTier})\n` +
          `Reasoning surfaced by ranking: ${opts.candidate.reasoning}\n` +
          `Freed slot: ${opts.whenLabel} for ${opts.serviceLabel} (${opts.priceLabel}).\n` +
          `Incentive framing to use: ${incentive}\n\n` +
          `Compose the outreach SMS.`,
      },
    ],
  });
  const out = res.choices?.[0]?.message?.content;
  return typeof out === "string"
    ? out.trim()
    : `Hi ${opts.candidate.customerName.split(" ")[0]}, a ${opts.serviceLabel} slot just opened ${opts.whenLabel}. ${incentive}\n— the salon`;
}

/**
 * Run the full Gap Filler pipeline: mark the appointment as no-show,
 * rank top-N candidates, and draft one outreach SMS per candidate.
 */
export async function runGapFillerPipeline(opts: {
  appointmentId: string;
  topN?: number;
}): Promise<GapFillerResult> {
  const steps: SalonAgentStep[] = [];

  const freed = await markAppointmentNoShow(opts.appointmentId);
  if (!freed) {
    throw new Error(`Appointment ${opts.appointmentId} not found`);
  }
  steps.push({
    step: "mock_api_called",
    label: `markAppointmentNoShow(${opts.appointmentId}) → freed ${freed.serviceCategory} on day ${freed.dayIndex} @ ${formatMinute(freed.startMinute)}`,
    detail: { freed },
  });

  const candidates = await findGapFillerCandidates(freed, opts.topN ?? 3);
  steps.push({
    step: "mock_api_called",
    label: `findGapFillerCandidates(top ${opts.topN ?? 3}) → ${candidates.length} candidate(s)`,
    detail: candidates,
  });

  const svc = await getServiceFn(freed.serviceCategory);
  const serviceLabel = svc?.name ?? freed.serviceCategory;
  const priceLabel = svc ? formatPriceRangeFn(svc) : "see catalog";
  const dayName = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][
    freed.dayIndex
  ];
  const whenLabel = `${dayName} at ${formatMinute(freed.startMinute)}`;

  const drafts: GapFillerDraft[] = [];
  for (const candidate of candidates) {
    const reply = await generateGapFillerReply({
      candidate,
      freedAppointment: freed,
      serviceLabel,
      priceLabel,
      whenLabel,
    });
    drafts.push({
      candidate,
      reply,
      bookingDraft: {
        customerId: candidate.customerId,
        stylistId: freed.stylistId,
        serviceCategory: freed.serviceCategory,
        dayIndex: freed.dayIndex,
        startMinute: freed.startMinute,
      },
    });
    steps.push({
      step: "response_drafted",
      label: `Drafted Gap Filler outreach to ${candidate.customerName} (${candidate.vipTier}, score ${candidate.score})`,
      detail: { reply },
    });
  }

  return { freedAppointment: freed, drafts, steps };
}

/* ============================================================
 * Phase 4 — Processing-window stylist reminder drafting
 * ------------------------------------------------------------
 * For each appointment whose processing window ends within the
 * lead time, build a short rinse-alert message addressed to the
 * stylist. These do NOT go to the customer — they are surfaced
 * to the operator panel as an internal nudge.
 *
 * Because these alerts are high-frequency and template-able, we
 * intentionally build them deterministically (no LLM call) to
 * keep cost and latency near zero.
 * ============================================================ */

export interface ProcessingReminderDraft {
  reminder: ProcessingReminder;
  reply: string;
}

export async function runProcessingReminderPipeline(opts: {
  now: { dayIndex: number; minute: number };
  leadMinutes?: number;
}): Promise<{
  reminders: ProcessingReminderDraft[];
  steps: SalonAgentStep[];
}> {
  const steps: SalonAgentStep[] = [];
  const lead = opts.leadMinutes ?? 5;
  const reminders = await findProcessingWindowsEndingSoon(opts.now, lead);
  steps.push({
    step: "mock_api_called",
    label: `findProcessingWindowsEndingSoon(now, lead=${lead}) → ${reminders.length} reminder(s)`,
    detail: reminders,
  });

  const drafts = reminders.map((r) => {
    const firstName = r.customerName.split(" ")[0];
    const stylistFirst = r.stylistName.split(" ")[0];
    const minutesPart =
      r.minutesUntilRinse <= 0
        ? "now"
        : r.minutesUntilRinse === 1
          ? "in 1 min"
          : `in ${r.minutesUntilRinse} min`;
    return {
      reminder: r,
      reply: `${stylistFirst}: ${firstName}'s ${r.serviceCategory} rinse ${minutesPart} (${formatMinute(r.rinseMinute)}). Head back to the chair.`,
    };
  });

  for (const d of drafts) {
    steps.push({
      step: "response_drafted",
      label: `Reminder drafted for ${d.reminder.stylistName} re ${d.reminder.customerName}`,
      detail: d,
    });
  }

  return { reminders: drafts, steps };
}

/**
 * Re-export so tests / router can import without reaching into mockSalon.
 */
export type { GapFillerCandidate, ProcessingReminder, SalonCustomer };
