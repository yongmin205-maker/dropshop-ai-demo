/**
 * Live integration probe for Nextiva credentials.
 *
 * Run with:
 *   RUN_NEXTIVA_LIVE=1 pnpm vitest run server/messaging/nextivaTransport.live.test.ts
 *
 * Status (2026-05-12):
 *   The pilot-1 friend's Nextiva account (NextivaONE plan) does NOT have
 *   access to the developer API documented at developer.nextiva.com. See
 *   `docs/adr/0009-nextiva-api-access-blocker.md` for the full probe grid and
 *   the resulting decision to defer integration.
 *
 *   This file is kept as a re-runnable diagnostic. If the account ever gains
 *   API access, re-running the "host/path grid probe" should surface a
 *   2xx-with-JSON response on one of the candidate endpoints, at which point
 *   ADR 0009 should be amended and the production transport reconnected.
 *
 *   Until then, the second/third tests (which call our real
 *   `createNextivaClient`) are expected to fail; we keep them so the failure
 *   message itself is the contemporary symptom (the user gets a clear
 *   "auth returned 404 + Nextiva 404 page" rather than a silent skip).
 *
 * Skipped by default to keep CI offline-safe.
 */

import { describe, expect, it } from "vitest";

import { createNextivaClient, readNextivaCredsFromEnv } from "./nextivaTransport";

const ENABLED = process.env.RUN_NEXTIVA_LIVE === "1";
const describeLive = ENABLED ? describe : describe.skip;

const HOST_CANDIDATES = [
  "https://api.nextiva.com",
  "https://nextos.nextiva.com",
  "https://api.thrio.com", // Nextiva acquired Thrio for contact-center API
];

const AUTH_PATH_CANDIDATES = [
  "/provider/token-with-authorities",
  "/api/provider/token-with-authorities",
  "/v1/provider/token-with-authorities",
  "/nextos/provider/token-with-authorities",
  "/auth/api/v1/login",
  "/auth/api/generateTokenWithAuthorities",
];

function basicAuth(u: string, p: string): string {
  return "Basic " + Buffer.from(`${u}:${p}`, "utf-8").toString("base64");
}

async function probe(
  url: string,
  auth: string,
  timeoutMs = 8_000,
): Promise<{ status: number | "ERR"; contentType: string; bodySnippet: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: auth },
      signal: ctrl.signal,
    });
    const ct = r.headers.get("content-type") ?? "";
    const txt = (await r.text()).slice(0, 200).replace(/\s+/g, " ");
    return { status: r.status, contentType: ct, bodySnippet: txt };
  } catch (e) {
    return { status: "ERR", contentType: "", bodySnippet: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

describeLive("nextivaTransport — LIVE PROBE (gated by RUN_NEXTIVA_LIVE=1)", () => {
  it("probes the host/path grid and surfaces any endpoint that returns JSON", async () => {
    const creds = readNextivaCredsFromEnv();
    expect(creds, "NEXTIVA_USERNAME/PASSWORD must be set").not.toBeNull();
    if (!creds) return;
    const auth = basicAuth(creds.username, creds.password);

    type Hit = {
      host: string;
      path: string;
      status: number | "ERR";
      contentType: string;
      snip: string;
    };
    const hits: Hit[] = [];
    const jsonHits: Hit[] = []; // the only result that would mean "real API"
    for (const host of HOST_CANDIDATES) {
      for (const path of AUTH_PATH_CANDIDATES) {
        const url = host + path;
        const r = await probe(url, auth);
        const hit: Hit = {
          host,
          path,
          status: r.status,
          contentType: r.contentType,
          snip: r.bodySnippet,
        };
        hits.push(hit);
        if (
          typeof r.status === "number" &&
          r.status < 500 &&
          r.contentType.includes("application/json")
        ) {
          jsonHits.push(hit);
        }
      }
    }

    console.log("[nextiva-probe] grid:");
    for (const h of hits) {
      console.log(
        `  ${String(h.status).padStart(4, " ")}  ct=${h.contentType.padEnd(28, " ")}  ${h.host}${h.path}`,
      );
    }
    if (jsonHits.length > 0) {
      console.log(
        "[nextiva-probe] 🎯 JSON responses found — API access may now be enabled:",
      );
      for (const h of jsonHits) {
        console.log(`  → ${h.host}${h.path} (status=${h.status})`);
      }
      console.log("ACTION: Update nextivaTransport.ts with the working URL and amend ADR 0009.");
    } else {
      console.log(
        "[nextiva-probe] No JSON responses — account still lacks API access (see ADR 0009).",
      );
    }
    // We don't fail the probe; this case is exploratory + informational.
    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);

  // Expected-failure cases — kept so the failure message itself documents
  // current state. Re-enable expectations when ADR 0009 is resolved.
  it.skip("authenticate() succeeds (re-enable when API access is granted)", async () => {
    const creds = readNextivaCredsFromEnv();
    if (!creds) return;
    const client = createNextivaClient(creds);
    const r = await client.authenticate();
    expect(r.ok).toBe(true);
  }, 30_000);

  it.skip("pollInbound() succeeds (re-enable when API access is granted)", async () => {
    const creds = readNextivaCredsFromEnv();
    if (!creds) return;
    const client = createNextivaClient(creds);
    const r = await client.pollInbound({ rows: 5 });
    expect(r.ok).toBe(true);
  }, 30_000);
});
