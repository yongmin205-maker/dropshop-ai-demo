import { eq } from "drizzle-orm";
import {
  mockCustomers,
  mockOrders,
  mockPriceList,
  type MockCustomer,
  type MockOrder,
  type MockPrice,
} from "../drizzle/schema";
import { getDb } from "./db";

/* ============================================================
 * Mock CleanCloud POS — seed data + tool-call helpers
 * ============================================================ */

export const SEED_CUSTOMERS = [
  {
    phone: "+15550101001",
    name: "Marie Pierce",
    membership: "gold" as const,
    address: "975 Park Ave, Apt 14D, New York, NY",
    notes: "Long-time customer. Prefers Tuesday & Friday pickups.",
  },
  {
    phone: "+15550101002",
    name: "Alexandra Klein",
    membership: "silver" as const,
    address: "210 W 79th St, New York, NY",
    notes: "Often sends item lists by SMS.",
  },
  {
    phone: "+15550101003",
    name: "Peter Demarco",
    membership: "none" as const,
    address: "118 E 60th St, New York, NY",
    notes: "Repeat pickup every 2 weeks.",
  },
  {
    phone: "+15550101004",
    name: "Shannan Barrett",
    membership: "gold" as const,
    address: "350 Bleecker St, New York, NY",
    notes: "Asks about member rates frequently.",
  },
  {
    phone: "+15550101005",
    name: "Liza Ganitsky",
    membership: "silver" as const,
    address: "455 W 23rd St, New York, NY",
    notes: "Sensitive to delivery delays.",
  },
];

export const SEED_ORDERS = [
  {
    orderNumber: "DS-10231",
    customerPhone: "+15550101001",
    status: "Ready to Deliver" as const,
    itemsSummary: "2 dress shirts, 1 wool coat",
    totalCents: 4200,
    etaText: "Out for delivery today between 4–6 PM",
  },
  {
    orderNumber: "DS-10232",
    customerPhone: "+15550101002",
    status: "Cleaning" as const,
    itemsSummary: "1 silk blouse, 1 cashmere sweater, 2 pants",
    totalCents: 6800,
    etaText: "Ready by Thursday 6 PM",
  },
  {
    orderNumber: "DS-10233",
    customerPhone: "+15550101003",
    status: "Awaiting Pickup" as const,
    itemsSummary: "Repeat pickup — usual order",
    totalCents: 0,
    etaText: "Pickup scheduled today between 2–4 PM",
  },
  {
    orderNumber: "DS-10234",
    customerPhone: "+15550101004",
    status: "Completed" as const,
    itemsSummary: "1 tuxedo (full press)",
    totalCents: 5500,
    etaText: "Delivered Mon",
  },
  {
    orderNumber: "DS-10235",
    customerPhone: "+15550101005",
    status: "Ready to Deliver" as const,
    itemsSummary: "3 dresses, 1 jacket",
    totalCents: 7900,
    etaText: "Out for delivery today between 5–7 PM",
  },
];

export const SEED_PRICES = [
  { category: "dryClean", itemName: "Dress shirt", priceCents: 700, notes: "Member: $5.95" },
  { category: "dryClean", itemName: "Pants / slacks", priceCents: 1100, notes: "Member: $9.35" },
  { category: "dryClean", itemName: "Suit (2-piece)", priceCents: 2800, notes: "Member: $23.80" },
  { category: "dryClean", itemName: "Wool coat", priceCents: 3200, notes: "Member: $27.20" },
  { category: "dryClean", itemName: "Silk blouse", priceCents: 1400, notes: "Member: $11.90" },
  { category: "dryClean", itemName: "Cashmere sweater", priceCents: 1800, notes: "Member: $15.30" },
  { category: "dryClean", itemName: "Dress", priceCents: 1900, notes: "Member: $16.15" },

  { category: "alteration", itemName: "Hem pants", priceCents: 1500, notes: "Standard hem" },
  { category: "alteration", itemName: "Replace zipper (pants)", priceCents: 3500, notes: "Includes zipper" },
  { category: "alteration", itemName: "Replace zipper (jacket)", priceCents: 7500, notes: "Standard YKK" },
  { category: "alteration", itemName: "Take in waist", priceCents: 2500, notes: "Up to 2 inches" },
  { category: "alteration", itemName: "Patch (per item)", priceCents: 1200, notes: "Customer-supplied patch" },

  { category: "laundry", itemName: "Wash & fold (per lb)", priceCents: 295, notes: "8 lb minimum" },
];

export const MEMBERSHIP_INFO = {
  none: {
    name: "Standard",
    discount: 0,
    benefits: [
      "Pay-per-item rates",
      "Free pickup & delivery on orders $30+",
    ],
  },
  silver: {
    name: "Silver",
    discount: 0.1,
    benefits: [
      "10% off all dry cleaning",
      "Free pickup & delivery on every order",
      "Priority weekday turnaround",
    ],
    monthlyFee: "$19/mo",
  },
  gold: {
    name: "Gold",
    discount: 0.15,
    benefits: [
      "15% off all dry cleaning + alterations",
      "Free pickup & delivery on every order",
      "Same-day service when ordered before 9 AM",
      "Dedicated account concierge",
    ],
    monthlyFee: "$39/mo",
  },
};

let seeded = false;

export async function ensureSeeded() {
  if (seeded) return;
  const db = await getDb();
  if (!db) return;

  const existing = await db.select().from(mockCustomers).limit(1);
  if (existing.length === 0) {
    await db.insert(mockCustomers).values(SEED_CUSTOMERS);
    await db.insert(mockOrders).values(SEED_ORDERS);
    await db.insert(mockPriceList).values(SEED_PRICES);
  }
  seeded = true;
}

/* ----- Tool-call helpers (these mirror what a CleanCloud API client would do) ----- */

export async function getCustomerByPhone(phone: string): Promise<MockCustomer | null> {
  await ensureSeeded();
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(mockCustomers).where(eq(mockCustomers.phone, phone)).limit(1);
  return rows[0] ?? null;
}

export async function getOrdersByPhone(phone: string): Promise<MockOrder[]> {
  await ensureSeeded();
  const db = await getDb();
  if (!db) return [];
  return db.select().from(mockOrders).where(eq(mockOrders.customerPhone, phone));
}

export async function searchPrice(query: string): Promise<MockPrice[]> {
  await ensureSeeded();
  const db = await getDb();
  if (!db) return [];
  const all = await db.select().from(mockPriceList);
  const q = query.toLowerCase();
  return all.filter(
    (p) =>
      p.itemName.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      (p.notes ?? "").toLowerCase().includes(q),
  );
}

export async function listAllPrices(): Promise<MockPrice[]> {
  await ensureSeeded();
  const db = await getDb();
  if (!db) return [];
  return db.select().from(mockPriceList);
}

export function getMembershipInfo(tier: "none" | "silver" | "gold") {
  return MEMBERSHIP_INFO[tier];
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
