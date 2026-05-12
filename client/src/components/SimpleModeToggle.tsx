/**
 * SimpleModeToggle — segmented control to flip between Simple and Full UI.
 *
 * Lives in the header. Visually de-emphasized (small, neutral) because the
 * friend's feedback was "hide unnecessary things"; a flashy toggle would
 * itself feel like another unnecessary thing. The control is large enough
 * to tap (44 × ~28 px container, 44 × 44 px effective hit target via the
 * surrounding padding) per Apple HIG guidance recorded in
 * docs/PHASE22_DECISIONS.md §Q1.
 *
 * Two segments, never a third — the only meaningful states for the operator
 * are "show me the work" (Simple) and "show me everything" (Full).
 */

import type { UiMode } from "@/hooks/useSimpleMode";

export function SimpleModeToggle({
  mode,
  onChange,
}: {
  mode: UiMode;
  onChange: (m: UiMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="UI density"
      className="inline-flex items-center rounded-full border border-border bg-secondary p-0.5 text-xs"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "simple"}
        onClick={() => onChange("simple")}
        className={`min-h-[28px] px-3 rounded-full font-medium tracking-wide transition-colors ${
          mode === "simple"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        Simple
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "full"}
        onClick={() => onChange("full")}
        className={`min-h-[28px] px-3 rounded-full font-medium tracking-wide transition-colors ${
          mode === "full"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        Full
      </button>
    </div>
  );
}
