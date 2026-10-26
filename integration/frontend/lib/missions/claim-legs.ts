// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/lib/missions/claim-legs.ts
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    Claim legs model (EXTERNAL MUSD/MEZO + LEDGER HST).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import type { SkrClaimLeg } from "@/types/solana";
import { formatMissionReward } from "@/lib/missions/reward-amount";
import { formatHst } from "@/lib/format-token";
import { isWearableRewardAsset } from "@/lib/web3/evm-rewards";

/** 레그 상태 묶음 — 화면은 지급됨 / 보내는 중 / 실패 / 아직 안 보냄 네 가지로만 보여 준다. */
export type ClaimLegState = "paid" | "pending" | "failed" | "notStarted";

export function claimLegState(leg: SkrClaimLeg): ClaimLegState {
  if (leg.status === "FINALIZED") return "paid";
  if (leg.status === "FAILED") return "failed";
  if (leg.status === "NOT_STARTED") return "notStarted";
  return "pending";
}

/** 아직 지급되지 않은 레그가 있는가 (외부·원장 모두). */
export function hasUnpaidClaimLeg(legs: readonly SkrClaimLeg[] | undefined) {
  return !!legs?.some((leg) => leg.status !== "FINALIZED");
}

/**
 * 다시 받기(클레임 재요청)로 이어 보낼 수 있는 외부 레그가 있는가 — 서버가 retryable 로 표시한
 * 레그만. 아직 안 보낸(NOT_STARTED) 레그라도 장부가 닫혔으면 다시 보낼 수 없다 (서버가 판정한다).
 */
export function canRetryClaimLegs(legs: readonly SkrClaimLeg[] | undefined) {
  return !!legs?.some(
    (leg) =>
      leg.kind === "EXTERNAL" && leg.status !== "FINALIZED" && leg.retryable
  );
}

/** 클레임으로 지급이 시작된 레그가 있는가 (레그 목록을 보여 줄 때). 클레임 전엔 레그가 없다. */
export function claimLegsStarted(legs: readonly SkrClaimLeg[] | undefined) {
  return !!legs?.some((leg) => leg.status !== "NOT_STARTED");
}

/** 레그가 있고 전부 끝났다 (지급 완료 또는 실패) — 더 따라갈 지급이 없다. */
export function claimLegsSettled(legs: readonly SkrClaimLeg[] | undefined) {
  return (
    !!legs?.length &&
    legs.every((leg) => leg.status === "FINALIZED" || leg.status === "FAILED")
  );
}

/** 클레임은 접수됐지만 외부 자산(MUSD·MEZO …)이 아직 보내지는 중인가 — 성공 토스트 문구를 고른다. */
export function claimPayoutsStillSending(
  legs: readonly SkrClaimLeg[] | undefined
) {
  return !!legs?.some(
    (leg) =>
      leg.kind === "EXTERNAL" &&
      (claimLegState(leg) === "pending" || claimLegState(leg) === "notStarted")
  );
}

/** 보내는 중인 레그가 있으면 다시 조회한다 (확인 루프). */
export function claimLegsInFlight(legs: readonly SkrClaimLeg[] | undefined) {
  return !!legs?.some((leg) => claimLegState(leg) === "pending");
}

/** 레그 금액 — 최소 단위 원문 그대로 (B-10: 부동소수 변환으로 자르지 않는다). */
export function formatClaimLegAmount(leg: SkrClaimLeg): string {
  if (leg.kind === "LEDGER")
    return `${formatHst(leg.amount ?? 0)} ${leg.asset}`;
  if (!leg.amountRaw) return leg.asset;
  if (isWearableRewardAsset(leg.rewardAsset)) return `${leg.amountRaw}×`;
  // A malformed raw amount must not crash the payout list (BigInt throws).
  try {
    return `${formatMissionReward(leg.amountRaw, leg.network)} ${leg.asset}`;
  } catch {
    return leg.amount != null ? `${leg.amount} ${leg.asset}` : leg.asset;
  }
}
