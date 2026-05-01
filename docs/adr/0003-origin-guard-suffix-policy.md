# Origin allow-list uses suffix matching, not Host comparison

The `originGuard.requireSameOrigin` middleware accepts any `Origin` header whose hostname ends with `.manus.space` or `.manus.computer` when no explicit `ALLOWED_ORIGINS` env is set. It does **not** compare against the request's `Host` header.

## Why this decision

The deployed app sits behind the Manus reverse proxy. The browser's `Origin` header carries the public hostname (`dropshopai-vx45nyzf.manus.space`), but by the time the request reaches our Express process the `Host` header has been rewritten to the internal Cloud Run pod address. A strict same-host comparison therefore returned 403 on every Approve / Reject mutation in production while passing every unit test that ran against a same-process loopback.

The bug surfaced as a generic `403 Forbidden` on the cached Vite bundle, with no useful trace — diagnosis took two failed deploys before the proxy rewrite was identified as the cause.

## Considered Options

- **Trust `x-forwarded-host`** — rejected. The header can be spoofed by any client; we would need the proxy to strip-and-reset it, which we don't control.
- **Disable the guard entirely and rely on cookie SameSite** — rejected. SameSite=Lax still permits top-level POST, and we want defense in depth against CSRF on Approve / Send mutations.
- **Per-deployment env allow-list only (no fallback)** — deferred. Best long-term posture; held back because the dev sandbox URL changes per session and would require constant env edits. Once the deployed domain stabilizes, we should set `ALLOWED_ORIGINS` explicitly and remove the suffix fallback (see Phase 17 follow-ups in `todo.md`).

## Consequences

- Any future Manus-hosted look-alike subdomain inherits trust automatically. Acceptable because Manus controls the apex and we run no other apps on these subdomains today.
- The look-alike-suffix attack (`manus.space.evil.com`) is explicitly tested as a 403 case (`server/originGuard.test.ts`).
- If we ever serve from a custom domain, `ALLOWED_ORIGINS` **must** be set or the guard will reject all traffic.
- (Phase 21b) The `ALLOWED_ORIGINS` env now flows through `server/_core/env.ts` (`ENV.allowedOrigins`, exposed as a getter so per-request reads still see hot-env updates). Cutover diagnostic at `scripts/verify-origin-config.ts`; cutover checklist in `SESSION_RECOVERY.md` § Custom-domain cutover.
