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

// Log only the first few CSRF rejections so we can diagnose live-environment
// header mismatches without spamming the log forever.
let csrfDebugLogsRemaining = 5;
function logCsrfRejection(reason: string, req: Request) {
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
      reqHostname: req.hostname,
      reqProtocol: req.protocol,
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

function originHostMatchesRequest(originUrl: string, req: Request): boolean {
  try {
    const u = new URL(originUrl);
    // When `app.set("trust proxy", true)` is on, Express populates req.hostname
    // from x-forwarded-host and req.protocol from x-forwarded-proto. We try the
    // proxy-aware values first, then fall back to raw Host header (still
    // checking x-forwarded-host directly in case trust-proxy is not configured).
    const candidateHosts = [
      req.hostname,
      (req.headers["x-forwarded-host"] as string) || "",
      (req.headers["host"] as string) || "",
    ]
      .map((h) => (h || "").split(",")[0].trim())
      .filter(Boolean);
    if (candidateHosts.length === 0) return false;
    return candidateHosts.some((host) => {
      try {
        // strip port to compare host only (browsers usually omit default ports
        // from Origin, but reverse proxies may add :443 / :8080 to Host)
        const originHost = u.hostname.toLowerCase();
        const reqHost = host.split(":")[0].toLowerCase();
        return originHost === reqHost;
      } catch {
        return false;
      }
    });
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
    logCsrfRejection("missing-origin", req);
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
      logCsrfRejection("not-in-allowlist", req);
      return res.status(403).json({
        error: `CSRF: Origin ${originPart} is not in ALLOWED_ORIGINS`,
      });
    }
    return next();
  }

  // Fallback: require the Origin host to match the request's own Host header.
  // This is the safe default for single-deployment Manus apps.
  if (!originHostMatchesRequest(origin, req)) {
    logCsrfRejection("origin-host-mismatch", req);
    return res.status(403).json({
      error: "CSRF: Origin does not match request host",
    });
  }
  return next();
}
