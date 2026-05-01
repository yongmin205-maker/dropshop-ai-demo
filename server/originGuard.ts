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
 *    allow-list (comma-separated, exact match). This is the strict mode.
 *  - Otherwise, fall back to a host-suffix policy: any Origin whose hostname
 *    ends with `.manus.space` or `.manus.computer` is accepted. The fallback
 *    exists for the dev sandbox (where the URL changes per session) and for
 *    the production deploy until ADR 0003's follow-up sets ALLOWED_ORIGINS
 *    explicitly. When the fallback approves a request in `NODE_ENV=production`
 *    we emit a `[originGuard] fallback-used` log so the gap is visible — the
 *    request is still allowed (we are not breaking live traffic), but the log
 *    line is the trigger to set ALLOWED_ORIGINS for prod.
 *
 * Why we did not flip to hard-deny in production: the deployed origin is
 * known and stable today (`https://dropshopai-vx45nyzf.manus.space`), but
 * domain renames and custom-domain bindings happen via the Management UI
 * without redeploys, and a stale ALLOWED_ORIGINS would 403 every mutation
 * with no easy recovery. The observability-first approach lets us notice and
 * fix before tightening.
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
import { ENV } from "./_core/env";

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
  // Single source of truth lives in `_core/env.ts` (ENV.allowedOrigins).
  // Empty string => fall back to the suffix policy (ADR 0003). The set is
  // re-parsed on every request so an env-var update on the running process
  // (rare but possible on PaaS hot-reload) is picked up without a restart.
  const raw = ENV.allowedOrigins;
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
  // Observability hook: in production the suffix fallback should eventually
  // be replaced by an explicit ALLOWED_ORIGINS. Surface its use so the gap is
  // visible in logs without breaking live traffic.
  if (process.env.NODE_ENV === "production") {
    logFallbackUsed(hostname, req);
  }
  return next();
}

// Same rate-limited pattern as logCsrfRejection — we want a few examples per
// process, not a flood. Reset to a small budget on boot so a long-running
// process eventually quiets down.
let fallbackLogsRemaining = 5;
function logFallbackUsed(hostname: string, req: Request) {
  if (fallbackLogsRemaining <= 0) return;
  fallbackLogsRemaining -= 1;
  // eslint-disable-next-line no-console
  console.warn(
    "[originGuard] fallback-used",
    JSON.stringify({
      hostname,
      method: req.method,
      url: req.originalUrl,
      hint: "Set ALLOWED_ORIGINS env to the exact origin(s) to remove the suffix fallback in production.",
    }),
  );
}
