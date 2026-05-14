import type { Express, Request, Response } from "express";
import { timingSafeEqual, createHash } from "crypto";
import { getDb } from "../db";
import { cleanCloudWebhookEvents } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { logServerError } from "../errorLog";

/**
 * Phase 23f-7 — CleanCloud inbound webhook handler.
 *
 * Mounted at `POST /api/cleancloud/webhook`. CleanCloud admin
 * (Pickup and Delivery -> API -> Webhooks) lets the store owner configure a
 * single URL that receives all enabled events. CleanCloud does NOT sign the
 * body, so we rely on a per-store shared secret passed as a URL query
 * parameter (`?token=<CLEANCLOUD_WEBHOOK_SECRET>`). That's the same pattern
 * CleanCloud themselves recommend in the August 2024 webhook announcement.
 *
 * Hardening:
 *   1. Shared-secret verification with `crypto.timingSafeEqual` — never
 *      `===` (string comparison short-circuits on first byte mismatch and is
 *      timing-side-channel vulnerable).
 *   2. Idempotency via UNIQUE (eventType, eventId) — duplicate retries from
 *      CleanCloud short-circuit at INSERT time and we don't re-dispatch.
 *   3. Always 200 OK once secret check passes — CleanCloud retries on 5xx,
 *      and the announcement explicitly asks integrators to "accept the
 *      webhook, return a 200 response code immediately, and process the
 *      data in the background." Dispatch errors are persisted on the
 *      event row, not surfaced as HTTP failures.
 *   4. eventId fallback: if CleanCloud's payload doesn't include a stable
 *      id, we synthesize one from sha256(eventType + canonical payload).
 *      Same body twice still collides on the UNIQUE index.
 *
 * Dispatch is intentionally minimal in this scaffold: we only persist the
 * event and emit one processingLog-style step. Real domain actions (e.g.
 * "send 'your order is ready' SMS when order.status_changed -> Ready") are
 * Phase 23f-8+ work.
 */

// Accepted event types. Anything else lands in `cleanCloudWebhookEvents`
// untouched but logs a warning so we notice if CleanCloud ships new ones.
export const CLEANCLOUD_EVENT_TYPES = [
  "order.created",
  "order.status_changed",
  "order.pickup_rescheduled",
  "order.delivery_rescheduled",
  "order.nothing_to_pickup",
  "order.deleted",
  "customer.created",
  "customer.updated",
  "customer.deleted",
] as const;
export type CleanCloudEventType = (typeof CLEANCLOUD_EVENT_TYPES)[number];

function isKnownEventType(s: string): s is CleanCloudEventType {
  return (CLEANCLOUD_EVENT_TYPES as readonly string[]).includes(s);
}

/**
 * Constant-time compare. Both inputs are coerced to Buffers of identical
 * length first (timingSafeEqual throws on length mismatch, which itself
 * leaks length info, so we pad to the max length).
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const len = Math.max(ab.length, bb.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  ab.copy(aPadded);
  bb.copy(bPadded);
  // Even if lengths differ the underlying comparison still runs over `len`
  // bytes and returns false; this is the standard pattern.
  const equal = timingSafeEqual(aPadded, bPadded);
  return equal && ab.length === bb.length;
}

/**
 * Best-effort id extraction. CleanCloud's webhook payload shape isn't
 * fully documented; common fields used by similar SaaS APIs are tried in
 * order, falling through to a content-hash if none are present.
 */
export function deriveEventId(eventType: string, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const k of ["eventId", "id", "orderID", "customerID"]) {
      const v = p[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number") return String(v);
    }
  }
  // Content hash fallback. Deterministic JSON.stringify ordering is fine
  // here because CleanCloud sends the same body on retry verbatim.
  const canonical = JSON.stringify({ eventType, payload });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/**
 * Extract the event type from the body. CleanCloud's announcement uses an
 * `event` field; we also accept `type` for forward-compatibility.
 */
export function extractEventType(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.event === "string") return b.event;
    if (typeof b.type === "string") return b.type;
  }
  return "";
}

export type DispatchOutcome = {
  ok: boolean;
  step: string;
  error?: string;
};

/**
 * Dispatch table. In this scaffold every handler is a no-op that returns
 * the step name it would have emitted. Real domain logic is wired in
 * Phase 23f-8+ once the friend toggles webhooks ON and we observe real
 * payload shapes.
 */
export async function dispatchEvent(
  eventType: CleanCloudEventType,
  _payload: unknown,
): Promise<DispatchOutcome> {
  switch (eventType) {
    case "order.created":
      return { ok: true, step: "cleancloud.order.created.acked" };
    case "order.status_changed":
      return { ok: true, step: "cleancloud.order.status_changed.acked" };
    case "order.pickup_rescheduled":
      return { ok: true, step: "cleancloud.order.pickup_rescheduled.acked" };
    case "order.delivery_rescheduled":
      return { ok: true, step: "cleancloud.order.delivery_rescheduled.acked" };
    case "order.nothing_to_pickup":
      return { ok: true, step: "cleancloud.order.nothing_to_pickup.acked" };
    case "order.deleted":
      return { ok: true, step: "cleancloud.order.deleted.acked" };
    case "customer.created":
      return { ok: true, step: "cleancloud.customer.created.acked" };
    case "customer.updated":
      return { ok: true, step: "cleancloud.customer.updated.acked" };
    case "customer.deleted":
      return { ok: true, step: "cleancloud.customer.deleted.acked" };
  }
}

/**
 * Persist + dispatch one event. Exposed for unit tests so we can assert
 * the idempotency + dispatch contract without spinning up Express.
 */
export async function recordAndDispatch(args: {
  eventType: string;
  payload: unknown;
}): Promise<{
  status: "inserted" | "duplicate" | "unknown_type";
  step?: string;
  error?: string;
}> {
  const { eventType, payload } = args;
  const eventId = deriveEventId(eventType, payload);

  const db = await getDb();
  if (!db) {
    // DB unavailable (e.g. unit test environment without DATABASE_URL).
    // Short-circuit cleanly; the caller can still observe the
    // event-type validity through the return value.
    return isKnownEventType(eventType)
      ? { status: "inserted", step: "cleancloud.no_db.skip" }
      : { status: "unknown_type" };
  }

  if (!isKnownEventType(eventType)) {
    // Still persist so we have forensic evidence CleanCloud sent us something
    // unexpected, but don't try to dispatch.
    try {
      await db.insert(cleanCloudWebhookEvents).values({
        eventType,
        eventId,
        payload: payload as object,
        processedAt: new Date(),
        dispatchError: "unknown_event_type",
      });
    } catch (e) {
      // Likely duplicate. Swallow because forensic logging is best-effort.
      void e;
    }
    return { status: "unknown_type" };
  }

  // Try to insert. If the UNIQUE (eventType, eventId) constraint trips, this
  // is a duplicate retry and we short-circuit.
  try {
    await db.insert(cleanCloudWebhookEvents).values({
      eventType,
      eventId,
      payload: payload as object,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // MySQL duplicate-key error code 1062, or generic message containing
    // "Duplicate entry" / "unique". Match defensively because driver
    // versions phrase it differently.
    if (/duplicate|unique|1062/i.test(msg)) {
      return { status: "duplicate" };
    }
    throw e;
  }

  let outcome: DispatchOutcome;
  try {
    outcome = await dispatchEvent(eventType as CleanCloudEventType, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outcome = { ok: false, step: "cleancloud.dispatch_error", error: msg };
  }

  // Mark as processed regardless of success — the row's `dispatchError`
  // column captures whether dispatch threw.
  try {
    const { eq, and } = await import("drizzle-orm");
    await db
      .update(cleanCloudWebhookEvents)
      .set({
        processedAt: new Date(),
        dispatchError: outcome.ok ? null : (outcome.error ?? "unknown"),
      })
      .where(
        and(
          eq(cleanCloudWebhookEvents.eventType, eventType),
          eq(cleanCloudWebhookEvents.eventId, eventId),
        ),
      );
  } catch (e) {
    // Non-fatal: the row exists, we just couldn't stamp processedAt.
    await logServerError({
      level: "warn",
      source: "cleancloud.webhook",
      err: e instanceof Error ? e : new Error("failed to update processedAt"),
      context: { phase: "mark_processed" },
    }).catch(() => {});
  }

  return { status: "inserted", step: outcome.step, error: outcome.error };
}

export function registerCleanCloudWebhook(app: Express) {
  app.post("/api/cleancloud/webhook", async (req: Request, res: Response) => {
    // ---- 1. Shared-secret check ----
    const expected = ENV.cleanCloudWebhookSecret;
    if (!expected) {
      // Never accept webhooks if the operator hasn't configured a secret —
      // an empty string match would silently pass any caller.
      res.status(503).type("text/plain").send("Webhook secret not configured");
      return;
    }
    const supplied = String(req.query.token ?? "");
    if (!constantTimeStringEqual(supplied, expected)) {
      // Loud 403 so misconfiguration shows up in metrics.
      res.status(403).type("text/plain").send("Invalid webhook token");
      return;
    }

    // ---- 2. Extract event type + payload ----
    const body = req.body;
    const eventType = extractEventType(body);
    if (!eventType) {
      res.status(400).type("text/plain").send("Missing event type");
      return;
    }

    // ---- 3. Persist + dispatch. Always 200 once we've authenticated. ----
    try {
      const result = await recordAndDispatch({ eventType, payload: body });
      res.status(200).json({ status: result.status, step: result.step ?? null });
    } catch (e) {
      // Catastrophic — log but still 200 so CleanCloud doesn't hammer us
      // on retry (the row UNIQUE index already protects us from dupes).
      await logServerError({
        level: "error",
        source: "cleancloud.webhook",
        err: e instanceof Error ? e : new Error(String(e)),
        context: { phase: "record_and_dispatch" },
      }).catch(() => {});
      res.status(200).json({ status: "error_logged" });
    }
  });
}
