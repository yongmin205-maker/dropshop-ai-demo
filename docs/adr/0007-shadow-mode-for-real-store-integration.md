# Real-store integration runs in shadow-mode before Live Mode

When the friend's actual texting line (Nextiva today, OpenPhone candidate) is connected, inbound webhooks land in a Shadow Inbox table for Owner review only. The Agent never drafts against shadow inbounds and `sendSms` is hard-blocked regardless of `DROPSHOP_LIVE_MODE`. Promotion to Live Mode is a separate, deliberate flag flip after a clean shadow period.

## Why this decision

The first weeks of real-store data exist to answer two questions: do our intent labels match what customers actually text about, and does our Knowledge Chunk + Style Example library cover the long tail of phrasings? Both questions are answered by reading inbounds. Neither requires the Agent to act, and any premature send carries asymmetric downside (one wrong text to a regular customer can end the pilot relationship).

Shadow-mode also gives us a safe surface to sanity-check webhook signature verification, attachment URL handling, and timezone parsing against real carrier payloads — things that are easy to get wrong and impossible to discover from synthetic fixtures.

## Considered Options

- **Skip shadow, ramp directly into HITL Live Mode** — rejected. HITL still puts a tested-but-unreviewed Draft in front of the Owner under time pressure; Approval fatigue would set in before we knew whether the Drafts were any good.
- **Auto-classify shadow inbounds into intents but suppress Drafts** — partially adopted. Intent classification runs because it costs us nothing and gives the Owner a useful triage view; Draft generation is the explicit tripwire.

## Consequences

- The `messaging/inboundPipeline.ts` module owns the Shadow Inbox vs. live routing decision and is covered by `inboundPipeline.test.ts`.
- The shadow → live transition is an environment flag plus a one-time data backfill of approved Style Examples, not a code change. The runbook for that transition lives in `mainstreet-ai/contexts/pilot1_dropshop.md`.
- Carrier choice (Nextiva vs. OpenPhone) is independent of this decision; both can feed the same Shadow Inbox via a thin adapter.
