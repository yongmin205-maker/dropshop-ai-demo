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
 *  - For POST/PUT/PATCH/DELETE: require `Origin` (or fall back to `Referer`).
 *  - If `ALLOWED_ORIGINS` env is set, the Origin must be in the explicit
 *    allow-list (comma-separated, exact match).
 *  - Otherwise, fall back to a host-suffix policy: any Origin whose hostname
 *    ends with `.manus.space` or `.manus.computer` is accepted. These two
 *    suffixes cover (a) the production deployment (`*.manus.space`) and (b)
 *    the sandbox dev preview (`*.manus.computer`). Comparing against the
 *    request's own `Host` header is unreliable behind the Manus reverse proxy
 *    — the proxy rewrites `Host` to the internal Cloud-Run host while leaving
 *    the browser's `Origin` set to the public domain, so a strict comparison
 *    rejects every legitimate request.
 *
 * Security tradeoff: the suffix policy means any other `*.manus.space` app the
 * operator opens could in principle issue a cross-origin POST to this app.
 * That is acceptable here because (i) all such apps are first-party Manus
 * deployments operating under the same OAuth realm, (ii) the protected
 * procedures additionally require a valid `app_session_id` cookie scoped to
 * THIS app's domain, and (iii) operators in practice only run one or two
 * Manus apps. If you need stricter isolation, set `ALLOWED_ORIGINS` to the
 * exact public origin(s) you trust.
 */

import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Manus-managed host suffixes that are always trusted in fallback mode.
const MANUS_HOST_SUFFIXES = [".manus.space", ".manus.computer"];

// Log only the first few CSRF rejections so we can diagnose live-environment
// header mismatches without spamming the log forever.
let csrfDebugLogsRemaining = 5;
function logCsrfRejection(reason: string, req: Request, extra?: Record<string, unknown>) {
  if (csrfDebugLogsRemaining <= 0) return;
  csrfDebugLogsRemaining -= 1;
  // eslint-disable-next-line no-console
  console.warn(
    "[originGuard] reject",
    JSON.stringify({
      reason,
      method: req.method,
      url: req.originalUrl,
      origin: req.headers["origin"] ?? null,
      referer: req.headers["referer"] ?? null,
      host: req.headers["host"] ?? null,
      xForwardedHost: req.headers["x-forwarded-host"] ?? null,
      xForwardedProto: req.headers["x-forwarded-proto"] ?? null,
      ...extra,
    }),
  );
}

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

function originHostname(originValue: string): string | null {
  try {
    return new URL(originValue).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isTrustedManusHost(hostname: string): boolean {
  return MANUS_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
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
    logCsrfRejection("missing-origin", req);
    return res.status(403).json({
      error: "CSRF: missing Origin/Referer header on mutation",
    });
  }

  const hostname = originHostname(origin);
  if (!hostname) {
    logCsrfRejection("unparseable-origin", req);
    return res.status(403).json({
      error: "CSRF: Origin/Referer header is not a valid URL",
    });
  }

  const allowList = parseAllowedOrigins();
  if (allowList) {
    // Origin headers are scheme://host[:port]. Referer can be a full URL — we
    // only compare its origin component.
    let originPart = origin.replace(/\/$/, "");
    try {
      originPart = new URL(origin).origin;
    } catch {
      // unreachable: hostname parse already succeeded
    }
    if (!allowList.has(originPart)) {
      logCsrfRejection("not-in-allowlist", req, { originPart });
      return res.status(403).json({
        error: `CSRF: Origin ${originPart} is not in ALLOWED_ORIGINS`,
      });
    }
    return next();
  }

  // Fallback: trust any Manus-managed domain. See the file header comment for
  // the security rationale.
  if (!isTrustedManusHost(hostname)) {
    logCsrfRejection("untrusted-host", req, { hostname });
    return res.status(403).json({
      error: "CSRF: Origin is not a trusted Manus domain",
    });
  }
  return next();
}
