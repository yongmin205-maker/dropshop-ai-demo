import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { PRESET_SCENARIOS, REJECT_CATEGORIES, REJECT_CATEGORY_LABELS, type PresetScenario, type RejectCategory } from "@shared/scenarios";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowUpRight,
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
import { toast } from "sonner";

type AgentStep = {
  step: "intent_detected" | "mock_api_called" | "response_drafted" | "sent" | "escalated";
  label: string;
  detail?: unknown;
};

const STEP_META: Record<AgentStep["step"], { label: string; tone: string; icon: React.ReactNode }> = {
  intent_detected: { label: "Intent detected", tone: "text-amber-300", icon: <Sparkles className="size-3.5" /> },
  mock_api_called: { label: "Mock API called", tone: "text-sky-300", icon: <CircleDot className="size-3.5" /> },
  response_drafted: { label: "Response drafted", tone: "text-emerald-300", icon: <CircleDot className="size-3.5" /> },
  sent: { label: "Sent", tone: "text-emerald-400", icon: <CheckCircle2 className="size-3.5" /> },
  escalated: { label: "Escalated", tone: "text-rose-400", icon: <AlertTriangle className="size-3.5" /> },
};

function intentTone(intent: string | null | undefined) {
  switch (intent) {
    case "Critical Escalation":
      return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    case "Pickup Request":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "ETA/Order Status":
      return "bg-sky-500/15 text-sky-300 border-sky-500/30";
    case "Alteration Quote":
      return "bg-violet-500/15 text-violet-300 border-violet-500/30";
    case "Membership & Pricing":
      return "bg-amber-500/15 text-amber-200 border-amber-500/30";
    default:
      return "bg-white/10 text-white/70 border-white/15";
  }
}

export default function Home() {
  const utils = trpc.useUtils();
  const config = trpc.config.get.useQuery();
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
    { enabled: effectiveConvId > 0, refetchInterval: 2000 },
  );
  const logs = trpc.conversations.logs.useQuery(
    { conversationId: effectiveConvId },
    { enabled: effectiveConvId > 0, refetchInterval: 2000 },
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
    <div className="min-h-screen bg-background text-foreground grain">
      {/* Header */}
      <header className="border-b border-white/5 bg-gradient-to-b from-white/[0.02] to-transparent">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-4 sm:py-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
              <span className="font-display text-zinc-900 font-bold text-lg">D</span>
            </div>
            <div>
              <h1 className="font-display text-xl tracking-tight text-champagne">DropShop</h1>
              <p className="text-xs text-muted-foreground tracking-wide uppercase">
                AI SMS Concierge · Demo
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <LiveModeBadge live={!!config.data?.liveMode} phone={config.data?.twilioPhone ?? null} />
            <ResetDemoButton />
            <Button variant="outline" size="sm" className="hidden sm:inline-flex bg-white/[0.04] border-white/10 hover:bg-white/[0.08]">
              <ArrowUpRight className="size-4 mr-1.5" />
              Pitch deck
            </Button>
          </div>
        </div>
      </header>

      {/* Preset scenarios bar */}
      <div className="border-b border-white/5 bg-white/[0.015]">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center gap-3 overflow-x-auto no-scrollbar">
          <span className="text-xs text-muted-foreground uppercase tracking-widest shrink-0 mr-1">
            Demo scenarios
          </span>
          {PRESET_SCENARIOS.map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant="outline"
              className="shrink-0 bg-white/[0.03] border-white/10 hover:border-amber-300/40 hover:bg-amber-300/[0.08]"
              onClick={() => injectScenario(s)}
              disabled={isSending}
            >
              <span className={`size-1.5 rounded-full mr-2 ${
                s.intentHint === "Critical Escalation" ? "bg-rose-400" :
                s.intentHint === "Pickup Request" ? "bg-emerald-400" :
                s.intentHint === "ETA/Order Status" ? "bg-sky-400" :
                s.intentHint === "Alteration Quote" ? "bg-violet-400" : "bg-amber-300"
              }`} />
              {s.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Split-screen workspace (desktop) */}
      <main className="hidden lg:grid max-w-[1600px] mx-auto px-6 py-6 grid-cols-12 gap-6">
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
            <TabsList className="bg-white/[0.04] border border-white/10">
              <TabsTrigger value="approvals">
                Approvals
                <PendingDraftsBadge />
              </TabsTrigger>
              <TabsTrigger value="log">AI Log</TabsTrigger>
              <TabsTrigger value="escalations">
                Critical
                {(escalations.data?.length ?? 0) > 0 && (
                  <Badge className="ml-2 bg-rose-500/20 text-rose-300 border-rose-500/30">
                    {escalations.data?.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="rag">RAG Memory</TabsTrigger>
            </TabsList>
            <TabsContent value="approvals" className="mt-3">
              <ApprovalQueue />
            </TabsContent>
            <TabsContent value="rag" className="mt-3">
              <RagMemoryPanel />
            </TabsContent>
            <TabsContent value="log" className="mt-3">
              <ProcessingLogPanel logs={sortedLogs} pending={pendingSteps} isSending={isSending} />
            </TabsContent>
            <TabsContent value="escalations" className="mt-3">
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
          </Tabs>
        </section>
      </main>

      {/* Mobile workspace (tabs) */}
      <main className="lg:hidden max-w-[1600px] mx-auto px-3 py-4">
        <Tabs defaultValue="simulator" className="w-full">
          <TabsList className="bg-white/[0.04] border border-white/10 w-full grid grid-cols-4">
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
            <ApprovalQueue />
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
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 mt-8">
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
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs">
        <Wifi className="size-3.5" />
        <span className="font-medium">Live · {phone}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-300/30 bg-amber-300/10 text-amber-200 text-xs">
      <span className="size-2 rounded-full bg-amber-300 animate-pulse" />
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
    <div className="rounded-[2rem] bg-gradient-to-b from-zinc-950 to-zinc-900 p-2 shadow-2xl shadow-black/40 border border-white/5">
      <div className="rounded-[1.6rem] bg-zinc-100 text-zinc-900 overflow-hidden flex flex-col" style={{ minHeight: 640 }}>
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
          <div className="size-12 rounded-full bg-gradient-to-br from-amber-300 to-amber-600 flex items-center justify-center shadow mb-1.5">
            <span className="font-display font-bold text-zinc-900">D</span>
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
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            className="bg-white border-zinc-200 text-zinc-900 rounded-full"
            disabled={isSending}
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
    <Card className="bg-white/[0.03] border-white/10 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between font-display text-lg">
          <span className="flex items-center gap-2">
            <Building2 className="size-4 text-amber-300" />
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
                  ? "border-amber-300/40 bg-amber-300/[0.06]"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className="text-sm font-medium flex items-center gap-2">
                {c.customerName ?? "Unknown"}
                {c.escalated === 1 && (
                  <AlertTriangle className="size-3 text-rose-400" />
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

        <Separator className="bg-white/5" />

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
                        <div className={`text-[10px] uppercase tracking-widest mb-1 ${isCustomer ? "text-muted-foreground" : "text-sky-300/80 text-right"}`}>
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
                              ? "rounded-2xl rounded-bl-md bg-zinc-700/60 text-zinc-100 px-3.5 py-2 text-sm whitespace-pre-wrap"
                              : "rounded-2xl rounded-br-md bg-blue-500 text-white px-3.5 py-2 text-sm whitespace-pre-wrap"
                          }
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
              Try the <span className="text-amber-300">{activeScenario.label}</span> scenario above.
            </p>
          </div>
        )}
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
    <Card className="bg-white/[0.03] border-white/10">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-lg">
          <Sparkles className="size-4 text-amber-300" />
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
    <div className={`rounded-lg border border-white/8 bg-white/[0.02] p-3 ${pending ? "animate-pulse" : ""}`}>
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
          <pre className="text-[10px] mt-1.5 p-2 rounded bg-black/30 text-foreground/70 overflow-auto max-h-40">
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
    <Card className="bg-rose-500/[0.03] border-rose-500/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-lg text-rose-200">
          <AlertTriangle className="size-4" />
          Critical Handoff
        </CardTitle>
        <p className="text-xs text-rose-300/70">
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
              <div key={e.id} className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
                <div className="flex items-center justify-between mb-1">
                  <Badge className="bg-rose-500/20 text-rose-200 border-rose-500/30">
                    {e.severity.toUpperCase()}
                  </Badge>
                  <span className="text-[10px] text-rose-300/70">
                    {format(new Date(e.createdAt), "MMM d · HH:mm")}
                  </span>
                </div>
                <p className="text-sm text-rose-100/90">{e.reason}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] text-rose-300/70">Conversation #{e.conversationId}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="bg-rose-500/10 border-rose-500/30 text-rose-100 hover:bg-rose-500/20"
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
 * Human-in-the-Loop & RAG components
 * ============================================================ */

function PendingDraftsBadge() {
  const pending = trpc.drafts.listPending.useQuery(undefined, {
    refetchInterval: 2500,
  });
  const count = pending.data?.length ?? 0;
  if (count === 0) return null;
  return (
    <Badge className="ml-2 bg-amber-300/20 text-amber-200 border-amber-300/30">
      {count}
    </Badge>
  );
}

function ApprovalQueue() {
  const utils = trpc.useUtils();
  const pending = trpc.drafts.listPending.useQuery(undefined, {
    refetchInterval: 2500,
  });
  const conversations = trpc.conversations.list.useQuery();

  const [rejectDraftId, setRejectDraftId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectCategory, setRejectCategory] = useState<RejectCategory>("tone_too_formal");

  const approve = trpc.drafts.approve.useMutation({
    onSuccess: () => {
      toast.success("Reply approved & sent");
      utils.drafts.listPending.invalidate();
      utils.conversations.list.invalidate();
      utils.conversations.messages.invalidate();
      utils.conversations.logs.invalidate();
      utils.rag.styleExamples.invalidate();
    },
    onError: (err) => toast.error("Approve failed", { description: err.message }),
  });

  const reject = trpc.drafts.reject.useMutation({
    onSuccess: () => {
      toast.success("Draft rejected — regenerating with feedback");
      setRejectDraftId(null);
      setRejectReason("");
      setRejectCategory("tone_too_formal");
      utils.drafts.listPending.invalidate();
      utils.conversations.logs.invalidate();
      utils.rag.rejections.invalidate();
    },
    onError: (err) => toast.error("Reject failed", { description: err.message }),
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
    <Card className="bg-white/[0.03] border-white/10">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-lg">
          <ThumbsDown className="size-4 text-amber-300 rotate-180" />
          Approval Queue
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          AI drafts await your <span className="text-emerald-300">Approve</span> or <span className="text-rose-300">Reject</span>. Rejections teach the model.
        </p>
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
                    className="rounded-lg border border-amber-300/20 bg-amber-300/[0.04] p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${intentTone(d.intent)}`}
                        >
                          {d.intent}
                        </Badge>
                        {d.revision && d.revision > 1 && (
                          <Badge variant="outline" className="text-[10px] bg-white/5 border-white/10 text-muted-foreground">
                            rev {d.revision}
                          </Badge>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {format(new Date(d.createdAt), "HH:mm:ss")}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mb-1">
                      To: <span className="text-foreground/80">{conv?.customerName ?? "Unknown"}</span>
                      <span className="ml-2 tabular-nums">{conv?.phone}</span>
                    </div>
                    <div className="rounded-md bg-black/20 border border-white/5 p-2.5 text-sm text-foreground/90 whitespace-pre-wrap">
                      {d.body}
                    </div>

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
                            <SelectTrigger className="mt-1 bg-white/[0.03] border-white/10 text-sm">
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
                          className="bg-white/[0.03] border-white/10 text-sm min-h-[72px]"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            className="bg-rose-500/20 text-rose-100 border-rose-500/30 hover:bg-rose-500/30 border"
                            disabled={
                              reject.isPending ||
                              (rejectCategory === "other" && !rejectReason.trim())
                            }
                            onClick={() =>
                              reject.mutate({
                                draftId: d.id,
                                category: rejectCategory,
                                reason:
                                  rejectReason.trim() ||
                                  REJECT_CATEGORY_LABELS[rejectCategory],
                              })
                            }
                          >
                            {reject.isPending ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <ThumbsDown className="size-3.5 mr-1" />}
                            Reject & teach
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="bg-white/[0.03] border-white/10"
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
                          className="bg-emerald-500/20 text-emerald-100 border-emerald-500/30 hover:bg-emerald-500/30 border"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate({ draftId: d.id })}
                        >
                          {approve.isPending ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Check className="size-3.5 mr-1" />}
                          Approve & send
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="bg-white/[0.03] border-white/10 hover:border-rose-400/30 hover:bg-rose-500/10"
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

function RagMemoryPanel() {
  const styleExamples = trpc.rag.styleExamples.useQuery();
  const rejections = trpc.rag.rejections.useQuery();
  const knowledge = trpc.rag.knowledge.useQuery();

  return (
    <Card className="bg-white/[0.03] border-white/10">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-lg">
          <Sparkles className="size-4 text-amber-300" />
          RAG Memory — 3 Tiers
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Knowledge · Approved replies · Rejection lessons. These are retrieved & injected into every new draft.
        </p>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="style">
          <TabsList className="bg-white/[0.04] border border-white/10">
            <TabsTrigger value="style">
              Approved
              <Badge className="ml-2 bg-emerald-500/20 text-emerald-200 border-emerald-500/30">
                {styleExamples.data?.length ?? 0}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="rejections">
              Rejections
              <Badge className="ml-2 bg-rose-500/20 text-rose-200 border-rose-500/30">
                {rejections.data?.length ?? 0}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="knowledge">
              Knowledge
              <Badge className="ml-2 bg-sky-500/20 text-sky-200 border-sky-500/30">
                {knowledge.data?.length ?? 0}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="style" className="mt-3">
            <ScrollArea className="h-[480px] pr-2">
              {(styleExamples.data ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-12">
                  No approved replies yet. Approve a draft and it appears here.
                </div>
              ) : (
                <div className="space-y-3">
                  {(styleExamples.data ?? []).map((ex) => (
                    <div key={ex.id} className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.04] p-3 space-y-2">
                      <Badge variant="outline" className={`text-[10px] ${intentTone(ex.intent)}`}>{ex.intent}</Badge>
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Customer</div>
                      <div className="text-sm text-foreground/90">{ex.customerBody}</div>
                      <div className="text-[10px] uppercase tracking-widest text-emerald-300/80">Approved DropShop reply</div>
                      <div className="text-sm text-foreground/90 whitespace-pre-wrap">{ex.approvedReply}</div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="rejections" className="mt-3">
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
                      <div key={r.id} className="rounded-lg border border-rose-500/15 bg-rose-500/[0.04] p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className={`text-[10px] ${intentTone(r.intent)}`}>{r.intent}</Badge>
                          {cat && (
                            <Badge variant="outline" className="text-[10px] bg-rose-500/10 text-rose-200 border-rose-500/30">
                              {REJECT_CATEGORY_LABELS[cat] ?? cat}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Customer</div>
                        <div className="text-sm text-foreground/90">{r.customerBody}</div>
                        <div className="text-[10px] uppercase tracking-widest text-rose-300/80">Rejected draft</div>
                        <div className="text-sm text-foreground/90 whitespace-pre-wrap line-through opacity-60">{r.rejectedReply}</div>
                        <div className="text-[10px] uppercase tracking-widest text-amber-300/80">Manager reason</div>
                        <div className="text-sm text-amber-100/90">{r.reason}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="knowledge" className="mt-3">
            <ScrollArea className="h-[480px] pr-2">
              <div className="space-y-3">
                {(knowledge.data ?? []).map((k) => (
                  <div key={k.id} className="rounded-lg border border-sky-500/15 bg-sky-500/[0.04] p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] bg-sky-500/10 text-sky-200 border-sky-500/30">
                        {k.topic}
                      </Badge>
                      <div className="text-sm font-medium">{k.title}</div>
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
    <div className="rounded-lg border border-amber-300/15 bg-gradient-to-br from-amber-300/[0.06] to-transparent p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-amber-200/90">
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
              <div className="text-xs w-32 shrink-0 text-foreground/80">
                {label}
              </div>
              <div className="flex-1 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full bg-amber-300/70"
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


function ResetDemoButton() {
  const utils = trpc.useUtils();
  const reset = trpc.demo.reset.useMutation({
    onSuccess: () => {
      utils.conversations.list.invalidate();
      utils.conversations.messages.invalidate();
      utils.drafts.listPending.invalidate();
      utils.rag.styleExamples.invalidate();
      utils.rag.rejections.invalidate();
      utils.escalations.list.invalidate();
      toast.success("Demo reset — all conversations cleared");
    },
    onError: (e) => toast.error(`Reset failed: ${e.message}`),
  });

  return (
    <Button
      variant="outline"
      size="sm"
      className="bg-white/[0.04] border-white/10 hover:bg-white/[0.08]"
      onClick={() => {
        if (confirm("Reset demo? This will delete all conversations, drafts, rejections, and AI logs. (Knowledge base is preserved.)")) {
          reset.mutate();
        }
      }}
      disabled={reset.isPending}
    >
      <RotateCcw className="size-4 mr-1.5" />
      {reset.isPending ? "Resetting…" : "Reset demo"}
    </Button>
  );
}
