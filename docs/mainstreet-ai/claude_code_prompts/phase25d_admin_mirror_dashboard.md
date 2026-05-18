# Phase 25d — Admin Mirror Dashboard (drill-down + replay + per-table inspector)

> **Audience: Claude Code**, working autonomously inside this repo on a fresh feature branch.
> Do not stop to ask for clarification; every decision below is final. If something looks
> ambiguous, prefer the most boring, conservative interpretation: no creative refactors, no
> renaming of existing public exports, no reformatting unrelated files. Match the conventions
> of the existing 25a / 25b / 25c code already on disk.

---

## 0. Goal in one sentence

Replace the **interim** `client/src/components/PosMirrorPanel.tsx` with a richer admin
dashboard that turns the POS mirror into something the store owner can actually inspect:
per-endpoint freshness gauges, error replay, drill-down tables for `posOrders` /
`posCustomers` / `posProducts` / `posPayments`, and a price-change feed sourced from
`posProductChanges`. Keep all existing tRPC procedures and DB tables; only add new ones
where strictly needed.

---

## 1. Branch & deliverable

1. Create a new branch off `main`: `feat/25d-admin-mirror-dashboard`.
2. Open exactly one PR titled `Phase 25d: Admin Mirror Dashboard`.
3. Do **not** delete `client/src/components/PosMirrorPanel.tsx`. Replace its body with a
   re-export of the new component so existing imports keep working:
   ```ts
   // PosMirrorPanel.tsx — kept as a stable import path; new UI lives under
   // ./mirror/MirrorDashboard.tsx (Phase 25d). Future phases should import
   // from MirrorDashboard directly.
   export { MirrorDashboard as PosMirrorPanel } from "./mirror/MirrorDashboard";
   ```
4. The existing `client/src/components/PosMirrorPanel.test.tsx` MUST keep passing
   unchanged (test the re-exported symbol). Run it as part of your final `pnpm test`.

---

## 2. Project context (already on disk; verify, do not recreate)

### 2.1 Schema (already shipped in 25a)

`drizzle/schema.ts` already contains:

- `posCustomers(id, source, externalId, name, phoneE164, syncedAt, createdAt, updatedAt, ...)`
- `posOrders(id, source, externalId, customerExternalId, status, finalTotalCents, paid, completed, express, placedAt, pickupAt, deliveryAt, syncedAt, ...)`
  — `status` is enum `POS_ORDER_STATUSES` (`received`, `in_progress`, `ready`, `delivered`, `cancelled`, ...).
- `posPayments(id, source, externalId, orderExternalId, amountCents, type, paidAt, ...)`
- `posProducts(id, source, externalId, name, category, priceCents, ...)`
- `posExternalRefs(id, source, externalId, internalTable, internalId, ...)`
- `posSyncLog(id, source, trigger, endpoint, startedAt, finishedAt, rowsFetched, rowsUpserted, rowsFailed, windowFrom, windowTo, error, ...)`
- `posProductChanges(id, source, externalId, kind, oldPriceCents, newPriceCents, productName, syncLogId, detectedAt)`
  — `kind` enum: `added`, `removed`, `price_changed`.

The `source` value for our pilot store is `"cleancloud"`. Other valid sources per the
enum are `"dropshop_pos"` (future). When in doubt, `eq(posXxx.source, "cleancloud")`.

**Do not add or alter columns.** If you find you "need" a new column, you are over-scoping;
derive the value at query time instead.

### 2.2 Existing tRPC sub-router

`server/routers.ts` already contains a `posMirror` sub-router at line ~1197. It exports:

- `runDailyPullNow`        — `adminProcedure.mutation`
- `runBackfill({monthsBack})` — `adminProcedure.mutation`
- `syncStatus`            — `adminProcedure.query` returning `{ latestByEndpoint, recent }`

Keep these three exactly as they are. Add new procedures to the same `posMirror` block.

### 2.3 Existing UI

`client/src/components/PosMirrorPanel.tsx` is the interim panel. It renders three endpoint
cards, the manual pull/backfill controls, and a recent-runs table. Read it once for shape;
the 25d version preserves all its capabilities and adds drill-down.

`Home.tsx` already wires it as the "POS 미러" admin tab (line ~338, paired with
`<TabsContent forceMount value="posMirror">…</TabsContent>` at line ~383). You do **not**
need to touch Home.tsx — the re-export from §1.3 keeps it working.

### 2.4 Helpers

- `getDb()` from `server/db.ts` — returns Drizzle client or `null` if the DB is unavailable
  (always handle the null path; existing code does).
- `adminProcedure` from `server/_core/trpc.ts`.
- `withTransaction(fn)` from `server/db.ts` (use only when writing).
- `Streamdown` from `streamdown` for any markdown rendering.
- shadcn primitives at `@/components/ui/*`: `Card`, `Button`, `Badge`, `Select`, `Tabs`,
  `Table`, `Dialog`, `Input`, `Label`, `Skeleton`, `Tooltip`. Do **not** add new shadcn
  components via the CLI; everything you need is already present.
- `lucide-react` icons.
- Toast: `import { toast } from "sonner";`.
- TanStack Query lives under the trpc client (`trpc.useUtils()`, `useQuery`, `useMutation`).

### 2.5 Time / locale

NYC store. Always render timestamps in the user's local timezone via
`new Date(utc).toLocaleString()`. Do **not** introduce moment/dayjs/luxon. Keep the cents
→ dollars helper inline (`(cents / 100).toLocaleString("en-US", { style: "currency",
currency: "USD" })`) — there's no shared util for it yet, and that's fine.

---

## 3. Files to create

### 3.1 `server/posmirror/inspector.ts` (new)

Pure read-only helpers that aggregate the mirror tables for the dashboard. No side effects,
no LLM, no DB writes. Each function returns plain rows you can JSON-serialize over tRPC.

```ts
import { and, desc, eq, gte, lte, like, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  posOrders, posCustomers, posPayments, posProducts, posProductChanges,
  posSyncLog,
} from "../../drizzle/schema";

/** Per-table row counts for the overview header. Returns 0s when DB is null. */
export async function tableRowCounts(): Promise<{
  customers: number;
  orders: number;
  payments: number;
  products: number;
}> { /* count(*) per table, source='cleancloud' */ }

/** Last 200 orders, paginated by `afterId` (cursor). */
export async function listOrders(opts: {
  status?: string;
  search?: string;     // matches externalId or customerExternalId
  paid?: boolean;
  afterId?: number;    // cursor
  limit?: number;      // default 50, max 200
}): Promise<{ rows: PosOrderRow[]; nextCursor: number | null }> { ... }

/** Last 200 customers, by syncedAt desc. */
export async function listCustomers(opts: {
  search?: string;     // matches name (LIKE) or phoneE164
  afterId?: number;
  limit?: number;
}): Promise<{ rows: PosCustomerRow[]; nextCursor: number | null }> { ... }

/** Products, last 500 by syncedAt desc, optional category filter. */
export async function listProducts(opts: {
  category?: string;
  afterId?: number;
  limit?: number;
}): Promise<{ rows: PosProductRow[]; nextCursor: number | null }> { ... }

/** Recent price/catalog changes (last 60 days, default limit 100). */
export async function listProductChanges(limit?: number): Promise<PosProductChangeRow[]> { ... }

/** A single failed sync_log row + enough context to display "what tried, what failed". */
export async function getSyncLogDetail(id: number): Promise<PosSyncLogDetail | null> { ... }
```

Notes:

- All reads scoped `eq(source, "cleancloud")`.
- Cap every limit to 200 rows server-side. Reject larger inputs with a `TRPCError({ code: "BAD_REQUEST" })` from the procedure layer (not from inside the helper).
- For `listOrders` `search`, do a single `or(like(externalId, %q%), like(customerExternalId, %q%))`. Don't try to join `posCustomers` for name search — order volume is much higher and we already have a separate Customers tab.

### 3.2 `server/posmirror/inspector.test.ts` (new)

Hermetic tests with mocked DB. Cover:

1. `tableRowCounts` returns zeros when `getDb()` returns null.
2. `listOrders` applies all filters in `where()` (status + paid + search clause).
3. `listOrders` returns `nextCursor: null` when fewer than `limit` rows.
4. `listOrders` returns `nextCursor: rows[rows.length - 1].id` when at limit.
5. `listProductChanges` orders by `detectedAt desc`.
6. `getSyncLogDetail` returns null for missing id.
7. Limit clamp: passing `limit: 9999` to `listOrders` collapses to 200 (test the actual SQL via the `__exposeForTests` seam below).

Use the same DB-mock pattern as `server/integrations/cleancloud/pullJob.test.ts` — i.e.,
inject a fake `db` through a small `__exposeForTests` factory rather than mocking
`drizzle-orm` itself. If you need to read the SQL string, call `query.toSQL()` on the
Drizzle builder; that's what `pullJob.test.ts` does.

### 3.3 `server/routers.ts` — extend the `posMirror` sub-router

Add five procedures **inside the existing `posMirror: router({ … })` block**. Do not move
the existing three.

```ts
overview: adminProcedure.query(async () => {
  const [counts, syncStatus, recentChanges] = await Promise.all([
    tableRowCounts(),
    /* reuse the same shape as the existing syncStatus query */,
    listProductChanges(20),
  ]);
  return { counts, syncStatus, recentChanges };
}),

orders: adminProcedure
  .input(z.object({
    status: z.string().optional(),
    search: z.string().max(64).optional(),
    paid: z.boolean().optional(),
    afterId: z.number().int().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }))
  .query(({ input }) => listOrders(input)),

customers: adminProcedure
  .input(z.object({
    search: z.string().max(64).optional(),
    afterId: z.number().int().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }))
  .query(({ input }) => listCustomers(input)),

products: adminProcedure
  .input(z.object({
    category: z.string().max(64).optional(),
    afterId: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }))
  .query(({ input }) => listProducts(input)),

priceChanges: adminProcedure
  .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).default(() => ({ limit: 50 })))
  .query(({ input }) => listProductChanges(input.limit)),

syncLogDetail: adminProcedure
  .input(z.object({ id: z.number().int() }))
  .query(({ input }) => getSyncLogDetail(input.id)),
```

Add corresponding tests in `server/routers.posMirror.test.ts` (new) covering happy-path
admin call + `FORBIDDEN` for non-admin. Mirror the shape of the existing
`server/routers.briefing.test.ts` if it exists; otherwise mirror the auth-guard test in
`server/auth.logout.test.ts`.

### 3.4 `client/src/components/mirror/MirrorDashboard.tsx` (new)

Replaces the interim panel. Use a top-level `Tabs` with **five** tabs (in this order):

1. **Overview** (default) — three header KPI tiles (total orders / total customers / total products) + the existing endpoint freshness cards + recent-runs table + recent price changes feed (top 10).
2. **주문** — searchable, filterable table of `posOrders` with cursor pagination (`afterId`). Columns: external id (truncated mono), customer ext id, status badge, paid/express chips, total ($), placed at, pickup at, delivery at. Filter bar on top: status `Select`, search input (debounced 300ms), paid tri-state.
3. **고객** — table of `posCustomers`. Columns: name, phone (E.164), external id, last syncedAt. Search box (debounced 300ms) over name+phone.
4. **상품** — table of `posProducts` with category filter. Columns: name, category, price ($), last syncedAt.
5. **가격 변동** — feed view of `posProductChanges` (added / removed / price_changed). Render added=green, removed=rose, price_changed=amber, with old→new diff.

Each tab is a small subcomponent under `client/src/components/mirror/` (one file each):
`OverviewTab.tsx`, `OrdersTab.tsx`, `CustomersTab.tsx`, `ProductsTab.tsx`,
`PriceChangesTab.tsx`. Keep each tab file under 250 lines; extract row components if
needed.

The Overview tab also keeps the existing two action cards (manual pull, backfill) from the
interim panel. Copy those JSX blocks verbatim from `PosMirrorPanel.tsx`; do not refactor
their behavior.

The Overview tab's "recent-runs" row gets a new affordance: clicking a failed row opens a
shadcn `Dialog` showing `getSyncLogDetail` output (window, fetched/upserted/failed counts,
full error text, optional 200-char excerpt of `req.body`/response if present in error).
This is the `replay` story — read-only, no actual replay yet (intentional: we want a human
to look first).

### 3.5 `client/src/components/mirror/MirrorDashboard.test.tsx` (new)

Tests, following the pattern in `client/src/components/PosMirrorPanel.test.tsx`:

1. Renders all 5 tabs.
2. Overview tab calls `posMirror.overview` once on mount.
3. Orders tab issues a new query when the search box debounces (use `vi.useFakeTimers()` + `userEvent.type`).
4. Failed sync_log row opens a dialog with the error text.
5. Clicking "백필 시작" still fires `posMirror.runBackfill` (regression test for the migrated controls).

Mock the trpc client surface the same way `PosMirrorPanel.test.tsx` does. Do **not** spin
up a real router.

### 3.6 `client/src/components/mirror/__exports.ts` (optional)

Bare re-export barrel for the five tab components, only if it makes the tests cleaner.
Skip if not needed.

---

## 4. Files to NOT touch

- `server/integrations/cleancloud/*` — Phase 25a code; freeze.
- `server/briefing/*` — Phase 25b code; freeze.
- `server/ownerAssistant/*` and `client/src/pages/OwnerChat.tsx` — Phase 25c; freeze.
- `drizzle/schema.ts` — no schema additions for 25d. If you "need" one, you're over-scoping.
- `server/_core/index.ts` — no new mounts; the dashboard reuses existing tRPC.
- Heartbeat cron CLI — the existing `dropshop-cleancloud-daily-pull` and
  `dropshop-daily-briefing` jobs are correct as-is.

---

## 5. Tests + acceptance criteria

Run, in order:

```bash
pnpm exec tsc --noEmit
pnpm vitest run
```

Both must succeed. Aim for **at least 12 new test cases** total across §3.2 / §3.3 / §3.5.
The full suite must still be at least 503 passing | 9 skipped before your work + the new
cases on top, with **zero** regressions. If any pre-existing test fails, that's a signal
to revert your last edit, not to "fix" the unrelated test.

Manual UX acceptance (operator-perspective; describe each in the PR body — you don't need
to record video):

- Open `/` while signed in as admin → click "POS 미러" → tabs appear.
- Overview: numbers reflect the live mirror; recent-runs table shows last ≥ 5 entries.
- Orders: typing a customer external id filters within ~300ms; clicking a row does **not**
  navigate (no per-order detail page in 25d; that's 25e).
- Customers: phone search returns matches; pagination cursor works (next page button).
- Products: category dropdown lists distinct categories alphabetically.
- Price changes: a row labeled `price_changed` shows `$X.XX → $Y.YY`.
- Failed sync_log row: clicking opens a dialog with full error text.

Performance budget: every `posMirror.*` query must complete in < 800ms p50 against a
populated mirror (12 months backfilled). If a query is slow, add the appropriate index
in a follow-up PR — do **not** add indexes in this PR (would change the schema).

---

## 6. Conventions reminder

- Korean copy for user-visible UI strings ("주문", "고객", etc.). English for log output,
  test descriptions, and code comments.
- Always destructure `data, isLoading, error` from `useQuery`; render an explicit empty
  state and an error state for every panel.
- Use `useState(() => initialValue)` lazy init for any object/array passed as a query
  input to avoid the infinite-fetch loop documented in `README.md` "Common Pitfalls".
- Cents → dollars at the render boundary, never store dollars.
- shadcn `Table`: keep `<TableHeader>` sticky if there's vertical scroll, otherwise leave
  default.
- Optimistic updates: NOT needed for 25d (every operation is a read). Use plain
  `useQuery` everywhere except the manual pull / backfill mutations.

---

## 7. Definition of done

- [ ] Branch `feat/25d-admin-mirror-dashboard` pushed to `user_github`.
- [ ] PR open against `main` with the title above and a body describing the manual UX
      acceptance results (§5).
- [ ] `pnpm exec tsc --noEmit` clean.
- [ ] `pnpm vitest run` clean; ≥ 12 new test cases added; zero regressions.
- [ ] `client/src/components/PosMirrorPanel.tsx` is now a one-line re-export shim.
- [ ] All five new procedures in `posMirror` are admin-gated and input-validated.
- [ ] `posMirror.overview` returns rows for all four tables when the mirror has data.
- [ ] No new Heartbeat crons, no new schema, no new env vars.
- [ ] PR body lists every new file, every test added, and a 1-line "what didn't fit"
      callout if any §5 item slipped.

When in doubt: smaller change > clever change. Ship.
