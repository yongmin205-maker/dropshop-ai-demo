/**
 * SimpleModeToggle — RTL render tests.
 *
 * Two things we care about:
 *   1. The "selected" segment has aria-selected=true and visual emphasis;
 *      the other has aria-selected=false. We assert on aria, not class
 *      strings, so a future visual tweak doesn't break the test.
 *   2. Clicking the other segment invokes onChange with the right value
 *      exactly once.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SimpleModeToggle } from "./SimpleModeToggle";

describe("SimpleModeToggle", () => {
  it("marks the active segment with aria-selected", () => {
    render(<SimpleModeToggle mode="simple" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: "Simple" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Full" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("flips active segment when mode changes", () => {
    const { rerender } = render(<SimpleModeToggle mode="simple" onChange={() => {}} />);
    rerender(<SimpleModeToggle mode="full" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: "Full" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Simple" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("calls onChange with 'full' when Full is clicked from Simple", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SimpleModeToggle mode="simple" onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "Full" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("full");
  });

  it("calls onChange with 'simple' when Simple is clicked from Full", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SimpleModeToggle mode="full" onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "Simple" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("simple");
  });

  it("renders tap targets at least 28px tall (header context, surrounding padding extends to 44px)", () => {
    render(<SimpleModeToggle mode="simple" onChange={() => {}} />);
    const simpleTab = screen.getByRole("tab", { name: "Simple" });
    // We can't measure layout in jsdom, but we can assert the class that
    // encodes the height constraint is still there. If a future refactor
    // removes the min-h, this test trips, prompting a re-review of HIG
    // tap-target conformance.
    expect(simpleTab.className).toMatch(/min-h-\[28px\]/);
  });
});
