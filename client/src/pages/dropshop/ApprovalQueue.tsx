/**
 * DropShop — Approval Queue card.
 *
 * Extracted from Home.tsx (CODE_AUDIT P1) so the Approve / Reject UI lives
 * in its own file. Two reasons:
 *   1. The "Approve failed · Unable to transform response from server" bug
 *      that hit the live deploy was a nested-anchor render issue inside this
 *      component. While the file was buried in a 1.7k-LOC Home.tsx it never
 *      got isolated tests; a dedicated file lets vitest target it directly.
 *   2. The card owns its own optimistic-update lifecycle (approve / reject
 *      cache patches), which is the most state-heavy chunk of the dashboard.
 *      Pulling it out makes Home.tsx easier to scan.
 *
 * Keeps its own copies of the small `CustomerProfileBadge` + `SmsLengthHint`
 * helpers it composes — they were defined right next to ApprovalQueue and
 * have no other consumers, so co-locating them here keeps the surface tight.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  REJECT_CATEGORIES,
  REJECT_CATEGORY_LABELS,
  type RejectCategory,
} from "@shared/scenarios";
import { format } from "date-fns";
import { Check, Loader2, ThumbsDown, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useVisiblePollInterval } from "@/hooks/useVisiblePollInterval";
import { toast } from "sonner";
import { intentTone } from "./intentTone";

export type CustomerProfileData = {
  customerName: string | null;
  phone: string;
  totalMessages: number;
  totalDrafts: number;
  approvedCount: number;
  rejectedCount: number;
  approvalRate: number;
  avgReplyChars: number;
  topIntents: Array<{ intent: string; count: number }>;
  topRejectCategories: Array<{ category: string; count: number }>;
  lastSeen: Date | null;
};

function CustomerProfileBadge({ profile }: { profile: CustomerProfileData }) {
  const decided = profile.approvedCount + profile.rejectedCount;
  const approvalPct = decided === 0 ? null : Math.round(profile.approvalRate * 100);
  const top = profile.topIntents[0];
  return (
    <div className="mt-2 rounded-md border border-[var(--iris)]/15 bg-[var(--iris-soft)]/60 px-2.5 py-2">
      <div className="flex items-center gap-2 flex-wrap text-[11px] leading-tight">
        <span className="text-foreground/90">
          <span className="text-muted-foreground">Pattern ·</span>{" "}
          {profile.totalMessages} msg{profile.totalMessages === 1 ? "" : "s"}
        </span>
        {top ? (
          <span className="text-foreground/90">
            <span className="text-muted-foreground">· usually</span>{" "}
            <span className={`px-1.5 py-0.5 rounded border ${intentTone(top.intent)} text-[10px]`}>
              {top.intent}
            </span>
          </span>
        ) : null}
        {approvalPct !== null ? (
          <span className="text-foreground/90">
            <span className="text-muted-foreground">· approve</span>{" "}
            <span className="text-emerald-700 tabular-nums font-medium">{approvalPct}%</span>
            <span className="text-muted-foreground"> ({decided})</span>
          </span>
        ) : null}
        {profile.avgReplyChars > 0 ? (
          <span className="text-foreground/90">
            <span className="text-muted-foreground">· avg reply</span>{" "}
            <span className="tabular-nums">{profile.avgReplyChars}c</span>
          </span>
        ) : null}
        {profile.topRejectCategories[0] ? (
          <span className="text-foreground/90">
            <span className="text-muted-foreground">· reject</span>{" "}
            <span className="text-rose-600">
              {(REJECT_CATEGORY_LABELS as Record<string, string>)[
                profile.topRejectCategories[0].category
              ] ?? profile.topRejectCategories[0].category}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

// §5.2 carryover: graduated guardrail next to the hard 4-segment cap. Mirrors
// the server-side `countSmsSegments` (GSM-7: 160 single / 153 multi). Shows a
// per-segment cost-style hint and goes amber at >320 chars / orange at >480.
function SmsLengthHint({ body }: { body: string }) {
  const len = body.length;
  // Conservative client-side approximation. Server is authoritative.
  const segments = len === 0 ? 0 : len <= 160 ? 1 : Math.ceil(len / 153);
  const tone =
    segments >= 4
      ? "text-rose-700 bg-rose-50 border-rose-200"
      : segments === 3
      ? "text-orange-700 bg-orange-50 border-orange-200"
      : segments === 2
      ? "text-amber-700 bg-amber-50 border-amber-200"
      : "text-muted-foreground bg-secondary border-border";
  return (
    <div className="mt-1.5 flex items-center justify-between text-[10px]">
      <span className={`px-1.5 py-0.5 rounded border tabular-nums ${tone}`}>
        {len} chars · {segments} SMS segment{segments === 1 ? "" : "s"}
      </span>
      {segments >= 4 ? (
        <span className="text-rose-700 font-medium">
          Will be blocked by hard cap (4 segments)
        </span>
      ) : segments >= 3 ? (
        <span className="text-orange-700">
          Long reply — bills as {segments}× SMS
        </span>
      ) : null}
    </div>
  );
}

export function ApprovalQueue({
  activeConversationId,
  customerName,
}: {
  activeConversationId?: number | null;
  customerName?: string | null;
} = {}) {
  const utils = trpc.useUtils();
  const [filterToActive, setFilterToActive] = useState(true);
  const filterConvId =
    filterToActive && activeConversationId && activeConversationId > 0
      ? activeConversationId
      : undefined;
  const pending = trpc.drafts.listPending.useQuery(
    filterConvId ? { conversationId: filterConvId } : undefined,
    { refetchInterval: useVisiblePollInterval(2500) },
  );
  const profile = trpc.customers.profile.useQuery(
    { conversationId: filterConvId ?? 0 },
    { enabled: !!filterConvId, staleTime: 10_000 },
  );
  const conversations = trpc.conversations.list.useQuery();

  const [rejectDraftId, setRejectDraftId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectCategory, setRejectCategory] = useState<RejectCategory>("tone_too_formal");

  // §4.2 Optimistic updates: Approve/Reject feel instantaneous because we
  // remove the affected draft from the cached `listPending` array immediately
  // (the canonical "approve disappears from queue right now") and roll back
  // only on error. Critical fields (the actual outbound message + AI log)
  // still surface via invalidation in `onSettled`, since those are sources of
  // truth that the optimistic stub doesn't try to predict.
  type PendingDraft = NonNullable<typeof pending.data>[number];

  const approve = trpc.drafts.approve.useMutation({
    onMutate: async (vars) => {
      await utils.drafts.listPending.cancel();
      const previous = utils.drafts.listPending.getData();
      utils.drafts.listPending.setData(undefined, (old) =>
        (old ?? []).filter((d: PendingDraft) => d.id !== vars.draftId),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) utils.drafts.listPending.setData(undefined, ctx.previous);
      toast.error("Approve failed", { description: err.message });
    },
    onSuccess: () => {
      toast.success("Reply approved & sent");
    },
    onSettled: () => {
      utils.drafts.listPending.invalidate();
      utils.conversations.list.invalidate();
      utils.conversations.messages.invalidate();
      utils.conversations.logs.invalidate();
      utils.rag.styleExamples.invalidate();
    },
  });

  const reject = trpc.drafts.reject.useMutation({
    onMutate: async (vars) => {
      await utils.drafts.listPending.cancel();
      const previous = utils.drafts.listPending.getData();
      utils.drafts.listPending.setData(undefined, (old) =>
        (old ?? []).filter((d: PendingDraft) => d.id !== vars.draftId),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) utils.drafts.listPending.setData(undefined, ctx.previous);
      toast.error("Reject failed", { description: err.message });
    },
    onSuccess: () => {
      toast.success("Draft rejected — regenerating with feedback");
      setRejectDraftId(null);
      setRejectReason("");
      setRejectCategory("tone_too_formal");
    },
    onSettled: () => {
      utils.drafts.listPending.invalidate();
      utils.conversations.logs.invalidate();
      utils.rag.rejections.invalidate();
    },
  });

  const drafts = pending.data ?? [];
  const convById = useMemo(() => {
    const map = new Map<number, { customerName: string | null; phone: string }>();
    for (const c of conversations.data ?? []) {
      map.set(c.id, { customerName: c.customerName, phone: c.phone });
    }
    return map;
  }, [conversations.data]);

  return (
    <Card className="panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 font-display text-lg">
          <span className="flex items-center gap-2">
            <ThumbsDown className="size-4 text-[var(--iris)] rotate-180" />
            Approval Queue
          </span>
          {activeConversationId && activeConversationId > 0 ? (
            <button
              type="button"
              onClick={() => setFilterToActive((v) => !v)}
              className={`text-[10px] uppercase tracking-widest px-2 py-1 rounded-md border transition-colors ${
                filterToActive
                  ? "bg-[var(--iris-soft)] text-[var(--iris)] border-[var(--iris)]/25"
                  : "bg-secondary text-muted-foreground border-border hover:bg-[var(--iris-soft)]/50"
              }`}
            >
              {filterToActive
                ? `Showing ${customerName ?? "selected"} · click for All`
                : "Showing All  ·  click to filter"}
            </button>
          ) : null}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          AI drafts await your <span className="text-emerald-700 font-medium">Approve</span> or{" "}
          <span className="text-rose-600 font-medium">Reject</span>. Rejections teach the model.
        </p>
        {filterConvId && profile.data ? <CustomerProfileBadge profile={profile.data} /> : null}
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[560px] pr-2">
          {drafts.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-12">
              No drafts pending. Send a message in the simulator to generate one.
            </div>
          ) : (
            <div className="space-y-3">
              {drafts.map((d) => {
                const conv = convById.get(d.conversationId);
                const isRejecting = rejectDraftId === d.id;
                return (
                  <div
                    key={d.id}
                    className="rounded-lg border border-[var(--iris)]/20 bg-[var(--iris-soft)]/40 p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] ${intentTone(d.intent)}`}>
                          {d.intent}
                        </Badge>
                        {d.revision && d.revision > 1 && (
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-secondary border-border text-muted-foreground"
                          >
                            rev {d.revision}
                          </Badge>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {format(new Date(d.createdAt), "HH:mm:ss")}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mb-1">
                      To:{" "}
                      <span className="text-foreground/80">{conv?.customerName ?? "Unknown"}</span>
                      <span className="ml-2 tabular-nums">{conv?.phone}</span>
                    </div>
                    <div className="rounded-md bg-background border border-border p-2.5 text-sm text-foreground whitespace-pre-wrap">
                      {d.body}
                    </div>
                    <SmsLengthHint body={d.body} />

                    {isRejecting ? (
                      <div className="mt-2 space-y-2">
                        <div>
                          <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                            Reason category
                          </label>
                          <Select
                            value={rejectCategory}
                            onValueChange={(v) => setRejectCategory(v as RejectCategory)}
                          >
                            <SelectTrigger className="mt-1 bg-background border-border text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {REJECT_CATEGORIES.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {REJECT_CATEGORY_LABELS[c]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Textarea
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder={
                            rejectCategory === "other"
                              ? "Tell the AI exactly what's wrong (required)…"
                              : "Optional: add specifics (e.g., 'price should be $35, not $40')"
                          }
                          className="bg-background border-border text-sm min-h-[72px]"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            className="bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 border"
                            disabled={
                              reject.isPending ||
                              (rejectCategory === "other" && !rejectReason.trim())
                            }
                            onClick={() =>
                              reject.mutate({
                                draftId: d.id,
                                category: rejectCategory,
                                reason:
                                  rejectReason.trim() || REJECT_CATEGORY_LABELS[rejectCategory],
                              })
                            }
                          >
                            {reject.isPending ? (
                              <Loader2 className="size-3.5 mr-1 animate-spin" />
                            ) : (
                              <ThumbsDown className="size-3.5 mr-1" />
                            )}
                            Reject & teach
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="bg-background border-border text-foreground"
                            onClick={() => {
                              setRejectDraftId(null);
                              setRejectReason("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          size="sm"
                          className="bg-[var(--iris)] text-white hover:bg-[#5a52f0] border-0 shadow-sm shadow-[#635BFF]/30"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate({ draftId: d.id })}
                        >
                          {approve.isPending ? (
                            <Loader2 className="size-3.5 mr-1 animate-spin" />
                          ) : (
                            <Check className="size-3.5 mr-1" />
                          )}
                          Approve & send
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="bg-background border-border text-foreground hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                          onClick={() => {
                            setRejectDraftId(d.id);
                            setRejectReason("");
                          }}
                        >
                          <X className="size-3.5 mr-1" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
