import { useSyncExternalStore } from "react";

/**
 * Returns the desired tRPC `refetchInterval` only while the document is
 * visible *and* focused. When the user switches tabs, minimizes the window,
 * or focuses another app the hook returns `false`, which tells React Query
 * to pause polling entirely. (§4.1 in CODE_AUDIT)
 *
 * Why a custom hook instead of `staleTime`:
 *   • staleTime gates *fetches initiated by the query system*, but background
 *     intervals still fire — so a forgotten dashboard tab open overnight can
 *     burn hundreds of API calls / LLM tokens.
 *   • This hook flips the interval to `false` when the tab is hidden, which
 *     is the documented React Query way to suspend polling without unmounting
 *     the query (resumes immediately on focus, no flicker).
 *
 * Reused by Home.tsx (DropShop dashboard) and Salon.tsx (Quo Salon dashboard)
 * — keeping it in one place prevents the two pages from drifting in their
 * polling behavior.
 */
export function useVisiblePollInterval(activeMs: number): number | false {
  const isVisible = useSyncExternalStore(
    (cb) => {
      const handler = () => cb();
      document.addEventListener("visibilitychange", handler);
      window.addEventListener("focus", handler);
      window.addEventListener("blur", handler);
      return () => {
        document.removeEventListener("visibilitychange", handler);
        window.removeEventListener("focus", handler);
        window.removeEventListener("blur", handler);
      };
    },
    () => (typeof document !== "undefined" ? !document.hidden : true),
    () => true,
  );
  return isVisible ? activeMs : false;
}
