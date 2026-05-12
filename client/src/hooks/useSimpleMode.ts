/**
 * useSimpleMode — UI density toggle for the DropShop dashboard.
 *
 * Per ADR 0009 + Phase 22 decisions (docs/PHASE22_DECISIONS.md §Q1):
 *  - Default is **Simple** (matches the friend's verbatim feedback that
 *    "다른앱들 필요없는것들이 너무 많아").
 *  - End target is a native iOS/Android app, so Simple mode is designed
 *    mobile-first and is intentionally the default even on desktop.
 *  - Toggle state persists across reloads via localStorage so the owner
 *    doesn't have to re-flip it every visit.
 *  - SSR-safe: server-side first render returns the default ("simple"); we
 *    hydrate to the stored preference inside an effect.
 *
 * Why a hook instead of context: there is exactly one consumer (Home.tsx).
 * Lifting to context would make the implementation testable in isolation
 * without buying us anything, so we keep it as a leaf hook for now.
 */

import { useEffect, useState } from "react";

export type UiMode = "simple" | "full";

const STORAGE_KEY = "dropshop.uiMode.v1";
const DEFAULT: UiMode = "simple";

function readStored(): UiMode {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "simple" || v === "full") return v;
  } catch {
    // Private-browsing / disabled-storage — fall through to default.
  }
  return DEFAULT;
}

export function useSimpleMode(): {
  mode: UiMode;
  isSimple: boolean;
  setMode: (m: UiMode) => void;
  toggle: () => void;
} {
  // Lazy initializer keeps the first render synchronous-ish; if window
  // exists at mount we already read the stored value, otherwise we use the
  // default and the useEffect below upgrades us once we are in the browser.
  const [mode, setModeState] = useState<UiMode>(() => readStored());

  // Reconcile after hydration in case the lazy init ran before window was
  // available (Vite SSR or test environments).
  useEffect(() => {
    const stored = readStored();
    if (stored !== mode) setModeState(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMode = (m: UiMode) => {
    setModeState(m);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, m);
      } catch {
        // Storage might be unavailable; in-memory state still works for the
        // session, which is acceptable degradation.
      }
    }
  };

  const toggle = () => setMode(mode === "simple" ? "full" : "simple");

  return { mode, isSimple: mode === "simple", setMode, toggle };
}
