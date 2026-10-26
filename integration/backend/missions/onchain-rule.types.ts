// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/missions/onchain-rule.types.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    On-chain mission rule schema (ANY_TX + eventTopic, USDT_TRANSFER, HST_MINT, ERC20_BALANCE, NATIVE_BALANCE ...).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { parseUnits } from 'viem';
import {
  NETWORKS,
  isNetworkId,
  isTestnetNetwork,
  type NetworkId,
} from '../web3/networks';

/**
 * proofType=ONCHAIN_TX 미션의 검증 규칙 (Mission.onchainRule Json 컬럼).
 *
 * kind:
 *   - ANY_TX         — 유저 지갑이 보낸(from=지갑) 성공 tx 면 통과.
 *                      rule.to 지정 시 해당 컨트랙트/주소로 보낸 tx 만 인정
 *                      (예: TUSDT faucet mint 호출, Mezo 의 임의 컨트랙트 상호작용).
 *                      미션 시작 이전 블록의 tx 는 거절한다 (2026-10-23).
 *                      rule.eventTopic(옵션, to 필수) 지정 시 그 tx receipt 에 to 컨트랙트가 낸
 *                      topics[0] = eventTopic 로그가 있어야 통과 ("지정 이벤트를 발생시킨 tx").
 *   - USDT_TRANSFER  — ERC20 transfer(to, value) 호출을 디코드해서
 *                      보낸이/받는이/금액까지 정확 검증 (Erc20Service.verifyTransfer 위임).
 *                      이름은 역사적이다 — 어떤 ERC-20 이든 쓴다 (GIWA TUSDT, Mezo MUSD).
 *   - HST_MINT       — 결제 토큰 transfer + 그 tx 로 완료된 HST 민팅 스냅샷이 있어야 통과.
 *   - INCOMING_TX    — 유저가 tx 해시를 제출하지 않는다. 기준 시각 이후에 유저 지갑이
 *                      "받은" 네이티브 송금을 서버가 익스플로러에서 직접 찾아 판정.
 *                      파우셋 수령처럼 유저가 발신자가 아닌 행동을 검증할 때 사용.
 *                      네이티브 수신은 이벤트 로그가 없어 RPC 로는 못 잡는다.
 *   - ERC20_BALANCE  — 유저 지갑의 ERC-20 잔액(balanceOf) 이 minAmount 이상이면 통과.
 *                      유저는 아무것도 제출하지 않는다 (예: MUSD 보유, MEZO 보유).
 *   - NATIVE_BALANCE — 유저 지갑의 네이티브 잔액(getBalance) 이 minAmount 이상이면 통과.
 *   - PARTNER_GOAL   — 파트너가 HodlerMissionBridge 에 남긴 달성 기록을 읽어 판정.
 *                      유저는 아무것도 제출하지 않는다.
 *                      ★ 브릿지 컨트랙트 주소는 서버 설정에 고정돼 있고 규칙에는
 *                      goalId 만 담는다. 미션은 누구나 만들 수 있어서, 주소를 규칙에
 *                      넣게 하면 항상 true 를 돌려주는 자기 컨트랙트를 가리켜 보상을
 *                      무한 수령할 수 있다.
 *   - CHOG_TRADE / GIWA_BRIDGE_DEPOSIT — 체인 전용 규칙 (Monad 마켓 / GIWA 공식 브릿지).
 *
 * 네트워크: 범용 규칙은 GENERIC_RULE_NETWORKS (giwa-sepolia · mezo-testnet · mezo) 에서 받는다.
 * bsc 는 실자산 체인이라 PARTNER_GOAL 만 받는다 (기존 동작 유지).
 *
 * 프론트 미러: hodlerstation-app/src/types/mission.ts 의 OnchainRule.
 */
export type OnchainRuleKind =
  | 'CHOG_TRADE'
  | 'GIWA_BRIDGE_DEPOSIT'
  | 'ANY_TX'
  | 'USDT_TRANSFER'
  | 'HST_MINT'
  | 'INCOMING_TX'
  | 'ERC20_BALANCE'
  | 'NATIVE_BALANCE'
  | 'PARTNER_GOAL';

export interface OnchainRule {
  network: NetworkId;
  tokenId?: string;
  tradeSide?: 'BUY' | 'SELL';
  kind: OnchainRuleKind;
  /** ANY_TX 전용 — 대상 컨트랙트/주소 filter (옵션) */
  to?: string;
  /**
   * ANY_TX 전용 — 요구할 이벤트 시그니처 해시 (bytes32 hex, 소문자 정규화, 옵션).
   * keccak256("Transfer(address,address,uint256)") 같은 topics[0] 값. `to` 가 있을 때만 받는다 —
   * 그 컨트랙트(log.address === to)가 낸 로그만 인정한다 (아무 컨트랙트의 같은 이벤트는 증빙이 아니다).
   */
  eventTopic?: string;
  /** USDT_TRANSFER / HST_MINT / ERC20_BALANCE — 검증할 토큰 컨트랙트 주소 */
  tokenContract?: string;
  /** USDT_TRANSFER 전용 — 수취 주소 */
  expectedTo?: string;
  /** USDT_TRANSFER 전용 — 정확 송금액 (사람 단위, 예: 10 = 10 TUSDT) */
  amount?: number;
  /** 토큰 decimals. 미지정 시 그 네트워크 결제 토큰의 decimals (GIWA 6, Mezo 18) */
  decimals?: number;
  /**
   * INCOMING_TX 전용 — 인정할 발신 주소 목록 (예: 파우셋 지갑).
   * 생략하면 본인 지갑을 제외한 모든 발신자를 인정한다.
   */
  fromAddresses?: string[];
  /** INCOMING_TX 전용 — 기준 시각. 'MISSION_START'(기본) 또는 'JOIN'(참여 누른 시각) */
  since?: 'MISSION_START' | 'JOIN';
  /** INCOMING_TX 전용 — 최소 수신 금액 (네이티브, 사람 단위 ETH). 기본 0 = 0 초과면 통과 */
  minValue?: number;
  /**
   * INCOMING_TX 전용 — fromAddresses 에 걸리는 수신이 없을 때 발신자를 가리지 않고 다시 찾는다.
   *
   * 파우셋이 지갑을 바꾸거나 유저가 다른 경로로 가스를 마련하면 allowlist 는 조용히 어긋난다.
   * 유저 입장에서는 받았는데 승인이 안 되고 에러도 안 남는 상태가 된다.
   * 켜두면 1순위로 allowlist 를 보고, 없을 때만 넓혀서 판정한다 (그때 경고 로그를 남긴다).
   */
  fallbackAnySender?: boolean;
  /** ERC20_BALANCE / NATIVE_BALANCE 전용 — 최소 보유량 (사람 단위). 0 초과. */
  minAmount?: number;
  /**
   * PARTNER_GOAL 전용 — HodlerMissionBridge 의 goalId (bytes32 hex).
   * 파트너가 registerGoal 로 만들고 알려준 값을 그대로 넣는다.
   */
  goalId?: string;
}

export const ONCHAIN_TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_REGEX = /^0x[a-fA-F0-9]{64}$/;

/**
 * 범용 EVM 규칙(ANY_TX·USDT_TRANSFER·HST_MINT·INCOMING_TX·잔액)을 받는 네트워크.
 * 새 EVM 네트워크를 미션에 열려면 여기와 프론트 types/mission.ts 의 GENERIC_RULE_NETWORKS 에 더한다.
 */
export const GENERIC_RULE_NETWORKS: readonly NetworkId[] = [
  'giwa-sepolia',
  'mezo-testnet',
  'mezo',
];

/** PARTNER_GOAL 을 받는 네트워크 — 브릿지 배포 여부는 실행 시 requireMissionBridgeContract 가 본다. */
export const PARTNER_GOAL_NETWORKS: readonly NetworkId[] = [
  'giwa-sepolia',
  'bsc',
  'mezo-testnet',
  'mezo',
];

export const SUPPORTED_ONCHAIN_NETWORKS: readonly NetworkId[] = [
  ...GENERIC_RULE_NETWORKS,
  'monad',
  'monad-testnet',
];

/** 유저가 tx 해시를 내지 않고 서버가 지갑 상태를 읽어 판정하는 규칙 종류. */
export const BALANCE_RULE_KINDS: readonly OnchainRuleKind[] = [
  'ERC20_BALANCE',
  'NATIVE_BALANCE',
];

export function isBalanceRuleKind(kind: unknown): kind is 'ERC20_BALANCE' | 'NATIVE_BALANCE' {
  return kind === 'ERC20_BALANCE' || kind === 'NATIVE_BALANCE';
}

/** 유저 제출물 없이 서버가 판정하는 규칙 (해시 입력 UI 없음). */
export function isAutoDetectRuleKind(kind: unknown): boolean {
  return (
    kind === 'INCOMING_TX' || kind === 'PARTNER_GOAL' || isBalanceRuleKind(kind)
  );
}

const isAddr = (v: unknown): v is string =>
  typeof v === 'string' && EVM_ADDRESS_REGEX.test(v);

const isPositiveFinite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 양의 유한 수를 지수 표기 없는 십진 문자열로 (parseUnits 입력). 소수 자릿수가 maxFraction 을 넘으면 null.
 * 생성 검증과 증명 읽기가 같은 함수를 써서, 저장된 규칙이 읽기 시점에 갑자기 무효가 되지 않는다.
 */
export function plainAmountString(
  v: unknown,
  maxFraction = 18,
): string | null {
  if (!isPositiveFinite(v)) return null;
  const text = v.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const fraction = text.split('.')[1] ?? '';
  return fraction.length <= maxFraction ? text : null;
}
const isPlainAmount = (v: unknown): v is number =>
  plainAmountString(v) !== null;

/**
 * 보유 규칙의 최소 보유량을 토큰 최소 단위로 (2026-10-25 B-4). 이 decimals 로 표현할 수 없는 소수 자릿수가 있거나
 * (parseUnits 는 넘치는 자릿수를 말없이 반올림한다) 최소 단위로 0 이 되면 null — 그 규칙은 받지 않는다.
 */
export function balanceRuleRequiredUnits(
  minAmount: unknown,
  decimals: number,
): bigint | null {
  const text = plainAmountString(minAmount, decimals);
  if (text === null) return null;
  try {
    const units = parseUnits(text, decimals);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

function parseDecimals(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= 18
    ? raw
    : null;
}

/** 미션 생성 입력에서만 거절하는 잔액 규칙 문제 (저장된 규칙 읽기는 parseOnchainRule 그대로). */
export type BalanceRuleInputProblem =
  | 'decimals_required'
  | 'min_amount_unrepresentable';

/**
 * 미션 생성 입력의 잔액 규칙을 본다 (2026-10-25 E2E). parseOnchainRule 은 decimals 가 없으면 그 네트워크 결제
 * 토큰의 decimals 를 쓰는데, 임의 ERC20 컨트랙트에 그 값을 붙이면 6자리 토큰이 10^12 배 많은 보유를 요구하는
 * 규칙이 말없이 만들어진다. 그래서 새 규칙은 결제 토큰이 아닌 컨트랙트면 decimals 를 꼭 받는다 (프론트 빌더도
 * 같은 규칙, db717fc7). 결제 토큰은 레지스트리 decimals 가 정답이라 생략해도 된다.
 * minAmount 가 그 decimals 로 표현되지 않으면 일반 문구 대신 그 이유를 돌려준다.
 */
export function balanceRuleInputProblem(
  raw: unknown,
): BalanceRuleInputProblem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isNetworkId(r.network)) return null;
  const network = r.network;
  if (r.kind === 'ERC20_BALANCE') {
    if (!isAddr(r.tokenContract)) return null;
    const payment = NETWORKS[network].usdt;
    const isPaymentToken =
      !!payment.address &&
      payment.address.toLowerCase() === r.tokenContract.toLowerCase();
    if (r.decimals === undefined && !isPaymentToken) return 'decimals_required';
    const decimals = parseDecimals(r.decimals, payment.decimals);
    if (decimals === null) return null;
    if (
      isPositiveFinite(r.minAmount) &&
      balanceRuleRequiredUnits(r.minAmount, decimals) === null
    )
      return 'min_amount_unrepresentable';
    return null;
  }
  if (r.kind === 'NATIVE_BALANCE') {
    if (
      isPositiveFinite(r.minAmount) &&
      balanceRuleRequiredUnits(
        r.minAmount,
        NETWORKS[network].chain.nativeCurrency.decimals,
      ) === null
    )
      return 'min_amount_unrepresentable';
  }
  return null;
}

/**
 * onchainRule shape 검증 (defensive) — DB Json / DTO 입력 양쪽에서 사용.
 * 통과 시 정규화된 OnchainRule 반환, 실패 시 null.
 */
export function parseOnchainRule(raw: unknown): OnchainRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isNetworkId(r.network)) return null;
  const network = r.network;

  // PARTNER_GOAL 은 브릿지가 배포된 체인이면 되므로 network 를 따로 본다.
  if (r.kind === 'PARTNER_GOAL') {
    if (!PARTNER_GOAL_NETWORKS.includes(network)) return null;
    if (typeof r.goalId !== 'string' || !BYTES32_REGEX.test(r.goalId))
      return null;
    return {
      network,
      kind: 'PARTNER_GOAL',
      goalId: r.goalId.toLowerCase(),
    };
  }

  if (network === 'monad' || network === 'monad-testnet') {
    if (r.kind !== 'CHOG_TRADE') return null;
    if (
      r.tokenId !== undefined &&
      (typeof r.tokenId !== 'string' ||
        !/^(0|[1-9][0-9]{0,77})$/.test(r.tokenId) ||
        BigInt(r.tokenId) >= 2n ** 256n)
    )
      return null;
    if (r.tradeSide !== 'BUY' && r.tradeSide !== 'SELL') return null;
    return {
      network,
      kind: 'CHOG_TRADE',
      tradeSide: r.tradeSide,
      ...(r.tokenId !== undefined ? { tokenId: r.tokenId } : {}),
    };
  }
  if (!GENERIC_RULE_NETWORKS.includes(network)) return null;
  // 실자산 체인(테스트넷이 아닌 범용 규칙 네트워크, 예: mezo 메인넷)에서는 송금·민팅 완료 규칙을 받지 않는다 —
  // 누구나 만드는 미션이 임의 주소로 실 MUSD 송금을 요구하게 되고, 메인넷에는 HST 민팅이 없다.
  // 잔액 보유·ANY_TX·INCOMING_TX·PARTNER_GOAL 만 허용한다.
  if (
    !isTestnetNetwork(network) &&
    (r.kind === 'USDT_TRANSFER' || r.kind === 'HST_MINT')
  )
    return null;
  if (r.kind === 'GIWA_BRIDGE_DEPOSIT') {
    if (network !== 'giwa-sepolia') return null;
    // Addresses, direction, amount and launch cutoff cannot be overridden by mission input.
    if (Object.keys(r).some((key) => key !== 'network' && key !== 'kind'))
      return null;
    return { network: 'giwa-sepolia', kind: 'GIWA_BRIDGE_DEPOSIT' };
  }
  if (
    r.kind !== 'ANY_TX' &&
    r.kind !== 'USDT_TRANSFER' &&
    r.kind !== 'HST_MINT' &&
    r.kind !== 'INCOMING_TX' &&
    r.kind !== 'ERC20_BALANCE' &&
    r.kind !== 'NATIVE_BALANCE'
  )
    return null;

  const paymentDecimals = NETWORKS[network].usdt.decimals;

  if (r.kind === 'ANY_TX') {
    if (r.to !== undefined && !isAddr(r.to)) return null;
    if (r.eventTopic !== undefined) {
      // 이벤트 조건은 발생 컨트랙트가 고정될 때만 의미가 있다 (아무 컨트랙트나 같은 시그니처를 낼 수 있다).
      if (r.to === undefined) return null;
      if (typeof r.eventTopic !== 'string' || !BYTES32_REGEX.test(r.eventTopic))
        return null;
    }
    return {
      network,
      kind: 'ANY_TX',
      ...(r.to !== undefined ? { to: r.to.toLowerCase() } : {}),
      ...(typeof r.eventTopic === 'string'
        ? { eventTopic: r.eventTopic.toLowerCase() }
        : {}),
    };
  }

  if (r.kind === 'INCOMING_TX') {
    let fromAddresses: string[] | undefined;
    if (r.fromAddresses !== undefined) {
      if (!Array.isArray(r.fromAddresses)) return null;
      if (!r.fromAddresses.every(isAddr)) return null;
      fromAddresses = r.fromAddresses.map((a) => (a as string).toLowerCase());
    }
    if (
      r.since !== undefined &&
      r.since !== 'MISSION_START' &&
      r.since !== 'JOIN'
    )
      return null;
    if (
      r.minValue !== undefined &&
      (typeof r.minValue !== 'number' ||
        !Number.isFinite(r.minValue) ||
        r.minValue < 0)
    )
      return null;
    if (
      r.fallbackAnySender !== undefined &&
      typeof r.fallbackAnySender !== 'boolean'
    )
      return null;
    return {
      network,
      kind: 'INCOMING_TX',
      ...(fromAddresses ? { fromAddresses } : {}),
      // Accept the legacy JOIN value but never use enrollment as eligibility.
      since: 'MISSION_START',
      ...(r.minValue !== undefined ? { minValue: r.minValue } : {}),
      ...(r.fallbackAnySender !== undefined
        ? { fallbackAnySender: r.fallbackAnySender }
        : {}),
    };
  }

  if (r.kind === 'ERC20_BALANCE') {
    if (!isAddr(r.tokenContract)) return null;
    if (!isPlainAmount(r.minAmount)) return null;
    const decimals = parseDecimals(r.decimals, paymentDecimals);
    if (decimals === null) return null;
    if (balanceRuleRequiredUnits(r.minAmount, decimals) === null) return null;
    return {
      network,
      kind: 'ERC20_BALANCE',
      tokenContract: r.tokenContract.toLowerCase(),
      minAmount: r.minAmount,
      decimals,
    };
  }

  if (r.kind === 'NATIVE_BALANCE') {
    if (!isPlainAmount(r.minAmount)) return null;
    if (
      balanceRuleRequiredUnits(
        r.minAmount,
        NETWORKS[network].chain.nativeCurrency.decimals,
      ) === null
    )
      return null;
    return {
      network,
      kind: 'NATIVE_BALANCE',
      minAmount: r.minAmount,
      decimals: NETWORKS[network].chain.nativeCurrency.decimals,
    };
  }

  // USDT_TRANSFER / HST_MINT — tokenContract / expectedTo / amount 필수
  if (!isAddr(r.tokenContract)) return null;
  if (!isAddr(r.expectedTo)) return null;
  if (!isPositiveFinite(r.amount)) return null;
  const decimals = parseDecimals(r.decimals, paymentDecimals);
  if (decimals === null) return null;

  return {
    network,
    kind: r.kind,
    tokenContract: r.tokenContract.toLowerCase(),
    expectedTo: r.expectedTo.toLowerCase(),
    amount: r.amount,
    decimals,
  };
}
