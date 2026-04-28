# Ubiquitous Language

Single source of truth for the domain terms used in this codebase. When schema, code, UI copy, ADRs, and demo scripts disagree, **this file wins** — open a PR to revise it before deviating.

Derived from real usage in `drizzle/schema.ts`, `server/routers.ts`, `server/aiAgent.ts`, `client/src/pages/dropshop/*`, and the master pilot context at `mainstreet-ai/contexts/pilot1_dropshop.md`.

---

## Conversation lifecycle

| Term                     | Definition                                                                                                                              | Aliases to avoid                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Conversation**         | The thread of inbound and outbound SMS/MMS for one customer phone number. One row in `conversations`.                                   | thread, chat, ticket                      |
| **Message**              | A single inbound or outbound SMS/MMS turn within a Conversation. One row in `messages`.                                                 | text, sms, line, item                     |
| **Inbound Message**      | A Message with `direction = "inbound"` — what the customer sent.                                                                        | incoming, customer message                |
| **Outbound Message**     | A Message with `direction = "outbound"` — what the store sent (after Approval).                                                         | outgoing, agent message, reply            |
| **Intent**               | The current category label for a Conversation (e.g. `Pickup Request`, `ETA/Order Status`, `Critical Escalation`). Mutable per turn.     | category, type, label                     |

## Approval lifecycle

| Term                     | Definition                                                                                                                              | Aliases to avoid                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Draft**                | An AI-generated reply candidate for an Inbound Message, awaiting Owner action. One row in `drafts`. Has `status` and `revision`.        | suggestion, candidate, proposal, response |
| **Pending Draft**        | A Draft with `status = "pending_approval"` — currently visible in the Approval Queue.                                                   | open draft, queued draft                  |
| **Approval**             | The act of an Owner accepting a Pending Draft, which produces an Outbound Message via Two-Phase Send.                                   | confirm, send, accept                     |
| **Rejection**            | The act of an Owner refusing a Pending Draft, captured with a `category` and free-text `reason`. Stored in `rejections`.                | reject, decline, dismiss                  |
| **Supersede**            | Marking older Pending Drafts for the same Inbound Message as `status = "superseded"` when a new revision is generated.                  | replace, override                         |
| **Revision**             | Monotonic counter on Drafts for the same Inbound Message. Increments when the Agent regenerates after a Rejection or new context.       | version, attempt                          |

## Send pipeline (Two-Phase Send)

| Term                     | Definition                                                                                                                              | Aliases to avoid                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Two-Phase Send**       | Always insert the Outbound Message row as `status = "queued"` **before** calling Twilio; only flip to `sent` after Twilio acknowledges.  | optimistic send, fire-and-forget          |
| **Live Mode**            | Real Twilio credentials are loaded **and** `DROPSHOP_LIVE_MODE=1`; outbound calls hit the carrier.                                      | production mode, prod                     |
| **Simulator Mode**       | Default state for every demo: no Twilio call ever fires. UI labels reflect this with a visible badge.                                   | demo mode, dry-run, dev mode              |
| **Auto-Send**            | When `DROPSHOP_AUTO_SEND=1`, low-risk Approved Drafts may be sent without an explicit Owner click. **MMS forces HITL regardless.**      | auto-approve, autopilot                   |
| **HITL**                 | Human-In-The-Loop. The default Approval policy: every Draft requires explicit Owner Approval before send.                               | manual mode, supervised mode              |

## Escalation

| Term                     | Definition                                                                                                                              | Aliases to avoid                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Escalation**           | A flag raised on a Conversation that requires Owner attention beyond the regular queue. One row in `escalations` with `reason`.         | alert, flag, urgent ticket                |
| **Critical Escalation**  | The most severe Intent, surfaces in the Critical tab. Triggered by keywords (theft, lawsuit, etc.) or any inbound MMS.                  | priority alert, P0                        |
| **Resolve**              | Owner action that closes one Escalation row. Conversation `escalated` flag clears only when **no** Escalations remain open for it.      | dismiss, close, ack                       |

## Knowledge & memory

| Term                     | Definition                                                                                                                              | Aliases to avoid                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **RAG Memory**           | The retrieval surface the Agent consults before drafting: prior Conversations + Knowledge Chunks + Style Examples + Rejections.         | context, memory, history                  |
| **Knowledge Chunk**      | A unit of store-specific information (hours, pricing, policy) embedded into the RAG index. Row in `knowledgeChunks`.                    | doc, snippet, fact                        |
| **Style Example**        | A previously Approved (Inbound, Outbound) pair used to teach the Agent the Owner's voice. Row in `styleExamples`.                       | template, sample, exemplar                |
| **Rejection** (memory)   | Stored not just as feedback but as a **negative example** the Agent must consult on similar future Drafts.                              | feedback, correction                      |
| **Embedding Fallback**   | Policy: when the embedding service is unavailable, retrieval degrades to keyword match — never silently returns empty.                  | offline mode, no-vec mode                 |

## Actors

| Term                     | Definition                                                                                                                              | Aliases to avoid                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Owner**                | The store operator using the Approval Queue. Same identity as the Manus OAuth user with `role = "admin"` for this pilot.                | admin, user, operator                     |
| **Customer**             | The texting end-user identified solely by phone number. Has no auth identity in our system; tracked via `conversations.phone`.          | client, lead, contact                     |
| **Agent**                | The LLM-driven module that produces Drafts, classifies Intent, and consults RAG Memory. Implemented in `server/aiAgent.ts`.             | bot, AI, model                            |

## Pilots & contexts

| Term                     | Definition                                                                                                                              | Aliases to avoid                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **DropShop**             | The dry-cleaning pilot (Pilot 1). The default surface of this app. Uses CleanCloud-shaped mock data + Pickup/ETA intents.               | cleaning, laundry mode                    |
| **Salon**                | The hair-salon pilot (Pilot 2). Toggleable from the header. Uses appointment-shaped mock data + Booking/ETA/Gap-Filler intents.         | spa, beauty mode                          |
| **Pilot Context**        | The strategic + operational decisions for one pilot, owned in `mainstreet-ai/contexts/pilotN_*.md`, **not** in the app repo.            | strategy doc, brief                       |

## Relationships

- A **Conversation** has many **Messages**; the latest Inbound Message has at most one **Pending Draft**.
- An **Approval** of a Draft creates exactly one **Outbound Message** via **Two-Phase Send**.
- A **Rejection** is both a transition (Draft → `rejected`) and a piece of **RAG Memory** consulted on the next Draft.
- An **Escalation** belongs to exactly one **Conversation**; one Conversation may have many open Escalations.
- The **Agent** never sends without an **Approval**, except when **Auto-Send** is enabled and the Draft is non-MMS.

## Example dialogue

> **Owner:** "I rejected three Drafts for the same Customer in a row — why is the Agent still suggesting the same wording?"
> **Engineer:** "Each Rejection is supposed to land in **RAG Memory** as a negative example. If the **Embedding Fallback** kicked in we degrade to keyword match — same-token Inbounds will still surface the Rejection but paraphrases will miss. Check the Errors tab for embedding outages."
> **Owner:** "And if the Customer texts a photo of a stained zipper?"
> **Engineer:** "Any inbound MMS is forced to **Critical Escalation** — no Draft generated, the **Agent** never sees it. Even with **Auto-Send** on, MMS stays HITL."
> **Owner:** "If I click Approve and Twilio is down?"
> **Engineer:** "Two-Phase Send: the Outbound Message is already in the DB as `queued`. We retry; if it permanently fails, the Draft re-opens to `pending_approval` so you can re-send or edit."

## Flagged ambiguities

- **"User" was used for both Owner and Customer** in early drafts. They are different: the **Owner** has a Manus OAuth identity and `role = "admin"`; the **Customer** is identified only by phone and has no account. When `ctx.user` appears in code it is **always** the Owner.
- **"Reply" was used for both Draft and Outbound Message.** A **Draft** is a candidate that may never be sent; an **Outbound Message** is what was actually transmitted. Use the precise term.
- **"Send" was used for both Approval and the Twilio call.** Approval is the *intent* to send; the Twilio call is the *attempt*. Two-Phase Send lets us distinguish queued (Approved, not yet acknowledged) from sent (Twilio ack received).
- **"Mode" was overloaded** between Live/Simulator (transport policy) and DropShop/Salon (pilot persona). The first is **Send Mode**; the second is **Pilot**.
