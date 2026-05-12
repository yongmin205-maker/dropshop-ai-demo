# Architecture Decision Records

Each ADR captures one decision that is hard to reverse, surprising without context, and the result of a real trade-off — per the criteria in the [mattpocock/skills `domain-model` skill](https://github.com/mattpocock/skills/tree/main/domain-model). Routine library choices and easily-reversible refactors do not get an ADR.

| #    | Decision                                                               |
| ---- | ---------------------------------------------------------------------- |
| 0001 | HITL by default; Auto-Send opt-in, never for MMS                       |
| 0002 | Two-Phase Send for outbound message lifecycle                          |
| 0003 | Origin allow-list uses suffix matching, not Host comparison            |
| 0004 | Inbound MMS forces Critical Escalation; Agent is never invoked         |
| 0005 | RAG retrieval degrades to keyword match when embeddings fail           |
| 0006 | Manus OAuth is the only Owner identity                                 |
| 0007 | Real-store integration runs in shadow-mode before Live Mode            |
| 0008 | MessageTransport seam defined; callers migrate later                   |
| 0009 | Nextiva developer API access is blocked for pilot account; defer       |

When a decision is reversed or superseded, mark the original ADR with a `Status: superseded by ADR-NNNN` line at the top — do not delete the file. The point of an ADR is to record that a decision was made and why; the historical reasoning is valuable even after the decision changes.

For domain vocabulary used inside these ADRs, refer to `UBIQUITOUS_LANGUAGE.md` at the repo root.
