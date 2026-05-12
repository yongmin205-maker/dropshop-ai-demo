/**
 * useSimpleMode — hermetic tests.
 *
 * The hook has four behaviours worth pinning:
 *   1. Default is "simple" when localStorage is empty (Phase 22 Q1 decision).
 *   2. A previously stored value rehydrates the initial state.
 *   3. setMode writes through to localStorage so the next mount sees it.
 *   4. toggle() flips between the two modes.
 *
 * We render the hook into a tiny harness component instead of using
 * @testing-library/react-hooks (which is no longer maintained for React 18+).
 * The harness exposes the hook's return value through DOM text we can assert
 * on, which keeps the test framework-version-agnostic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useSimpleMode } from "./useSimpleMode";

const STORAGE_KEY = "dropshop.uiMode.v1";

function Harness() {
  const { mode, isSimple, setMode, toggle } = useSimpleMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="is-simple">{String(isSimple)}</span>
      <button onClick={() => setMode("full")}>set-full</button>
      <button onClick={() => setMode("simple")}>set-simple</button>
      <button onClick={toggle}>toggle</button>
    </div>
  );
}

describe("useSimpleMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'simple' when localStorage is empty", () => {
    render(<Harness />);
    expect(screen.getByTestId("mode").textContent).toBe("simple");
    expect(screen.getByTestId("is-simple").textContent).toBe("true");
  });

  it("rehydrates from localStorage on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "full");
    render(<Harness />);
    expect(screen.getByTestId("mode").textContent).toBe("full");
    expect(screen.getByTestId("is-simple").textContent).toBe("false");
  });

  it("ignores invalid stored values and falls back to default", () => {
    window.localStorage.setItem(STORAGE_KEY, "garbage");
    render(<Harness />);
    expect(screen.getByTestId("mode").textContent).toBe("simple");
  });

  it("setMode writes through to localStorage", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("set-full"));
    expect(screen.getByTestId("mode").textContent).toBe("full");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("full");
  });

  it("toggle flips between simple and full", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId("mode").textContent).toBe("simple");
    await user.click(screen.getByText("toggle"));
    expect(screen.getByTestId("mode").textContent).toBe("full");
    await user.click(screen.getByText("toggle"));
    expect(screen.getByTestId("mode").textContent).toBe("simple");
  });

  it("tolerates a localStorage that throws (private browsing simulation)", () => {
    const origSet = window.localStorage.setItem;
    // Simulate a browser that rejects writes (e.g. Safari Private Mode quota).
    Object.defineProperty(window.localStorage.__proto__, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("QuotaExceededError");
      },
    });
    try {
      render(<Harness />);
      // We just need the render not to crash and the setter not to throw.
      act(() => {
        // setMode internally swallows the storage error.
        screen.getByText("set-full").click();
      });
      expect(screen.getByTestId("mode").textContent).toBe("full");
    } finally {
      // Restore so other tests aren't poisoned.
      Object.defineProperty(window.localStorage.__proto__, "setItem", {
        configurable: true,
        value: origSet,
      });
    }
  });
});
