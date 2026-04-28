# HITL by default; Auto-Send is opt-in and never applies to MMS

Every AI Draft requires explicit Owner Approval before an Outbound Message is sent. Auto-Send is gated by `DROPSHOP_AUTO_SEND=1` and even then is suppressed for any inbound that contains MMS, low-confidence intent, or Critical Escalation triggers.

## Why this decision

The first failure mode for an SMS concierge product is sending the wrong text to a customer the Owner has a years-long relationship with. The recovery cost (a confused or angry customer call) dwarfs the productivity gain of skipping one click. We optimize for **trust earned per Approval**, not throughput.

## Considered Options

- **Full autopilot from day one** — rejected. Demo-stage product with no per-customer reputation cushion; one bad send torches the pilot.
- **Per-intent allowlist for Auto-Send** — deferred. Worth revisiting once we have ≥200 Approvals of data per intent class to argue from.

## Consequences

- Owner click is on the critical path of every send. UX must keep Approval to ≤2s of cognition (kept via the Approval Queue card layout, single primary button, keyboard shortcut).
- MMS handling is irreducibly HITL-only and must short-circuit the Agent entirely (see ADR 0004).
