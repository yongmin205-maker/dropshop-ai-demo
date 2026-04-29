import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
}));

import { fromPartial } from "@total-typescript/shoehorn";
import { invokeLLM } from "./_core/llm";
import { appRouter } from "./routers";

const mockedInvokeLLM = invokeLLM as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
});

function intentJson(intent: string) {
  return {
    choices: [{ message: { content: JSON.stringify({ intent }) } }],
  };
}

function reply(text: string) {
  return {
    choices: [{ message: { content: text } }],
  };
}

function makeCaller() {
  // Salon mutations (draft, approveBooking, resetDemo, simulateNoShow) are
  // adminProcedure as of fix/1. Read-only queries (listAppointments,
  // getCustomer, findOverlapSlots, checkProcessingReminders) work for any
  // role. We always seat an admin so the same helper covers both surfaces.
  return appRouter.createCaller(
    fromPartial<Parameters<typeof appRouter.createCaller>[0]>({
      user: fromPartial<NonNullable<Parameters<typeof appRouter.createCaller>[0]["user"]>>({
        id: 1,
        openId: "salon-test-admin",
        email: "admin@dropshop.test",
        name: "Salon Test Admin",
        loginMethod: "manus",
        role: "admin",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      }),
    }),
  );
}

describe("salon router contracts", () => {
  it("listAppointments returns a flattened week with stylist and service metadata", async () => {
    const caller = makeCaller();
    const out = await caller.salon.listAppointments();
    expect(Array.isArray(out.appointments)).toBe(true);
    expect(out.appointments.length).toBeGreaterThan(0);
    // every appointment carries a human label and stylist name
    for (const a of out.appointments) {
      expect(typeof a.label).toBe("string");
      expect(typeof a.stylistName).toBe("string");
      expect(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).toContain(
        a.dayLabel,
      );
    }
    expect(out.stylists.length).toBeGreaterThanOrEqual(3);
    expect(out.services.length).toBeGreaterThanOrEqual(7);
  });

  it("getCustomer returns null for unknown phone and the customer for known", async () => {
    const caller = makeCaller();
    expect(await caller.salon.getCustomer({ phone: "+15559999999" })).toBeNull();
    const c = await caller.salon.getCustomer({ phone: "+15550201001" });
    expect(c?.name).toBe("Jessica Kim");
  });

  it("findOverlapSlots returns at least one slot for `cut`", async () => {
    const caller = makeCaller();
    const slots = await caller.salon.findOverlapSlots({
      serviceCategory: "cut",
    });
    expect(slots.length).toBeGreaterThan(0);
    // every slot has a label and dayLabel
    for (const s of slots) {
      expect(typeof s.label).toBe("string");
      expect(typeof s.dayLabel).toBe("string");
    }
  });

  it("findOverlapSlots respects maxDays input", async () => {
    const caller = makeCaller();
    const all = await caller.salon.findOverlapSlots({
      serviceCategory: "cut",
    });
    const limited = await caller.salon.findOverlapSlots({
      serviceCategory: "cut",
      maxDays: 2,
    });
    expect(limited.length).toBeLessThanOrEqual(all.length);
  });

  it("draft mutation generates a salon reply with overlap slots for booking", async () => {
    mockedInvokeLLM
      .mockResolvedValueOnce(intentJson("Booking Request"))
      .mockResolvedValueOnce(reply("Wed 2:30 PM with Hayley works.\n— the salon"));
    const caller = makeCaller();
    const out = await caller.salon.draft({
      phone: "+15550201001",
      body: "any opening for a cut this week?",
    });
    expect(out.escalated).toBe(false);
    expect(out.intent).toBe("Booking Request");
    expect(out.overlapSlots.length).toBeGreaterThan(0);
    expect(typeof out.latencyMs).toBe("number");
  });

  it("draft mutation escalates without an LLM reply for Critical Escalation", async () => {
    mockedInvokeLLM.mockResolvedValueOnce(intentJson("Critical Escalation"));
    const caller = makeCaller();
    const out = await caller.salon.draft({
      phone: "+15550201001",
      body: "my scalp is burning after the perm",
    });
    expect(out.escalated).toBe(true);
    expect(out.reply).toBeNull();
    expect(mockedInvokeLLM).toHaveBeenCalledTimes(1);
  });

  it("draft mutation accepts intentOverride and skips classifier", async () => {
    mockedInvokeLLM.mockResolvedValueOnce(reply("Cut & style runs $40–$80.\n— the salon"));
    const caller = makeCaller();
    const out = await caller.salon.draft({
      phone: "+15550201001",
      body: "how much for a cut",
      intentOverride: "Pricing",
    });
    expect(out.intent).toBe("Pricing");
    expect(mockedInvokeLLM).toHaveBeenCalledTimes(1);
  });

  it("draft mutation rejects oversized message bodies", async () => {
    const caller = makeCaller();
    await expect(
      caller.salon.draft({
        phone: "+15550201001",
        body: "x".repeat(2001),
      }),
    ).rejects.toThrow();
  });

  /* ---------- closed-loop approveBooking ---------- */

  it("approveBooking commits a new appointment that shows up in listAppointments", async () => {
    const caller = makeCaller();
    // Snapshot the count before, so we can verify exactly +1 after.
    const before = await caller.salon.listAppointments();
    const beforeCount = before.appointments.length;

    const res = await caller.salon.approveBooking({
      customerId: "c-emily",
      stylistId: "hayley",
      serviceCategory: "cut",
      dayIndex: 2, // Wed (during Jessica's perm processing window)
      startMinute: 14 * 60 + 30, // 14:30
    });
    expect(res.appointment.status).toBe("confirmed");
    expect(res.appointment.dayLabel).toBe("Wed");
    expect(res.appointment.stylistId).toBe("hayley");
    expect(res.appointment.serviceCategory).toBe("cut");
    expect(typeof res.appointment.label).toBe("string");
    expect(res.appointment.id).toMatch(/appt-runtime-/);

    const after = await caller.salon.listAppointments();
    expect(after.appointments.length).toBe(beforeCount + 1);
    const found = after.appointments.find((a) => a.id === res.appointment.id);
    expect(found).toBeDefined();
    expect(found?.customerId).toBe("c-emily");
  });

  it("resetDemo drops runtime appointments back to the seed week", async () => {
    const caller = makeCaller();
    // Make this test order-independent: clear any runtime state from
    // earlier tests *before* snapshotting the baseline.
    await caller.salon.resetDemo();
    const baseline = await caller.salon.listAppointments();
    // Add two runtime bookings, then reset.
    await caller.salon.approveBooking({
      customerId: "c-cindy",
      stylistId: "soomin",
      serviceCategory: "cut",
      dayIndex: 3,
      startMinute: 11 * 60,
    });
    await caller.salon.approveBooking({
      customerId: "c-jihoon",
      stylistId: "soomin",
      serviceCategory: "manicure",
      dayIndex: 4,
      startMinute: 16 * 60,
    });
    const grown = await caller.salon.listAppointments();
    expect(grown.appointments.length).toBe(baseline.appointments.length + 2);

    const reset = await caller.salon.resetDemo();
    expect(reset.ok).toBe(true);
    const after = await caller.salon.listAppointments();
    expect(after.appointments.length).toBe(baseline.appointments.length);
  });

  it("approveBooking rejects out-of-range dayIndex / startMinute", async () => {
    const caller = makeCaller();
    await expect(
      caller.salon.approveBooking({
        customerId: "c-emily",
        stylistId: "hayley",
        serviceCategory: "cut",
        dayIndex: 9, // out of range
        startMinute: 14 * 60,
      }),
    ).rejects.toThrow();
    await expect(
      caller.salon.approveBooking({
        customerId: "c-emily",
        stylistId: "hayley",
        serviceCategory: "cut",
        dayIndex: 2,
        startMinute: 24 * 60, // out of range
      }),
    ).rejects.toThrow();
  });
});


/* ============================================================
 * Phase 3 — Gap Filler (no-show recovery) router contracts
 * ============================================================ */

describe("salon Gap Filler — simulateNoShow", () => {
  it("marks the appointment as no_show and returns top-N drafts with bookable metadata", async () => {
    const caller = makeCaller();
    // Reset first so we always start from clean seed state, regardless of
    // earlier tests in the file.
    await caller.salon.resetDemo();

    // Stub all LLM calls (one per draft) with deterministic replies.
    mockedInvokeLLM.mockResolvedValue(
      reply("Hi friend, a slot just opened up.\n— the salon"),
    );

    const out = await caller.salon.simulateNoShow({
      appointmentId: "appt-1", // Jessica's Wed perm
      topN: 3,
    });

    expect(out.freedAppointment.status).toBe("no_show");
    expect(out.freedAppointment.dayLabel).toBe("Wed");
    expect(out.freedAppointment.id).toBe("appt-1");
    expect(out.drafts.length).toBeGreaterThan(0);
    expect(out.drafts.length).toBeLessThanOrEqual(3);

    for (const d of out.drafts) {
      expect(typeof d.reply).toBe("string");
      expect(d.reply.length).toBeGreaterThan(0);
      expect(d.bookingDraft.dayIndex).toBe(out.freedAppointment.dayIndex);
      expect(d.bookingDraft.startMinute).toBe(
        out.freedAppointment.startMinute,
      );
      expect(d.bookingDraft.serviceCategory).toBe(
        out.freedAppointment.serviceCategory,
      );
      expect(d.candidate.score).toBeGreaterThan(0);
      expect(typeof d.candidate.reasoning).toBe("string");
    }

    // The freed appointment should now show up as no_show in listAppointments
    const calendar = await caller.salon.listAppointments();
    const freedRow = calendar.appointments.find((a) => a.id === "appt-1");
    expect(freedRow?.status).toBe("no_show");
  });

  it("simulateNoShow throws for an unknown appointmentId", async () => {
    const caller = makeCaller();
    await expect(
      caller.salon.simulateNoShow({ appointmentId: "appt-doesnt-exist" }),
    ).rejects.toThrow();
  });

  it("simulateNoShow ranks VIPs above non-VIPs in the candidate list", async () => {
    const caller = makeCaller();
    await caller.salon.resetDemo();
    mockedInvokeLLM.mockResolvedValue(
      reply("Hi, slot just opened.\n— the salon"),
    );
    const out = await caller.salon.simulateNoShow({
      appointmentId: "appt-1", // freed perm slot
      topN: 5,
    });
    // First candidate should never be a `none` tier when a vip/regular exists.
    const tiers = out.drafts.map((d) => d.candidate.vipTier);
    if (tiers.includes("vip") || tiers.includes("regular")) {
      expect(["vip", "regular"]).toContain(tiers[0]);
    }
  });

  it("after Gap Filler, resetDemo restores the freed appointment back to confirmed", async () => {
    const caller = makeCaller();
    await caller.salon.resetDemo();
    mockedInvokeLLM.mockResolvedValue(reply("hi\n— the salon"));
    await caller.salon.simulateNoShow({ appointmentId: "appt-1", topN: 1 });

    const before = await caller.salon.listAppointments();
    expect(
      before.appointments.find((a) => a.id === "appt-1")?.status,
    ).toBe("no_show");

    await caller.salon.resetDemo();
    const after = await caller.salon.listAppointments();
    expect(
      after.appointments.find((a) => a.id === "appt-1")?.status,
    ).toBe("confirmed");
  });
});

/* ============================================================
 * Phase 4 — Processing-window reminder router contracts
 * ============================================================ */

describe("salon Processing-Window Reminders — checkProcessingReminders", () => {
  // Reminders read live appointment status; reset before each test so prior
  // Gap Filler tests (which flip appt-1 → no_show) cannot bleed in.
  beforeEach(async () => {
    await makeCaller().salon.resetDemo();
  });

  it("surfaces a rinse reminder when current time is inside the lead window", async () => {
    const caller = makeCaller();
    // Jessica's perm is Wed @ 13:00. Perm is 180 minutes total with 90
    // minutes processing. Active prep on each side = (180-90)/2 = 45 min,
    // so processing ENDS at 13:00 + 45 + 90 = 15:15 (915). Querying at
    // 15:13 with leadMinutes=5 → minutesUntilRinse = 2, well inside.
    const out = await caller.salon.checkProcessingReminders({
      dayIndex: 2, // Wed
      minute: 15 * 60 + 13,
      leadMinutes: 5,
    });
    expect(out.reminders.length).toBeGreaterThan(0);
    const jessicaRinse = out.reminders.find((r) =>
      r.reminder.customerName.startsWith("Jessica"),
    );
    expect(jessicaRinse).toBeDefined();
    expect(jessicaRinse?.reminder.serviceCategory).toBe("perm");
    expect(jessicaRinse?.reply.toLowerCase()).toContain("rinse");
  });

  it("returns no reminders when the lead window has not yet started", async () => {
    const caller = makeCaller();
    // 14:00 on Wed — Jessica's processing window is open but rinse is
    // still 75 min away (procEnd 15:15). With lead=5, nothing surfaces.
    const out = await caller.salon.checkProcessingReminders({
      dayIndex: 2,
      minute: 14 * 60,
      leadMinutes: 5,
    });
    // The only Wed appointment with processing time is Jessica's perm.
    // 14:00 is well before its rinse, so it must NOT surface.
    const jessica = out.reminders.find((r) =>
      r.reminder.customerName.startsWith("Jessica"),
    );
    expect(jessica).toBeUndefined();
  });

  it("returns no reminders for a different day even at the same time", async () => {
    const caller = makeCaller();
    const out = await caller.salon.checkProcessingReminders({
      dayIndex: 0, // Mon
      minute: 15 * 60 + 13,
      leadMinutes: 5,
    });
    expect(
      out.reminders.find((r) => r.reminder.customerName.startsWith("Jessica")),
    ).toBeUndefined();
  });

  it("rejects out-of-range dayIndex / minute / leadMinutes", async () => {
    const caller = makeCaller();
    await expect(
      caller.salon.checkProcessingReminders({
        dayIndex: 7,
        minute: 600,
        leadMinutes: 5,
      }),
    ).rejects.toThrow();
    await expect(
      caller.salon.checkProcessingReminders({
        dayIndex: 0,
        minute: 24 * 60,
        leadMinutes: 5,
      }),
    ).rejects.toThrow();
    await expect(
      caller.salon.checkProcessingReminders({
        dayIndex: 0,
        minute: 600,
        leadMinutes: 61,
      }),
    ).rejects.toThrow();
  });
});
