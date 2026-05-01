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
};
