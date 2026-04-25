import { TRPCError } from "@trpc/server";

/**
 * In-memory token-bucket rate limiter.
 *
 * Production-grade upgrade path: swap `bucketStore` for Redis (e.g. SETEX with
 * a Lua script). For a single Cloud Run instance this is sufficient as a hard
 * cost cap against abusive callers. Each instance maintains its own counters,
 * so the *effective* rate limit scales linearly with instance count — keep
 * `RATE_LIMIT_MAX_INSTANCES` in mind when sizing budgets.
 */

type Bucket = {
  count: number;
  resetAt: number;
};

const bucketStore = new Map<string, Bucket>();

const DAY_MS = 24 * 60 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

function pruneIfStale(bucket: Bucket): Bucket | null {
  if (bucket.resetAt <= nowMs()) return null;
  return bucket;
}

export interface RateLimitOptions {
  /** Logical bucket key, e.g. `simulator:ip:1.2.3.4` or `simulator:phone:+15550101003`. */
  key: string;
  /** Max requests inside the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Friendly label used in the error message. */
  label?: string;
}

export function rateLimit(opts: RateLimitOptions): void {
  const existing = bucketStore.get(opts.key);
  const fresh = existing ? pruneIfStale(existing) : null;
  if (fresh) {
    if (fresh.count >= opts.max) {
      const retryInSec = Math.max(1, Math.ceil((fresh.resetAt - nowMs()) / 1000));
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded${opts.label ? ` for ${opts.label}` : ""}. Retry in ~${retryInSec}s.`,
      });
    }
    fresh.count += 1;
    bucketStore.set(opts.key, fresh);
    return;
  }
  bucketStore.set(opts.key, {
    count: 1,
    resetAt: nowMs() + opts.windowMs,
  });
}

/* ---- Daily LLM token budget ---- */

const LLM_BUDGET_KEY = "global:llm-tokens";

export function noteLlmTokenUsage(estimatedTokens: number, dailyMax = 5_000_000): void {
  const existing = bucketStore.get(LLM_BUDGET_KEY);
  const fresh = existing ? pruneIfStale(existing) : null;
  if (!fresh) {
    bucketStore.set(LLM_BUDGET_KEY, {
      count: estimatedTokens,
      resetAt: nowMs() + DAY_MS,
    });
    return;
  }
  if (fresh.count + estimatedTokens > dailyMax) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Daily LLM token budget reached (${dailyMax.toLocaleString()}). Resets at midnight UTC.`,
    });
  }
  fresh.count += estimatedTokens;
  bucketStore.set(LLM_BUDGET_KEY, fresh);
}

/** Test-only helper. Not exported through any router. */
export function __resetRateLimitState(): void {
  bucketStore.clear();
}

/** Best-effort caller IP from common proxy headers. */
export function callerIp(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    return fwd[0].split(",")[0].trim();
  }
  return req.ip ?? "unknown";
}
