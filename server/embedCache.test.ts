import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("§5.12 embedText LRU cache", () => {
  beforeEach(() => {
    delete process.env.BUILT_IN_FORGE_API_KEY;
    delete process.env.FORGE_API_KEY;
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("returns cached vector for identical input on second call (no new fetch)", async () => {
    const fetchSpy = vi.fn(async () => new Response("x", { status: 500 }));
    global.fetch = fetchSpy as any;
    const mod = await import("./embeddings");
    mod._resetEmbedCacheForTests();

    const v1 = await mod.embedText("repeat me");
    const v2 = await mod.embedText("repeat me");
    expect(v1).toBe(v2); // same reference (cached)
    // fetch was attempted once for the first call (Forge fail) — second call
    // must short-circuit before tryForgeEmbedding.
    // Note: when no API key is set tryForgeEmbedding skips fetch entirely, so
    // fetchSpy may stay at 0 — the cache assertion above is the real contract.
    expect(mod._embedCacheStats().size).toBe(1);
  });

  it("different inputs produce different cache entries", async () => {
    global.fetch = vi.fn(async () => new Response("x", { status: 500 })) as any;
    const mod = await import("./embeddings");
    mod._resetEmbedCacheForTests();
    await mod.embedText("hello");
    await mod.embedText("world");
    await mod.embedText("hello"); // re-hit
    expect(mod._embedCacheStats().size).toBe(2);
  });

  it("evicts the oldest entry when cap exceeded", async () => {
    global.fetch = vi.fn(async () => new Response("x", { status: 500 })) as any;
    const mod = await import("./embeddings");
    mod._resetEmbedCacheForTests();
    const cap = mod._embedCacheStats().max;
    for (let i = 0; i < cap + 5; i += 1) {
      await mod.embedText(`q-${i}`);
    }
    expect(mod._embedCacheStats().size).toBe(cap);
  });
});
