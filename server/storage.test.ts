/**
 * Contract tests for the S3 storage helpers (`server/storage.ts`).
 *
 * These never hit the real Forge / S3 endpoints. We mock global `fetch` so we
 * can pin the *behavior* the rest of the codebase depends on:
 *   - `storagePut` requests a presigned PUT URL, then PUTs the body, then
 *     returns the public `/manus-storage/{key}` URL.
 *   - The returned `key` is suffixed with an 8-char hex hash to prevent
 *     collisions when callers re-use the same `relKey` (e.g. "logo.png").
 *   - Missing Forge credentials throw a descriptive error rather than
 *     silently producing a broken URL.
 *   - Leading slashes in `relKey` are trimmed so that the key is canonical.
 *   - Presign HTTP failures surface the upstream status + body in the error
 *     message (operators can reproduce from the audit trail).
 *
 * Audit gap: storage.ts was 0% covered before this file. Anything in this
 * module that silently broke would only surface as a 500 in production with
 * no test reproduction; these 6 cases close that gap with the smallest
 * possible surface area.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let storagePut: typeof import("./storage").storagePut;
let storageGet: typeof import("./storage").storageGet;
let storageGetSignedUrl: typeof import("./storage").storageGetSignedUrl;

const ORIGINAL_FETCH = globalThis.fetch;

async function loadStorage() {
  // Re-import every test so module-level reads of process.env happen *after*
  // we set them up in beforeEach.
  vi.resetModules();
  const mod = await import("./storage");
  storagePut = mod.storagePut;
  storageGet = mod.storageGet;
  storageGetSignedUrl = mod.storageGetSignedUrl;
}

beforeEach(async () => {
  process.env.BUILT_IN_FORGE_API_URL = "https://forge.example.com";
  process.env.BUILT_IN_FORGE_API_KEY = "test-key";
  await loadStorage();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("storagePut", () => {
  it("requests a presigned URL then PUTs the body and returns the public path", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/presign/put")) {
        return new Response(
          JSON.stringify({ url: "https://s3.example.com/upload-target?sig=abc" }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const result = await storagePut("uploads/photo.png", Buffer.from("hi"), "image/png");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/v1/storage/presign/put?path=uploads%2Fphoto");
    expect(calls[0]!.url).toMatch(/_[0-9a-f]{8}\.png$/); // hash suffix preserves extension
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    expect(calls[1]!.url).toBe("https://s3.example.com/upload-target?sig=abc");
    expect(calls[1]!.init?.method).toBe("PUT");

    expect(result.key).toMatch(/^uploads\/photo_[0-9a-f]{8}\.png$/);
    expect(result.url).toBe(`/manus-storage/${result.key}`);
  });

  it("appends a hex hash even when relKey has no extension", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/presign/put")) {
        return new Response(JSON.stringify({ url: "https://s3.example.com/up" }), {
          status: 200,
        });
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const r1 = await storagePut("blob", Buffer.from("a"));
    const r2 = await storagePut("blob", Buffer.from("b"));
    expect(r1.key).toMatch(/^blob_[0-9a-f]{8}$/);
    expect(r2.key).toMatch(/^blob_[0-9a-f]{8}$/);
    expect(r1.key).not.toBe(r2.key);
  });

  it("throws a descriptive error when Forge credentials are missing", async () => {
    delete process.env.BUILT_IN_FORGE_API_URL;
    delete process.env.BUILT_IN_FORGE_API_KEY;
    await loadStorage();

    await expect(storagePut("x.txt", "y")).rejects.toThrow(
      /BUILT_IN_FORGE_API_URL.*BUILT_IN_FORGE_API_KEY/,
    );
  });

  it("trims leading slashes from relKey so the storage key is canonical", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/presign/put")) {
        return new Response(JSON.stringify({ url: "https://s3.example.com/up" }), {
          status: 200,
        });
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const r = await storagePut("///nested/path/file.bin", "x");
    expect(r.key.startsWith("/")).toBe(false);
    expect(r.key).toMatch(/^nested\/path\/file_[0-9a-f]{8}\.bin$/);
  });

  it("surfaces presign HTTP failure with status + body", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/presign/put")) {
        return new Response("forge: rate limit exceeded", { status: 429 });
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await expect(storagePut("a.txt", "x")).rejects.toThrow(
      /Storage presign failed \(429\): forge: rate limit exceeded/,
    );
  });
});

describe("storageGet", () => {
  it("returns the public /manus-storage/{key} path without hitting Forge", async () => {
    let called = false;
    globalThis.fetch = vi.fn(async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const r = await storageGet("/some/path.bin");
    expect(called).toBe(false); // pure local URL builder
    expect(r.key).toBe("some/path.bin");
    expect(r.url).toBe("/manus-storage/some/path.bin");
  });
});

describe("storageGetSignedUrl", () => {
  it("requests a presigned GET URL from Forge and returns it verbatim", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      expect(String(url)).toContain("/v1/storage/presign/get?path=files%2Fa.bin");
      return new Response(
        JSON.stringify({ url: "https://s3.example.com/download?sig=zzz" }),
        { status: 200 },
      );
    }) as typeof fetch;

    const url = await storageGetSignedUrl("files/a.bin");
    expect(url).toBe("https://s3.example.com/download?sig=zzz");
  });
});
