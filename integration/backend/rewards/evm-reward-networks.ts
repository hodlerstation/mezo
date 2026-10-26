// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/solana/evm-reward-networks.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    EVM reward networks and assets (MUSD / MEZO on Mezo).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import {
  MEZO_TOKEN_ADDRESS,
  NETWORKS,
  networkFamily,
  type NetworkId,
} from '../web3/networks';
import { CHOG_PAYMENT_TOKEN } from '../avatar/chog/chog-market.constants';
import type { Hex } from 'viem';

/**
 * EVM 체인에서 서버 지갑이 직접 보상(네이티브 또는 ERC-20)을 지급하는 네트워크.
 * SolanaMissionEscrow.rewardNetwork 가 이 값이면 MonChainService 경로(오프라인 서명·내구 nonce)로 지급한다.
 *
 * - monad / monad-testnet: MON(네이티브) · CHOG(ERC-20, 메인넷만)
 * - mezo / mezo-testnet:   MUSD(ERC-20) · MEZO(ERC-20, 시스템 주소) — 가스는 BTC
 *
 * 새 체인을 열려면 여기 목록과 {@link rewardAssetsFor} 만 늘린다. 지급 지갑은
 * {@link rewardWalletKindFor} 의 kind 로 TreasuryWallet (kind, chainId) 행을 만든다.
 */
export const EVM_REWARD_NETWORKS = [
  'monad',
  'monad-testnet',
  'mezo',
  'mezo-testnet',
] as const;
export type EvmRewardNetwork = (typeof EVM_REWARD_NETWORKS)[number];

/**
 * 보상 지급 서명을 허용하는 chainId (Monad 143/10143 · Mezo 31612/31611).
 * 서명기는 이 목록 밖 체인으로는 서명하지 않는다 (2026-10-25: Mezo 지급이 MON_WRONG_CHAIN 으로 전부 실패).
 */
export const EVM_REWARD_CHAIN_IDS: readonly number[] = EVM_REWARD_NETWORKS.map(
  (n) => NETWORKS[n].chainId,
);

export function isEvmRewardNetwork(value: unknown): value is EvmRewardNetwork {
  return (
    typeof value === 'string' &&
    (EVM_REWARD_NETWORKS as readonly string[]).includes(value)
  );
}

/** 보상 자산 식별자 — 'NATIVE' 는 체인 네이티브, 나머지는 ERC-20 심볼. */
export type EvmRewardAsset = 'NATIVE' | 'CHOG' | 'MUSD' | 'MEZO';
export const EVM_REWARD_ASSETS: readonly EvmRewardAsset[] = [
  'NATIVE',
  'CHOG',
  'MUSD',
  'MEZO',
];

/** 네트워크가 지급할 수 있는 자산 (UI 선택지·DTO 검증·지급기 공통). */
export function rewardAssetsFor(network: EvmRewardNetwork): EvmRewardAsset[] {
  switch (network) {
    case 'monad':
      return ['NATIVE', 'CHOG'];
    case 'monad-testnet':
      return ['NATIVE'];
    case 'mezo':
    case 'mezo-testnet':
      return ['MUSD', 'MEZO'];
  }
}

export function supportsRewardAsset(
  network: unknown,
  asset: unknown,
): boolean {
  return (
    isEvmRewardNetwork(network) &&
    (rewardAssetsFor(network) as readonly string[]).includes(String(asset))
  );
}

/** ERC-20 컨트랙트 주소. 네이티브면 undefined. 지원하지 않는 조합은 throw. */
export function rewardTokenAddress(
  network: EvmRewardNetwork,
  asset: string = 'NATIVE',
): Hex | undefined {
  if (!supportsRewardAsset(network, asset))
    throw new Error('MON_REWARD_ASSET_UNSUPPORTED');
  if (asset === 'NATIVE') return undefined;
  if (asset === 'CHOG') return CHOG_PAYMENT_TOKEN;
  if (asset === 'MUSD') return NETWORKS[network].usdt.address;
  if (asset === 'MEZO') return MEZO_TOKEN_ADDRESS;
  throw new Error('MON_REWARD_ASSET_UNSUPPORTED');
}

/** 화면·알림용 심볼 (NATIVE → 체인 네이티브 심볼: MON / BTC). */
export function rewardSymbol(network: NetworkId | string, asset = 'NATIVE'): string {
  if (asset !== 'NATIVE') return asset;
  return isEvmRewardNetwork(network)
    ? NETWORKS[network].chain.nativeCurrency.symbol
    : 'MON';
}

/** Token 레지스트리 행 이름 (rewardLedger 가 MissionReward 용 Token 을 만들 때). */
export function rewardTokenName(network: NetworkId | string, asset = 'NATIVE'): string {
  const symbol = rewardSymbol(network, asset);
  switch (symbol) {
    case 'MON':
      return 'Monad';
    case 'CHOG':
      return 'Chog';
    case 'MUSD':
      return 'Mezo USD';
    case 'MEZO':
      return 'Mezo';
    case 'BTC':
      return 'Bitcoin';
    case 'SKR':
      return 'Seeker';
    default:
      return symbol;
  }
}

/**
 * 한 미션에 걸 수 있는 외부 자산 레그 — 네트워크의 자산 목록 전부 (Mezo 는 MUSD+MEZO 두 레그).
 * 같은 자산을 두 번 걸 수는 없다 (SolanaMissionEscrow 의 키가 (missionId, rewardAsset)).
 */
export function maxRewardLegsFor(network: EvmRewardNetwork): number {
  return rewardAssetsFor(network).length;
}

/**
 * 지급 지갑 kind — 체인 계열마다 하나. 기존 Monad 행은 'MON_REWARDS' 를 그대로 쓴다.
 * TreasuryWallet 은 (kind, chainId) 유니크라 테스트넷·메인넷은 같은 kind 로 각자 행을 가진다.
 */
export function rewardWalletKindFor(network: EvmRewardNetwork): string {
  return networkFamily(network) === 'mezo' ? 'MEZO_REWARDS' : 'MON_REWARDS';
}
