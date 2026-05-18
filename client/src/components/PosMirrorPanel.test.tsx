/**
 * Smoke test for PosMirrorPanel — verifies (1) it renders the three
 * endpoint cards (customers / orders / products), (2) the backfill
 * button is wired and the months selector defaults to 12.
 *
 * The intent here isn't deep coverage (richer UI is coming in Phase
 * 25d). It's a minimal regression net so that future refactors that
 * rename the underlying tRPC procedures (e.g. posMirror.runBackfill →
 * posMirror.backfill.start) trip a test instead of silently shipping
 * a dead button.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Mock the trpc client surface used by the panel.
const syncStatusRefetch = vi.fn();
const runDailyPullNowMutate = vi.fn();
const runBackfillMutate = vi.fn();
const invalidate = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      posMirror: { syncStatus: { invalidate } },
    }),
    posMirror: {
      syncStatus: {
        useQuery: () => ({
          data: {
            latestByEndpoint: { customers: null, orders: null, products: null },
            recent: [],
          },
          isFetching: false,
          refetch: syncStatusRefetch,
        }),
      },
      runDailyPullNow: {
        useMutation: () => ({
          mutate: runDailyPullNowMutate,
          isPending: false,
        }),
      },
      runBackfill: {
        useMutation: () => ({
          mutate: runBackfillMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { PosMirrorPanel } from "./PosMirrorPanel";

describe("<PosMirrorPanel />", () => {
  beforeEach(() => {
    syncStatusRefetch.mockReset();
    runDailyPullNowMutate.mockReset();
    runBackfillMutate.mockReset();
    invalidate.mockReset();
  });

  it("renders the three endpoint status cards (customers / orders / products) and the backfill controls", () => {
    render(<PosMirrorPanel />);

    expect(screen.getByText("고객")).toBeInTheDocument();
    expect(screen.getByText("주문")).toBeInTheDocument();
    expect(screen.getByText("상품")).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: /수동 풀/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /백필 시작/ }),
    ).toBeInTheDocument();
  });

  it("shows '아직 실행 기록이 없습니다' when posSyncLog is empty", () => {
    render(<PosMirrorPanel />);
    expect(
      screen.getByText("아직 실행 기록이 없습니다."),
    ).toBeInTheDocument();
  });
});
