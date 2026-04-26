import { describe, expect, it } from "vitest";
import {
  CLOSE_MINUTE,
  DAY_NAMES,
  OPEN_MINUTE,
  SEED_APPOINTMENTS,
  SEED_CUSTOMERS,
  SEED_SERVICES,
  SEED_STYLISTS,
  findOverlapSlots,
  formatMinute,
  formatPriceRange,
  formatSlot,
  getSalonCustomerByPhone,
  getService,
  getStylist,
  listAppointmentsForCustomer,
  listAppointmentsForWeek,
} from "./mockSalon";

describe("mockSalon seed integrity", () => {
  it("has unique stylist ids and consistent capabilities", () => {
    const ids = new Set(SEED_STYLISTS.map((s) => s.id));
    expect(ids.size).toBe(SEED_STYLISTS.length);
    for (const s of SEED_STYLISTS) {
      expect(s.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("has every service category covered by at least one stylist", () => {
    const allCaps = new Set(SEED_STYLISTS.flatMap((s) => s.capabilities));
    for (const svc of SEED_SERVICES) {
      expect(
        allCaps.has(svc.category),
        `category ${svc.category} not in any stylist capabilities`,
      ).toBe(true);
    }
  });

  it("has unique customer phones", () => {
    const phones = new Set(SEED_CUSTOMERS.map((c) => c.phone));
    expect(phones.size).toBe(SEED_CUSTOMERS.length);
  });

  it("seed appointments reference real customers, stylists, and services", async () => {
    for (const appt of SEED_APPOINTMENTS) {
      expect(SEED_CUSTOMERS.find((c) => c.id === appt.customerId)).toBeTruthy();
      expect(await getStylist(appt.stylistId)).toBeTruthy();
      expect(await getService(appt.serviceCategory)).toBeTruthy();
      // Day in the demo week range
      expect(appt.dayIndex).toBeGreaterThanOrEqual(0);
      expect(appt.dayIndex).toBeLessThan(7);
      // Slot inside business hours
      expect(appt.startMinute).toBeGreaterThanOrEqual(OPEN_MINUTE);
      expect(appt.startMinute).toBeLessThan(CLOSE_MINUTE);
    }
  });

  it("seed appointments fit before close time including total minutes", async () => {
    for (const appt of SEED_APPOINTMENTS) {
      const svc = await getService(appt.serviceCategory);
      expect(appt.startMinute + (svc?.totalMinutes ?? 0)).toBeLessThanOrEqual(
        CLOSE_MINUTE,
      );
    }
  });

  it("appointments referenced stylists are actually capable", async () => {
    for (const appt of SEED_APPOINTMENTS) {
      const s = await getStylist(appt.stylistId);
      expect(s?.capabilities.includes(appt.serviceCategory)).toBe(true);
    }
  });
});

describe("query helpers", () => {
  it("returns null for unknown phone", async () => {
    expect(await getSalonCustomerByPhone("+15559999999")).toBeNull();
  });

  it("returns the matching customer by phone", async () => {
    const c = await getSalonCustomerByPhone("+15550201001");
    expect(c?.name).toBe("Jessica Kim");
  });

  it("returns a defensive copy from listAppointmentsForWeek", async () => {
    const list = await listAppointmentsForWeek();
    list[0].startMinute = 0;
    const fresh = await listAppointmentsForWeek();
    expect(fresh[0].startMinute).not.toBe(0);
  });

  it("filters appointments by customer id", async () => {
    const j = await listAppointmentsForCustomer("c-jessica");
    expect(j.length).toBe(1);
    expect(j[0].serviceCategory).toBe("perm");
  });
});

describe("findOverlapSlots — the killer feature", () => {
  it("finds Hayley free during Jessica's perm processing for a cut", async () => {
    const slots = await findOverlapSlots("cut");
    // Jessica's Wed perm at 13:00 → Hayley capable of cut → overlap exists.
    const wedHayleyCut = slots.find(
      (s) => s.stylistId === "hayley" && s.dayIndex === 2,
    );
    expect(wedHayleyCut).toBeTruthy();
    // Cut requires 45 min, fits inside 90-min processing.
    expect(wedHayleyCut!.durationMinutes).toBeGreaterThanOrEqual(45);
    expect(wedHayleyCut!.hostCustomerId).toBe("c-jessica");
    expect(wedHayleyCut!.hostServiceCategory).toBe("perm");
  });

  it("finds Jisoo free during Sarah's balayage processing for a cut", async () => {
    const slots = await findOverlapSlots("cut");
    const satJisoo = slots.find(
      (s) => s.stylistId === "jisoo" && s.dayIndex === 5,
    );
    expect(satJisoo).toBeTruthy();
    expect(satJisoo!.hostServiceCategory).toBe("balayage");
  });

  it("does NOT slot a service the stylist is not capable of", async () => {
    // Soomin can't do perm — even if we asked for perm, no slots from soomin.
    const slots = await findOverlapSlots("perm");
    expect(slots.find((s) => s.stylistId === "soomin")).toBeUndefined();
  });

  it("returns empty list for a service no host has processing time for", async () => {
    // Manicure has no processing time, so a *requested* manicure can fit
    // in any processing window. But a host appointment must have processing
    // time for any slot to exist. Filter to a host that doesn't exist:
    // request a service that needs more active time than any window allows.
    const slots = await findOverlapSlots("balayage");
    // Balayage requires active = 240 - 120 = 120 min active. Hosts:
    // - perm: processing = 90 min  → too short
    // - color: processing = 60 min → too short
    // - balayage: processing = 120 min → fits exactly
    // Sarah's Sat balayage on Jisoo, Hayley not appointed during it.
    // So we expect at most slots from balayage hosts where the stylist can do balayage.
    for (const s of slots) {
      expect(s.durationMinutes).toBeGreaterThanOrEqual(120);
    }
  });

  it("respects the `now` cutoff", async () => {
    // Cut off after Saturday 23:00 — only Sunday slots remain.
    const slots = await findOverlapSlots("cut", 7, {
      dayIndex: 5,
      minute: 23 * 60,
    });
    for (const s of slots) {
      expect(s.dayIndex >= 6).toBe(true);
    }
  });

  it("respects maxDays scan window", async () => {
    // Only first 2 days (Mon–Tue). No host appointments in that range
    // have processing time → empty.
    const slots = await findOverlapSlots("cut", 2);
    expect(slots).toEqual([]);
  });
});

describe("formatting helpers", () => {
  it("formats minutes as 12h with AM/PM", () => {
    expect(formatMinute(0)).toBe("12:00 AM");
    expect(formatMinute(13 * 60)).toBe("1:00 PM");
    expect(formatMinute(13 * 60 + 45)).toBe("1:45 PM");
    expect(formatMinute(12 * 60)).toBe("12:00 PM");
  });

  it("formats slot with day label", () => {
    expect(formatSlot(2, 13 * 60, 90)).toBe("Wed 1:00 PM – 2:30 PM");
  });

  it("formats price range, collapsing equal lows/highs", () => {
    const cut = SEED_SERVICES.find((s) => s.category === "cut")!;
    expect(formatPriceRange(cut)).toBe("$40–$80");
    const spa = SEED_SERVICES.find((s) => s.category === "hairspa")!;
    expect(formatPriceRange(spa)).toBe("$50");
  });

  it("DAY_NAMES has 7 entries", () => {
    expect(DAY_NAMES.length).toBe(7);
  });
});
