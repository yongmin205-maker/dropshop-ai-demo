/**
 * PosMirrorPanel — minimal admin UI for the vendor-neutral POS mirror
 * (Phase 25a). This is a deliberately small interim panel that exposes
 * the three tRPC procedures already shipped in `posMirror`:
 *
 *   - `runDailyPullNow`  – manual incremental pull (matches the 03:00 ET cron)
 *   - `runBackfill`      – one-time historical backfill (default 12 months)
 *   - `syncStatus`       – latest run per endpoint + recent history
 *
 * A richer drill-down dashboard (per-endpoint row counts, error log,
 * data table previews) is scoped to Phase 25d and will be built by
 * Claude Code from the self-contained prompt in
 * `docs/mainstreet-ai/claude_code_prompts/phase25d_admin_mirror_dashboard.md`.
 *
 * Until 25d lands, this panel exists so the operator can trigger the
 * 12-month backfill from the browser without us having to expose the
 * `/api/scheduled/*` callback to ad-hoc curl (which is gated by the
 * Manus platform anyway).
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, RefreshCw, Database, History } from "lucide-react";
import { toast } from "sonner";

function formatTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatDuration(start: Date | string | null, end: Date | string | null): string {
  if (!start || !end) return "—";
  const s = typeof start === "string" ? new Date(start) : start;
  const e = typeof end === "string" ? new Date(end) : end;
  const ms = e.getTime() - s.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} m`;
}

export function PosMirrorPanel() {
  const utils = trpc.useUtils();
  const status = trpc.posMirror.syncStatus.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const [monthsBack, setMonthsBack] = useState<number>(12);

  const runNow = trpc.posMirror.runDailyPullNow.useMutation({
    onSuccess: (summary) => {
      const okAll =
        summary.customers.error === null &&
        summary.orders.error === null &&
        summary.products.error === null;
      toast[okAll ? "success" : "error"](
        okAll ? "수동 풀 완료" : "수동 풀 일부 실패 — 로그 확인",
      );
      utils.posMirror.syncStatus.invalidate();
    },
    onError: (err) => toast.error(`수동 풀 실패: ${err.message}`),
  });

  const runBack = trpc.posMirror.runBackfill.useMutation({
    onSuccess: () => {
      toast.success(`${monthsBack}개월 백필 완료`);
      utils.posMirror.syncStatus.invalidate();
    },
    onError: (err) => toast.error(`백필 실패: ${err.message}`),
  });

  const triggerBackfill = () => {
    if (
      !window.confirm(
        `${monthsBack}개월 분량의 CleanCloud 주문 / 결제 / 고객 데이터를 한 번에 가져옵니다.\n` +
          "처음 한 번만 누르면 됩니다. CleanCloud 측 rate-limit (3 req/sec) 때문에 길면 5–10분 걸릴 수 있어요.\n\n계속하시겠어요?",
      )
    ) {
      return;
    }
    runBack.mutate({ monthsBack });
  };

  const latestByEndpoint = status.data?.latestByEndpoint;
  const recent = status.data?.recent ?? [];

  return (
    <div className="space-y-4">
      <Card className="panel">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="size-4" />
              POS 미러 상태
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              CleanCloud → vendor-neutral 미러. 매일 03:00 ET 자동 풀 + 수동 트리거 가능.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => status.refetch()}
            disabled={status.isFetching}
          >
            {status.isFetching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            <span className="ml-1.5">새로고침</span>
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(
              [
                ["customers", "고객", latestByEndpoint?.customers],
                ["orders", "주문", latestByEndpoint?.orders],
                ["products", "상품", latestByEndpoint?.products],
              ] as const
            ).map(([key, label, row]) => (
              <div
                key={key}
                className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{label}</span>
                  {row ? (
                    <Badge
                      variant={row.error ? "destructive" : "secondary"}
                      className="text-[10px]"
                    >
                      {row.error ? "error" : "ok"}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      no run
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  마지막: {formatTime(row?.finishedAt ?? null)}
                </div>
                {row?.rowsUpserted != null && (
                  <div className="text-xs">
                    upserts: <span className="font-mono">{row.rowsUpserted}</span>
                  </div>
                )}
                {row?.error && (
                  <div className="text-xs text-destructive break-all line-clamp-2">
                    {row.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle className="text-base">수동 트리거</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => runNow.mutate()}
              disabled={runNow.isPending}
              variant="outline"
            >
              {runNow.isPending && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
              수동 풀 (오늘분만)
            </Button>
            <span className="text-xs text-muted-foreground">
              매일 03:00 ET 자동 실행과 동일. 어제 cron이 실패했을 때만 누르세요.
            </span>
          </div>

          <div className="border-t border-border pt-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">백필 기간</label>
                <Select
                  value={String(monthsBack)}
                  onValueChange={(v) => setMonthsBack(Number(v))}
                  disabled={runBack.isPending}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">3개월</SelectItem>
                    <SelectItem value="6">6개월</SelectItem>
                    <SelectItem value="12">12개월 (권장)</SelectItem>
                    <SelectItem value="24">24개월</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={triggerBackfill}
                disabled={runBack.isPending}
              >
                {runBack.isPending && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                백필 시작
              </Button>
              <p className="text-xs text-muted-foreground max-w-md">
                최초 1회만 실행. 멱등(같은 (source, externalId) 행 → 업데이트)이라 중복 실행해도 안전하지만 불필요.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <History className="size-4" />
            최근 실행 로그 ({recent.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              아직 실행 기록이 없습니다.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground border-b border-border">
                  <tr>
                    <th className="py-2 pr-3">시작</th>
                    <th className="py-2 pr-3">엔드포인트</th>
                    <th className="py-2 pr-3">트리거</th>
                    <th className="py-2 pr-3">상태</th>
                    <th className="py-2 pr-3 text-right">upserts</th>
                    <th className="py-2 pr-3">소요</th>
                    <th className="py-2 pr-3">에러</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id} className="border-b border-border/40">
                      <td className="py-1.5 pr-3 font-mono">
                        {formatTime(r.startedAt)}
                      </td>
                      <td className="py-1.5 pr-3">{r.endpoint}</td>
                      <td className="py-1.5 pr-3">{r.trigger}</td>
                      <td className="py-1.5 pr-3">
                        <Badge
                          variant={r.error ? "destructive" : "secondary"}
                          className="text-[10px]"
                        >
                          {r.error ? "error" : "ok"}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono">
                        {r.rowsUpserted ?? "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        {formatDuration(r.startedAt, r.finishedAt)}
                      </td>
                      <td className="py-1.5 pr-3 text-destructive max-w-[260px] truncate">
                        {r.error ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default PosMirrorPanel;
