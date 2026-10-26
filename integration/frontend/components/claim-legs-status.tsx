// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/components/missions/mission-detail/claim-legs-status.tsx
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    Per-token payout status with explorer links.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

"use client";

import { useTranslations } from "next-intl";
import { RotateCw } from "lucide-react";
import { Text } from "@/components/shared/text";
import { ListContainer, ListRow } from "@/components/shared/list-row";
import { Button } from "@/components/ui/button";
import { explorerTxUrl } from "@/lib/web3/networks";
import {
  canRetryClaimLegs,
  claimLegState,
  formatClaimLegAmount,
  type ClaimLegState,
} from "@/lib/missions/claim-legs";
import type { SkrClaimLeg } from "@/types/solana";

const STATE_COLOR: Record<ClaimLegState, "success" | "warning" | "danger" | "muted"> = {
  paid: "success",
  pending: "warning",
  failed: "danger",
  notStarted: "muted",
};

/**
 * 보상 레그별 지급 상태 — "MUSD 지급됨 · MEZO 보내는 중 · HST 지급됨" (2026-10-25).
 * 레그가 하나라도 남아 있으면 참여가 완료로 바뀌어도 다시 받기 버튼을 둔다 (재시도 상한에 닿은 레그만 남으면 숨긴다).
 */
export function ClaimLegsStatus({
  legs,
  onRetry,
  retrying,
}: {
  legs: readonly SkrClaimLeg[];
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const t = useTranslations("missions.detail.claimLegs");
  if (legs.length === 0) return null;
  return (
    <div style={{ marginTop: 12, textAlign: "left" }} data-testid="claim-legs">
      <Text variant="label" as="p" color="muted" style={{ marginBottom: 6 }}>
        {t("title")}
      </Text>
      <ListContainer>
        {legs.map((leg, index) => {
          const state = claimLegState(leg);
          return (
            <ListRow
              key={`${leg.kind}:${leg.rewardAsset}`}
              padding="10px 14px"
              divided={index < legs.length - 1}
              title={
                <Text variant="bodySm" weight="semibold">
                  {formatClaimLegAmount(leg)}
                </Text>
              }
              subtitle={
                leg.txHash ? (
                  <a
                    href={explorerTxUrl(leg.network, leg.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "hsl(var(--primary))" }}
                  >
                    {t("viewTx")}
                  </a>
                ) : undefined
              }
              trailing={
                <Text variant="caption" weight="bold" color={STATE_COLOR[state]}>
                  {t(`status.${state}`)}
                </Text>
              }
            />
          );
        })}
      </ListContainer>
      {onRetry && canRetryClaimLegs(legs) && (
        <Button
          type="button"
          variant="outline"
          className="mt-3 w-full gap-1.5"
          onClick={onRetry}
          disabled={retrying}
        >
          <RotateCw style={{ width: 14, height: 14 }} />
          {t("retry")}
        </Button>
      )}
    </div>
  );
}
