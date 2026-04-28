# Two-Phase Send for outbound messages

Every outbound SMS/MMS is persisted as a `messages` row with `status = "queued"` **before** the Twilio call is made; the row only flips to `sent` after Twilio acknowledges with a SID. On Twilio failure the row flips to `failed` and the originating Draft is reopened to `pending_approval` so the Owner can re-send or edit.

## Why this decision

Without the queued-first row we cannot answer two of the most common production questions: "did the customer get my reply?" and "the carrier returned 21610 (blocked recipient) — what do I do now?" A naive optimistic flow would either lose the message on a server crash between Twilio call and DB write, or surface success to the Owner UI on a transport failure. Both are unrecoverable without rebuilding state from Twilio's API, which is rate-limited and slow.

Two-Phase Send also gives delivery callbacks a stable target row to update, and gives the Critical tab a place to surface stuck `queued` rows older than ~60 s.

## Consequences

- The `messages` table mixes confirmed and pending sends; every read path that lists outbounds must filter or label by `status`.
- Failure → reopen Draft is the **only** allowed transition; we never silently drop. Tested in `server/draftStateMachine.test.ts`.
- Tests must pre-seed `queued` rows to exercise the success and failure paths separately. Use `fromPartial<Parameters<typeof db.appendMessage>[0]>` per the shoehorn migration in this repo.
