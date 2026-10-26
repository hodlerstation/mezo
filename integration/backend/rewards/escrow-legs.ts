// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/solana/escrow-legs.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    One escrow row per (mission, reward asset) leg.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

/**
 * 외부 자산 보상 레그 — SolanaMissionEscrow 는 (missionId, rewardAsset) 마다 한 행이다 (2026-10-23, MUSD + MEZO).
 * API 는 예전 모양을 지킨다: `mission.skrEscrow` = 대표 레그(legIndex 0) 행 + `legs` 에 모든 레그.
 * 레그가 하나인 미션(Solana SKR·Monad·단일 Mezo)은 전과 똑같이 보인다.
 */
export const ESCROW_LEGS_INCLUDE = {
  orderBy: [{ legIndex: 'asc' as const }, { rewardAsset: 'asc' as const }],
};

export type EscrowLegRow = {
  legIndex: number;
  rewardAsset: string;
  [key: string]: unknown;
};

export type WithEscrowLegs<T, R extends EscrowLegRow = EscrowLegRow> = Omit<
  T,
  'skrEscrows'
> & { skrEscrow: (R & { legs: R[] }) | null };

export function flattenEscrowLegs<T extends object>(
  mission: T,
): WithEscrowLegs<T> {
  const { skrEscrows, ...rest } = mission as T & {
    skrEscrows?: EscrowLegRow[] | null;
  };
  const legs = [...(skrEscrows ?? [])].sort(
    (a, b) =>
      a.legIndex - b.legIndex || a.rewardAsset.localeCompare(b.rewardAsset),
  );
  return {
    ...rest,
    skrEscrow: legs.length ? { ...legs[0], legs } : null,
  } as WithEscrowLegs<T>;
}
