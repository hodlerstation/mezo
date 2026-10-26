// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/hooks/use-skr-claim-legs.ts
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    Polls per-leg payout status until every leg settles.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import apiClient, { unwrap } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { claimLegsInFlight, claimLegsSettled } from "@/lib/missions/claim-legs";
import { invalidateMissionEffects } from "@/lib/mission-query-invalidation";
import type { SkrClaimStatus } from "@/types/solana";

/** 클레임 직후 레그가 아직 안 잡혔어도(NOT_STARTED·빈 목록) 이 시간 동안은 다시 본다. */
const CLAIM_WATCH_MS = 60_000;
const claimWatchUntil = new Map<string, number>();

/** 클레임 요청을 보낸 직후 부른다 — 서버가 지급 작업을 만드는 사이에도 상태를 따라간다. */
export function watchClaimLegs(missionId: string, now = Date.now()) {
  claimWatchUntil.set(missionId, now + CLAIM_WATCH_MS);
}

export function claimLegsPollInterval(
  missionId: string,
  data: SkrClaimStatus | null | undefined,
  now = Date.now()
): number | false {
  if (claimLegsInFlight(data?.legs)) return 5000;
  // 레그가 전부 끝났으면 클레임 직후 감시 시간이 남아 있어도 더 묻지 않는다.
  if (claimLegsSettled(data?.legs)) return false;
  return (claimWatchUntil.get(missionId) ?? 0) > now ? 5000 : false;
}

/** 레그별 지급 상태 조회 — 훅과 클레임 직후 확인(claim-confirm)이 같은 키·같은 요청을 쓴다. */
export function skrClaimLegsQueryOptions(
  missionId: string,
  userId: string | undefined
) {
  return {
    queryKey: queryKeys.solana.skrClaimLegs(missionId, userId),
    queryFn: async () =>
      unwrap<SkrClaimStatus | null>(
        (
          await apiClient.get(
            `/solana/rewards/${encodeURIComponent(missionId)}/claim/status`
          )
        ).data
      ),
  };
}

/**
 * 참여자의 레그별 보상 지급 상태 (MUSD 지급 · MEZO 보내는 중 · HST 지급 …).
 * 외부 자산 보상 미션에서 승인·완료 참여자만 부른다. 보내는 중인 레그가 있으면 5초마다 다시 본다.
 *
 * 마지막 레그가 정산되는 순간 미션 상세(참여 상태)와 잔액을 다시 읽는다. 예전엔 폴링만 멈춰
 * 지급이 끝났는데도 초록 "보상 받기" 버튼이 남고, 다시 누르면 "진행 중" 토스트만 떴다
 * (2026-10-25 Mezo e2e).
 */
export function useSkrClaimLegs(
  missionId: string,
  userId: string | undefined,
  enabled: boolean
) {
  const qc = useQueryClient();
  const query = useQuery({
    ...skrClaimLegsQueryOptions(missionId, userId),
    enabled: enabled && Boolean(userId),
    refetchInterval: (q) => claimLegsPollInterval(missionId, q.state.data),
  });
  const inFlight = claimLegsInFlight(query.data?.legs);
  const settled = claimLegsSettled(query.data?.legs);
  const wasInFlight = useRef(false);
  useEffect(() => {
    // 클레임 직후 첫 응답이 이미 전부 정산(NOT_STARTED → FINALIZED 로 건너뜀)이어도 보내는
    // 중을 거치지 않았을 뿐 지급은 끝났다 — 같은 갱신을 한다.
    const watching = (claimWatchUntil.get(missionId) ?? 0) > Date.now();
    if ((wasInFlight.current && !inFlight) || (watching && settled)) {
      claimWatchUntil.delete(missionId);
      invalidateMissionEffects(qc, { missionId, balances: true, rewards: true });
    }
    wasInFlight.current = inFlight;
  }, [inFlight, settled, missionId, qc]);
  return query;
}
