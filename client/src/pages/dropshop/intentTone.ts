/**
 * Tailwind utility classes for an intent badge (color + bg + border).
 *
 * Extracted from Home.tsx so the Approval Queue, RAG Memory, Errors panel,
 * and any future UI that wants to render an intent label don't drift on the
 * color palette. Keeping it as a pure function (string in → classes out)
 * means it stays trivially testable.
 */
export function intentTone(intent: string | null | undefined): string {
  switch (intent) {
    case "Critical Escalation":
      return "bg-rose-50 text-rose-700 border-rose-200";
    case "Pickup Request":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "ETA/Order Status":
      return "bg-sky-50 text-sky-700 border-sky-200";
    case "Alteration Quote":
      return "bg-violet-50 text-violet-700 border-violet-200";
    case "Membership & Pricing":
      return "bg-amber-50 text-amber-700 border-amber-200";
    default:
      return "bg-secondary text-muted-foreground border-border";
  }
}
