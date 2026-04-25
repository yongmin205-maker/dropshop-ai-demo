import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Pins §4.4 + §4.12: when the embedding service is in fallback mode the agent
 * MUST tighten its RAG retrieval policy (smaller K, higher cosine floor) so
 * that lexical hash-bag matches don't flood the prompt.
 */

describe("ragRetrievalDefaults() — adaptive RAG policy under embedding fallback", () => {
  afterEach(() => { vi.resetModules(); });

  it("returns generous defaults when embeddings are healthy", async () => {
    const mod = await import("./embeddings");
    // Sanity: a fresh import means the fallback flag is false.
    expect(mod.isEmbeddingFallbackActive()).toBe(false);
    const policy = mod.ragRetrievalDefaults();
    expect(policy).toEqual({
      topKKnowledge: 3,
      topKExamples: 3,
      topKRejections: 2,
      minScore: 0,
      fallback: false,
    });
  });

  it("tightens to k/2 + cosine floor 0.7 once fallback has been tripped", async () => {
    vi.resetModules();
    const mod = await import("./embeddings");
    // Force fallback by stubbing fetch to fail so embedText() trips the flag.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error("upstream unreachable"); }) as any;
    try {
      await mod.embedText("hello world");
      expect(mod.isEmbeddingFallbackActive()).toBe(true);
      const policy = mod.ragRetrievalDefaults();
      expect(policy.fallback).toBe(true);
      expect(policy.topKKnowledge).toBeLessThan(3);
      expect(policy.topKExamples).toBeLessThan(3);
      expect(policy.topKRejections).toBeLessThan(2);
      expect(policy.minScore).toBeGreaterThanOrEqual(0.7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("topK() — minScore floor", () => {
  it("filters out items below the requested cosine floor", async () => {
    const { topK } = await import("./embeddings");
    const items = [
      { id: 1, embedding: [1, 0, 0] }, // identical → cosine 1.0
      { id: 2, embedding: [1, 1, 0] }, // ~0.707
      { id: 3, embedding: [0, 1, 0] }, // 0.0
    ];
    const ranked = topK([1, 0, 0], items, 5, { minScore: 0.7 });
    expect(ranked.map((r) => r.id)).toEqual([1, 2]); // 3 dropped
  });

  it("defaults to no floor when minScore is omitted", async () => {
    const { topK } = await import("./embeddings");
    const items = [
      { id: 1, embedding: [0.1, 0.1, 0.1] },
      { id: 2, embedding: [0, 0, 0] }, // zero vector → score 0
    ];
    const ranked = topK([1, 0, 0], items, 5);
    // Item 2 has score exactly 0 — with default minScore=0 it's filtered (>0).
    // Item 1 has a small positive score and stays.
    expect(ranked.map((r) => r.id)).toContain(1);
  });
});
