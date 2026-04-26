import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { SALON_PRESET_SCENARIOS, type SalonPresetScenario } from "@shared/salonScenarios";
import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  Check,
  Clock3,
  Loader2,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

/* ============================================================
 * Pilot 2 — Salon AI demo page
 * ------------------------------------------------------------
 * Three-column layout (mirrors the laundromat shell):
 *   left   = phone simulator (customer POV iMessage bubbles)
 *   center = StoreInbox + CalendarTimeline (mini week view)
 *   right  = Approval Queue (Approve / Reject)
 *
 * Conversation state is local to the page (no DB persistence)
 * — the salon demo is meant to be reset by refresh.
 * ============================================================ */

const OPEN_MINUTE = 10 * 60;
const CLOSE_MINUTE = 20 * 60;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

type SalonIntent =
  | "Booking Request"
  | "Availability Check"
  | "Reschedule"
  | "Cancel"
  | "Service Question"
  | "Pricing"
  | "Critical Escalation";

interface CustomerTurn {
  id: string;
  role: "customer" | "salon";
  body: string;
  intent?: SalonIntent | null;
  escalated?: boolean;
  escalationReason?: string;
  overlapSlots?: Array<{
    stylistName: string;
    dayIndex: number;
    startMinute: number;
    durationMinutes: number;
    hostServiceCategory: string;
  }>;
  approved?: boolean;
  rejected?: boolean;
  ts: number;
}

function formatMin(m: number) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm.toString().padStart(2, "0")} ${suffix}`;
}

function intentTone(intent?: SalonIntent | null) {
  switch (intent) {
    case "Critical Escalation":
      return "salon-pill--terra";
    case "Booking Request":
      return "";
    case "Reschedule":
    case "Cancel":
      return "salon-pill--ink";
    default:
      return "salon-pill--ink";
  }
}

function bubbleClasses(role: "customer" | "salon") {
  // Customer POV (iPhone): customer = right (sage), salon = left (white)
  if (role === "customer") {
    return "ml-auto bg-[var(--salon-sage)] text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm max-w-[80%]";
  }
  return "mr-auto bg-white border border-[var(--salon-line)] text-[var(--salon-ink)] rounded-2xl rounded-bl-sm px-3 py-2 text-sm max-w-[80%] shadow-sm";
}

/* ----- Calendar Timeline (mini week visualization) ----- */

interface TimelineProps {
  appointments: Array<{
    id: string;
    stylistId: string;
    stylistName: string;
    serviceCategory: string;
    serviceName: string;
    dayIndex: number;
    startMinute: number;
    totalMinutes: number;
    processingMinutes: number;
    status: string;
  }>;
  overlapSlots: Array<{
    stylistName: string;
    dayIndex: number;
    startMinute: number;
    durationMinutes: number;
    hostServiceCategory: string;
  }>;
}

function CalendarTimeline({ appointments, overlapSlots }: TimelineProps) {
  const totalMinutes = CLOSE_MINUTE - OPEN_MINUTE; // 600
  // For each day, render a horizontal bar 10am→8pm with appointments stacked.
  const byDay: Record<number, TimelineProps["appointments"]> = {};
  for (let i = 0; i < 7; i++) byDay[i] = [];
  for (const a of appointments) byDay[a.dayIndex]?.push(a);

  const overlapsByDay: Record<number, TimelineProps["overlapSlots"]> = {};
  for (let i = 0; i < 7; i++) overlapsByDay[i] = [];
  for (const s of overlapSlots) overlapsByDay[s.dayIndex]?.push(s);

  // Hour ticks every 2 hours
  const ticks = [0, 2, 4, 6, 8, 10].map((h) => OPEN_MINUTE + h * 60);

  function leftPct(min: number) {
    return ((min - OPEN_MINUTE) / totalMinutes) * 100;
  }
  function widthPct(dur: number) {
    return (dur / totalMinutes) * 100;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-[var(--salon-ink-soft)]">
        <span>10 AM</span>
        <div className="flex-1 relative h-0">
          {ticks.slice(1, -1).map((t, i) => (
            <span
              key={i}
              className="absolute top-0"
              style={{ left: `${leftPct(t)}%` }}
            >
              {formatMin(t).replace(":00 ", " ")}
            </span>
          ))}
        </div>
        <span>8 PM</span>
      </div>
      <div className="space-y-1.5">
        {DAYS.map((day, dayIdx) => {
          const dayAppts = byDay[dayIdx] ?? [];
          const dayOverlaps = overlapsByDay[dayIdx] ?? [];
          return (
            <div key={day} className="flex items-center gap-2">
              <div className="w-9 text-xs font-medium text-[var(--salon-ink-soft)]">
                {day}
              </div>
              <div className="flex-1 relative h-9 rounded-md bg-[var(--salon-surface-2)] overflow-hidden">
                {/* hour grid */}
                {ticks.map((t, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 w-px bg-[var(--salon-line)]"
                    style={{ left: `${leftPct(t)}%` }}
                  />
                ))}
                {dayAppts.map((a) => {
                  const activeMinutes = a.totalMinutes - a.processingMinutes;
                  const halfActive = activeMinutes / 2;
                  return (
                    <div
                      key={a.id}
                      className="absolute top-0.5 bottom-0.5 rounded-[6px] flex items-center text-[10px] font-medium"
                      style={{
                        left: `${leftPct(a.startMinute)}%`,
                        width: `${widthPct(a.totalMinutes)}%`,
                        background:
                          a.status === "tentative"
                            ? "color-mix(in oklab, var(--salon-terracotta) 22%, white)"
                            : "color-mix(in oklab, var(--salon-sage) 28%, white)",
                        color: "var(--salon-ink)",
                        border: "1px solid color-mix(in oklab, var(--salon-sage) 45%, white)",
                      }}
                      title={`${a.stylistName} · ${a.serviceName} (${formatMin(a.startMinute)}–${formatMin(a.startMinute + a.totalMinutes)})`}
                    >
                      {/* processing inset (lighter band in middle) */}
                      {a.processingMinutes > 0 && (
                        <div
                          className="absolute top-1 bottom-1 rounded-[3px]"
                          style={{
                            left: `${(halfActive / a.totalMinutes) * 100}%`,
                            width: `${(a.processingMinutes / a.totalMinutes) * 100}%`,
                            background: "rgba(255,255,255,0.6)",
                            border: "1px dashed color-mix(in oklab, var(--salon-sage) 50%, white)",
                          }}
                        />
                      )}
                      <span className="relative px-1.5 truncate">
                        {a.stylistName.split(" ")[0]} · {a.serviceCategory}
                      </span>
                    </div>
                  );
                })}
                {/* overlap candidate slots — dashed terracotta */}
                {dayOverlaps.map((s, i) => (
                  <div
                    key={i}
                    className="absolute top-1.5 bottom-1.5 rounded-[5px] pointer-events-none"
                    style={{
                      left: `${leftPct(s.startMinute)}%`,
                      width: `${widthPct(s.durationMinutes)}%`,
                      background: "color-mix(in oklab, var(--salon-terracotta) 18%, white)",
                      border: "2px dashed var(--salon-terracotta)",
                    }}
                    title={`Overlap candidate: ${s.stylistName} ${formatMin(s.startMinute)}–${formatMin(s.startMinute + s.durationMinutes)} (host: ${s.hostServiceCategory} processing)`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-[var(--salon-ink-soft)]">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-3 rounded-sm"
            style={{
              background: "color-mix(in oklab, var(--salon-sage) 28%, white)",
              border: "1px solid color-mix(in oklab, var(--salon-sage) 45%, white)",
            }}
          />
          Confirmed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-3 rounded-sm"
            style={{
              background: "color-mix(in oklab, var(--salon-terracotta) 22%, white)",
              border: "1px solid color-mix(in oklab, var(--salon-terracotta) 45%, white)",
            }}
          />
          Tentative
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-3 rounded-sm border-2 border-dashed"
            style={{
              background: "color-mix(in oklab, var(--salon-terracotta) 18%, white)",
              borderColor: "var(--salon-terracotta)",
            }}
          />
          Overlap candidate (in processing window)
        </span>
      </div>
    </div>
  );
}

/* ----- Main page ----- */

export default function Salon() {
  const calendarQuery = trpc.salon.listAppointments.useQuery();
  const draftMutation = trpc.salon.draft.useMutation();

  const [persona, setPersona] = useState<SalonPresetScenario>(
    SALON_PRESET_SCENARIOS[0],
  );
  const [composer, setComposer] = useState("");
  const [turns, setTurns] = useState<CustomerTurn[]>([]);
  const lastOverlapRef = useRef<CustomerTurn | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript to the bottom on new turn.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Surface overlap slots from the latest pending salon turn so the
  // CalendarTimeline highlights them.
  const overlapSlots = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "salon" && t.overlapSlots && t.overlapSlots.length > 0 && !t.rejected) {
        lastOverlapRef.current = t;
        return t.overlapSlots;
      }
    }
    return [] as CustomerTurn["overlapSlots"];
  }, [turns]);

  async function sendCustomerTurn(body: string) {
    if (!body.trim()) return;
    const customerTurn: CustomerTurn = {
      id: crypto.randomUUID(),
      role: "customer",
      body,
      ts: Date.now(),
    };
    setTurns((prev) => [...prev, customerTurn]);
    setComposer("");
    try {
      const res = await draftMutation.mutateAsync({
        phone: persona.customerPhone,
        body,
      });
      const salonTurn: CustomerTurn = {
        id: crypto.randomUUID(),
        role: "salon",
        body: res.reply ?? "(escalated — no draft generated)",
        intent: res.intent as SalonIntent,
        escalated: res.escalated,
        escalationReason: res.escalationReason,
        overlapSlots: res.overlapSlots,
        ts: Date.now(),
      };
      setTurns((prev) => [...prev, salonTurn]);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Salon draft generation failed",
      );
    }
  }

  function approve(turnId: string) {
    setTurns((prev) =>
      prev.map((t) => (t.id === turnId ? { ...t, approved: true } : t)),
    );
    toast.success("Draft approved (simulator — no SMS sent)");
  }

  function reject(turnId: string) {
    setTurns((prev) =>
      prev.map((t) => (t.id === turnId ? { ...t, rejected: true } : t)),
    );
    toast("Draft rejected — operator would regenerate or write manually.");
  }

  function reset() {
    setTurns([]);
    setComposer("");
  }

  const pendingApprovals = turns.filter(
    (t) => t.role === "salon" && !t.approved && !t.rejected && !t.escalated,
  );
  const escalations = turns.filter((t) => t.role === "salon" && t.escalated);

  return (
    <div className="salon-theme min-h-screen">
      {/* Header */}
      <header className="border-b border-[var(--salon-line)] bg-[var(--salon-surface)]">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-[var(--salon-sage)] flex items-center justify-center text-white font-semibold">
              S
            </div>
            <div>
              <div className="salon-display text-lg font-semibold leading-tight">
                Salon AI Concierge
              </div>
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--salon-ink-soft)]">
                AI SMS · Pilot 2 · DEMO
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Industry switcher */}
            <Link href="/">
              <a className="inline-flex items-center gap-1.5 rounded-full border border-[var(--salon-line)] bg-[var(--salon-surface)] px-3 py-1.5 text-xs font-medium text-[var(--salon-ink-soft)] hover:bg-[var(--salon-surface-2)]">
                <ArrowLeftRight className="size-3.5" />
                Switch to Laundromat
              </a>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={reset}
              className="bg-[var(--salon-surface)] border-[var(--salon-line)] text-[var(--salon-ink)] hover:bg-[var(--salon-surface-2)]"
            >
              Reset demo
            </Button>
          </div>
        </div>
        {/* Preset scenarios */}
        <div className="container pb-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--salon-ink-soft)] mr-1">
            Demo scenarios
          </span>
          {SALON_PRESET_SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setPersona(s);
                setComposer(s.body);
              }}
              className={`salon-pill ${s.tone === "rose" ? "salon-pill--terra" : s.tone === "terracotta" ? "salon-pill--terra" : s.tone === "ink" ? "salon-pill--ink" : ""} hover:opacity-80 cursor-pointer`}
              title={s.caption}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {s.label}
            </button>
          ))}
        </div>
      </header>

      <main className="container py-6 grid grid-cols-1 lg:grid-cols-[320px_1fr_360px] gap-6">
        {/* LEFT — Phone simulator */}
        <section className="salon-panel p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--salon-ink-soft)]">
                Texting as
              </div>
              <div className="font-medium text-sm">{persona.customerName}</div>
              <div className="text-[11px] text-[var(--salon-ink-soft)]">
                {persona.customerPhone}
              </div>
            </div>
            <div className="size-9 rounded-full bg-[var(--salon-sage)] flex items-center justify-center text-white text-xs font-semibold">
              {persona.customerName.split(" ").map((p) => p[0]).slice(0, 2).join("")}
            </div>
          </div>
          <div
            ref={transcriptRef}
            className="flex-1 min-h-[420px] rounded-lg bg-[var(--salon-surface-2)] p-3 space-y-2 overflow-auto"
          >
            {turns.length === 0 && (
              <div className="text-xs text-[var(--salon-ink-soft)] text-center py-6">
                Pick a scenario above or type a message below to start.
              </div>
            )}
            {turns.map((t) => (
              <div key={t.id} className={bubbleClasses(t.role)}>
                {t.body}
              </div>
            ))}
            {draftMutation.isPending && (
              <div className={bubbleClasses("salon")}>
                <Loader2 className="size-3.5 inline animate-spin mr-1" />
                drafting…
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Textarea
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder="Type as the customer…"
              className="min-h-[60px] bg-white border-[var(--salon-line)] text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  sendCustomerTurn(composer);
                }
              }}
            />
            <Button
              onClick={() => sendCustomerTurn(composer)}
              disabled={!composer.trim() || draftMutation.isPending}
              className="bg-[var(--salon-sage)] hover:bg-[var(--salon-sage)]/90 text-white"
            >
              {draftMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>
        </section>

        {/* CENTER — Calendar + Inbox */}
        <section className="space-y-6">
          <div className="salon-panel p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--salon-ink-soft)]">
                  Live week
                </div>
                <h2 className="salon-display text-lg font-semibold">
                  Calendar
                </h2>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[var(--salon-ink-soft)]">
                <Clock3 className="size-3.5" />
                {calendarQuery.data
                  ? `${calendarQuery.data.appointments.length} appts · ${calendarQuery.data.stylists.length} stylists`
                  : "Loading…"}
              </div>
            </div>
            {calendarQuery.data ? (
              <CalendarTimeline
                appointments={calendarQuery.data.appointments}
                overlapSlots={overlapSlots ?? []}
              />
            ) : (
              <div className="h-32 rounded-md bg-[var(--salon-surface-2)] animate-pulse" />
            )}
          </div>

          <div className="salon-panel p-4">
            <div className="flex items-center gap-2 mb-3">
              <Building2 className="size-4 text-[var(--salon-sage)]" />
              <h2 className="salon-display text-lg font-semibold">
                Store inbox (operator POV)
              </h2>
              <span className="text-xs text-[var(--salon-ink-soft)] ml-auto">
                {turns.length} turn{turns.length === 1 ? "" : "s"}
              </span>
            </div>
            <ScrollArea className="h-[340px] pr-2">
              <div className="space-y-2">
                {turns.length === 0 && (
                  <div className="text-xs text-[var(--salon-ink-soft)] py-8 text-center">
                    Customer messages and AI drafts will appear here.
                  </div>
                )}
                {turns.map((t) => (
                  <div
                    key={t.id}
                    className={`flex ${t.role === "customer" ? "" : "flex-row-reverse"} gap-2`}
                  >
                    <div
                      className={`flex-1 max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                        t.role === "customer"
                          ? "bg-[var(--salon-surface-2)] border border-[var(--salon-line)]"
                          : t.escalated
                          ? "bg-[var(--salon-terracotta-soft)] border border-[var(--salon-terracotta)]/40"
                          : "bg-[var(--salon-sage)] text-white"
                      }`}
                    >
                      {t.intent && (
                        <div className="mb-1">
                          <span className={`salon-pill ${intentTone(t.intent)}`}>
                            {t.intent}
                          </span>
                        </div>
                      )}
                      <div className="whitespace-pre-wrap leading-snug">{t.body}</div>
                      {t.escalated && t.escalationReason && (
                        <div className="mt-1 text-[11px] text-[var(--salon-terracotta)] flex items-center gap-1">
                          <AlertTriangle className="size-3" />
                          {t.escalationReason}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </section>

        {/* RIGHT — Approval queue */}
        <section className="space-y-6">
          <div className="salon-panel p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="size-4 text-[var(--salon-sage)]" />
              <h2 className="salon-display text-lg font-semibold">
                Approval queue
              </h2>
              <span className="ml-auto salon-pill">
                {pendingApprovals.length} pending
              </span>
            </div>
            {pendingApprovals.length === 0 ? (
              <div className="text-xs text-[var(--salon-ink-soft)] py-6 text-center">
                No drafts awaiting approval.
              </div>
            ) : (
              <div className="space-y-3">
                {pendingApprovals.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-xl border border-[var(--salon-line)] bg-white p-3"
                  >
                    {t.intent && (
                      <span className={`salon-pill ${intentTone(t.intent)} mb-2`}>
                        {t.intent}
                      </span>
                    )}
                    <div className="text-sm leading-snug whitespace-pre-wrap mt-1">
                      {t.body}
                    </div>
                    {t.overlapSlots && t.overlapSlots.length > 0 && (
                      <div className="mt-2 rounded-lg bg-[var(--salon-terracotta-soft)] border border-[var(--salon-terracotta)]/30 p-2 text-[11px] text-[var(--salon-ink)]">
                        <div className="font-medium text-[var(--salon-terracotta)] mb-1">
                          Overlap candidates surfaced
                        </div>
                        <ul className="space-y-0.5">
                          {t.overlapSlots.slice(0, 3).map((s, i) => (
                            <li key={i}>
                              · {DAYS[s.dayIndex]} {formatMin(s.startMinute)}–
                              {formatMin(s.startMinute + s.durationMinutes)} ·{" "}
                              {s.stylistName} ({s.hostServiceCategory} processing)
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="flex gap-2 mt-3">
                      <Button
                        size="sm"
                        onClick={() => approve(t.id)}
                        className="bg-[var(--salon-sage)] hover:bg-[var(--salon-sage)]/90 text-white"
                      >
                        <Check className="size-3.5 mr-1" />
                        Approve & send
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => reject(t.id)}
                        className="bg-white border-[var(--salon-line)] text-[var(--salon-ink-soft)] hover:bg-[var(--salon-surface-2)]"
                      >
                        <X className="size-3.5 mr-1" />
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {escalations.length > 0 && (
            <div className="salon-panel p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="size-4 text-[var(--salon-terracotta)]" />
                <h2 className="salon-display text-lg font-semibold">
                  Critical escalations
                </h2>
                <span className="ml-auto salon-pill salon-pill--terra">
                  {escalations.length}
                </span>
              </div>
              <div className="space-y-2">
                {escalations.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-lg border border-[var(--salon-terracotta)]/40 bg-[var(--salon-terracotta-soft)] p-3 text-sm"
                  >
                    <div className="text-xs uppercase tracking-wide text-[var(--salon-terracotta)] mb-1">
                      Manager paged
                    </div>
                    <div className="text-[var(--salon-ink)]">
                      {t.escalationReason ?? "Critical message detected."}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
