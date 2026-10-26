// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/lib/web3/networks.ts
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    Frontend network registry (header switch, wallet add/switch chain).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

/**
 * 멀티 네트워크 registry (Single source of truth).
 *
 * BSC 메인넷 = 프로덕션 기본. GIWA Sepolia = ADMIN 전용 테스트넷.
 * 온체인 관련 코드(민팅·잔고·체인 스위치·헤더 칩)는 반드시 이 registry 를 경유 —
 * `bsc.id` / USDT 주소 / decimals 하드코딩 금지.
 *
 * 활성 네트워크 선택은 `src/stores/network-store.ts` (zustand persist).
 * 일반 유저는 항상 'bsc' 고정 — 전환 UI 는 ADMIN 에게만 노출 (settings 페이지).
 */

import { defineChain, type Chain } from "viem";
import { bsc, monad, monadTestnet } from "viem/chains";
import { BSC_USDT_CONTRACT_DEFAULT } from "@/lib/treasury/constants";
import { COLORS } from "@/lib/design-tokens";

export type NetworkId =
  "bsc" | "giwa-sepolia" | "monad" | "monad-testnet" | "mezo" | "mezo-testnet";

/**
 * GIWA Sepolia 테스트 USDT (TUSDT, 6 decimals) — 공개 컨트랙트 주소.
 * BSC USDT 처럼 registry 기본값으로 박음. 새 테스트 토큰 재배포 시 env 로 override.
 * scripts/giwa/deploy-test-usdt.mjs 로 배포.
 */
const GIWA_TEST_USDT_DEFAULT =
  "0xb391db53d9705cb5d63afa6f2b9185403e3e0f6e" as const;

/** GIWA Sepolia 테스트넷 (OP Stack L2). */
export const giwaSepolia = defineChain({
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_GIWA_RPC ?? "https://sepolia-rpc.giwa.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "GIWA Explorer",
      url: "https://sepolia-explorer.giwa.io",
    },
  },
  testnet: true,
});

/**
 * Mezo (Bitcoin L2). 가스 BTC(18 dec), 결제 토큰 MUSD(18 dec), MEZO 는 시스템 주소의 ERC-20.
 * 값 출처: mezo.org/docs (chain id·RPC·explorer·주소). 백엔드 src/web3/networks.ts 와 동기.
 */
export const MEZO_MUSD_TESTNET_DEFAULT =
  "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" as const;
export const MEZO_MUSD_MAINNET_DEFAULT =
  "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186" as const;
/** MEZO ERC-20 — 메인넷·테스트넷 동일 주소. */
export const MEZO_TOKEN_ADDRESS =
  "0x7B7c000000000000000000000000000000000001" as const;
export const MEZO_TESTNET_FAUCET_URL = "https://faucet.test.mezo.org";

/**
 * 지갑 화면에 잔고를 보여 줄 추가 ERC-20 (가스·결제 토큰 외). 예: Mezo 의 MEZO.
 * 표시 전용 — 결제·보상 승인 근거로 쓰지 않는다.
 */
export interface NetworkDisplayAsset {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
}

/** 지갑 자산 스트립에 그리는 MEZO 잔고 (메인넷·테스트넷 같은 주소, 18 dec). */
const MEZO_DISPLAY_ASSETS: readonly NetworkDisplayAsset[] = [
  { symbol: "MEZO", name: "Mezo", address: MEZO_TOKEN_ADDRESS, decimals: 18 },
];

const MEZO_NATIVE_CURRENCY = {
  name: "Bitcoin",
  symbol: "BTC",
  decimals: 18,
} as const;

/** Mezo Testnet (chain 31611). */
export const mezoTestnet = defineChain({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: MEZO_NATIVE_CURRENCY,
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_MEZO_TESTNET_RPC ?? "https://rpc.test.mezo.org",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Mezo Testnet Explorer",
      url: "https://explorer.test.mezo.org",
    },
  },
  testnet: true,
});

/** Mezo Mainnet (chain 31612). */
export const mezoMainnet = defineChain({
  id: 31612,
  name: "Mezo",
  nativeCurrency: MEZO_NATIVE_CURRENCY,
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_MEZO_RPC ?? "https://mezo-mainnet.boar.network",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" },
  },
});

export interface NetworkConfig {
  id: NetworkId;
  chain: Chain;
  chainId: number;
  hstEnabled?: boolean;
  /** 가스·결제 토큰 외에 지갑 자산 스트립에 잔고를 그릴 ERC-20 목록. */
  displayAssets?: readonly NetworkDisplayAsset[];
  usdt: {
    /** 미배포 네트워크는 빈 문자열일 수 있음 — 사용처에서 falsy 방어 필수. */
    address: `0x${string}`;
    decimals: number;
  };
  /**
   * 민팅 결제 토큰 심볼 (bsc USDT · giwa TUSDT · mezo MUSD). 헤더 잔고·민팅 패널·안내 문구는
   * 이 값만 쓴다 — `activeNetwork === "giwa-sepolia" ? "TUSDT" : "USDT"` 같은 분기 금지.
   */
  paymentSymbol: string;
  /** 결제 토큰 전체 이름 (안내 문구용). */
  paymentTokenName: string;
  /**
   * 결제 토큰 transfer 의 고정 가스 한도. 지정하면 지갑이 RPC 로 가스를 추정하지 않는다.
   * Mezo 공개 RPC 는 ERC-20 transfer 를 21,632 처럼 EIP-7623 하한(약 22,580) 아래로 추정해
   * 전송이 "Missing or invalid parameters" 로 실패한다 (2026-10-26 로컬 e2e: 6회 중 2회).
   * 실제 사용량은 약 34,600 이라 100,000 이면 새 잔액 슬롯까지 넉넉하다. 수수료는 사용량만큼만 나간다.
   */
  paymentTransferGas?: bigint;
  /** 테스트넷 가스·토큰 수령처. 없으면 테스트넷 가이드에 faucet 링크를 그리지 않는다. */
  faucetUrl?: string;
  /** 앱 안에서 결제 토큰을 못 찍어 주는 테스트넷의 "결제 토큰 얻는 법" 안내 링크. */
  paymentTokenGuideUrl?: string;
  /**
   * 미션 피드 노출 범위 (백엔드 registry 와 동일 의미).
   *  - shared(기본) 항상 노출 · scoped 골랐을 때만 · exclusive 골랐을 때만 + 그때는 이 네트워크만.
   */
  missionVisibility?: "shared" | "scoped" | "exclusive";
  explorerUrl: string;
  /** 폴백 라벨 (UI 는 i18n `network.labels.{id}` 우선). */
  label: string;
  /**
   * 좁은 헤더(어드민 모바일)용 체인 이름 — 번역하지 않는 고유명사라 i18n 이 아니라
   * 여기서 가져온다. 메인넷/테스트넷 구분은 칩 색(testnet)과 전체 라벨이 맡는다.
   */
  shortLabel: string;
  /**
   * 테스트넷 여부 — 실자산이 아님을 UI 가 드러내야 하는 근거.
   * `id === "giwa-sepolia"` 같은 ad-hoc 비교 금지, 이 필드를 볼 것.
   */
  testnet: boolean;
  /**
   * UI 강조색 (상태 dot · 네트워크 배지 테두리/전경).
   * 메인넷 green, 테스트넷 cyan. 컴포넌트에서 hex 하드코딩 금지 — 여기서만 가져온다.
   */
  accentColor: string;
}

/** Mezo 결제 토큰(MUSD) transfer 고정 가스 한도 — `paymentTransferGas` 주석 참고. */
export const MEZO_PAYMENT_TRANSFER_GAS = 100_000n;

function monadNetwork(
  id: "monad" | "monad-testnet",
  chain: Chain
): NetworkConfig {
  return {
    id,
    chain,
    chainId: chain.id,
    usdt: { address: "" as `0x${string}`, decimals: 18 },
    paymentSymbol: "",
    paymentTokenName: "",
    hstEnabled: false,
    missionVisibility: "scoped",
    explorerUrl: chain.blockExplorers!.default.url,
    label: chain.name,
    shortLabel: "Monad",
    testnet: !!chain.testnet,
    accentColor: COLORS.cyan,
  };
}
export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  monad: monadNetwork("monad", monad),
  "monad-testnet": monadNetwork("monad-testnet", monadTestnet),
  bsc: {
    id: "bsc",
    chain: bsc,
    chainId: bsc.id,
    usdt: {
      address: (process.env.NEXT_PUBLIC_BSC_USDT_CONTRACT ??
        BSC_USDT_CONTRACT_DEFAULT) as `0x${string}`,
      decimals: 18,
    },
    paymentSymbol: "USDT",
    paymentTokenName: "Tether USD (BEP-20)",
    explorerUrl: "https://bscscan.com",
    label: "BSC Mainnet",
    shortLabel: "BSC",
    testnet: false,
    accentColor: COLORS.green,
  },
  "giwa-sepolia": {
    id: "giwa-sepolia",
    chain: giwaSepolia,
    chainId: giwaSepolia.id,
    usdt: {
      // 공개 주소 — registry 기본값. env 는 재배포 시 override 용 (옵션).
      address: (process.env.NEXT_PUBLIC_GIWA_TEST_USDT ||
        GIWA_TEST_USDT_DEFAULT) as `0x${string}`,
      decimals: 6,
    },
    paymentSymbol: "TUSDT",
    paymentTokenName: "GIWA Test USDT",
    faucetUrl: "https://faucet.giwa.io",
    explorerUrl: "https://sepolia-explorer.giwa.io",
    label: "GIWA Testnet",
    shortLabel: "GIWA",
    testnet: true,
    accentColor: COLORS.cyan,
  },
  "mezo-testnet": {
    id: "mezo-testnet",
    chain: mezoTestnet,
    chainId: mezoTestnet.id,
    usdt: {
      address: (process.env.NEXT_PUBLIC_MEZO_TESTNET_MUSD ||
        MEZO_MUSD_TESTNET_DEFAULT) as `0x${string}`,
      decimals: 18,
    },
    paymentSymbol: "MUSD",
    paymentTokenName: "Mezo USD",
    paymentTransferGas: MEZO_PAYMENT_TRANSFER_GAS,
    faucetUrl: MEZO_TESTNET_FAUCET_URL,
    displayAssets: MEZO_DISPLAY_ASSETS,
    // 테스트넷 MUSD 는 faucet 이 없다 — 공식 테스트넷 앱에서 테스트 BTC 담보로 빌린다 (2026-10-23 확인).
    paymentTokenGuideUrl: "https://testnet.mezo.org/",
    missionVisibility: "exclusive",
    explorerUrl: "https://explorer.test.mezo.org",
    label: "Mezo Testnet",
    shortLabel: "Mezo",
    testnet: true,
    accentColor: COLORS.cyan,
  },
  mezo: {
    id: "mezo",
    chain: mezoMainnet,
    chainId: mezoMainnet.id,
    usdt: {
      address: (process.env.NEXT_PUBLIC_MEZO_MUSD ||
        MEZO_MUSD_MAINNET_DEFAULT) as `0x${string}`,
      decimals: 18,
    },
    paymentSymbol: "MUSD",
    paymentTokenName: "Mezo USD",
    paymentTransferGas: MEZO_PAYMENT_TRANSFER_GAS,
    // 실자산 체인 — HST 원장·민팅 없음 (Monad 메인넷과 같은 등급). 미션·지갑 전환만.
    hstEnabled: false,
    displayAssets: MEZO_DISPLAY_ASSETS,
    missionVisibility: "exclusive",
    explorerUrl: "https://explorer.mezo.org",
    label: "Mezo",
    shortLabel: "Mezo",
    testnet: false,
    accentColor: COLORS.green,
  },
};

/** 결제 토큰 심볼 — unknown network 는 기본 네트워크(USDT)로 방어. */
export function paymentSymbolOf(id: NetworkId | string | null | undefined) {
  return getNetwork(toNetworkId(id)).paymentSymbol || "USDT";
}

export const MISSION_NETWORK_IDS = Object.keys(NETWORKS) as NetworkId[];
// Global HST screens keep their existing supported networks.
export const NETWORK_IDS = MISSION_NETWORK_IDS.filter(
  (id) => NETWORKS[id].hstEnabled !== false
);
/**
 * HST 원장이 없는 EVM 네트워크 (monad, monad-testnet, mezo). 헤더에서 고르면
 * `activeNetwork`(원장) 는 그대로 두고 store 의 `nonLedgerSelected` 슬롯에만 들어간다 —
 * 미션 피드·지갑 체인·아바타 마켓은 이 슬롯을 우선 본다.
 */
export function isNonLedgerNetwork(value: unknown): value is NetworkId {
  return isNetworkId(value) && NETWORKS[value].hstEnabled === false;
}

/**
 * 네트워크 "가족" — 메인넷·테스트넷 접미사(`-testnet` · `-sepolia`)를 뗀 이름.
 * `mezo` 와 `mezo-testnet` 은 같은 가족, `giwa-sepolia` 의 가족은 `giwa`.
 * 아바타 마켓(Monad 가족만 CHOG)·원장 안내(가족 안의 HST 원장) 같은 판정은 이 값으로 한다 —
 * 컴포넌트마다 `id.startsWith("monad")` 를 쓰지 않는다.
 */
export function networkFamily(id: unknown): string | null {
  return isNetworkId(id) ? id.replace(/-(testnet|sepolia)$/, "") : null;
}

/**
 * 원장이 없는 네트워크(mezo · monad)를 골랐을 때 안내할 "같은 가족의 HST 원장".
 * mezo → mezo-testnet. Monad 는 가족 안에 원장이 없어 null (호출부가 이전 원장으로 폴백).
 */
export function ledgerNetworkForFamily(id: unknown): NetworkId | null {
  const family = networkFamily(id);
  if (!family) return null;
  return (
    NETWORK_IDS.find((candidate) => networkFamily(candidate) === family) ?? null
  );
}

export const DEFAULT_NETWORK: NetworkId = "bsc";

export function getNetwork(id: NetworkId): NetworkConfig {
  return NETWORKS[isNetworkId(id) ? id : DEFAULT_NETWORK];
}

/** 알 수 없는/누락된 값은 기본 네트워크로 수렴 — 서버가 내려주는 문자열 필드용 방어. */
export function isNetworkId(value: unknown): value is NetworkId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(NETWORKS, value)
  );
}

/**
 * 서버 필드(`mission.network` 등) → NetworkId.
 * 구 데이터는 network 가 없을 수 있으므로 'bsc' 폴백 (백엔드 백필과 동일 규약).
 */
export function toNetworkId(value: unknown): NetworkId {
  return isNetworkId(value) ? value : DEFAULT_NETWORK;
}

/** 테스트넷 여부 — 컴포넌트에서 `id === "giwa-sepolia"` 비교 대신 이 헬퍼 사용. */
export function isTestnetNetwork(
  id: NetworkId | string | null | undefined
): boolean {
  return getNetwork(toNetworkId(id)).testnet;
}

/**
 * "테스트넷 결제 토큰은 실제 가치가 없다" 안내를 그릴 네트워크인가 — HST 원장이 있고 결제
 * 토큰이 있는 테스트넷(giwa-sepolia · mezo-testnet)만. Monad 테스트넷은 결제 토큰·민팅이
 * 없어 "USDT 는 실제 가치가 없습니다" 가 거짓이 된다 (2026-10-23 리뷰).
 */
export function hasTestnetPaymentNotice(id: unknown): id is NetworkId {
  if (!isNetworkId(id)) return false;
  const net = NETWORKS[id];
  return net.testnet && net.hstEnabled !== false && !!net.paymentSymbol;
}

/** 네트워크의 추가 표시 ERC-20 (예: Mezo 의 MEZO). 없으면 빈 배열. */
export function displayAssetsOf(
  id: NetworkId | string | null | undefined
): readonly NetworkDisplayAsset[] {
  return getNetwork(toNetworkId(id)).displayAssets ?? [];
}

/**
 * 숫자 chainId (예: MintSnapshot.chainId) → NetworkConfig.
 * 미등록/누락은 기본 네트워크로 수렴. 97 = BSC 테스트넷 legacy → bsc.
 */
export function networkForChainId(
  chainId: number | null | undefined
): NetworkConfig {
  if (chainId != null) {
    for (const id of MISSION_NETWORK_IDS) {
      if (NETWORKS[id].chainId === chainId) return NETWORKS[id];
    }
    if (chainId === 97) return NETWORKS.bsc;
  }
  return NETWORKS[DEFAULT_NETWORK];
}

/** 익스플로러 tx 상세 URL — unknown network 는 기본 네트워크 익스플로러로 방어. */
export function explorerTxUrl(
  network: NetworkId | string,
  txHash: string
): string {
  const config = NETWORKS[network as NetworkId] ?? NETWORKS[DEFAULT_NETWORK];
  return `${config.explorerUrl}/tx/${txHash}`;
}

/** 익스플로러 주소 상세 URL — unknown network 는 기본 네트워크 익스플로러로 방어. */
export function explorerAddressUrl(
  network: NetworkId | string,
  address: string
): string {
  const config = NETWORKS[network as NetworkId] ?? NETWORKS[DEFAULT_NETWORK];
  return `${config.explorerUrl}/address/${address}`;
}
