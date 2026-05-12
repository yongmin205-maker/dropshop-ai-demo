import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { PRESET_SCENARIOS, REJECT_CATEGORIES, REJECT_CATEGORY_LABELS, type PresetScenario, type RejectCategory } from "@shared/scenarios";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowUpRight,
  Bug,
  Building2,
  Check,
  CheckCircle2,
  CircleDot,
  Loader2,
  Phone,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsDown,
  Wifi,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVisiblePollInterval } from "@/hooks/useVisiblePollInterval";
import { useSimpleMode } from "@/hooks/useSimpleMode";
import { SimpleModeToggle } from "@/components/SimpleModeToggle";
import { ApprovalQueue } from "./dropshop/ApprovalQueue";
import { intentTone } from "./dropshop/intentTone";
import { Link } from "wouter";
import { toast } from "sonner";

/**
 * Subscribes to document visibility and returns a polling interval that
 * auto-pauses while the tab is hidden.
 *
 * - Active tab        → returns `activeMs` (e.g. 2_000ms)
 * - Hidden tab        → returns `false` (react-query interprets as "don't poll")
 * - Backgrounded > 60s→ still false; first refocus triggers an immediate refetch
 *
 * Saves both client CPU and server cost — the demo had ~5 timers each polling
 * every 2–2.5s, so a closed-laptop overnight could cost thousands of empty
 * round-trips per pane. (§4.1)
 */
type AgentStep = {
  step: "intent_detected" | "mock_api_called" | "response_drafted" | "sent" | "escalated" | "send_failed";
  label: string;
  detail?: unknown;
};

const STEP_META: Record<AgentStep["step"], { label: string; tone: string; icon: React.ReactNode }> = {
  intent_detected: { label: "Intent detected", tone: "text-[var(--iris)]", icon: <Sparkles className="size-3.5" /> },
  mock_api_called: { label: "Mock API called", tone: "text-sky-700", icon: <CircleDot className="size-3.5" /> },
  response_drafted: { label: "Response drafted", tone: "text-emerald-700", icon: <CircleDot className="size-3.5" /> },
  sent: { label: "Sent", tone: "text-emerald-700", icon: <CheckCircle2 className="size-3.5" /> },
  escalated: { label: "Escalated", tone: "text-rose-600", icon: <AlertTriangle className="size-3.5" /> },
  send_failed: { label: "Send failed", tone: "text-rose-600", icon: <AlertTriangle className="size-3.5" /> },
};

export default function Home() {
  const utils = trpc.useUtils();
  // Owner-only diagnostics gating. We deliberately do NOT show the Errors tab
  // to anonymous demo viewers — raw stack traces would be both noisy and a
  // small information leak about the internals.
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Simple Mode toggle (Phase 22a). Default is "simple" per
  // docs/PHASE22_DECISIONS.md §Q1; full layout stays one click away.
  const { mode: uiMode, isSimple, setMode: setUiMode } = useSimpleMode();
  // Re-poll the live-mode / fallback config every 30s so the UI honestly
  // reflects toggles made server-side without forcing a hard reload.
  const config = trpc.config.get.useQuery(undefined, { refetchInterval: 30_000 });
  const conversations = trpc.conversations.list.useQuery();
  const escalations = trpc.escalations.list.useQuery();

  const [activeScenario, setActiveScenario] = useState<PresetScenario>(PRESET_SCENARIOS[0]);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingSteps, setPendingSteps] = useState<AgentStep[]>([]);
  const [isSending, setIsSending] = useState(false);

  // Auto-select most recent conversation if none chosen
  useEffect(() => {
    if (activeConvId === null && conversations.data && conversations.data.length > 0) {
      setActiveConvId(conversations.data[0].id);
    }
  }, [activeConvId, conversations.data]);

  const effectiveConvId = activeConvId ?? conversations.data?.[0]?.id ?? -1;
  const messages = trpc.conversations.messages.useQuery(
    { conversationId: effectiveConvId },
    { enabled: effectiveConvId > 0, refetchInterval: useVisiblePollInterval(2000) },
  );
  const logs = trpc.conversations.logs.useQuery(
    { conversationId: effectiveConvId },
    { enabled: effectiveConvId > 0, refetchInterval: useVisiblePollInterval(2000) },
  );

  const sendMutation = trpc.simulator.sendMessage.useMutation({
    onSuccess: (result) => {
      setActiveConvId(result.conversationId);
      setPendingSteps([]);
      utils.conversations.list.invalidate();
      utils.conversations.messages.invalidate({ conversationId: result.conversationId });
      utils.conversations.logs.invalidate({ conversationId: result.conversationId });
      utils.escalations.list.invalidate();
      if (result.escalated) {
        toast.error("Critical Escalation — manager paged", {
          description: result.escalationReason ?? undefined,
        });
      } else {
        toast.success(`Reply sent · ${result.intent}`);
      }
    },
    onError: (err) => {
      toast.error("Agent error", { description: err.message });
      setPendingSteps([]);
    },
    onSettled: () => setIsSending(false),
  });

  const phoneScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phoneScrollRef.current) {
      phoneScrollRef.current.scrollTop = phoneScrollRef.current.scrollHeight;
    }
  }, [messages.data?.length, pendingSteps.length]);

  const sortedMessages = useMemo(() => messages.data ?? [], [messages.data]);
  const sortedLogs = useMemo(() => (logs.data ?? []).slice().reverse(), [logs.data]);

  function send(body: string, fromScenario?: PresetScenario) {
    if (!body.trim()) return;
    const scenario = fromScenario ?? activeScenario;
    setIsSending(true);
    setPendingSteps([{ step: "intent_detected", label: "Routing to AI agent…" }]);
    sendMutation.mutate({
      phone: scenario.customer.phone,
      body: body.trim(),
    });
    setDraft("");
  }

  function injectScenario(s: PresetScenario) {
    setActiveScenario(s);
    send(s.body, s);
  }

  return (
    <div className="min-h-screen bg-secondary text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-background">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-4 sm:py-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-gradient-to-br from-[#635BFF] to-[#5a52f0] flex items-center justify-center shadow-md shadow-[#635BFF]/25">
              <span className="font-display text-white font-bold text-lg">D</span>
            </div>
            <div>
              <h1 className="font-display text-xl tracking-tight text-foreground">DropShop</h1>
              <p className="text-xs text-muted-foreground tracking-wide uppercase">
                AI SMS Concierge · Demo
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <LiveModeBadge live={!!config.data?.liveMode} phone={config.data?.twilioPhone ?? null} />
            <Link
              href="/salon"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
              title="Switch to Pilot 2 — Salon AI demo"
            >
              <ArrowUpRight className="size-3.5" />
              Switch to Salon
            </Link>
            <ResetDemoButton onReset={() => setActiveConvId(null)} />
            <SimpleModeToggle mode={uiMode} onChange={setUiMode} />
            <Button variant="outline" size="sm" className="hidden sm:inline-flex bg-background border-border hover:bg-secondary text-foreground">
              <ArrowUpRight className="size-4 mr-1.5" />
              Pitch deck
            </Button>
          </div>
        </div>
      </header>

      {/* Embedding-degraded banner. Honest disclosure when semantic RAG is
          running on the deterministic hash-bag fallback (Forge embedding
          endpoint missing or has failed at least once this process).
          Hidden in Simple Mode — the friend's daily-use perspective doesn't
          need to see infra-degradation notices. */}
      {!isSimple && config.data?.embeddingFallback && (
        <div className="border-b border-amber-200 bg-amber-50 text-amber-900">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2 text-xs sm:text-sm flex items-start gap-2">
            <span className="mt-0.5">⚠</span>
            <span>
              <strong>Semantic search degraded.</strong>{" "}
              {config.data.embeddingMissingKey
                ? "Embedding API key not configured — RAG is running on a deterministic hash-bag fallback (lexical overlap only, not true semantics)."
                : "At least one embedding call has failed in this session — some RAG retrievals are now backed by a deterministic hash-bag fallback. Restart the server after the upstream recovers to clear this notice."}
            </span>
          </div>
        </div>
      )}

      {/* Preset scenarios bar. Hidden in Simple Mode — these are pitch /
          demo affordances, not part of the operator's daily workflow. */}
      {!isSimple && <div className="border-b border-border bg-background">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center gap-3 overflow-x-auto no-scrollbar">
          <span className="text-xs text-muted-foreground uppercase tracking-widest shrink-0 mr-1">
            Demo scenarios
          </span>
          {PRESET_SCENARIOS.map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant="outline"
              className="shrink-0 bg-secondary border-border text-foreground hover:border-[var(--iris)]/40 hover:bg-[var(--iris-soft)]"
              onClick={() => injectScenario(s)}
              disabled={isSending}
            >
              <span className={`size-1.5 rounded-full mr-2 ${
                s.intentHint === "Critical Escalation" ? "bg-rose-500" :
                s.intentHint === "Pickup Request" ? "bg-emerald-500" :
                s.intentHint === "ETA/Order Status" ? "bg-sky-500" :
                s.intentHint === "Alteration Quote" ? "bg-violet-500" : "bg-[var(--iris)]"
              }`} />
              {s.label}
            </Button>
          ))}
        </div>
      </div>}

      {/* Simple Mode: single vertical stack at every breakpoint. Designed
          mobile-first per docs/PHASE22_DECISIONS.md §Q1 (target is iOS/Android
          native app, not a desktop dashboard). Two regions only:
          (1) what came in (inbox chips), (2) what to send next (approval). */}
      {isSimple && (
        <main className="max-w-[480px] mx-auto px-4 py-4 space-y-4">
          <StoreInboxCompact
            conversations={conversations.data ?? []}
            activeId={activeConvId}
            onSelect={setActiveConvId}
          />
          <ApprovalQueue
            activeConversationId={activeConvId}
            customerName={
              conversations.data?.find((c) => c.id === activeConvId)?.customerName ?? null
            }
          />
          {(escalations.data?.length ?? 0) > 0 && (
            <EscalationsPanel
              escalations={escalations.data ?? []}
              onResolve={(id) => {
                utils.client.escalations.resolve.mutate({ id }).then(() => {
                  utils.escalations.list.invalidate();
                  toast.success("Escalation resolved");
                });
              }}
            />
          )}
        </main>
      )}

      {/* Split-screen workspace (desktop) — Full mode only. */}
      {!isSimple && <main className="hidden lg:grid max-w-[1600px] mx-auto px-6 py-6 grid-cols-12 gap-7">
        {/* Left: Customer phone simulator */}
        <section className="col-span-3">
          <PhoneSimulator
            scenario={activeScenario}
            onScenarioChange={setActiveScenario}
            messages={sortedMessages}
            draft={draft}
            onDraftChange={setDraft}
            onSend={() => send(draft)}
            isSending={isSending}
            scrollRef={phoneScrollRef}
          />
        </section>

        {/* Center: Store inbox */}
        <section className="col-span-5 space-y-4">
          <StoreInbox
            conversations={conversations.data ?? []}
            activeId={activeConvId}
            onSelect={setActiveConvId}
            messages={sortedMessages}
            activeScenario={activeScenario}
          />
        </section>

        {/* Right: AI log + escalations */}
        <section className="col-span-4 space-y-4">
          <Tabs defaultValue="approvals">
            <TabsList className="bg-background border border-border shadow-sm">
              <TabsTrigger value="approvals">
                Approvals
                <PendingDraftsBadge />
              </TabsTrigger>
              <TabsTrigger value="log">AI Log</TabsTrigger>
              <TabsTrigger value="escalations">
                Critical
                {(escalations.data?.length ?? 0) > 0 && (
                  <Badge className="ml-2 bg-rose-50 text-rose-700 border-rose-200">
                    {escalations.data?.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="rag">RAG Memory</TabsTrigger>
              {isAdmin && <TabsTrigger value="errors">Errors</TabsTrigger>}
            </TabsList>
            <TabsContent forceMount value="approvals" className="mt-3 data-[state=inactive]:hidden">
              <ApprovalQueue
                activeConversationId={activeConvId}
                customerName={
                  conversations.data?.find((c) => c.id === activeConvId)?.customerName ?? null
                }
              />
            </TabsContent>
            <TabsContent forceMount value="rag" className="mt-3 data-[state=inactive]:hidden">
              <RagMemoryPanel />
            </TabsContent>
            <TabsContent forceMount value="log" className="mt-3 data-[state=inactive]:hidden">
              <ProcessingLogPanel logs={sortedLogs} pending={pendingSteps} isSending={isSending} />
            </TabsContent>
            <TabsContent forceMount value="escalations" className="mt-3 data-[state=inactive]:hidden">
              <EscalationsPanel
                escalations={escalations.data ?? []}
                onResolve={(id) => {
                  utils.client.escalations.resolve.mutate({ id }).then(() => {
                    utils.escalations.list.invalidate();
                    toast.success("Escalation resolved");
                  });
                }}
              />
            </TabsContent>
            {isAdmin && (
              <TabsContent forceMount value="errors" className="mt-3 data-[state=inactive]:hidden">
                <ErrorsPanel />
              </TabsContent>
            )}
          </Tabs>
        </section>
      </main>}

      {/* Mobile workspace (tabs) — Full mode only. Simple mode handles its
          own mobile-first single-column layout above. */}
      {!isSimple && <main className="lg:hidden max-w-[1600px] mx-auto px-3 py-4">
        <Tabs defaultValue="simulator" className="w-full">
          <TabsList className="bg-background border border-border w-full grid grid-cols-4 shadow-sm">
            <TabsTrigger value="simulator" className="text-xs">Simulator</TabsTrigger>
            <TabsTrigger value="inbox" className="text-xs">Inbox</TabsTrigger>
            <TabsTrigger value="approvals" className="text-xs">
              Approvals
              <PendingDraftsBadge />
            </TabsTrigger>
            <TabsTrigger value="log" className="text-xs">Log</TabsTrigger>
          </TabsList>
          <TabsContent value="simulator" className="mt-3">
            <PhoneSimulator
              scenario={activeScenario}
              onScenarioChange={setActiveScenario}
              messages={sortedMessages}
              draft={draft}
              onDraftChange={setDraft}
              onSend={() => send(draft)}
              isSending={isSending}
              scrollRef={phoneScrollRef}
            />
          </TabsContent>
          <TabsContent value="inbox" className="mt-3">
            <StoreInbox
              conversations={conversations.data ?? []}
              activeId={activeConvId}
              onSelect={setActiveConvId}
              messages={sortedMessages}
              activeScenario={activeScenario}
            />
          </TabsContent>
          <TabsContent value="approvals" className="mt-3">
            <ApprovalQueue
              activeConversationId={activeConvId}
              customerName={
                conversations.data?.find((c) => c.id === activeConvId)?.customerName ?? null
              }
            />
          </TabsContent>
          <TabsContent value="log" className="mt-3 space-y-4">
            <ProcessingLogPanel logs={sortedLogs} pending={pendingSteps} isSending={isSending} />
            {(escalations.data?.length ?? 0) > 0 && (
              <EscalationsPanel
                escalations={escalations.data ?? []}
                onResolve={(id) => {
                  utils.client.escalations.resolve.mutate({ id }).then(() => {
                    utils.escalations.list.invalidate();
                    toast.success("Escalation resolved");
                  });
                }}
              />
            )}
            <RagMemoryPanel />
          </TabsContent>
        </Tabs>
      </main>}

      {/* Footer */}
      <footer className="border-t border-border bg-background mt-8">
        <div className="max-w-[1600px] mx-auto px-6 py-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>DropShop AI · Mock CleanCloud POS · {config.data?.liveMode ? "Live SMS via Twilio" : "Simulator Mode"}</span>
          <span>Built for the dry-cleaning operator who never wants to type "Will do" again.</span>
        </div>
      </footer>
    </div>
  );
}

/* ============================================================
 * Sub-components
 * ============================================================ */

function LiveModeBadge({ live, phone }: { live: boolean; phone: string | null }) {
  if (live) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs">
        <Wifi className="size-3.5" />
        <span className="font-medium">Live · {phone}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--iris)]/25 bg-[var(--iris-soft)] text-[var(--iris)] text-xs">
      <span className="size-2 rounded-full bg-[var(--iris)] animate-pulse" />
      <span className="font-medium tracking-wide">Simulator Mode</span>
    </div>
  );
}

function PhoneSimulator({
  scenario,
  onScenarioChange,
  messages,
  draft,
  onDraftChange,
  onSend,
  isSending,
  scrollRef,
}: {
  scenario: PresetScenario;
  onScenarioChange: (s: PresetScenario) => void;
  messages: { id: number; direction: "inbound" | "outbound"; body: string; createdAt: Date }[];
  draft: string;
  onDraftChange: (s: string) => void;
  onSend: () => void;
  isSending: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const visibleMessages = messages; // already filtered to active conversation by parent
  return (
    <div className="rounded-[2rem] bg-gradient-to-b from-zinc-800 to-zinc-900 p-2 border border-zinc-900" style={{ boxShadow: "0 0 0 1px rgba(50,50,93,0.04), 0 12px 32px -10px rgba(20,20,40,0.25), 0 6px 12px -4px rgba(50,50,93,0.08)" }}>
      <div className="rounded-[1.6rem] bg-zinc-50 text-zinc-900 overflow-hidden flex flex-col" style={{ minHeight: 640 }}>
        {/* Phone status bar */}
        <div className="flex items-center justify-between text-xs text-zinc-500 px-5 pt-3 pb-2">
          <span>9:41</span>
          <span className="flex items-center gap-1">
            <span className="size-1 rounded-full bg-zinc-400" />
            <span className="size-1 rounded-full bg-zinc-400" />
            <span className="size-1 rounded-full bg-zinc-400" />
          </span>
        </div>
        {/* Contact header */}
        <div className="px-4 pb-3 border-b border-zinc-200 flex flex-col items-center">
          <div className="size-12 rounded-xl bg-gradient-to-br from-[#635BFF] to-[#5a52f0] flex items-center justify-center shadow mb-1.5">
            <span className="font-display font-bold text-white">D</span>
          </div>
          <div className="text-sm font-semibold">DropShop</div>
          <div className="text-xs text-zinc-500">iMessage</div>
        </div>
        {/* Persona switcher */}
        <div className="px-4 py-3 bg-zinc-50 border-b border-zinc-200">
          <label className="text-[10px] uppercase tracking-widest text-zinc-500">Texting as</label>
          <Select
            value={scenario.id}
            onValueChange={(v) => {
              const s = PRESET_SCENARIOS.find((x) => x.id === v);
              if (s) onScenarioChange(s);
            }}
          >
            <SelectTrigger className="mt-1 bg-white border-zinc-200 text-zinc-900">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESET_SCENARIOS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.customer.name} · {s.customer.phone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Messages */}
        <ScrollArea className="flex-1" >
          <div ref={scrollRef} className="px-4 py-4 space-y-2 min-h-[320px] max-h-[420px] overflow-y-auto">
            {visibleMessages.length === 0 && (
              <div className="text-center text-xs text-zinc-400 py-12">
                No messages yet. Send one below or pick a preset scenario.
              </div>
            )}
            {visibleMessages.map((m) => (
              <div key={m.id} className={`flex ${m.direction === "inbound" ? "justify-end" : "justify-start"}`}>
                {m.direction === "inbound" ? (
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-blue-500 text-white px-3.5 py-2 text-sm shadow-sm">
                    {m.body}
                  </div>
                ) : (
                  <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-zinc-200 text-zinc-900 px-3.5 py-2 text-sm shadow-sm whitespace-pre-wrap">
                    {m.body}
                  </div>
                )}
              </div>
            ))}
            {isSending && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md bg-zinc-200 text-zinc-500 px-3.5 py-2 text-sm flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse" />
                  <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:120ms]" />
                  <span className="size-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:240ms]" />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
        {/* Composer */}
        <div className="px-3 py-3 border-t border-zinc-200 bg-zinc-50 flex items-center gap-2">
          <Input
            value={draft}
            placeholder="iMessage"
            maxLength={500}
            onChange={(e) => onDraftChange(e.target.value.slice(0, 500))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            className="bg-white border-zinc-200 text-zinc-900 rounded-full"
            disabled={isSending}
            aria-label="Customer SMS body"
          />
          <Button
            size="icon"
            className="rounded-full bg-blue-500 hover:bg-blue-600 text-white shrink-0"
            onClick={onSend}
            disabled={isSending || !draft.trim()}
            aria-label="Send"
          >
            {isSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StoreInbox({
  conversations,
  activeId,
  onSelect,
  messages,
  activeScenario,
}: {
  conversations: { id: number; phone: string; customerName: string | null; lastIntent: string | null; escalated: number; updatedAt: Date }[];
  activeId: number | null;
  onSelect: (id: number) => void;
  messages: { id: number; direction: "inbound" | "outbound"; sender: string; body: string; intent: string | null; createdAt: Date }[];
  activeScenario: PresetScenario;
}) {
  const sortedConvs = useMemo(
    () => [...conversations].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    [conversations],
  );
  const activeConv = sortedConvs.find((c) => c.id === activeId) ?? sortedConvs[0];

  // Auto-select if none chosen
  useEffect(() => {
    if (activeId === null && sortedConvs[0]) onSelect(sortedConvs[0].id);
  }, [activeId, sortedConvs, onSelect]);

  return (
    <Card className="panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between font-display text-lg">
          <span className="flex items-center gap-2">
            <Building2 className="size-4 text-[var(--iris)]" />
            Store Inbox
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {sortedConvs.length} conversation{sortedConvs.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Conversation chips */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {sortedConvs.length === 0 && (
            <div className="text-sm text-muted-foreground py-6 px-2">
              No inbound messages yet. Send one from the simulator on the left.
            </div>
          )}
          {sortedConvs.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`shrink-0 text-left px-3 py-2 rounded-lg border transition ${
                c.id === activeConv?.id
                  ? "border-[var(--iris)]/35 bg-[var(--iris-soft)]"
                  : "border-border bg-secondary hover:bg-[var(--iris-soft)]/50"
              }`}
            >
              <div className="text-sm font-medium flex items-center gap-2">
                {c.customerName ?? "Unknown"}
                {c.escalated === 1 && (
                  <AlertTriangle className="size-3 text-rose-600" />
                )}
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums">{c.phone}</div>
              {c.lastIntent && (
                <Badge variant="outline" className={`mt-1.5 text-[10px] py-0 ${intentTone(c.lastIntent)}`}>
                  {c.lastIntent}
                </Badge>
              )}
            </button>
          ))}
        </div>

        <Separator className="bg-border" />

        {/* Active thread */}
        {activeConv ? (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-medium flex items-center gap-2">
                  <Phone className="size-3.5 text-muted-foreground" />
                  {activeConv.customerName ?? "Unknown"}
                  <span className="text-xs text-muted-foreground tabular-nums">{activeConv.phone}</span>
                </div>
                {activeConv.lastIntent && (
                  <Badge variant="outline" className={`mt-1 text-[10px] ${intentTone(activeConv.lastIntent)}`}>
                    {activeConv.lastIntent}
                  </Badge>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground">{format(new Date(activeConv.updatedAt), "MMM d · HH:mm")}</span>
            </div>
            <ScrollArea className="h-[460px] pr-2">
              <div className="space-y-3">
                {messages.length === 0 && (
                  <div className="text-sm text-muted-foreground text-center py-12">
                    Loading conversation…
                  </div>
                )}
                {messages.map((m) => {
                  // Manager POV: the customer is the OTHER person, so customer
                  // (inbound) is on the LEFT in gray; DropShop (outbound) is
                  // on the RIGHT in blue — mirroring how a real store inbox
                  // (Front, Nextiva, OpenPhone, Slack DMs) renders threads.
                  const isCustomer = m.direction === "inbound";
                  return (
                    <div key={m.id} className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}>
                      <div className="max-w-[78%]">
                        <div className={`text-[10px] uppercase tracking-widest mb-1 ${isCustomer ? "text-muted-foreground" : "text-[var(--iris)] text-right"}`}>
                          {isCustomer ? "Customer" : m.sender === "ai" ? "DropShop AI" : "Manager"}
                          {m.intent && (
                            <span className={`ml-2 inline-block px-1.5 py-0.5 rounded border text-[9px] ${intentTone(m.intent)}`}>
                              {m.intent}
                            </span>
                          )}
                        </div>
                        <div
                          className={
                            isCustomer
                              ? "bubble-customer-inbox whitespace-pre-wrap"
                              : "bubble-business-inbox whitespace-pre-wrap"
                          }
                          style={{ maxWidth: "100%" }}
                        >
                          {m.body}
                        </div>
                        <div className={`text-[10px] text-muted-foreground mt-1 ${isCustomer ? "" : "text-right"}`}>
                          {format(new Date(m.createdAt), "HH:mm:ss")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-sm text-muted-foreground">
              Try the <span className="text-[var(--iris)] font-medium">{activeScenario.label}</span> scenario above.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * StoreInboxCompact — the Simple-Mode inbox.
 *
 * Just a vertical list of recent conversations as full-width tap targets,
 * sized for one-thumb operation on a 375 × 812 phone screen. Tapping a row
 * selects that conversation so the ApprovalQueue card below it switches to
 * that thread's pending draft.
 *
 * We intentionally do NOT render the message thread inline here — in Simple
 * Mode the operator only needs to see (a) who's waiting and (b) what to
 * send. If they want the full thread, they flip to Full mode.
 */
function StoreInboxCompact({
  conversations,
  activeId,
  onSelect,
}: {
  conversations: { id: number; phone: string; customerName: string | null; lastIntent: string | null; escalated: number; updatedAt: Date }[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  const sorted = useMemo(
    () => [...conversations].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    [conversations],
  );
  if (sorted.length === 0) {
    return (
      <Card className="panel">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No customer messages yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between font-display text-sm">
          <span className="flex items-center gap-2">
            <Building2 className="size-4 text-[var(--iris)]" />
            Customers waiting
          </span>
          <span className="text-[10px] font-normal text-muted-foreground">
            {sorted.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-2">
        <div className="divide-y divide-border">
          {sorted.slice(0, 5).map((c) => {
            const active = c.id === activeId;
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`w-full min-h-[44px] px-2 py-2 flex items-center justify-between text-left transition-colors ${
                  active
                    ? "bg-[var(--iris-soft)]"
                    : "hover:bg-secondary"
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    {c.customerName ?? c.phone}
                    {c.escalated === 1 && (
                      <AlertTriangle className="size-3 text-rose-600 shrink-0" />
                    )}
                  </div>
                  {c.lastIntent && (
                    <span
                      className={`mt-1 inline-block text-[10px] px-1.5 py-0.5 rounded border ${intentTone(c.lastIntent)}`}
                    >
                      {c.lastIntent}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-3">
                  {format(new Date(c.updatedAt), "HH:mm")}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ProcessingLogPanel({
  logs,
  pending,
  isSending,
}: {
  logs: { id: number; step: AgentStep["step"]; label: string; detail: unknown; createdAt: Date }[];
  pending: AgentStep[];
  isSending: boolean;
}) {
  return (
    <Card className="panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-lg">
          <Sparkles className="size-4 text-[var(--iris)]" />
          AI Processing Log
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          intent detected → mock API called → response drafted → sent / escalated
        </p>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[560px] pr-2">
          <div className="space-y-2">
            {isSending && pending.map((p, i) => (
              <LogRow key={`p${i}`} step={p.step} label={p.label} detail={null} pending />
            ))}
            {logs.length === 0 && !isSending && (
              <div className="text-sm text-muted-foreground text-center py-12">
                Send a message to see every step the AI takes.
              </div>
            )}
            {logs.map((l) => (
              <LogRow key={l.id} step={l.step} label={l.label} detail={l.detail} time={new Date(l.createdAt)} />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function LogRow({
  step,
  label,
  detail,
  time,
  pending,
}: {
  step: AgentStep["step"];
  label: string;
  detail: unknown;
  time?: Date;
  pending?: boolean;
}) {
  const meta = STEP_META[step];
  return (
    <div className={`rounded-lg border border-border bg-secondary p-3 ${pending ? "animate-pulse" : ""}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-widest ${meta.tone}`}>
          {meta.icon}
          <span>{meta.label}</span>
        </div>
        {time && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {format(time, "HH:mm:ss")}
          </span>
        )}
      </div>
      <div className="text-sm text-foreground/90">{label}</div>
      {detail != null && (
        <details className="mt-1.5">
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
            view payload
          </summary>
          <pre className="text-[10px] mt-1.5 p-2 rounded bg-background border border-border text-foreground/80 overflow-auto max-h-40 font-mono">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function EscalationsPanel({
  escalations,
  onResolve,
}: {
  escalations: { id: number; reason: string; severity: "high" | "critical"; createdAt: Date; conversationId: number }[];
  onResolve: (id: number) => void;
}) {
  return (
    <Card className="rounded-[12px] border bg-rose-50/40 border-rose-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-lg text-rose-700">
          <AlertTriangle className="size-4" />
          Critical Handoff
        </CardTitle>
        <p className="text-xs text-rose-600/80">
          AI auto-reply suspended. Human manager must respond directly.
        </p>
      </CardHeader>
      <CardContent>
        {escalations.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            No open escalations. The store is calm.
          </div>
        ) : (
          <div className="space-y-3">
            {escalations.map((e) => (
              <div key={e.id} className="rounded-lg border border-rose-200 bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between mb-1">
                  <Badge className="bg-rose-100 text-rose-700 border-rose-200">
                    {e.severity.toUpperCase()}
                  </Badge>
                  <span className="text-[10px] text-rose-600/70">
                    {format(new Date(e.createdAt), "MMM d · HH:mm")}
                  </span>
                </div>
                <p className="text-sm text-rose-900">{e.reason}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] text-rose-600/70">Conversation #{e.conversationId}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="bg-white border-rose-200 text-rose-700 hover:bg-rose-50"
                    onClick={() => onResolve(e.id)}
                  >
                    Mark resolved
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


/* ============================================================
 * ErrorsPanel — admin-only diagnostics view (Phase 9)
 * ============================================================
 *
 * Surfaces server-side failures persisted into `errorLogs` so the owner can
 * triage incidents without needing access to the underlying Cloud Run console.
 * Gated server-side via `adminProcedure`; the tab itself is also conditionally
 * rendered only when `useAuth().user?.role === 'admin'`.
 */
function ErrorsPanel() {
  const utils = trpc.useUtils();
  // Local filter state. Use "__all__" sentinel because shadcn <SelectItem>
  // forbids empty-string values (see Common Pitfalls in template README).
  const [levelFilter, setLevelFilter] = useState<"__all__" | "error" | "warn">("__all__");
  const [sourceFilter, setSourceFilter] = useState<string>("__all__");
  // Memoize the query input so trpc doesn't refetch on every keystroke /
  // unrelated re-render (see Common Pitfalls #1 in template README).
  const listInput = useMemo(
    () => ({
      level: levelFilter === "__all__" ? undefined : levelFilter,
      source: sourceFilter === "__all__" ? undefined : sourceFilter,
    }),
    [levelFilter, sourceFilter],
  );
  const errors = trpc.errorLogs.list.useQuery(listInput, {
    refetchInterval: useVisiblePollInterval(8000),
  });
  const sources = trpc.errorLogs.sources.useQuery();
  const alerts = trpc.errorLogs.alerts.useQuery(undefined, {
    refetchInterval: useVisiblePollInterval(8000),
  });
  const clearAll = trpc.errorLogs.clear.useMutation({
    onSuccess: ({ cleared }) => {
      toast.success(cleared === 0 ? "No errors to clear" : `Cleared ${cleared} error(s)`);
      utils.errorLogs.list.invalidate();
      utils.errorLogs.sources.invalidate();
      utils.errorLogs.alerts.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const purgeOld = trpc.errorLogs.purgeOld.useMutation({
    onSuccess: ({ logsPurged, alertsPurged, olderThanDays }) => {
      const total = logsPurged + alertsPurged;
      toast.success(
        total === 0
          ? `Nothing to purge (older than ${olderThanDays}d)`
          : `Purged ${logsPurged} log(s) + ${alertsPurged} alert(s) older than ${olderThanDays}d`,
      );
      utils.errorLogs.list.invalidate();
      utils.errorLogs.sources.invalidate();
      utils.errorLogs.alerts.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const rows = errors.data ?? [];
  const sourceList = sources.data ?? [];
  const filtersActive = levelFilter !== "__all__" || sourceFilter !== "__all__";
  return (
    <Card className="panel rounded-[12px]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 font-display text-lg text-[var(--ink)]">
              <Bug className="size-4 text-rose-600" />
              Server Errors
              {rows.length > 0 && (
                <Badge className="ml-1 bg-rose-50 text-rose-700 border-rose-200">
                  {rows.length}
                </Badge>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Persisted server-side failures (Twilio webhook, DB writes, OAuth, embedding loops).
              Admin-only. Newest first.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={purgeOld.isPending}
              onClick={() => purgeOld.mutate({ olderThanDays: 30 })}
              title="Drop logs and alerts older than 30 days"
            >
              {purgeOld.isPending ? <Loader2 className="size-3 mr-1 animate-spin" /> : null}
              Purge old (30d+)
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={rows.length === 0 || clearAll.isPending}
              onClick={() => clearAll.mutate()}
            >
              {clearAll.isPending ? <Loader2 className="size-3 mr-1 animate-spin" /> : null}
              Clear all
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Filter
          </span>
          <Select value={levelFilter} onValueChange={(v) => setLevelFilter(v as typeof levelFilter)}>
            <SelectTrigger className="h-7 w-[110px] text-xs">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All levels</SelectItem>
              <SelectItem value="error">error</SelectItem>
              <SelectItem value="warn">warn</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="h-7 w-[180px] text-xs">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All sources</SelectItem>
              {sourceList.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtersActive && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setLevelFilter("__all__");
                setSourceFilter("__all__");
              }}
            >
              Reset
            </Button>
          )}
        </div>
        {alerts.data && alerts.data.length > 0 && (
          <div className="mb-4 space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-amber-700">
              Fired alerts (notifyOwner pushed)
            </div>
            {alerts.data.slice(0, 5).map((a) => (
              <div
                key={a.id}
                className="rounded-md border border-amber-200 bg-amber-50/70 p-2 text-xs flex items-center justify-between"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge className="bg-amber-100 text-amber-800 border-amber-200">
                    {a.kind === "spike" ? "SPIKE" : "FLAP"}
                  </Badge>
                  <span className="font-medium text-[var(--ink)] truncate">{a.source}</span>
                  <span className="text-amber-700">
                    {a.count}× in {Math.round(a.windowSeconds / 60)}m
                  </span>
                  {a.message && (
                    <span className="text-muted-foreground truncate">· {a.message}</span>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                  {format(new Date(a.createdAt), "MMM d · HH:mm")}
                </span>
              </div>
            ))}
          </div>
        )}
        {errors.isLoading ? (
          <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted-foreground py-12 text-center">
            No server errors recorded. 🎉
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <div
                key={row.id}
                className="rounded-lg border border-rose-200 bg-rose-50/40 p-3 text-sm"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      className={
                        row.level === "warn"
                          ? "bg-amber-100 text-amber-800 border-amber-200"
                          : "bg-rose-100 text-rose-700 border-rose-200"
                      }
                    >
                      {row.level.toUpperCase()}
                    </Badge>
                    <span className="text-xs font-medium text-[var(--ink)]">{row.source}</span>
                    {row.correlationId && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {row.correlationId}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {format(new Date(row.createdAt), "MMM d · HH:mm:ss")}
                  </span>
                </div>
                <p className="text-rose-900 break-words">{row.message}</p>
                {row.context !== null && row.context !== undefined && (
                  <pre className="mt-2 text-[10px] bg-white/70 rounded p-2 border border-rose-200 overflow-x-auto">
                    {JSON.stringify(row.context, null, 2)}
                  </pre>
                )}
                {row.stack && (
                  <details className="mt-2">
                    <summary className="text-[10px] text-muted-foreground cursor-pointer">
                      stack trace
                    </summary>
                    <pre className="mt-1 text-[10px] bg-white/70 rounded p-2 border border-rose-200 overflow-x-auto whitespace-pre-wrap">
                      {row.stack}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
 * Human-in-the-Loop & RAG components
 * ============================================================ */

function PendingDraftsBadge() {
  const pending = trpc.drafts.listPending.useQuery(undefined, {
    refetchInterval: useVisiblePollInterval(2500),
  });
  const count = pending.data?.length ?? 0;
  // §5.6 Surface the pending-approval count in the browser tab title so the
  // owner notices new drafts even when the tab is in the background.
  // We restore the original title on unmount so this hook is safe to remove.
  useEffect(() => {
    const original = document.title;
    document.title = count > 0 ? `(${count}) ${original.replace(/^\(\d+\)\s*/, "")}` : original.replace(/^\(\d+\)\s*/, "");
    return () => {
      document.title = original.replace(/^\(\d+\)\s*/, "");
    };
  }, [count]);
  if (count === 0) return null;
  return (
    <Badge className="ml-2 bg-[var(--iris-soft)] text-[var(--iris)] border-[var(--iris)]/25">
      {count}
    </Badge>
  );
}


function RagMemoryPanel() {
  const styleExamples = trpc.rag.styleExamples.useQuery();
  const rejections = trpc.rag.rejections.useQuery();
  const knowledge = trpc.rag.knowledge.useQuery();

  return (
    <Card className="panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-lg">
          <Sparkles className="size-4 text-[var(--iris)]" />
          RAG Memory — 3 Tiers
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Knowledge · Approved replies · Rejection lessons. These are retrieved & injected into every new draft.
        </p>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="style">
          <TabsList className="bg-secondary border border-border rounded-md">
            <TabsTrigger value="style">
              Approved
              <Badge className="ml-2 bg-emerald-50 text-emerald-700 border-emerald-200">
                {styleExamples.data?.length ?? 0}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="rejections">
              Rejections
              <Badge className="ml-2 bg-rose-50 text-rose-700 border-rose-200">
                {rejections.data?.length ?? 0}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="knowledge">
              Knowledge
              <Badge className="ml-2 bg-sky-50 text-sky-700 border-sky-200">
                {knowledge.data?.length ?? 0}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent forceMount value="style" className="mt-3 data-[state=inactive]:hidden">
            <ScrollArea className="h-[480px] pr-2">
              {(styleExamples.data ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-12">
                  No approved replies yet. Approve a draft and it appears here.
                </div>
              ) : (
                <div className="space-y-3">
                  {(styleExamples.data ?? []).map((ex) => (
                    <div key={ex.id} className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
                      <Badge variant="outline" className={`text-[10px] ${intentTone(ex.intent)}`}>{ex.intent}</Badge>
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Customer</div>
                      <div className="text-sm text-foreground">{ex.customerBody}</div>
                      <div className="text-[10px] uppercase tracking-widest text-emerald-700">Approved DropShop reply</div>
                      <div className="text-sm text-foreground whitespace-pre-wrap">{ex.approvedReply}</div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent forceMount value="rejections" className="mt-3 data-[state=inactive]:hidden">
            <ScrollArea className="h-[480px] pr-2">
              {(rejections.data ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-12">
                  No rejections yet. Reject a draft with a reason and the AI will learn from it.
                </div>
              ) : (
                <div className="space-y-3">
                  <TopRejectReasons rejections={rejections.data ?? []} />
                  {(rejections.data ?? []).map((r) => {
                    const cat = ((r as unknown) as { category?: RejectCategory | null }).category ?? null;
                    return (
                      <div key={r.id} className="rounded-lg border border-rose-200 bg-rose-50/40 p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className={`text-[10px] ${intentTone(r.intent)}`}>{r.intent}</Badge>
                          {cat && (
                            <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-200">
                              {REJECT_CATEGORY_LABELS[cat] ?? cat}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Customer</div>
                        <div className="text-sm text-foreground">{r.customerBody}</div>
                        <div className="text-[10px] uppercase tracking-widest text-rose-700">Rejected draft</div>
                        <div className="text-sm text-foreground/70 whitespace-pre-wrap line-through opacity-70">{r.rejectedReply}</div>
                        <div className="text-[10px] uppercase tracking-widest text-[var(--iris)]">Manager reason</div>
                        <div className="text-sm text-foreground">{r.reason}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent forceMount value="knowledge" className="mt-3 data-[state=inactive]:hidden">
            <ScrollArea className="h-[480px] pr-2">
              <div className="space-y-3">
                {(knowledge.data ?? []).map((k) => (
                  <div key={k.id} className="rounded-lg border border-sky-200 bg-sky-50/40 p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] bg-sky-50 text-sky-700 border-sky-200">
                        {k.topic}
                      </Badge>
                      <div className="text-sm font-medium text-foreground">{k.title}</div>
                    </div>
                    <div className="text-sm text-foreground/80">{k.body}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}


function TopRejectReasons({
  rejections,
}: {
  rejections: { category?: string | null }[];
}) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rejections) {
      const c = (r.category as string | undefined) || "other";
      map.set(c, (map.get(c) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [rejections]);

  if (counts.length === 0) return null;
  const total = rejections.length;

  return (
    <div className="rounded-lg border border-[var(--iris)]/20 bg-[var(--iris-soft)]/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-[var(--iris)] font-semibold">
          Top reject reasons
        </div>
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {total} total
        </div>
      </div>
      <div className="space-y-1.5">
        {counts.map(([cat, n]) => {
          const pct = Math.round((n / Math.max(total, 1)) * 100);
          const label =
            REJECT_CATEGORY_LABELS[cat as RejectCategory] ?? cat;
          return (
            <div key={cat} className="flex items-center gap-2">
              <div className="text-xs w-32 shrink-0 text-foreground/85">
                {label}
              </div>
              <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full bg-[var(--iris)]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="text-[11px] tabular-nums text-muted-foreground w-8 text-right">
                {n}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ResetDemoButton({ onReset }: { onReset?: () => void } = {}) {
  const utils = trpc.useUtils();
  // §4.10 Typed RESET guard — the destructive CTA stays disabled until the
  // operator literally types `RESET`. Belt-and-suspenders against accidental
  // mid-demo wipes (and against the AlertDialog primary button being default-
  // focused, which makes a stray Enter dangerous).
  const [confirmText, setConfirmText] = useState("");
  const [open, setOpen] = useState(false);
  const canSubmit = confirmText.trim().toUpperCase() === "RESET";

  const reset = trpc.demo.reset.useMutation({
    onSuccess: () => {
      utils.conversations.list.invalidate();
      utils.conversations.messages.invalidate();
      utils.drafts.listPending.invalidate();
      utils.rag.styleExamples.invalidate();
      utils.rag.rejections.invalidate();
      utils.escalations.list.invalidate();
      toast.success("Demo reset — all conversations cleared");
      setConfirmText("");
      setOpen(false);
      // §5.11 Drop the stale activeConvId selection now that all conversations
      // are gone — otherwise the Approval Queue keeps the old filter and the
      // Customer Profile badge points at a deleted row.
      onReset?.();
    },
    onError: (e) => toast.error(`Reset failed: ${e.message}`),
  });

  return (
    <AlertDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setConfirmText(""); }}>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="bg-background border-border text-foreground hover:bg-secondary hover:border-rose-200 hover:text-rose-700"
          disabled={reset.isPending}
        >
          <RotateCcw className="size-4 mr-1.5" />
          {reset.isPending ? "Resetting…" : "Reset demo"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset demo data?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes <b>all conversations, drafts, rejections, AI logs, and escalations</b>.
            The knowledge base and approved style examples are preserved.
            <br /><br />
            Type <code className="px-1 py-0.5 rounded bg-secondary text-rose-700 font-semibold">RESET</code> below to confirm — there is no undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="Type RESET"
          className="font-mono tracking-wider"
          onKeyDown={(e) => {
            // Block the stray-Enter footgun: only fire when the gate is open.
            if (e.key === "Enter" && canSubmit) reset.mutate();
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300 disabled:cursor-not-allowed"
            disabled={!canSubmit || reset.isPending}
            onClick={(e) => {
              if (!canSubmit) { e.preventDefault(); return; }
              reset.mutate();
            }}
          >
            {reset.isPending ? "Resetting…" : "Yes, wipe demo data"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
