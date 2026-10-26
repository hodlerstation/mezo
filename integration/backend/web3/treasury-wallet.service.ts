// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/web3/treasury-wallet.service.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (52-104)
//   why:    Treasury wallet sharing rules: one key serves mint collection and MUSD/MEZO payouts on mezo-testnet.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-51 omitted) …
/**
 * 같은 체인의 다른 kind 행을 대신 쓰는 별칭 (2026-10-24, Mezo Buildathon).
 *
 * `TreasuryWallet.address` 가 unique 라 키 하나는 행 하나로만 들어간다. Mezo 테스트넷은 키 하나
 * (FEE_COLLECTOR 로 한 번 등록) 로 수금·보상 지급을 처리하는 설계라, 그 체인의
 * MEZO_REWARDS 행이 없으면 **같은 체인의** FEE_COLLECTOR 행을 쓴다.
 *
 * HST_OPERATOR 는 별칭에 없다 (2026-10-25 운영자 결정): Mezo 테스트넷 HST 원장은 BSC 처럼 DB 원장으로
 * 돈다. 컨트랙트 원장을 켤 때(HST_ONCHAIN_NETWORKS) 는 그 체인의 HST_OPERATOR 행을 따로 등록한다.
 *
 * 범위를 Mezo 계열 테스트넷으로 좁힌 이유: 실자산 체인(bsc·mezo 메인넷)에서는 수금 키가 발행·지급
 * 키를 겸하면 안 되고(키 분리), GIWA 는 이미 전용 operator 행이 있다. 다른 체인(BSC) 지갑으로의
 * 대체는 이 별칭과 무관하다 (별칭 행도 대상 체인 chainId 로만 찾는다). BSC 지갑은 레지스트리가
 * `treasuryWalletFromDefault` 로 승인한 네트워크(mezo-testnet)에서만, 별칭 다음 순서로 쓴다
 * ({@link defaultSharedWalletKind}). mezo 메인넷은 여전히 금지다.
 */
export const SAME_CHAIN_KIND_ALIASES: Readonly<Record<string, string>> = {
  MEZO_REWARDS: 'FEE_COLLECTOR',
};

/** 이 네트워크에서 kind 행이 없을 때 쓸 같은 체인의 별칭 kind (없으면 null). */
export function sameChainAliasKind(
  kind: string,
  network: NetworkId,
): string | null {
  if (networkFamily(network) !== 'mezo' || !isTestnetNetwork(network))
    return null;
  return SAME_CHAIN_KIND_ALIASES[kind] ?? null;
}

/**
 * 기본 네트워크 지갑을 승인된 지갑으로 쓰는 kind (`NetworkConfig.treasuryWalletFromDefault`).
 * 수금(FEE_COLLECTOR)·보상 지급(MEZO_REWARDS) 두 역할을 기본 네트워크의 FEE_COLLECTOR 행 하나로 푼다.
 * HST 발행(HST_OPERATOR)은 없다 — Mezo 테스트넷 HST 원장은 DB 원장이다 (2026-10-25 운영자 결정).
 */
export const DEFAULT_SHARED_WALLET_KINDS: Readonly<Record<string, string>> = {
  FEE_COLLECTOR: 'FEE_COLLECTOR',
  MEZO_REWARDS: 'FEE_COLLECTOR',
};

/**
 * 이 네트워크에서 kind 행(과 같은 체인 별칭)이 없을 때 쓸 **기본 네트워크** 의 kind (없으면 null).
 * 레지스트리 플래그가 켜진 네트워크(mezo-testnet)만 — 그 밖은 BSC 키로 서명하지 않는다.
 */
export function defaultSharedWalletKind(
  kind: string,
  network: NetworkId,
): string | null {
  if (network === DEFAULT_NETWORK) return null;
  if (getNetwork(network).treasuryWalletFromDefault !== true) return null;
  return DEFAULT_SHARED_WALLET_KINDS[kind] ?? null;
}

// … (lines 105-833 omitted) …
