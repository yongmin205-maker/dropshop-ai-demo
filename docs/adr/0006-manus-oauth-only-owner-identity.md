# Manus OAuth is the only Owner identity; no email/password, no SSO shopping

The Owner authenticates exclusively via Manus OAuth (`/api/oauth/callback`). There is no password store, no magic-link flow, and no third-party SSO (Google, Microsoft, Auth0). The `user.role` discriminator (`admin` vs `user`) is the single gate for write mutations on the DropShop tRPC procedures.

## Why this decision

- The pilot ships inside Manus and the Owner is, by construction, already a Manus account holder. Asking them to set up a second credential is friction with no security upside.
- Implementing email/password (or magic-link) means standing up an email transactional provider, password-reset flow, lockout policy, and breach-response runbook — none of which are core to the SMS concierge thesis.
- Custom SSO (Google / Microsoft) is a multi-week integration we cannot justify against a single-Owner pilot.

## Considered Options

- **Magic link via the existing notification helper** — rejected. Owner identity drift (one Owner, two link-clicks from different devices) creates ambiguous audit trails on Approvals.
- **Multi-tenant Owner accounts (one app, many stores)** — deferred until pilot 2 (Salon) is operational and the per-pilot data model proves stable. Documented separately in `mainstreet-ai/contexts/`.

## Consequences

- The app is unusable for any browser that blocks Manus cookies (Safari Private, Brave Aggressive Shields, Firefox Strict ETP) — surfaced in the README's OAuth section.
- Demo mode for friend-as-Owner relies on the Manus OAuth identity being pre-provisioned; the friend cannot self-register inside the app.
- When we eventually need a second Owner per store, the path is: keep Manus OAuth, extend `users` with a `storeId`, add a join table, and gate procedures on store membership — not switch auth providers.
