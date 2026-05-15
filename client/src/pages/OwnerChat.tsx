/**
 * OwnerChat — Phase 25c "Owner Assistant" chat page (/owner-chat).
 *
 * The owner asks plain-Korean questions about their store ("지난 주 매출",
 * "60일 이상 안 온 손님") and the backend agent (router → planner → executor
 * → synthesizer) returns a markdown answer plus an `AgentTrace`. The trace
 * is collapsed under each assistant bubble — the operator can pop it open
 * when they want to verify which tools actually ran (trust + debugability).
 *
 * Surface:
 *   - Header: title + freshness chip (derived from the last assistant trace).
 *   - Empty state: 5 suggested-prompt chips (server-provided seed list).
 *   - Bubbles: user right, assistant left (Streamdown markdown). Each
 *     assistant message gets an `<OwnerAssistantTrace />` expander below it.
 *   - Composer: Textarea + Send. Enter sends; Shift+Enter inserts newline.
 *     While `ask.isPending`, the Send button is disabled and a 3-dot
 *     typing-indicator bubble shows in the assistant column.
 *   - Conversation switcher: <Select> of recent conversations + a
 *     "New conversation" button that resets state to `conversationId=null`.
 *
 * §7.3 test fixtures (suggested prompts visible, send wires the mutation,
 * trace expander reveals the tool list, freshness footer renders) are
 * covered by `OwnerChat.test.tsx` — the trpc module is mocked there.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
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
import { toast } from "sonner";
import { Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
import { OwnerAssistantTrace } from "@/components/OwnerAssistantTrace";
import type { AgentTrace } from "../../../server/ownerAssistant/types";

/** Best-effort freshness derivation from the most recent assistant trace.
 *  Live tools ("fetchLiveOrder", "countActiveGarments", "aggregateRevenueLive")
 *  imply "방금 확인한 실시간 데이터"; everything else falls back to the
 *  daily-mirror line. Pure function so it's trivial to unit test. */
const LIVE_TOOL_NAMES = new Set([
  "fetchLiveOrder",
  "countActiveGarments",
  "aggregateRevenueLive",
]);

function freshnessLabel(trace: AgentTrace | null | undefined): string {
  if (!trace) return "데이터: 오늘 03:00 ET 기준";
  const usedLive = trace.toolCalls.some((c) => LIVE_TOOL_NAMES.has(c.toolName));
  if (usedLive) return "방금 확인한 실시간 데이터";
  return "데이터: 오늘 03:00 ET 기준";
}

type AssistantMessage = {
  id: number | string;
  role: "user" | "assistant";
  contentMarkdown: string;
  trace: AgentTrace | null;
  createdAt: Date;
};

export default function OwnerChat() {
  const utils = trpc.useUtils();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [question, setQuestion] = useState("");

  // Suggested prompts — server returns a fixed list of 5 strings.
  const suggested = trpc.ownerAssistant.suggestedPrompts.useQuery();
  const conversations = trpc.ownerAssistant.listConversations.useQuery({ limit: 20 });
  const conversation = trpc.ownerAssistant.getConversation.useQuery(
    { id: conversationId ?? 0 },
    { enabled: conversationId !== null && conversationId > 0 },
  );

  const ask = trpc.ownerAssistant.ask.useMutation({
    onSuccess: (result) => {
      setConversationId(result.conversationId);
      setQuestion("");
      utils.ownerAssistant.listConversations.invalidate();
      // `result.conversationId` is the freshly-persisted row's id — it's
      // always a real number from the server but TS narrows through the
      // mutation input type. Guard with a `> 0` check + cast so the
      // invalidate input type accepts it cleanly.
      if (typeof result.conversationId === "number" && result.conversationId > 0) {
        utils.ownerAssistant.getConversation.invalidate({ id: result.conversationId });
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  /** Messages flow:
   *   - If we have a loaded conversation, render its persisted messages.
   *   - We also append an "optimistic" user bubble while the mutation is in
   *     flight so the operator sees their question echo immediately rather
   *     than waiting for the round-trip + cache invalidation.
   */
  const persistedMessages: AssistantMessage[] = useMemo(() => {
    if (!conversation.data?.messages) return [];
    return conversation.data.messages.map((m) => ({
      id: m.id,
      role: m.role,
      contentMarkdown: m.contentMarkdown,
      trace: (m.trace as AgentTrace | null) ?? null,
      createdAt: new Date(m.createdAt),
    }));
  }, [conversation.data]);

  // Optimistic user bubble while the request is in flight. Cleared on success
  // (the persisted version supersedes it via invalidation) and on error.
  const pendingUserQuestion = ask.isPending ? ask.variables?.question ?? null : null;

  const displayMessages: AssistantMessage[] = useMemo(() => {
    if (!pendingUserQuestion) return persistedMessages;
    return [
      ...persistedMessages,
      {
        id: "pending-user",
        role: "user" as const,
        contentMarkdown: pendingUserQuestion,
        trace: null,
        createdAt: new Date(),
      },
    ];
  }, [persistedMessages, pendingUserQuestion]);

  // Auto-scroll the message list to the bottom on new messages / typing.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [displayMessages.length, ask.isPending]);

  const lastAssistantTrace = useMemo<AgentTrace | null>(() => {
    for (let i = persistedMessages.length - 1; i >= 0; i--) {
      const m = persistedMessages[i];
      if (m.role === "assistant" && m.trace) return m.trace;
    }
    return null;
  }, [persistedMessages]);

  function submitQuestion(body: string) {
    const trimmed = body.trim();
    if (!trimmed || ask.isPending) return;
    ask.mutate({ conversationId, question: trimmed });
  }

  function newConversation() {
    setConversationId(null);
    setQuestion("");
  }

  const isEmpty = displayMessages.length === 0;
  // Server returns a `readonly [...]` tuple literal — copy into a mutable
  // `string[]` so the consumer prop type lines up cleanly.
  const suggestedList: string[] = suggested.data ? [...suggested.data] : [];

  return (
    <div className="min-h-screen bg-secondary text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-background">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-gradient-to-br from-[#635BFF] to-[#5a52f0] flex items-center justify-center shadow-md shadow-[#635BFF]/25">
              <Sparkles className="size-5 text-white" />
            </div>
            <div>
              <h1 className="font-display text-xl tracking-tight text-foreground">
                Owner Assistant
              </h1>
              <p
                className="text-xs text-muted-foreground tracking-wide"
                data-testid="freshness-chip"
              >
                {freshnessLabel(lastAssistantTrace)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(conversations.data ?? []).length > 0 && (
              <Select
                value={conversationId ? String(conversationId) : "__new__"}
                onValueChange={(v) => {
                  if (v === "__new__") {
                    newConversation();
                  } else {
                    setConversationId(Number(v));
                  }
                }}
              >
                <SelectTrigger className="h-8 w-[220px] bg-background border-border text-xs">
                  <SelectValue placeholder="Recent conversations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__new__">+ New conversation</SelectItem>
                  {(conversations.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.title || `Conversation #${c.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              size="sm"
              className="bg-background border-border text-foreground"
              onClick={newConversation}
              disabled={ask.isPending}
            >
              <RotateCcw className="size-3.5 mr-1.5" />
              New conversation
            </Button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6">
        <Card className="panel">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 font-display text-lg">
              <Sparkles className="size-4 text-[var(--iris)]" />
              점주 어시스턴트
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              매장 데이터에 대해 자연어로 물어보세요. 답변마다 어떤 tool이 호출됐는지
              "Agent trace"에서 확인할 수 있습니다.
            </p>
          </CardHeader>
          <CardContent>
            {/* Message list */}
            <ScrollArea className="h-[520px] pr-2">
              <div ref={listRef} className="space-y-3 pb-2">
                {isEmpty ? (
                  <EmptyState
                    prompts={suggestedList}
                    onPick={(p) => setQuestion(p)}
                  />
                ) : (
                  displayMessages.map((m) => (
                    <MessageBubble key={m.id} message={m} />
                  ))
                )}
                {ask.isPending && (
                  <div className="flex justify-start">
                    <div
                      className="max-w-[78%] rounded-2xl rounded-bl-md bg-secondary text-zinc-600 px-3.5 py-2 text-sm flex items-center gap-1.5"
                      data-testid="typing-indicator"
                      aria-label="Assistant is typing"
                    >
                      <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse" />
                      <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:120ms]" />
                      <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:240ms]" />
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Composer */}
            <div className="mt-3 flex items-end gap-2 border-t border-border pt-3">
              <Textarea
                value={question}
                placeholder="예: 지난 달 대비 이번 달 매출 어땠어?"
                maxLength={2000}
                rows={2}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitQuestion(question);
                  }
                }}
                disabled={ask.isPending}
                aria-label="Owner question"
                className="flex-1 bg-background border-border text-sm resize-none"
              />
              <Button
                onClick={() => submitQuestion(question)}
                disabled={ask.isPending || !question.trim()}
                className="bg-[var(--iris)] text-white hover:bg-[#5a52f0] border-0 shadow-sm shadow-[#635BFF]/30"
                aria-label="Send"
              >
                {ask.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4 mr-1.5" />
                )}
                {ask.isPending ? "Thinking…" : "Send"}
              </Button>
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              Enter로 전송 · Shift+Enter로 줄바꿈
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function EmptyState({
  prompts,
  onPick,
}: {
  prompts: string[];
  onPick: (p: string) => void;
}) {
  return (
    <div className="text-center py-10 px-3">
      <div className="text-sm text-muted-foreground mb-4">
        어떤 게 궁금하세요? 아래 추천 질문을 누르면 자동으로 채워집니다.
      </div>
      <div
        className="flex flex-wrap justify-center gap-2"
        data-testid="suggested-prompts"
      >
        {prompts.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-full border border-[var(--iris)]/25 bg-[var(--iris-soft)] text-[var(--iris)] px-3 py-1.5 text-xs hover:bg-[var(--iris-soft)]/70 transition-colors"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: AssistantMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-2xl rounded-br-md bg-[var(--iris)] text-white px-3.5 py-2 text-sm whitespace-pre-wrap shadow-sm">
          {message.contentMarkdown}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] w-full">
        <div className="rounded-2xl rounded-bl-md bg-background border border-border text-foreground px-3.5 py-2.5 text-sm shadow-sm">
          <div className="prose prose-sm max-w-none text-foreground">
            <Streamdown>{message.contentMarkdown}</Streamdown>
          </div>
        </div>
        {message.trace ? <OwnerAssistantTrace trace={message.trace} /> : null}
      </div>
    </div>
  );
}
