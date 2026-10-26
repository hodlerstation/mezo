// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/__tests__/missions/claim-legs-status.test.tsx
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    UI behaviour of the legs list.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { describe, test, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../test-utils";
import { ClaimLegsStatus } from "@/components/missions/mission-detail/claim-legs-status";
import {
  canRetryClaimLegs,
  claimLegState,
  claimLegsInFlight,
  formatClaimLegAmount,
  hasUnpaidClaimLeg,
} from "@/lib/missions/claim-legs";
import type { SkrClaimLeg } from "@/types/solana";

/**
 * 2026-10-25 C1 / B-1: "0.1 MEZO + 1 MUSD + 10 HST" 미션의 레그별 지급 상태.
 * 한 레그가 남아 있으면 참여가 완료여도 레그 상태와 다시 받기를 보여 준다.
 */
const TX = `0x${"ab".repeat(32)}`;
function leg(over: Partial<SkrClaimLeg>): SkrClaimLeg {
  return {
    kind: "EXTERNAL",
    rewardAsset: "MUSD",
    asset: "MUSD",
    network: "mezo-testnet",
    status: "FINALIZED",
    signature: TX,
    txHash: TX,
    amountRaw: "1000000000000000000",
    amount: 1,
    retryable: false,
    ...over,
  };
}

const PAID_MUSD = leg({});
const PENDING_MEZO = leg({
  rewardAsset: "MEZO",
  asset: "MEZO",
  status: "SUBMITTED",
  amountRaw: "100000000000000000",
  txHash: `0x${"cd".repeat(32)}`,
});
const FAILED_MEZO = leg({
  rewardAsset: "MEZO",
  asset: "MEZO",
  status: "FAILED",
  amountRaw: "100000000000000000",
  retryable: true,
});
const HST = leg({
  kind: "LEDGER",
  rewardAsset: "HST",
  asset: "HST",
  signature: null,
  txHash: null,
  amountRaw: null,
  amount: 10,
});

describe("claim leg helpers", () => {
  test("map backend statuses to four display states", () => {
    expect(claimLegState(PAID_MUSD)).toBe("paid");
    expect(claimLegState(PENDING_MEZO)).toBe("pending");
    expect(claimLegState(leg({ status: "PREPARED" }))).toBe("pending");
    expect(claimLegState(FAILED_MEZO)).toBe("failed");
    expect(claimLegState(leg({ status: "NOT_STARTED" }))).toBe("notStarted");
  });

  test("unpaid / retry / in-flight decisions", () => {
    expect(hasUnpaidClaimLeg([PAID_MUSD, HST])).toBe(false);
    expect(hasUnpaidClaimLeg([PAID_MUSD, PENDING_MEZO])).toBe(true);
    expect(canRetryClaimLegs([PAID_MUSD, FAILED_MEZO])).toBe(true);
    // 재시도 상한에 닿은 실패·보내는 중만 남았으면 다시 받기는 소용없다.
    expect(canRetryClaimLegs([PAID_MUSD, { ...FAILED_MEZO, retryable: false }])).toBe(false);
    expect(canRetryClaimLegs([PAID_MUSD, PENDING_MEZO])).toBe(false);
    // 아직 안 보낸 레그는 서버가 retryable 이라고 할 때만 (장부가 닫혔으면 보낼 수 없다).
    expect(canRetryClaimLegs([leg({ status: "NOT_STARTED", retryable: false })])).toBe(false);
    expect(canRetryClaimLegs([leg({ status: "NOT_STARTED", retryable: true })])).toBe(true);
    expect(claimLegsInFlight([PAID_MUSD, PENDING_MEZO])).toBe(true);
    expect(claimLegsInFlight([PAID_MUSD, FAILED_MEZO])).toBe(false);
  });

  test("formats raw amounts exactly (no float truncation)", () => {
    expect(formatClaimLegAmount(PAID_MUSD)).toBe("1 MUSD");
    expect(formatClaimLegAmount(PENDING_MEZO)).toBe("0.1 MEZO");
    expect(
      formatClaimLegAmount(leg({ amountRaw: "1234567890123456789" })),
    ).toBe("1.234567890123456789 MUSD");
    expect(formatClaimLegAmount(HST)).toContain("HST");
  });
});

describe("ClaimLegsStatus", () => {
  test("shows each leg with its state and an explorer link per paid or sent leg", () => {
    renderWithProviders(<ClaimLegsStatus legs={[PAID_MUSD, PENDING_MEZO, HST]} />);
    expect(screen.getByText("1 MUSD")).toBeTruthy();
    expect(screen.getByText("0.1 MEZO")).toBeTruthy();
    const links = screen.getAllByRole("link") as HTMLAnchorElement[];
    expect(links.map((a) => a.href)).toEqual([
      `https://explorer.test.mezo.org/tx/${TX}`,
      `https://explorer.test.mezo.org/tx/0x${"cd".repeat(32)}`,
    ]);
    // 보내는 중인 레그만 있으면 다시 받기 버튼은 없다.
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("keeps a retry button while a failed leg can still be sent", () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <ClaimLegsStatus legs={[PAID_MUSD, FAILED_MEZO, HST]} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
