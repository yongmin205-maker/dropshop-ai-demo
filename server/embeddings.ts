import { ENV } from "./_core/env";

/**
 * Lightweight embedding helper for DropShop RAG.
 *
 * Strategy:
 *   1. Try OpenAI-compatible /v1/embeddings endpoint on the Forge proxy.
 *   2. If that 404s or fails, fall back to a deterministic hash-bag embedding
 *      so the demo keeps working end-to-end without an external vector service.
 *
 * The deterministic fallback is NOT semantic, but it is stable across calls
 * (same text → same vector) and therefore nearest-neighbour lookups over
 * approved examples / rejection lessons still return meaningful results
 * when customers repeat similar phrasing. In production we would switch to
 * OpenAI text-embedding-3-small or a self-hosted BGE model.
 */

const DIM = 256;

function hashBagEmbedding(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const tok of tokens) {
    // djb2 hash
    let h = 5381;
    for (let i = 0; i < tok.length; i += 1) {
      h = ((h << 5) + h + tok.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(h) % DIM;
    vec[idx] += 1;
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * Set to true the first time we fall back to the deterministic hash-bag
 * embedding (i.e. Forge call failed or returned junk). Surfaced via
 * `config.get` so the dashboard can show an honest "semantic search degraded"
 * banner during the demo.
 */
let __embeddingFallbackActive = false;
export function isEmbeddingFallbackActive(): boolean {
  return __embeddingFallbackActive;
}

async function tryForgeEmbedding(text: string): Promise<number[] | null> {
  if (!ENV.forgeApiKey) return null;
  const base = ENV.forgeApiUrl?.replace(/\/$/, "") || "https://forge.manus.im";
  // Hard 5s timeout: an unbounded embedding call would block every customer
  // turn behind it (we await this synchronously).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);
  try {
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ embedding: number[] }>;
    };
    const emb = json.data?.[0]?.embedding;
    if (Array.isArray(emb) && emb.length > 0) return emb;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function embedText(text: string): Promise<number[]> {
  const forge = await tryForgeEmbedding(text);
  if (forge) {
    // Forge succeeded — we are *not* in fallback mode for this call. We do not
    // unset the global flag because once a deployment has started serving
    // semantically-degraded vectors, future Forge successes still mix with
    // those rows, and the operator should be told.
    return forge;
  }
  __embeddingFallbackActive = true;
  return hashBagEmbedding(text);
}

export function cosineSim(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Cosine top-K with an optional `minScore` floor. Callers should pass the
 * threshold returned by `ragRetrievalDefaults()` so retrieval automatically
 * tightens when the embedding service is in fallback mode (lexical hash-bag
 * vectors are noisier and produce more spurious near-matches).
 */
export function topK<T extends { embedding: unknown }>(
  query: number[],
  items: T[],
  k: number,
  options: { minScore?: number } = {},
): Array<T & { score: number }> {
  const min = options.minScore ?? 0;
  return items
    .map((it) => {
      const emb = Array.isArray(it.embedding) ? (it.embedding as number[]) : [];
      return { ...it, score: cosineSim(query, emb) };
    })
    .filter((it) => it.score > min)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Returns the retrieval policy the agent should use right now.
 *
 * - **Healthy mode** (semantic embeddings): generous top-K (3) and a permissive
 *   floor (>0), letting weak-but-real matches surface.
 * - **Fallback mode** (hash-bag vectors): cut top-K in half (the matches are
 *   noisier so we don't want to flood the prompt with junk) and raise the
 *   cosine floor to 0.7 so only confident lexical overlaps make it through.
 *   This is the §4.12 "degrade gracefully instead of confidently" rule.
 */
export function ragRetrievalDefaults(): { topKKnowledge: number; topKExamples: number; topKRejections: number; minScore: number; fallback: boolean } {
  if (__embeddingFallbackActive) {
    return { topKKnowledge: 2, topKExamples: 2, topKRejections: 1, minScore: 0.7, fallback: true };
  }
  return { topKKnowledge: 3, topKExamples: 3, topKRejections: 2, minScore: 0, fallback: false };
}
