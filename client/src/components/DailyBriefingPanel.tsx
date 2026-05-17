/**
 * DailyBriefingPanel — admin-only daily LLM briefing card.
 * Shows yesterday's briefing in a hero card (markdown summary + metric chips)
 * + 30-day history list with click-to-view drilldown.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import { Loader2, RefreshCw, Calendar } from "lucide-react";

const KOREAN_WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function formatKoreanDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = KOREAN_WEEKDAY[dt.getUTCDay()];
  return `${y}년 ${m}월 ${d}일 (${weekday})`;
}

function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

type MetricsShape = {
  revenueCents?: number | null;
  orderCount?: number | null;
  newCustomers?: number | null;
  returningCustomers?: number | null;
  avgOrderCents?: number | null;
  pickupsToday?: number | null;
};

export function DailyBriefingPanel() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const latest = trpc.briefing.latest.useQuery();
  const history = trpc.briefing.list.useQuery({ limit: 30 });
  const selected = trpc.briefing.byDate.useQuery(
    { briefingDate: selectedDate ?? "" },
    { enabled: !!selectedDate },
  );

  const generate = trpc.briefing.generateNow.useMutation({
    onSuccess: () => {
      toast.success("브리핑 새로 생성됨");
      utils.briefing.latest.invalidate();
      utils.briefing.list.invalidate();
      if (selectedDate) {
        utils.briefing.byDate.invalidate({ briefingDate: selectedDate });
      }
    },
    onError: (err) => toast.error(`브리핑 생성 실패: ${err.message}`),
  });

  const briefing = selectedDate ? selected.data : latest.data;
  const isLoading = selectedDate ? selected.isLoading : latest.isLoading;

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              매장 데일리 브리핑
            </div>
            <div className="text-xl font-semibold">
              {briefing
                ? formatKoreanDate(briefing.briefingDate)
                : "어제 브리핑"}
            </div>
            {briefing && (
              <div className="text-xs text-muted-foreground mt-1">
                {new Date(briefing.generatedAt).toLocaleString("ko-KR", {
                  timeZone: "America/New_York",
                })}{" "}
                NYC 생성
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              generate.mutate(
                briefing ? { briefingDate: briefing.briefingDate } : undefined,
              )
            }
            disabled={generate.isPending}
          >
            {generate.isPending ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="size-4 mr-2" />
            )}
            지금 다시 생성
          </Button>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">브리핑 불러오는 중…</div>
        ) : !briefing ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            아직 브리핑이 없습니다. 오른쪽 위 버튼을 눌러 어제 데이터로 생성하거나,
            매일 07:00 ET 자동 생성을 기다려주세요.
          </div>
        ) : briefing.errorMessage ? (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded p-3">
            <div className="font-medium mb-1">브리핑 생성 중 오류</div>
            <div className="text-xs font-mono">{briefing.errorMessage}</div>
          </div>
        ) : (
          <>
            <div className="prose prose-sm max-w-none mb-4">
              <Streamdown>{briefing.summaryMarkdown ?? ""}</Streamdown>
            </div>
            {briefing.metrics ? (
              <div className="flex flex-wrap gap-2 pt-3 border-t">
                <MetricChip
                  label="매출"
                  value={formatCurrency(
                    (briefing.metrics as MetricsShape).revenueCents,
                  )}
                />
                <MetricChip
                  label="주문"
                  value={`${(briefing.metrics as MetricsShape).orderCount ?? 0}건`}
                />
                <MetricChip
                  label="신규 손님"
                  value={`${(briefing.metrics as MetricsShape).newCustomers ?? 0}명`}
                />
                <MetricChip
                  label="재방문"
                  value={`${(briefing.metrics as MetricsShape).returningCustomers ?? 0}명`}
                />
                <MetricChip
                  label="평균 주문"
                  value={formatCurrency(
                    (briefing.metrics as MetricsShape).avgOrderCents,
                  )}
                />
                <MetricChip
                  label="픽업 예정"
                  value={`${(briefing.metrics as MetricsShape).pickupsToday ?? 0}건`}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="size-4 text-muted-foreground" />
          <div className="text-sm font-medium">지난 30일 브리핑</div>
          {history.data && (
            <Badge variant="secondary" className="ml-auto">
              {history.data.length}개
            </Badge>
          )}
        </div>
        {history.isLoading ? (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        ) : !history.data || history.data.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            아직 히스토리가 없습니다.
          </div>
        ) : (
          <div className="space-y-1">
            {history.data.map((row) => {
              const isActive =
                selectedDate === row.briefingDate ||
                (!selectedDate &&
                  row.briefingDate === latest.data?.briefingDate);
              return (
                <button
                  key={row.id}
                  onClick={() => setSelectedDate(row.briefingDate)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-secondary"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span>{formatKoreanDate(row.briefingDate)}</span>
                    {row.errorMessage ? (
                      <Badge
                        variant="outline"
                        className="text-xs text-rose-600 border-rose-200"
                      >
                        오류
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {formatCurrency(
                          (row.metrics as MetricsShape | null)?.revenueCents,
                        )}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
