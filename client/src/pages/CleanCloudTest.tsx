/**
 * /cleancloud-test — admin-only diagnostic page that calls the friend's
 * real CleanCloud account and renders a small sample of customers, orders,
 * products, and price lists. Used to visually confirm that:
 *
 *   (a) the CLEANCLOUD_API_TOKEN secret is set and working,
 *   (b) the friend's plan returns the expected data shapes,
 *   (c) field mapping looks reasonable BEFORE we flip
 *       DROPSHOP_USE_REAL_POS=1 in production.
 *
 * The underlying tRPC procedure is `cleancloud.diagnostic`, which is locked
 * to `adminProcedure`. A non-admin hitting this page will see the tRPC error
 * surfaced via the error block below; we don't render any sample data
 * client-side without a successful query result.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge
      variant="outline"
      className={
        ok
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-rose-300 bg-rose-50 text-rose-700"
      }
    >
      {ok ? "✓" : "✗"} {label}
    </Badge>
  );
}

function SectionCard({
  title,
  count,
  ok,
  error,
  sample,
}: {
  title: string;
  count: number;
  ok: boolean;
  error?: string;
  sample: unknown[];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2">
          <StatusPill ok={ok} label={ok ? `${count} returned` : "failed"} />
        </div>
      </CardHeader>
      <CardContent>
        {!ok && error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </div>
        ) : sample.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No rows in the last 30 days. (This is normal for an inactive
            account; the request itself succeeded.)
          </div>
        ) : (
          <pre className="max-h-[420px] overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-5">
            {JSON.stringify(sample, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

export default function CleanCloudTest() {
  const me = trpc.auth.me.useQuery();
  const diag = trpc.cleancloud.diagnostic.useQuery(undefined, {
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container flex items-center justify-between py-4">
          <div>
            <Link href="/">
              <a className="text-sm text-muted-foreground hover:underline">← Back to DropShop</a>
            </Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              CleanCloud diagnostic
            </h1>
            <p className="text-sm text-muted-foreground">
              Read-only check of the connected CleanCloud account. Admin-only.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => diag.refetch()}
            disabled={diag.isFetching}
          >
            {diag.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        {!me.data ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              You must be signed in as an admin to view this page.
            </CardContent>
          </Card>
        ) : diag.isLoading ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              Calling CleanCloud…
            </CardContent>
          </Card>
        ) : diag.error ? (
          <Card>
            <CardContent className="space-y-2 py-6 text-sm">
              <div className="font-medium text-rose-700">
                Diagnostic call failed
              </div>
              <pre className="rounded-md bg-muted/40 p-3 text-xs">
                {diag.error.message}
              </pre>
              <p className="text-muted-foreground">
                Most likely cause: you're not signed in as the project owner
                (admin role). Sign in from the home page and try again.
              </p>
            </CardContent>
          </Card>
        ) : !diag.data ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              No diagnostic data returned.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Connection status</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <StatusPill ok={diag.data.tokenSet} label="API token set" />
                <StatusPill
                  ok={diag.data.useRealPos}
                  label={
                    diag.data.useRealPos
                      ? "DROPSHOP_USE_REAL_POS=1 (real POS)"
                      : "Mock POS mode (flag off)"
                  }
                />
                <StatusPill
                  ok={diag.data.priceLists.ok}
                  label="getPriceLists"
                />
                <StatusPill ok={diag.data.products.ok} label="getProducts" />
                <StatusPill ok={diag.data.orders.ok} label="getOrders" />
                <StatusPill ok={diag.data.customers.ok} label="getCustomer" />
              </CardContent>
            </Card>

            <SectionCard
              title="Price lists"
              count={diag.data.priceLists.count}
              ok={diag.data.priceLists.ok}
              error={diag.data.priceLists.error}
              sample={diag.data.priceLists.sample}
            />
            <SectionCard
              title="Products (first 5)"
              count={diag.data.products.count}
              ok={diag.data.products.ok}
              error={diag.data.products.error}
              sample={diag.data.products.sample}
            />
            <SectionCard
              title="Orders — last 30 days (first 5)"
              count={diag.data.orders.count}
              ok={diag.data.orders.ok}
              error={diag.data.orders.error}
              sample={diag.data.orders.sample}
            />
            <SectionCard
              title="Customers — added in last 30 days (first 5, phone last-4 masked)"
              count={diag.data.customers.count}
              ok={diag.data.customers.ok}
              error={diag.data.customers.error}
              sample={diag.data.customers.sample}
            />
          </>
        )}
      </main>
    </div>
  );
}
