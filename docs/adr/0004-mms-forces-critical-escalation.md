# Inbound MMS forces Critical Escalation; Agent is never invoked

When an inbound webhook payload contains `NumMedia ≥ 1` we persist the inbound Message with attachments, raise an Escalation with `reason = "attachment received"`, set the Conversation Intent to `Critical Escalation`, and **return without invoking the Agent or generating any Draft**. Auto-Send remains suppressed regardless of the flag.

## Why this decision

Customer photos almost always communicate something the LLM would mishandle: stains the customer wants assessed, damaged garments, items left behind, a printed receipt with a number we cannot OCR reliably. A confident text reply to a photo we did not look at is the worst-case Owner-trust failure. The only acceptable behaviour is "human eyes on this, now" and the Critical tab is the surface designed for it.

## Considered Options

- **Multimodal LLM call on the photo** — deferred. Latency, cost, and false-confidence risk are all material. Worth revisiting once we have a pre-classified intent (e.g. "ETA inquiry with photo of receipt") that we trust the LLM to handle on a structured field, not on the image.
- **Generate a Draft asking "got the photo, looking now"** — rejected. Encourages Owner to Approve a templated reply without inspecting the image, defeating the purpose of the Escalation.

## Consequences

- The MMS code path in `twilioWebhook.ts` is intentionally short-circuit and is exercised by `server/twilioWebhook.mms.test.ts` (4 contracts, all green).
- Owner sees the photo as an attachment in the Critical tab; no Draft card appears in the Approval Queue for that turn.
