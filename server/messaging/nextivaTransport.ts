/**
 * Nextiva transport — POC for polling inbound SMS + sending outbound SMS via
 * the Nextiva developer API (https://developer.nextiva.com/).
 *
 * Endpoint contract (confirmed from developer.nextiva.com on 2026-05-12):
 *
 *  1. LOGIN — Generate token with user authorities
 *     `GET https://api.nextiva.com/provider/token-with-authorities`
 *     Header: `Authorization: Basic base64(username:password)`
 *     Response: `{ location: string, token: string }`
 *     - `token` is the JWT used as `Bearer` on subsequent calls.
 *     - `location` is the tenant-specific base URL. Per docs all the other
 *       endpoint examples still use `api.nextiva.com` directly, but we keep
 *       `location` as a fallback in case the tenant has been sharded.
 *
 *  2. POLL INBOUND SMS — Fetch all workitems
 *     `GET https://api.nextiva.com/data/api/types/workitem`
 *     Query: `q=type:InboundSMS&rows=50&start=0`
 *     Header: `Authorization: Bearer <jwt>`
 *     Response: `{ count, total, objects: [{ _id, workitemId, state,
 *               channelType, type, priority, agentUsername, createdAt,
 *               modifiedAt }] }`
 *
 *  3. SEND SMS — Send an outbound SMS message
 *     `POST https://api.nextiva.com/users/api/sms`
 *     Header: `Authorization: Bearer <jwt>`
 *     Body: `{ to, message, campaignId?, from?, ... }`
 *     - `campaignId` is OPTIONAL — the docs say "If not provided, the user's
 *       default SMS campaign ID will be used." So we attempt the send even
 *       when `NEXTIVA_CAMPAIGN_ID` is empty.
 *     Response: `{ canDial: boolean, consentType: int }`
 *
 * Cross-cutting concerns:
 *  - JWT cached in-process with 50 min TTL (Nextiva default ~60 min).
 *  - On 401 we drop the cached token and retry auth once.
 *  - All fetches wrapped in AbortController (10s default).
 *  - `createNextivaClient()` accepts `fetchImpl` so vitest can mock fetch.
 */

const NEXTIVA_BASE_URL = "https://api.nextiva.com";

/** 50 minutes — JWTs default to 60 min; we refresh early to avoid 401 races. */
const TOKEN_TTL_MS = 50 * 60 * 1000;

/** Default per-request timeout. Nextiva SLA is ~2s; 10s gives generous slack. */
const DEFAULT_TIMEOUT_MS = 10_000;

export type NextivaCredentials = {
  username: string;
  password: string;
  /** Optional: when omitted, Nextiva uses the user's default SMS campaign. */
  campaignId?: string;
  /** Optional: outbound `from` number. When omitted, Nextiva uses the user's default. */
  fromNumber?: string;
};

export type AuthResult =
  | { ok: true; token: string; location: string; expiresAt: number }
  | { ok: false; status: number; error: string };

export type PollResult =
  | { ok: true; items: NextivaInboundItem[]; raw?: unknown }
  | { ok: false; status: number; error: string };

export type SendResult =
  | { ok: true; canDial: boolean; consentType?: number; raw: unknown }
  | { ok: false; status: number; error: string; code?: string };

export type NextivaInboundItem = {
  /** Public Nextiva workitem identifier (used for dedup). */
  workitemId: string;
  /** MongoDB-style internal ID (kept for traceability). */
  _id?: string;
  state?: string;
  channelType?: string;
  type?: string;
  priority?: number;
  agentUsername?: string;
  createdAt?: number;
  modifiedAt?: number;
  /** Original row for fields we may need later (from/to/body when Nextiva exposes them). */
  raw: Record<string, unknown>;
};

export interface NextivaClient {
  /** Force re-authentication; returns the JWT, location, and expiry timestamp. */
  authenticate(): Promise<AuthResult>;
  /** Pull the most recent inbound SMS workitems (up to `rows`). */
  pollInbound(opts?: { rows?: number; start?: number }): Promise<PollResult>;
  /** Send an outbound SMS. `campaignId` is optional. */
  sendSms(to: string, message: string): Promise<SendResult>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type NextivaClientOptions = {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Override the per-request timeout (ms). */
  timeoutMs?: number;
  /** Inject a custom clock for deterministic tests. */
  now?: () => number;
};

/**
 * Read Nextiva credentials from the environment. Returns `null` (not an
 * exception) when required fields are missing so callers can render a clean
 * "configure me" state without try/catch.
 */
export function readNextivaCredsFromEnv(): NextivaCredentials | null {
  const username = process.env.NEXTIVA_USERNAME?.trim() ?? "";
  const password = process.env.NEXTIVA_PASSWORD?.trim() ?? "";
  if (!username || !password) return null;
  const campaignId = process.env.NEXTIVA_CAMPAIGN_ID?.trim();
  const fromNumber = process.env.NEXTIVA_PHONE_NUMBER?.trim();
  return {
    username,
    password,
    campaignId: campaignId || undefined,
    fromNumber: fromNumber || undefined,
  };
}

/** Base64 encoder that works in both Node and browser-like runtimes. */
function basicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`;
  // Node 22 has globalThis.btoa, but Buffer is more reliable in CI envs.
  if (typeof Buffer !== "undefined") {
    return `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.btoa === "function") return `Basic ${g.btoa(raw)}`;
  throw new Error("No base64 encoder available");
}

/** Build a client. The factory shape keeps tests deterministic + mockable. */
export function createNextivaClient(
  creds: NextivaCredentials,
  options: NextivaClientOptions = {},
): NextivaClient {
  const baseUrl = options.baseUrl ?? NEXTIVA_BASE_URL;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  let cachedToken: { token: string; location: string; expiresAt: number } | null = null;

  async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function authenticate(): Promise<AuthResult> {
    const url = `${baseUrl}/provider/token-with-authorities`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          Authorization: basicAuth(creds.username, creds.password),
          Accept: "application/json",
        },
      });
    } catch (err) {
      return { ok: false, status: 0, error: `network: ${(err as Error).message}` };
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* swallow */
      }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, status: res.status, error: `bad_json: ${(err as Error).message}` };
    }
    const token = extractToken(body);
    const location = extractLocation(body) ?? baseUrl;
    if (!token) {
      return {
        ok: false,
        status: res.status,
        error: `auth response missing token; keys=${Object.keys((body as object) ?? {}).join(",")}`,
      };
    }
    const expiresAt = now() + TOKEN_TTL_MS;
    cachedToken = { token, location, expiresAt };
    return { ok: true, token, location, expiresAt };
  }

  async function getValidToken(): Promise<
    { ok: true; token: string; location: string } | { ok: false; status: number; error: string }
  > {
    if (cachedToken && cachedToken.expiresAt > now()) {
      return { ok: true, token: cachedToken.token, location: cachedToken.location };
    }
    const auth = await authenticate();
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    return { ok: true, token: auth.token, location: auth.location };
  }

  /** Helper: invalidate cached token and retry the auth+request once on 401. */
  async function fetchWithRetryOn401(
    buildRequest: (token: string) => { url: string; init: RequestInit },
  ): Promise<{ res: Response } | { error: { status: number; message: string } }> {
    const tok1 = await getValidToken();
    if (!tok1.ok) return { error: { status: tok1.status, message: tok1.error } };
    const req1 = buildRequest(tok1.token);
    let res: Response;
    try {
      res = await fetchWithTimeout(req1.url, req1.init);
    } catch (err) {
      return { error: { status: 0, message: `network: ${(err as Error).message}` } };
    }
    if (res.status !== 401) return { res };
    // 401 → invalidate and try once more.
    cachedToken = null;
    const tok2 = await getValidToken();
    if (!tok2.ok) return { error: { status: tok2.status, message: tok2.error } };
    const req2 = buildRequest(tok2.token);
    try {
      const res2 = await fetchWithTimeout(req2.url, req2.init);
      return { res: res2 };
    } catch (err) {
      return { error: { status: 0, message: `network: ${(err as Error).message}` } };
    }
  }

  async function pollInbound(
    opts: { rows?: number; start?: number } = {},
  ): Promise<PollResult> {
    const rows = opts.rows ?? 50;
    const start = opts.start ?? 0;
    // The docs' "Try It!" example uses api.nextiva.com directly. We stick with
    // baseUrl for the request host; tenant-specific `location` is captured at
    // auth time and available via authenticate() if a future call needs it.
    const url =
      `${baseUrl}/data/api/types/workitem` +
      `?q=${encodeURIComponent("type:InboundSMS")}` +
      `&rows=${rows}&start=${start}`;
    const out = await fetchWithRetryOn401((token) => ({
      url,
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      },
    }));
    if ("error" in out) return { ok: false, status: out.error.status, error: out.error.message };
    const res = out.res;
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* swallow */
      }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, status: res.status, error: `bad_json: ${(err as Error).message}` };
    }
    return { ok: true, items: extractItems(body), raw: body };
  }

  async function sendSms(to: string, message: string): Promise<SendResult> {
    if (!to.startsWith("+") || to.length < 8) {
      return { ok: false, status: 0, error: `invalid E.164 to=${to}`, code: "invalid_phone" };
    }
    if (!message || message.trim().length === 0) {
      return { ok: false, status: 0, error: "empty body", code: "empty_body" };
    }
    const url = `${baseUrl}/users/api/sms`;
    const bodyObj: Record<string, unknown> = { to, message };
    if (creds.campaignId) bodyObj.campaignId = creds.campaignId;
    if (creds.fromNumber) bodyObj.from = creds.fromNumber;

    const out = await fetchWithRetryOn401((token) => ({
      url,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(bodyObj),
      },
    }));
    if ("error" in out) return { ok: false, status: out.error.status, error: out.error.message };
    const res = out.res;
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* swallow */
      }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, status: res.status, error: `bad_json: ${(err as Error).message}` };
    }
    const bodyRec = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const canDial = typeof bodyRec.canDial === "boolean" ? bodyRec.canDial : true;
    const consentType =
      typeof bodyRec.consentType === "number" ? bodyRec.consentType : undefined;
    return { ok: true, canDial, consentType, raw: body };
  }

  return { authenticate, pollInbound, sendSms };
}

/**
 * Token extractor — tolerant of multiple Nextiva response shapes.
 * Documented shape: `{ token, location }`. We also accept legacy shapes
 * (accessToken, jwt, idToken) for forward compatibility.
 */
function extractToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const candidates: Array<unknown> = [
    obj.token,
    obj.accessToken,
    obj.access_token,
    obj.jwt,
    obj.idToken,
  ];
  if (obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    candidates.push(d.token, d.accessToken, d.access_token, d.jwt);
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

function extractLocation(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const loc = obj.location;
  if (typeof loc === "string" && loc.length > 0) return loc;
  return null;
}

/**
 * Item extractor — Nextiva returns `{ count, total, objects: [...] }`.
 * We also tolerate legacy envelopes (`items`, `docs`, `result`).
 */
function extractItems(body: unknown): NextivaInboundItem[] {
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const candidates: Array<unknown> = [
    obj.objects, // documented shape
    obj.items,
    obj.result,
    obj.results,
    obj.docs,
    (obj.response as Record<string, unknown> | undefined)?.docs,
    (obj.data as Record<string, unknown> | undefined)?.items,
  ];
  let rawList: unknown[] | null = null;
  for (const c of candidates) {
    if (Array.isArray(c)) {
      rawList = c;
      break;
    }
  }
  if (!rawList) return [];
  return rawList
    .map((row): NextivaInboundItem | null => {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      const workitemId = pickString(r, ["workitemId", "workitem_id", "id"]);
      if (!workitemId) return null;
      return {
        workitemId,
        _id: pickString(r, ["_id"]) ?? undefined,
        state: pickString(r, ["state"]) ?? undefined,
        channelType: pickString(r, ["channelType"]) ?? undefined,
        type: pickString(r, ["type"]) ?? undefined,
        priority: pickNumber(r, ["priority"]),
        agentUsername: pickString(r, ["agentUsername"]) ?? undefined,
        createdAt: pickNumber(r, ["createdAt"]),
        modifiedAt: pickNumber(r, ["modifiedAt"]),
        raw: r,
      };
    })
    .filter((x): x is NextivaInboundItem => x !== null);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}
