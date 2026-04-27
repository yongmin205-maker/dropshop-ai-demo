/**
 * ApprovalQueue — first RTL render test.
 *
 * Locks the two regressions that bit the live deploy in CODE_AUDIT:
 *
 *   1. Nested anchors. The original Home.tsx wrapped a `<Link>` around an
 *      `<a>`, which crashed React on hydration in production. Here we assert
 *      that no rendered `<a>` lives inside another `<a>`, so any future
 *      refactor that re-introduces the bug fails CI before it ships.
 *
 *   2. Approve button wiring. The button must invoke
 *      `trpc.drafts.approve.useMutation().mutate({ draftId })` exactly once
 *      with the right id. Anything that breaks the click → mutation chain
 *      (renamed prop, forgotten onClick, duplicated handler) trips this.
 *
 * The trpc client is mocked module-wide so the test stays hermetic — no
 * provider, no fetch, no react-query cache. The shape of each hook is the
 * minimum the component reads at render time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const approveMutate = vi.fn();
const rejectMutate = vi.fn();
const invalidate = vi.fn();

vi.mock("@/lib/trpc", () => {
  const draft = {
    id: 42,
    conversationId: 7,
    intent: "ETA/Order Status",
    revision: 1,
    body: "Hi, your order is out for delivery.",
    createdAt: new Date("2026-04-27T20:47:42Z"),
  };
  const conversation = {
    id: 7,
    customerName: "Test Customer",
    phone: "+15550109901",
  };
  return {
    trpc: {
      useUtils: () => ({
        drafts: {
          listPending: {
            cancel: vi.fn().mockResolvedValue(undefined),
            getData: vi.fn().mockReturnValue([draft]),
            setData: vi.fn(),
            invalidate,
          },
        },
        conversations: {
          list: { invalidate },
          messages: { invalidate },
          logs: { invalidate },
        },
        rag: {
          styleExamples: { invalidate },
          rejections: { invalidate },
        },
      }),
      drafts: {
        listPending: {
          useQuery: () => ({ data: [draft] }),
        },
        approve: {
          useMutation: () => ({
            mutate: approveMutate,
            isPending: false,
          }),
        },
        reject: {
          useMutation: () => ({
            mutate: rejectMutate,
            isPending: false,
          }),
        },
      },
      customers: {
        profile: {
          useQuery: () => ({ data: undefined }),
        },
      },
      conversations: {
        list: {
          useQuery: () => ({ data: [conversation] }),
        },
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// useVisiblePollInterval is fine to call (returns a number) but jsdom
// doesn't fire visibility events, so the simplest mock is to return a
// constant interval. Avoids relying on `useSyncExternalStore` semantics.
vi.mock("@/hooks/useVisiblePollInterval", () => ({
  useVisiblePollInterval: () => 2500,
}));

import { ApprovalQueue } from "./ApprovalQueue";

describe("<ApprovalQueue />", () => {
  beforeEach(() => {
    approveMutate.mockClear();
    rejectMutate.mockClear();
    invalidate.mockClear();
  });

  it("renders the pending draft body and the Approve / Reject buttons", () => {
    render(<ApprovalQueue activeConversationId={7} customerName="Test Customer" />);
    expect(screen.getByText("Approval Queue")).toBeInTheDocument();
    expect(screen.getByText(/Hi, your order is out for delivery\./)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Approve & send/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/i })).toBeInTheDocument();
  });

  it("calls drafts.approve.mutate with the draft id when the Approve button is clicked", async () => {
    const user = userEvent.setup();
    render(<ApprovalQueue activeConversationId={7} customerName="Test Customer" />);
    await user.click(screen.getByRole("button", { name: /Approve & send/i }));
    expect(approveMutate).toHaveBeenCalledTimes(1);
    expect(approveMutate).toHaveBeenCalledWith({ draftId: 42 });
  });

  it("never renders a nested <a> tag (the regression that broke the live deploy)", () => {
    const { container } = render(
      <ApprovalQueue activeConversationId={7} customerName="Test Customer" />,
    );
    for (const outer of Array.from(container.querySelectorAll("a"))) {
      expect(within(outer).queryAllByRole("link")).toHaveLength(0);
      expect(outer.querySelectorAll("a")).toHaveLength(0);
    }
  });
});
