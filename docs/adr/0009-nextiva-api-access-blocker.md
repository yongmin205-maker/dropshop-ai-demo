# ADR 0009: Nextiva developer API access is blocked for our pilot account; defer integration

- Status: Accepted
- Date: 2026-05-12

## Context

Our pilot-1 friend ("Drop Shop", Frafk LLC) runs their business phone on
**Nextiva (NextivaONE plan)** and would like inbound SMS to flow through their
existing `+1 (646) 889-2423` business line rather than a new Twilio number. We
attempted to integrate with the Nextiva developer API documented at
[developer.nextiva.com](https://developer.nextiva.com/), specifically:

| Operation         | Documented URL                                          | Method | Auth                      |
| ----------------- | ------------------------------------------------------- | ------ | ------------------------- |
| Login             | `https://api.nextiva.com/provider/token-with-authorities` | GET    | Basic base64(user:pass)   |
| List workitems    | `https://api.nextiva.com/data/api/types/workitem`        | GET    | Bearer JWT                |
| Send outbound SMS | `https://api.nextiva.com/users/api/sms`                  | POST   | Bearer JWT                |

We registered the friend's real Nextiva credentials in the project secret
store (`NEXTIVA_USERNAME`, `NEXTIVA_PASSWORD`, `NEXTIVA_PHONE_NUMBER`),
implemented `server/messaging/nextivaTransport.ts` against the documented
contract, and ran a live integration test (`nextivaTransport.live.test.ts`,
gated by `RUN_NEXTIVA_LIVE=1`).

## Findings (live probe, 2026-05-12)

We probed 4 host candidates × 6 path candidates against the real credentials
and recorded the response status + first 200 chars of body for each
combination. The full grid is preserved in the test log; the salient pattern:

- **`api.nextiva.com`** — every documented path returns `HTTP 404` with the
  generic "Nextiva Web Server" Nginx-style 404 page. That is, the host is
  reachable but **does not serve the developer API for our account**.
- **`nextos-api.nextiva.com`** — DNS does not resolve (no such host).
- **`nextos.nextiva.com`** — every path (documented or not) returns `HTTP 200`
  with the same `text/html` body whose `<title>` is "Nextiva Online Account —
  Secure Login". POST + JSON, POST + form-urlencoded, and GET + Basic Auth all
  produce the same HTML. This is a SPA login portal, not an API endpoint.
- **`api.thrio.com`** (Thrio is the contact-center vendor Nextiva acquired) —
  every path returns `HTTP 404` with a different SPA shell. Suggests a real
  application server but our account is not provisioned for it.

No combination returned a JSON body, a 401 with `WWW-Authenticate`, or any
other signal of a live API endpoint our credentials could use.

## Interpretation

Cross-referencing this with what we already knew about the friend's account:

1. Friend's plan is **NextivaONE** (PBX + business SMS), not
   **Nextiva Contact Center** / NextOS Engage. The contact-center features in
   the Nextiva web UI were previously observed as **locked** for this account.
2. The endpoints documented at `developer.nextiva.com` are the
   **NextOS Contact Center / workitem service** API — the same product line
   Thrio originally built and Nextiva resells. Access to those endpoints
   appears to be gated behind the Contact Center plan and a separate API
   provisioning step (likely the "Provider App registration" implied by the
   `/provider/token-with-authorities` path name).
3. Therefore the friend's `care@visitdropshop.com` credentials are valid for
   logging into the regular Nextiva web app (which is why `nextos.nextiva.com`
   serves them the login HTML) but are **not authorized for the developer
   API**.

In short: **Nextiva's published developer API is not accessible on this
pilot account, and we cannot fix that from the client side.**

## Decision

We will:

1. **Stop trying to make `nextivaTransport.ts` reach Nextiva.** The module is
   kept as scaffolding (and its unit tests still validate the contract we
   *would* use if access were granted), but no production code path will
   instantiate it.
2. **Document the probe results in this ADR** so a future agent (or the human
   operator) does not re-do the same investigation.
3. **Keep the live test gated by `RUN_NEXTIVA_LIVE=1`** but mark its first
   case (`deep-probes …`) as a one-shot diagnostic that can be re-run if the
   account's API access changes. The other two cases (authenticate / poll)
   are expected to fail under the current account state.
4. **Surface the blocker to the operator (the friend)** with three concrete
   forward paths to choose between:
   - **(a) Stay on Twilio for pilot-1.** Already integrated and tested. The
     friend would publish a Twilio number (not the Nextiva one) for AI-handled
     SMS, and keep the Nextiva line for voice. Lowest friction, ships today.
   - **(b) Number-forward Nextiva → Twilio.** Configure Nextiva to forward
     inbound SMS on `+1 (646) 889-2423` to a Twilio number we control. Keeps
     the customer-facing number unchanged. Requires the friend to flip a
     setting in the Nextiva admin UI; no API access needed.
   - **(c) Request Contact Center API access from Nextiva.** Likely
     requires a plan upgrade and a multi-week sales/provisioning cycle. We
     would resume this ADR's integration path once the account returns 2xx on
     `/provider/token-with-authorities`.

The decision-record itself does **not** pick (a)/(b)/(c) — that is the
friend's call. What we *are* recording here is that **integrating today is
blocked by an account-level entitlement, not by a bug in our code.**

## Consequences

- The `MessageTransport` seam from ADR 0008 still has only one production
  implementation (Twilio). The `NextivaAdapter` is not yet a candidate for the
  selector in `server/messaging/transport.ts`.
- Phase 22's roadmap is reshuffled: **Simple Mode (Phase 22a)** is promoted
  to the next deliverable since it is independent of the carrier and directly
  addresses the friend's feedback ("hide the unnecessary panels").
- If forward path (b) is chosen, the integration becomes a Twilio webhook
  configuration change only — no new transport, no new ADR.
- If forward path (c) is chosen later, this ADR should be amended (not
  replaced) with the date the API access was granted and the resulting status
  codes from the same probe grid.

## Probe grid (raw)

For reproducibility, the exact host × path grid we tested with the friend's
real credentials. `ERR` means DNS or TCP-level failure; everything else is
the HTTP status returned by the server.

```
404  GET https://api.nextiva.com/provider/token-with-authorities
404  GET https://api.nextiva.com/api/provider/token-with-authorities
404  GET https://api.nextiva.com/v1/provider/token-with-authorities
404  GET https://api.nextiva.com/nextos/provider/token-with-authorities
404  GET https://api.nextiva.com/auth/api/v1/login
404  GET https://api.nextiva.com/auth/api/generateTokenWithAuthorities
ERR  GET https://nextos-api.nextiva.com/*                            (DNS no-resolve)
200  GET https://nextos.nextiva.com/auth/api/generateTokenWithAuthorities  → HTML login page
200  GET https://nextos.nextiva.com/provider/token-with-authorities       → HTML login page
404  GET https://api.thrio.com/*                                          (SPA 404, all paths)
```

Deep probe of the only 200-returning endpoint:

```
POST + JSON body            → 200  Content-Type: text/html  (login page)
POST + form-urlencoded body → 200  Content-Type: text/html  (login page)
GET  + Basic Auth header    → 200  Content-Type: text/html  (login page)
```

No combination produced a JSON body, a `Set-Cookie` for a session, or a 401.

## References

- ADR 0008 — MessageTransport seam (which Nextiva would have been the second adapter for)
- `server/messaging/nextivaTransport.ts` — scaffolding kept for future use
- `server/messaging/nextivaTransport.test.ts` — 19 unit tests pinning the documented contract
- `server/messaging/nextivaTransport.live.test.ts` — gated probe + integration tests
