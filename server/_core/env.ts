export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // CSRF allow-list for tRPC mutations. Empty string => suffix fallback in
  // originGuard.ts (see ADR 0003). Comma-separated list of exact origins
  // (e.g. "https://app.visitdropshop.com,https://staging.dropshop.ai") once
  // a custom domain is bound. Centralized here so the value is grep-able and
  // every reader (originGuard, the verify-origin-config diagnostic) sees the
  // same source of truth.
  //
  // Deliberately a getter (not a static read) so PaaS hot-env reloads and
  // per-test mutations of `process.env.ALLOWED_ORIGINS` are picked up
  // without a process restart. Other ENV entries are static because they
  // must agree with their value at OAuth boot; this one is read per
  // request, so dynamism is the right shape.
  get allowedOrigins(): string {
    return process.env.ALLOWED_ORIGINS ?? "";
  },
  // CleanCloud POS integration (Phase 23). Both accessors are dynamic getters
  // so vitest can mutate `process.env` per test without a process restart.
  // `cleanCloudApiToken` is the per-store secret pasted by the friend in
  // CleanCloud admin -> Pickup and Delivery -> API. `useRealPos` is the
  // gradual-rollout feature flag: when 1, the cleanCloudAdapter calls the
  // real cleancloudapp.com endpoints; when unset / 0, it falls through to the
  // existing `mockCleanCloud` seed data so demo flows stay green even if the
  // token is missing.
  get cleanCloudApiToken(): string {
    return process.env.CLEANCLOUD_API_TOKEN ?? "";
  },
  get useRealPos(): boolean {
    return process.env.DROPSHOP_USE_REAL_POS === "1";
  },
  // Shared secret CleanCloud passes back as `?token=...` on every webhook
  // POST. Compared constant-time inside `/api/cleancloud/webhook`. Dynamic
  // getter so vitest can override per test without a process restart.
  get cleanCloudWebhookSecret(): string {
    return process.env.CLEANCLOUD_WEBHOOK_SECRET ?? "";
  },
};
