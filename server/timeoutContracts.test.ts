import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contract tests for production-critical timeout + fallback behavior.
 *
 *   - `_core/llm.invokeLLM` MUST abort the upstream fetch after ~30s and
 *     surface a clear timeout error. Without this, one stuck LLM call could
 *     hold a worker indefinitely.
 *
 *   - `embeddings.embedText` MUST set the embedding-fallback flag to `true`
 *     the first time the Forge embedding endpoint is unavailable, and the
 *     flag MUST stay `true` for the rest of the process lifetime even if a
 *     later call succeeds (because mixed embeddings are no longer comparable
 *     and the operator deserves to know).
 */

describe("_core/llm.invokeLLM timeout", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env.BUILT_IN_FORGE_API_KEY;
    process.env.BUILT_IN_FORGE_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BUILT_IN_FORGE_API_KEY;
    else process.env.BUILT_IN_FORGE_API_KEY = originalKey;
    vi.useRealTimers();
  });

  it("aborts the fetch when AbortController.signal fires and surfaces a timeout error", async () => {
    // Simulate a hung upstream by returning a fetch that resolves with a
    // never-completing Response *until* its abort signal fires. We attach a
    // .catch() to the dangling promise so vitest's unhandled-rejection guard
    // stays quiet after the test asserts the timeout error.
    globalThis.fetch = vi.fn((_url: any, init: any) => {
      const p: Promise<Response> = new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig) {
          sig.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as any).name = "AbortError";
            reject(err);
          });
        }
      });
      // Swallow the rejection at the source — the SUT (invokeLLM) will
      // catch the AbortError via its own try/catch and re-throw a friendly
      // message; we only need to keep the raw promise from leaking up to
      // the unhandled-rejection handler.
      p.catch(() => {});
      return p;
    }) as any;

    vi.useFakeTimers();
    const { invokeLLM } = await import("./_core/llm");
    const promise = invokeLLM({ messages: [{ role: "user", content: "hi" }] });
    // Same defensive catch on the SUT promise: even though we await it via
    // expect().rejects below, attaching a no-op catch immediately prevents a
    // microtask-ordering race where the rejection is observed before the
    // assertion attaches.
    promise.catch(() => {});

    // Advance past the 30s timeout the implementation installs.
    await vi.advanceTimersByTimeAsync(30_500);

    await expect(promise).rejects.toThrow(/timed out after 30s/);
  });
});

describe("embeddings.embedText fallback flag", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env.BUILT_IN_FORGE_API_KEY;
    process.env.BUILT_IN_FORGE_API_KEY = "test-key";
    vi.resetModules(); // reset module-level fallback flag between tests
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BUILT_IN_FORGE_API_KEY;
    else process.env.BUILT_IN_FORGE_API_KEY = originalKey;
  });

  it("flips isEmbeddingFallbackActive=true the first time Forge fails", async () => {
    // First call: forge returns 500 → fallback engages.
    globalThis.fetch = vi.fn(async () => new Response("err", { status: 500 })) as any;

    const mod = await import("./embeddings");
    expect(mod.isEmbeddingFallbackActive()).toBe(false);
    const v = await mod.embedText("test sentence");
    expect(Array.isArray(v) && v.length > 0).toBe(true);
    expect(mod.isEmbeddingFallbackActive()).toBe(true);
  });

  it("keeps the flag sticky once set, even after a later success", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("err", { status: 500 });
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.01) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const mod = await import("./embeddings");
    await mod.embedText("first");
    expect(mod.isEmbeddingFallbackActive()).toBe(true);
    await mod.embedText("second");
    expect(mod.isEmbeddingFallbackActive()).toBe(true);
  });
});
