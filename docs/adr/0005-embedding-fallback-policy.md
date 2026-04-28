# RAG retrieval degrades to keyword match when embeddings fail

When the embedding endpoint returns an error or times out, retrieval over Knowledge Chunks, Style Examples, and Rejections falls back to a tokenized substring match against the inbound body. We never silently return an empty result set, and we never block draft generation on the embedding outage.

## Why this decision

Empty RAG context produces bland, off-voice Drafts that look correct in unit tests but read as obviously machine-written to the Owner. The Owner's most common feedback in early sessions was "this doesn't sound like me" — almost always traceable to retrieval returning zero Style Examples. Better to surface a slightly-stale keyword match than to ship a generic response and erode trust.

The fallback also keeps the Errors tab honest: an embedding outage is logged but does not propagate as a failed mutation, so the Owner can keep working while we recover the upstream service.

## Consequences

- Retrieval quality is bimodal: either embeddings (sharp, semantic) or keyword (loose, lexical). The Drafts produced under fallback are flagged with a `ragMode = "keyword"` note in the processing log.
- Tests for the fallback path live in the retrieval layer and are seeded explicitly — no hidden randomization.
- We must monitor fallback frequency; sustained fallback (>10% of generations over an hour) is itself an Escalation-class signal worth alerting the Owner about. Not yet built.
