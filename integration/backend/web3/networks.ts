// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/web3/networks.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified except operational comments redacted
//   why:    Network registry: mezo-testnet / mezo entries next to bsc and giwa-sepolia.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { defineChain, fallback, http, type Chain } from 'viem';
import { bsc, monad, monadTestnet } from 'viem/chains';
import { BSC_CHAIN_ID, BSC_TOKEN, BEP20_DECIMALS } from './constants';
import { AppError } from '../common/app-error';
import { ErrorCode } from '../common/error-codes';
import {
  giwaStickyEndpointEpoch,
  giwaStickyEndpointIndex,
  withGiwaEndpointCooldown,
  withGiwaRpcBudget,
  withGiwaStickyEndpoint,
  withChainIdMemo,
  type GiwaRpcLane,
} from './giwa-rpc-budget';

/**
 * 멀티 네트워크 레지스트리.
 *
 * - `bsc` — 프로덕션 기본. 모든 network 파라미터의 default. 기존 동작 무변경.
 * - `giwa-sepolia` — GIWA Sepolia 테스트넷 (OP Stack L2 on Ethereum Sepolia).
 *
 * 새 네트워크 추가 시: NetworkId union + NETWORKS 엔트리만 추가하면
 * BscReaderService / TreasuryWalletService / Erc20Service / SwapService가 그대로 동작.
 */

export type NetworkId =
  | 'bsc'
  | 'giwa-sepolia'
  | 'monad'
  | 'monad-testnet'
  | 'mezo'
  | 'mezo-testnet';

export const DEFAULT_NETWORK: NetworkId = 'bsc';

/**
 * GIWA 공개(무료) RPC 엔드포인트 — fallback 우선순위 순.
 *   [0] 기본 로드밸런서, [1] Flashblocks (200ms preconfirmation — head 전파가 더 빠름).
 * 출처: docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa
 *
 * 근거(2026-08 prod 실측): 기본 LB 뒤 일부 노드가 write 직후의
 * receipt.blockNumber 를 아직 몰라 pin 조회가 "0x"(no data) 로 실패 → 클레임 후
 * 잔액 반영이 인덱서 tick(30s) 까지 지연. 두 번째 엔드포인트로 자동 전환할 수
 * 있도록 배열로 정의하고 BscReaderService 가 viem fallback transport 로 감싼다.
 *
 * env override: GIWA_RPC_URL 에 쉼표 구분으로 1개 이상 지정 가능
 *   (예: GIWA_RPC_URL=https://a,https://b — 1개만 지정하면 fallback 없이 단일 http).
 */
const GIWA_RPC_URLS_DEFAULT = [
  'https://sepolia-rpc.giwa.io',
  'https://sepolia-rpc-flashblocks.giwa.io',
] as const;

function resolveGiwaRpcUrls(): string[] {
  const raw = process.env.GIWA_RPC_URL?.trim();
  if (!raw) return [...GIWA_RPC_URLS_DEFAULT];
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return urls.length > 0 ? urls : [...GIWA_RPC_URLS_DEFAULT];
}

const GIWA_RPC_URLS = resolveGiwaRpcUrls();

/** GIWA Sepolia — Chain ID 91342, 통화 ETH, Blockscout explorer */
export const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: GIWA_RPC_URLS,
    },
  },
  blockExplorers: {
    default: {
      name: 'GIWA Sepolia Explorer (Blockscout)',
      url: 'https://sepolia-explorer.giwa.io',
    },
  },
  testnet: true,
});

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/**
 * GIWA Sepolia 테스트 USDT (TUSDT, 6 decimals) — 공개 컨트랙트 주소.
 * BSC USDT 처럼 registry 기본값으로 박음. 새 테스트 토큰 재배포 시 GIWA_TEST_USDT env 로 override.
 */
const GIWA_TEST_USDT_DEFAULT =
  '0xb391db53d9705cb5d63afa6f2b9185403e3e0f6e' as const;

/**
 * Mezo (Bitcoin L2, Cosmos-EVM). 가스는 BTC(18 dec). 결제 토큰은 MUSD(18 dec).
 * 값 출처: mezo.org/docs/developers (chain id·RPC·explorer) + users/resources/contracts-reference
 * (MUSD·MEZO 주소). 2026-10-23 RPC 로 chainId / symbol / decimals 직접 확인.
 *
 * - `mezo-testnet` (31611) — Buildathon 제출용 HST 원장 네트워크. faucet.test.mezo.org (BTC/MEZO).
 * - `mezo` (31612) — 메인넷. 실자산이라 HST 원장·민팅은 열지 않는다 (hstEnabled:false, Monad 와 동일 등급).
 *   미션 대상 체인·지갑 전환·토큰 전송 검증만 지원.
 *
 * MEZO 토큰은 네이티브가 아니라 시스템 주소에 미리 배포된 ERC-20 이다 (양 네트워크 같은 주소).
 * env override: MEZO_TESTNET_RPC_URL / MEZO_RPC_URL (쉼표 구분 1개 이상), MEZO_TESTNET_MUSD / MEZO_MUSD.
 */
export const MEZO_MUSD_TESTNET_DEFAULT =
  '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503' as const;
export const MEZO_MUSD_MAINNET_DEFAULT =
  '0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186' as const;
/** MEZO ERC-20 — 메인넷·테스트넷 동일 시스템 주소. */
export const MEZO_TOKEN_ADDRESS =
  '0x7B7c000000000000000000000000000000000001' as const;
/** 네이티브 BTC 의 ERC-20 뷰 (잔액 조회용). 전송은 네이티브로. */
export const MEZO_BTC_ERC20_ADDRESS =
  '0x7b7C000000000000000000000000000000000000' as const;

const MEZO_TESTNET_RPC_URLS_DEFAULT = ['https://rpc.test.mezo.org'] as const;
/** 메인넷은 공식 docs 가 전용 프로바이더를 권장 — 공개 엔드포인트 3종을 fallback 순서로. */
const MEZO_RPC_URLS_DEFAULT = [
  'https://mezo-mainnet.boar.network',
  'https://mainnet.mezo.public.validationcloud.io',
  'https://mezo.drpc.org',
] as const;

function resolveRpcUrls(
  envValue: string | undefined,
  defaults: readonly string[],
): string[] {
  const raw = envValue?.trim();
  if (!raw) return [...defaults];
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return urls.length > 0 ? urls : [...defaults];
}

const MEZO_TESTNET_RPC_URLS = resolveRpcUrls(
  process.env.MEZO_TESTNET_RPC_URL,
  MEZO_TESTNET_RPC_URLS_DEFAULT,
);
const MEZO_RPC_URLS = resolveRpcUrls(
  process.env.MEZO_RPC_URL,
  MEZO_RPC_URLS_DEFAULT,
);

const MEZO_NATIVE_CURRENCY = {
  name: 'Bitcoin',
  symbol: 'BTC',
  decimals: 18,
} as const;

/** Mezo Testnet — Chain ID 31611, 통화 BTC, Blockscout explorer */
export const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: MEZO_NATIVE_CURRENCY,
  rpcUrls: { default: { http: MEZO_TESTNET_RPC_URLS } },
  blockExplorers: {
    default: {
      name: 'Mezo Testnet Explorer (Blockscout)',
      url: 'https://explorer.test.mezo.org',
    },
  },
  testnet: true,
});

/** Mezo Mainnet — Chain ID 31612, 통화 BTC, Blockscout explorer */
export const mezoMainnet = defineChain({
  id: 31612,
  name: 'Mezo',
  nativeCurrency: MEZO_NATIVE_CURRENCY,
  rpcUrls: { default: { http: MEZO_RPC_URLS } },
  blockExplorers: {
    default: {
      name: 'Mezo Explorer (Blockscout)',
      url: 'https://explorer.mezo.org',
    },
  },
});

export interface NetworkConfig {
  id: NetworkId;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  /**
   * 다중 공개 RPC (fallback 순서). 2개 이상 정의된 네트워크만 BscReaderService 가
   * viem fallback transport 로 감싼다. **bsc 는 정의하지 않음** — 기존 단일 http
   * transport 를 그대로 유지해야 하는 프로덕션 경로 (변경 금지).
   */
  rpcUrls?: string[];
  /** False for chains supporting missions and native rewards only. */
  hstEnabled?: boolean;
  /**
   * 민팅 결제 토큰 (역사적 이름 `usdt`). bsc=USDT, giwa=TUSDT, mezo=MUSD.
   * 심볼·이름은 `paymentToken` 이 들고, 주소·decimals 만 여기.
   */
  usdt: { address: `0x${string}`; decimals: number };
  /** 결제 토큰 표시 메타 — 미지정 시 USDT. UI 문구·로그는 이 값만 쓴다 (심볼 하드코딩 금지). */
  paymentToken?: { symbol: string; name: string };
  /**
   * 결제 토큰에 권한 없는 public `mint` 가 있어 operator 가 담보를 스스로 찍을 수 있는지
   * (GIWA TUSDT 만). 없는 체인(Mezo MUSD)은 operator 지갑 잔고(유저 결제 수금)로만 예치한다.
   */
  collateralFaucetMint?: boolean;
  explorerUrl: string;
  /**
   * Blockscout/Etherscan 호환 API 베이스. 미지정 시 explorerUrl 과 같은 호스트의 `/api`.
   * (Mezo 는 UI 호스트와 API 호스트가 다르다.)
   */
  explorerApiUrl?: string;
  /** 테스트넷 여부 — `chain.testnet` 과 동일하되 명시적으로 둔다 (집계·KPI 제외 판정). */
  testnet: boolean;
  /**
   * 미션 피드 노출 범위.
   *  - `shared`(기본): 어느 네트워크를 골라도 보인다 (bsc·giwa·solana).
   *  - `scoped`: 그 네트워크를 골랐을 때만 보인다 (monad — 기존 동작).
   *  - `exclusive`: 골랐을 때만 보이고, 골랐을 때는 그 네트워크 미션만 보인다 (mezo —
   *    "Mezo 선택 시 Mezo 내용만" 요구).
   */
  missionVisibility?: 'shared' | 'scoped' | 'exclusive';
  /** 이 네트워크가 플랫폼의 기본 수금·보상 지갑 설정을 이어받는지 (mezo-testnet 만). [operational details redacted] */
  treasuryWalletFromDefault?: true;
  /**
   * operator 가스(네이티브 코인) 감시 (2026-10-25). 지정한 네트워크만 OperatorGasGuardService 가
   * `walletKind`(기본 HST_OPERATOR) 로 해석되는 지갑의 네이티브 잔액을 보고 어드민에게 알린다. 자동 충전은 하지 않는다.
   * HST 원장이 DB 인 네트워크는 체인에서 서명하는 지갑이 보상 지급 지갑뿐이라 그 kind 를 적는다 (Mezo: MEZO_REWARDS).
   * GIWA 는 레인·예비 지갑까지 다루는 전용 경로가 따로 있어 여기 넣지 않는다.
   *
   * 임계는 wei 문자열 (NETWORKS 를 JSON 으로 내보내는 곳이 있어 bigint 를 두지 않는다).
   * env `<ID>_OPERATOR_GAS_WARN_WEI` / `<ID>_OPERATOR_GAS_CRITICAL_WEI` (ID 는 대문자·`-`→`_`) 로 덮을 수 있다.
   */
  operatorGas?: {
    warnWei: string;
    criticalWei: string;
    faucetUrl: string;
    walletKind?: string;
  };
  label: string;
}

/** 미션 피드에서 "골랐을 때만 보이는" 네트워크 (scoped + exclusive). */
export function scopedMissionNetworkIds(): NetworkId[] {
  return (Object.keys(NETWORKS) as NetworkId[]).filter(
    (id) => (NETWORKS[id].missionVisibility ?? 'shared') !== 'shared',
  );
}

/** 골랐을 때 다른 네트워크 미션을 숨기는 네트워크인지. */
export function isExclusiveMissionNetwork(id: unknown): id is NetworkId {
  return (
    typeof id === 'string' &&
    Object.prototype.hasOwnProperty.call(NETWORKS, id) &&
    NETWORKS[id as NetworkId].missionVisibility === 'exclusive'
  );
}

/**
 * 네트워크 계열 — 메인넷/테스트넷 접미사를 뗀 이름 (mezo-testnet → mezo, giwa-sepolia → giwa).
 * "같은 체인 계열인가" 판정용 (미션 규칙이 미션 네트워크와 같은 계열인지).
 */
export function networkFamily(id: NetworkId): string {
  return id.replace(/-(testnet|sepolia)$/, '');
}

/** operator 가스 감시 대상 네트워크 (operatorGas 가 정의된 곳). */
export function operatorGasWatchNetworks(): NetworkId[] {
  return (Object.keys(NETWORKS) as NetworkId[]).filter(
    (id) => !!NETWORKS[id].operatorGas,
  );
}

/** operator 가스 감시가 잔액을 보는 지갑 kind (operatorGas.walletKind, 기본 HST_OPERATOR). */
export function operatorGasWalletKind(id: NetworkId): string {
  return NETWORKS[id]?.operatorGas?.walletKind ?? 'HST_OPERATOR';
}

/** 네이티브(가스) 코인 심볼 — Mezo 는 BTC, GIWA 는 ETH. */
export function nativeSymbolOf(id: NetworkId): string {
  return NETWORKS[id]?.chain?.nativeCurrency?.symbol ?? 'ETH';
}

/** 결제 토큰 심볼 (UI/로그용). */
export function paymentSymbolOf(id: NetworkId = DEFAULT_NETWORK): string {
  return NETWORKS[id]?.paymentToken?.symbol ?? 'USDT';
}

/** Blockscout 호환 API 베이스 (끝 슬래시 없음). */
export function explorerApiBase(id: NetworkId): string {
  const net = NETWORKS[id];
  return (net.explorerApiUrl ?? net.explorerUrl).replace(/\/+$/, '');
}

function monadNetwork(
  id: 'monad' | 'monad-testnet',
  chain: Chain,
): NetworkConfig {
  return {
    id,
    chain,
    chainId: chain.id,
    rpcUrl:
      (id === 'monad'
        ? process.env.CHOG_RPC_URL
        : process.env.MONAD_TESTNET_RPC_URL) || chain.rpcUrls.default.http[0],
    usdt: { address: '' as `0x${string}`, decimals: 18 },
    hstEnabled: false,
    explorerUrl: chain.blockExplorers!.default.url,
    testnet: !!chain.testnet,
    missionVisibility: 'scoped',
    label: chain.name,
  };
}

const MEZO_PAYMENT_TOKEN = { symbol: 'MUSD', name: 'Mezo USD' } as const;

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  monad: monadNetwork('monad', monad),
  'monad-testnet': monadNetwork('monad-testnet', monadTestnet),
  bsc: {
    id: 'bsc',
    chain: bsc,
    chainId: BSC_CHAIN_ID,
    rpcUrl: process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org/',
    usdt: { address: BSC_TOKEN.USDT, decimals: BEP20_DECIMALS },
    paymentToken: { symbol: 'USDT', name: 'Tether USD (BEP-20)' },
    explorerUrl: 'https://bscscan.com',
    testnet: false,
    label: 'BNB Smart Chain',
  },
  'mezo-testnet': {
    id: 'mezo-testnet',
    chain: mezoTestnet,
    chainId: mezoTestnet.id,
    rpcUrl: MEZO_TESTNET_RPC_URLS[0],
    rpcUrls: MEZO_TESTNET_RPC_URLS,
    usdt: {
      address:
        (process.env.MEZO_TESTNET_MUSD as `0x${string}`) ||
        MEZO_MUSD_TESTNET_DEFAULT,
      decimals: 18,
    },
    paymentToken: MEZO_PAYMENT_TOKEN,
    explorerUrl: 'https://explorer.test.mezo.org',
    explorerApiUrl: 'https://api.explorer.test.mezo.org',
    testnet: true,
    missionVisibility: 'exclusive',
    treasuryWalletFromDefault: true,
    // 가스 가격 ~146 wei 라 지급 한 건이 ~1e-11 BTC. 0.002 BTC 면 사실상 무제한이고,
    // 그 아래로 내려가면 누가 다른 용도로 꺼냈다는 뜻이라 알린다.
    operatorGas: {
      warnWei: '2000000000000000', // 0.002 BTC
      criticalWei: '500000000000000', // 0.0005 BTC
      faucetUrl: 'https://faucet.test.mezo.org',
      // HST 원장은 DB — 이 체인에서 서명하는 지갑은 MUSD·MEZO 보상 지급 지갑이다.
      walletKind: 'MEZO_REWARDS',
    },
    label: 'Mezo Testnet',
  },
  mezo: {
    id: 'mezo',
    chain: mezoMainnet,
    chainId: mezoMainnet.id,
    rpcUrl: MEZO_RPC_URLS[0],
    rpcUrls: MEZO_RPC_URLS,
    usdt: {
      address:
        (process.env.MEZO_MUSD as `0x${string}`) || MEZO_MUSD_MAINNET_DEFAULT,
      decimals: 18,
    },
    paymentToken: MEZO_PAYMENT_TOKEN,
    // 실자산 체인 — HST 원장·민팅 없음 (Monad 메인넷과 같은 등급). 미션·지갑 전환만.
    hstEnabled: false,
    explorerUrl: 'https://explorer.mezo.org',
    explorerApiUrl: 'https://api.explorer.mezo.org',
    testnet: false,
    missionVisibility: 'exclusive',
    label: 'Mezo',
  },
  'giwa-sepolia': {
    id: 'giwa-sepolia',
    chain: giwaSepolia,
    chainId: giwaSepolia.id,
    // rpcUrl(단일) 은 wallet client 등 기존 소비자용 — fallback 배열의 첫 항목.
    rpcUrl: GIWA_RPC_URLS[0],
    rpcUrls: GIWA_RPC_URLS,
    usdt: {
      // 공개 주소 — registry 기본값. env 는 재배포 시 override 용 (옵션).
      address:
        (process.env.GIWA_TEST_USDT as `0x${string}`) || GIWA_TEST_USDT_DEFAULT,
      decimals: 6,
    },
    paymentToken: { symbol: 'TUSDT', name: 'GIWA Test USDT' },
    collateralFaucetMint: true,
    explorerUrl: 'https://sepolia-explorer.giwa.io',
    testnet: true,
    label: 'GIWA Sepolia (Testnet)',
  },
};

/** 테스트넷 네트워크인지 — `=== 'giwa-sepolia'` 비교 대신 이것을 쓴다. */
export function isTestnetNetwork(id: NetworkId): boolean {
  return NETWORKS[id]?.testnet === true;
}

/** 등록된 NetworkId 인지 (헤더·DTO 입력 방어). */
export function isNetworkId(value: unknown): value is NetworkId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(NETWORKS, value)
  );
}

/**
 * 어드민 Treasury 지갑을 만들 수 있는 체인 — 등록된 EVM 네트워크 전부 + solana.
 * (DTO `@IsIn` 과 컨트롤러 검사가 같은 목록을 본다.)
 */
export const TREASURY_WALLET_NETWORKS: readonly string[] = [
  ...(Object.keys(NETWORKS) as NetworkId[]),
  'solana',
];

/** 미션 피드 `selectedNetwork` 로 받을 수 있는 값 — 등록된 EVM 네트워크 전부 + solana. */
export const SELECTABLE_MISSION_NETWORKS: readonly string[] =
  TREASURY_WALLET_NETWORKS;

export function getNetwork(id: NetworkId = DEFAULT_NETWORK): NetworkConfig {
  const net = NETWORKS[id];
  if (!net) {
    throw AppError.bad(
      ErrorCode.NETWORK_UNSUPPORTED,
      `지원하지 않는 네트워크: ${id}`,
    );
  }
  return net;
}

/** 등록된 모든 NetworkId (Token/FundAccount/HstTreasury 네트워크별 시드 루프에 사용). */
export const ALL_NETWORK_IDS: NetworkId[] = Object.keys(NETWORKS).filter(
  (id) => NETWORKS[id as NetworkId].hstEnabled !== false,
) as NetworkId[];

/** 기본(bsc) 을 뺀 원장 네트워크 — 네트워크 스코프 캐시 키(tokensMy·sbtFeeDiscount) 무효화 루프용. */
export const NON_DEFAULT_LEDGER_NETWORK_IDS: NetworkId[] =
  ALL_NETWORK_IDS.filter((id) => id !== DEFAULT_NETWORK);

/**
 * 잘못되거나 없는 값은 조용히 DEFAULT_NETWORK('bsc') 로 폴백 — 요청 헤더 `X-Network`
 * 파싱 전용. 미지정/불량 요청이 기존(bsc)과 100% 동일하게 동작해야 하는 규약.
 */
export function parseNetworkId(raw: unknown): NetworkId {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NETWORKS, v))
      return v as NetworkId;
  }
  return DEFAULT_NETWORK;
}

/**
 * chainId → NetworkId 역매핑. 등록 안 된 chainId 는 null.
 * (예: MintSnapshot.chainId 56/97 → 'bsc' 은 legacyChainIdsFor 로 커버 — 97 은 BSC 테스트넷.)
 */
export function networkIdForChainId(
  chainId: number | null | undefined,
): NetworkId | null {
  if (chainId == null) return null;
  for (const id of Object.keys(NETWORKS) as NetworkId[]) {
    if (NETWORKS[id].chainId === chainId) return id;
  }
  // BSC 테스트넷(97) legacy rows — bsc 장부로 취급.
  if (chainId === 97) return 'bsc';
  return null;
}

/**
 * 네트워크에 귀속되는 MintSnapshot.chainId 목록.
 * bsc 는 legacy(null 저장 행 별도 처리) + 56(mainnet) + 97(testnet) 을 포함.
 */
export function mintSnapshotChainIdsFor(id: NetworkId): number[] {
  if (id === 'bsc') return [NETWORKS.bsc.chainId, 97];
  return [NETWORKS[id].chainId];
}

/**
 * 네트워크의 USDT 설정 반환. GIWA_TEST_USDT 미설정(placeholder) 상태에서
 * 실제로 USDT 주소를 쓰려고 하면 명확하게 throw — 조용한 zero-address 송금 방지.
 */
export function requireUsdt(id: NetworkId = DEFAULT_NETWORK): {
  address: `0x${string}`;
  decimals: number;
} {
  const net = getNetwork(id);
  if (!net.usdt.address || net.usdt.address === ZERO_ADDRESS) {
    throw AppError.bad(
      ErrorCode.NETWORK_USDT_NOT_CONFIGURED,
      `${net.label} 결제 토큰(${paymentSymbolOf(id)}) 컨트랙트 주소가 설정되지 않았습니다`,
    );
  }
  return net.usdt;
}

/**
 * 온체인 receipt 대기 상한 (ms).
 *
 * ★ 왜 필요한가 (2026-09-08 전면 장애)
 *   viem 의 `waitForTransactionReceipt` 는 기본이 **무한 폴링** 이다. transport 에는
 *   15초 타임아웃이 걸려 있어 개별 RPC 호출은 안 멈추지만, 폴링 루프 자체는 끝나지
 *   않는다. nonce 경합("replacement transaction underpriced", 2026-09-07)으로 채굴되지
 *   못한 tx 를 기다리며 6.4시간을 버텼고, 그 대기가 **Prisma 트랜잭션 안** 이었던 탓에
 *   DB 락과 커넥션을 그대로 붙잡아 사이트 전체가 500 이 됐다.
 *
 *   2026-09-23 부터 체인 write 와 영수증 대기는 Prisma 트랜잭션 **밖** 에서만 돈다
 *   (ChainSettlementService, no-network-in-transaction.spec). 이 값은 이제 DB 예산과
 *   무관하며, 큐 한 작업이 붙잡히는 상한(operator 지갑 nonce 직렬화)만 정한다.
 */
export const RECEIPT_TIMEOUT_MS = 75_000;

/**
 * 네트워크별 viem transport — **읽기 클라이언트와 지갑(전송) 클라이언트가 같이 쓴다.**
 *
 * ★ 왜 한 곳에서 만드나 (2026-09-10 민팅 실패 16건)
 *   fallback 은 읽기 클라이언트(BscReaderService)에만 들어가 있었고, 실제로 서명·전송을
 *   하는 지갑 클라이언트는 `http(config.rpcUrl)` 단일 엔드포인트에 묶여 있었다.
 *   그래서 기본 LB 가 "over rate limit" 을 뱉는 순간, 읽기는 두 번째 엔드포인트로 넘어가
 *   멀쩡한데 `eth_sendRawTransaction` 만 그대로 실패해 유저 민팅이 500 으로 죽었다.
 *   (하루에 서로 다른 유저 16명.) 두 경로가 갈라질 수 있는 구조 자체가 원인이라
 *   transport 생성을 여기 한 곳으로 모은다.
 *
 * bsc 는 rpcUrls 미정의 → 기존 단일 http 그대로 (프로덕션 경로 무변경).
 */
export function makeTransport(
  config: NetworkConfig,
  options: { lane?: GiwaRpcLane } = {},
) {
  if (config.id === 'giwa-sepolia') {
    const urls = giwaUrls(config);
    const lane = options.lane ?? 'read';
    // Retries belong to the shared budget, not nested HTTP/fallback layers.
    // Five logical starts/sec, at most four in flight, and a bounded 5s queue.
    // 레인은 우선순위만 바꾼다 (총량은 URL 집합별 예산 하나를 공유).
    const providers = urls.map((url) =>
      withGiwaEndpointCooldown(
        url,
        http(url, { timeout: 15_000, retryCount: 0 }),
        // 전송·유저 레인은 쿨다운 힌트를 무시하고 실제로 호출한다 — 유저 읽기는 초당 0.6회라 헛호출
        // 비용이 없고, 가짜 429 로 503 을 내는 것이 훨씬 비싸다 (giwa-rpc-budget ENDPOINT_COOLDOWN_CAP_MS 주석).
        { honorCooldown: lane === 'read' || lane === 'bulk' },
      ),
    );
    const base =
      providers.length > 1
        ? fallback(providers, { rank: false, retryCount: 0 })
        : providers[0];
    return withGiwaRpcBudget(urls, base, lane);
  }
  return config.rpcUrls && config.rpcUrls.length > 1
    ? withChainIdMemo(
        config.rpcUrls.join(','),
        fallback(
          // 엔드포인트별 http 재시도는 끈다 (Low): viem 기본(3회)이 fallback 재시도(기본 3회) 안에서 겹쳐 한 호출이
          // 같은 URL 로 여러 번 연달아 나갔다. 재시도는 fallback 한 곳에서, 목록 전체를 한 번 더, 잠깐 쉬고 한다.
          config.rpcUrls.map((url) =>
            http(url, { timeout: 15_000, retryCount: 0 }),
          ),
          // rank 비활성 — 항상 [0](기본 LB) 우선, 실패 시에만 다음 엔드포인트.
          { rank: false, retryCount: 1, retryDelay: 300 },
        ),
      )
    : http(config.rpcUrl, { timeout: 15_000 });
}

function giwaUrls(config: NetworkConfig): string[] {
  return config.rpcUrls?.length ? config.rpcUrls : [config.rpcUrl];
}

/**
 * operator nonce(latest/pending) 조회 전용 transport. GIWA 는 엔드포인트 하나에 고정한다
 * ({@link withGiwaStickyEndpoint} 주석). 전송 레인 예산을 쓴다. bsc 는 기존 transport 그대로.
 */
export function makeNonceViewTransport(config: NetworkConfig) {
  if (config.id !== 'giwa-sepolia') return makeTransport(config);
  const urls = giwaUrls(config);
  const providers = urls.map((url) =>
    withGiwaEndpointCooldown(
      url,
      http(url, { timeout: 15_000, retryCount: 0 }),
      { honorCooldown: false },
    ),
  );
  return withGiwaRpcBudget(
    urls,
    withGiwaStickyEndpoint(urls, providers),
    'send',
    'sticky',
  );
}

/** 한 엔드포인트만 부르는 transport (fallback 없음). 채우기 직전 교차 확인용. */
export function makeSingleEndpointTransport(
  config: NetworkConfig,
  index: number,
  lane: GiwaRpcLane = 'send',
) {
  const urls = giwaUrls(config);
  const url = urls[index % urls.length];
  return withGiwaRpcBudget(
    urls,
    withGiwaEndpointCooldown(
      url,
      http(url, { timeout: 15_000, retryCount: 0 }),
      { honorCooldown: lane === 'read' || lane === 'bulk' },
    ),
    lane,
    `endpoint:${index % urls.length}`,
  );
}

/** nonce 조회 엔드포인트 상태 (GIWA 만 의미가 있다). */
export function nonceViewState(config: NetworkConfig): {
  epoch: number;
  index: number;
  endpoints: number;
} {
  if (config.id !== 'giwa-sepolia') return { epoch: 0, index: 0, endpoints: 1 };
  const urls = giwaUrls(config);
  return {
    epoch: giwaStickyEndpointEpoch(urls),
    index: giwaStickyEndpointIndex(urls),
    endpoints: urls.length,
  };
}
