/**
 * §5.10 CSRF defense for tRPC mutations.
 *
 * Why we need this: Manus OAuth sets `app_session_id` as a cookie. Without an
 * Origin/Referer check, a malicious site the operator visits could fire a POST
 * to /api/trpc/drafts.approve with `withCredentials: true` and the browser
 * would attach the cookie. SameSite=Lax (the default) blocks top-level POSTs
 * from cross-site forms but does NOT block fetch/XHR from a malicious page.
 *
 * Strategy:
 *  - Allow any GET / HEAD / OPTIONS (no state change).
 *  - For POST/PUT/PATCH/DELETE: require `Origin` (or fall back to `Referer`)
 *    that matches one of the allowed origins.
 *  - Allowed origins come from `ALLOWED_ORIGINS` (comma-separated). If the env
 *    is missing we fall back to a permissive same-host rule using the request's
 *    own `Host` header — the typical Manus deployment pattern.
 */

import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function parseAllowedOrigins(): Set<string> | null {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function originHostMatchesRequest(originUrl: string, req: Request): boolean {
  try {
    const u = new URL(originUrl);
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
    const host =
      (req.headers["x-forwarded-host"] as string) ||
      (req.headers["host"] as string) ||
      "";
    if (!host) return false;
    const expected = new URL(`${proto}://${host}`);
    return u.host === expected.host;
  } catch {
    return false;
  }
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin =
    (req.headers["origin"] as string | undefined) ||
    (req.headers["referer"] as string | undefined);

  if (!origin) {
    // Most browsers send Origin on every state-changing fetch. A missing one
    // is suspicious — block it. Server-to-server callers should hit dedicated
    // signed endpoints (e.g. /api/twilio/sms with HMAC), not /api/trpc.
    return res.status(403).json({
      error: "CSRF: missing Origin/Referer header on mutation",
    });
  }

  const allowList = parseAllowedOrigins();
  if (allowList) {
    const norm = origin.replace(/\/$/, "");
    // Origin headers are scheme://host[:port]. Referer can be a full URL — we
    // only compare its origin component.
    let originPart = norm;
    try {
      originPart = new URL(norm).origin;
    } catch {
      // not a parseable URL — treat raw value as origin
    }
    if (!allowList.has(originPart)) {
      return res.status(403).json({
        error: `CSRF: Origin ${originPart} is not in ALLOWED_ORIGINS`,
      });
    }
    return next();
  }

  // Fallback: require the Origin host to match the request's own Host header.
  // This is the safe default for single-deployment Manus apps.
  if (!originHostMatchesRequest(origin, req)) {
    return res.status(403).json({
      error: "CSRF: Origin does not match request host",
    });
  }
  return next();
}
