import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
}));

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
  // Salon endpoints are public, so an empty ctx is fine.
  return appRouter.createCaller({
    user: null,
  } as unknown as Parameters<typeof appRouter.createCaller>[0]);
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
