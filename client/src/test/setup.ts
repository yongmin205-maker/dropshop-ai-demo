/**
 * Vitest jsdom setup — runs once per worker before any client test.
 *
 * Pulls in `@testing-library/jest-dom` so component tests can assert on
 * DOM-specific matchers (`toBeInTheDocument`, `toHaveClass`, etc.). Also
 * defines lightweight stand-ins for browser APIs that jsdom doesn't ship
 * but that some Radix UI primitives reach for during render.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// React Testing Library only auto-cleans when vitest sees `globals: true`
// AND the runner detects an auto-cleanup test framework. Wiring it manually
// keeps it explicit so leakage between tests can never resurface.
afterEach(() => cleanup());

// matchMedia: Radix theme/dialog primitives query it on mount.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}

// ResizeObserver: jsdom doesn't implement it; Radix Select / ScrollArea use it.
if (typeof window !== "undefined" && !(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
}
