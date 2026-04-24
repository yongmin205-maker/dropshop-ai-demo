import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { PRESET_SCENARIOS, type PresetScenario } from "@shared/scenarios";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  CircleDot,
  Loader2,
  Phone,
  Send,
  Sparkles,
  Wifi,
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
        <div className="max-w-[1600px] mx-auto px-6 py-5 flex items-center justify-between">
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
          <div className="flex items-center gap-3">
            <LiveModeBadge live={!!config.data?.liveMode} phone={config.data?.twilioPhone ?? null} />
            <Button variant="outline" size="sm" className="bg-white/[0.04] border-white/10 hover:bg-white/[0.08]">
              <ArrowUpRight className="size-4 mr-1.5" />
              Pitch deck
            </Button>
          </div>
        </div>
      </header>

      {/* Preset scenarios bar */}
      <div className="border-b border-white/5 bg-white/[0.015]">
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center gap-3 overflow-x-auto">
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

      {/* Split-screen workspace */}
      <main className="max-w-[1600px] mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Customer phone simulator */}
        <section className="lg:col-span-3">
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
        <section className="lg:col-span-5 space-y-4">
          <StoreInbox
            conversations={conversations.data ?? []}
            activeId={activeConvId}
            onSelect={setActiveConvId}
            messages={sortedMessages}
            activeScenario={activeScenario}
          />
        </section>

        {/* Right: AI log + escalations */}
        <section className="lg:col-span-4 space-y-4">
          <Tabs defaultValue="log">
            <TabsList className="bg-white/[0.04] border border-white/10">
              <TabsTrigger value="log">AI Processing Log</TabsTrigger>
              <TabsTrigger value="escalations">
                Critical Handoff
                {(escalations.data?.length ?? 0) > 0 && (
                  <Badge className="ml-2 bg-rose-500/20 text-rose-300 border-rose-500/30">
                    {escalations.data?.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
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
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === "inbound" ? "justify-start" : "justify-end"}`}>
                    <div className="max-w-[78%]">
                      <div className={`text-[10px] uppercase tracking-widest mb-1 ${m.direction === "inbound" ? "text-muted-foreground" : "text-amber-300/80 text-right"}`}>
                        {m.direction === "inbound" ? "Customer" : m.sender === "ai" ? "DropShop AI" : "Manager"}
                        {m.intent && (
                          <span className={`ml-2 inline-block px-1.5 py-0.5 rounded border text-[9px] ${intentTone(m.intent)}`}>
                            {m.intent}
                          </span>
                        )}
                      </div>
                      <div className={m.direction === "inbound" ? "bubble-customer whitespace-pre-wrap" : "bubble-business whitespace-pre-wrap"}>
                        {m.body}
                      </div>
                      <div className={`text-[10px] text-muted-foreground mt-1 ${m.direction === "inbound" ? "" : "text-right"}`}>
                        {format(new Date(m.createdAt), "HH:mm:ss")}
                      </div>
                    </div>
                  </div>
                ))}
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
