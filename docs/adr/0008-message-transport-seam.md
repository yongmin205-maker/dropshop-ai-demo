# MessageTransport seam — defined now, callers migrate later

> **Status: Superseded by fix/4-transport-migration.** The "Option B" choice
> below (define the seam, do not migrate the callers) was abandoned in fix/4
> after a third-party review flagged the un-migrated callers as invisible
> debt — the seam looked like progress in the diff but every live send still
> bypassed it. fix/4 migrates `drafts.approve`, `simulator.sendMessage` and
> `twilioWebhook` auto-send to consume `getMessageTransport().send()`; the
> SimulatorTransport now ships a real synthetic SIM sid which the UI labels
> "Delivered in Simulator (no real SMS)" so the operator never confuses
> a fake delivery with a real one. Original Option-B reasoning is preserved
> below for the audit trail; the **What ships now** / **What ships later**
> sections describe the original plan, not the current state.

## Phase 21c — semantic audit attestation

> Audit performed at sha `d8eff34` (post-21b merge). Scope: every reader of `messages.status` or `messages.mode='simulator'` in server, client, and tests. Findings:
>
> - No client-side code reads `messages.status` or `deliveryStatus` from outbound rows. The conversation panes render `direction` and `body` only; the queued vs sent transition is invisible to the UI.
> - No server-side query filters outbound rows by `status='queued'`. Outbound reads are by primary key (`id`) or by `twilioSid` for Twilio status-callback reconciliation.
> - No sweeper, cron, scheduler, or `setInterval` exists in the codebase that walks queued rows. The two-phase send completes synchronously inside the request that initiated it; rollback is via `withTransaction`.
> - The 'real synthetic SIM sid' described under "Status: Superseded" is therefore observable only in the database and in `[transport] simulator/send` logs. No reader treats it as anomalous.
>
> Conclusion: fix/4 + isTransportLive() did not introduce a hidden state that downstream code mishandles. The seam migration is semantically clean.

# Original ADR (Option B, superseded)

The codebase introduces a `MessageTransport` interface in `server/messaging/transport.ts` with three Adapters (`TwilioAdapter`, `SimulatorTransport`, `ShadowGuardTransport`) and a boot-time selector `getMessageTransport()`. **The three existing send call sites (`drafts.approve`, `simulator.sendMessage`, `twilioWebhook` auto-send) are not migrated to consume the transport in this round.** They continue to call `sendSms()` directly. The seam exists, but it is unused by the live paths today.

## Why this decision

The infrastructure is the cheap, low-risk part. The migration is the expensive, high-risk part because each of the three call sites currently relies on the implicit contract that `sendSms()` returns `{ ok: false, error: "Live Mode disabled" }` when Twilio creds are absent — and downstream UI / processing-log copy depends on that exact failure message. Switching the same call sites to `getMessageTransport().send()` would, in the no-creds default state, return `{ ok: true, sid: "SIM..." }` instead, which propagates as a *successful* outbound row in the database and a *sent* badge in the UI.

That change is the right long-term answer (the Simulator path *should* be modeled as a real send against a real-but-fake transport, not as a transport failure), but it is also a behaviour change visible to the Owner and to the friend's demo recipients. We are one day removed from a live 403 incident; doing two semantically meaningful changes back-to-back without a human in the loop on the demo is bad operational hygiene.

## What ships now

The interface, the three Adapters, and 13 contract tests in `server/messaging/transport.test.ts`. The transport module is exportable and documented; nothing in the live request path imports it yet.

## What ships later

The migration of `drafts.approve`, `simulator.sendMessage`, and `twilioWebhook` auto-send from `sendSms()` to `getMessageTransport().send()`. That migration must come with: a UI copy update for the Simulator-mode sent state ("Sent in Simulator" rather than "Sent"), a backfill of historical processing-log labels, and a deliberate test-and-demo cycle on the deployed sandbox. The natural trigger for the migration is the OpenPhone or Nextiva integration — at that point we *need* a real adapter for a non-Twilio carrier, and the cost-benefit flips.

## Considered Options

We considered doing the full migration today. Rejected because the value (cleaner test mocking, easier OpenPhone path) is real but speculative until OpenPhone work actually starts, while the risk (Simulator behaviour drift visible to the friend on the demo URL) is concrete and immediate.

We considered not landing the interface at all and waiting to do everything in one PR. Rejected because the ADR vocabulary, the Adapter type, and the contract tests are themselves valuable — they pin down what "a transport" means in this codebase before anyone tries to write a second one. Without the pin, the OpenPhone PR would re-litigate the shape of the seam.

## Consequences

The repo now has a documented Seam with no Adapter consumers, which violates the "two Adapters means a real Seam" rule from `CODE_AUDIT.md` § 5.2 in spirit. We accept the temporary violation because the Adapters exist and are tested — they are simply waiting for callers. The follow-up issue is recorded in `todo.md` Phase 18 and explicitly named as "OpenPhone integration trigger" so it is not silently forgotten.
