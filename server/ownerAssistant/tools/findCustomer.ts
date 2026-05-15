/**
 * `findCustomerByPhoneOrName` — single-shot customer lookup against
 * the posCustomers mirror.
 *
 * Routing rule (cheap, deterministic; doesn't need an LLM):
 *   - If the query looks like a phone (starts with optional `+` then ≥7
 *     digits), normalize to digits-only and LIKE-match on phoneE164.
 *   - If it looks like an email (contains '@'), exact-match on email.
 *   - Otherwise, treat as a name and LIKE-match on name (case-insensitive).
 *
 * visitCount is computed from posOrders via a correlated subquery — we
 * avoid pulling every order row to JS just to count. lastSeenAt = max
 * placedAt for the same customerExternalId.
 *
 * The shape is deliberately small: up to 10 customers, with a
 * `truncated` flag so the Synthesizer can say "10명 보였고 더 있어요"
 * instead of fabricating a number.
 */

import { z } from "zod";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { posCustomers, posOrders, type PosCustomer } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ToolDefinition } from "../types";

const inputSchema = z.object({
  query: z.string().min(1).max(256),
});
type Input = z.infer<typeof inputSchema>;

const customerRow = z.object({
  id: z.number(),
  externalId: z.string(),
  name: z.string().nullable(),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  visitCount: z.number(),
  lastSeenAt: z.string().nullable(), // ISO
});
const outputSchema = z.object({
  customers: z.array(customerRow),
  truncated: z.boolean(),
});
type Output = z.infer<typeof outputSchema>;

const EMAIL_LIKE = /@/;
/** A query is "phone-shaped" if it's mostly digits / phone-formatting
 *  punctuation and contains at least 7 digits when normalized.
 *  This catches +14155551234, 415-555-1234, (415) 555-1234, and a
 *  ten-digit run with no punctuation. */
const PHONE_ALLOWED_CHARS = /^[+\d\s\-().]+$/;

/** Strip everything but digits — `(415) 555-1234` → `4155551234`. */
export function digitsOnly(q: string): string {
  return q.replace(/\D+/g, "");
}

export function classifyQuery(q: string): "phone" | "email" | "name" {
  const trimmed = q.trim();
  if (EMAIL_LIKE.test(trimmed)) return "email";
  if (PHONE_ALLOWED_CHARS.test(trimmed) && digitsOnly(trimmed).length >= 7) {
    return "phone";
  }
  return "name";
}

const MAX_RESULTS = 10;

export const findCustomerByPhoneOrName: ToolDefinition<Input, Output> = {
  name: "findCustomerByPhoneOrName",
  category: "lookup",
  description:
    "전화번호, 이름, 또는 이메일로 단일 손님을 검색한다. 정확한 일치가 아니어도 부분 일치(LIKE)로 찾는다. 최대 10명까지 반환.",
  inputSchema,
  outputSchema,
  async invoke(input) {
    const db = await getDb();
    if (!db) return { customers: [], truncated: false };

    const kind = classifyQuery(input.query);
    const trimmed = input.query.trim();

    let rows: PosCustomer[] = [];
    if (kind === "phone") {
      const digits = digitsOnly(trimmed);
      if (digits.length === 0) return { customers: [], truncated: false };
      rows = await db
        .select()
        .from(posCustomers)
        .where(like(posCustomers.phoneE164, `%${digits}%`))
        .limit(MAX_RESULTS + 1);
    } else if (kind === "email") {
      rows = await db
        .select()
        .from(posCustomers)
        .where(eq(posCustomers.email, trimmed))
        .limit(MAX_RESULTS + 1);
    } else {
      rows = await db
        .select()
        .from(posCustomers)
        .where(like(posCustomers.name, `%${trimmed}%`))
        .limit(MAX_RESULTS + 1);
    }

    const truncated = rows.length > MAX_RESULTS;
    const slice = rows.slice(0, MAX_RESULTS);

    // Fan-out the visit-count + lastSeen subqueries in one shot — N
    // round-trips are wasteful when N≤10.
    const customers = await Promise.all(
      slice.map(async (c) => {
        const stats = await db
          .select({
            count: sql<number>`COUNT(*)`,
            lastSeen: sql<Date | null>`MAX(${posOrders.placedAt})`,
          })
          .from(posOrders)
          .where(
            and(
              eq(posOrders.source, c.source),
              eq(posOrders.customerExternalId, c.externalId),
            ),
          );
        const row = stats[0] ?? { count: 0, lastSeen: null };
        return {
          id: c.id,
          externalId: c.externalId,
          name: c.name,
          phoneE164: c.phoneE164,
          email: c.email,
          visitCount: Number(row.count ?? 0),
          lastSeenAt: row.lastSeen ? new Date(row.lastSeen).toISOString() : null,
        };
      }),
    );
    customers.sort((a, b) => b.visitCount - a.visitCount);

    return { customers, truncated };
  },
};
