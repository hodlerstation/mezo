// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/missions/onchain-proof.service.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    On-chain proof verifier over the Mezo RPC (mission types A-E).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import {
  decodeEventLog,
  erc20Abi,
  formatUnits,
  isAddress,
  parseAbi,
  type PublicClient,
  type Transaction,
} from 'viem';
import { EnvioSourceError } from '../vendor/monad/envio-mission-event-source';
import { CHOG_MARKET_ADDRESS } from '../avatar/chog/chog-market.constants';
import {
  MISSION_EVENT_SOURCE,
  type MissionEventSource,
  RpcMissionEventSource,
} from './mission-event-source';
import { MintSnapshots } from '../treasury/mint-snapshot.store';
import {
  verifyGiwaBridgeDeposit,
  bridgeUnavailable,
  type BridgeEvidence,
} from './giwa-bridge-proof';
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getNetwork, paymentSymbolOf, type NetworkId } from '../web3/networks';
import {
  isEvmRewardNetwork,
  rewardAssetsFor,
  rewardTokenAddress,
} from '../solana/evm-reward-networks';

/**
 * Symbol of a token the platform knows on this network (payment token or an
 * EVM reward asset such as MEZO), for user-facing messages. Unknown → null.
 * Before this the balance failure read "hold at least 1  (current 0 )".
 */
export function knownTokenSymbol(
  network: NetworkId,
  tokenContract: string | undefined,
): string | null {
  const token = tokenContract?.toLowerCase();
  if (!token) return null;
  if (getNetwork(network).usdt.address?.toLowerCase() === token)
    return paymentSymbolOf(network);
  if (!isEvmRewardNetwork(network)) return null;
  for (const asset of rewardAssetsFor(network)) {
    if (asset === 'NATIVE') continue;
    if (rewardTokenAddress(network, asset)?.toLowerCase() === token) return asset;
  }
  return null;
}
import { BscReaderService } from '../web3/bsc-reader.service';
import { ChainTruth, isKnown, toUnknown, type Truth } from '../web3/chain-truth';
import { amountToUnits, Erc20Service } from '../web3/erc20.service';
import {
  ExplorerApiService,
  type ExplorerTx,
} from '../web3/explorer-api.service';
import {
  OnchainRule,
  ONCHAIN_TX_HASH_REGEX,
  isBalanceRuleKind,
  parseOnchainRule,
  balanceRuleRequiredUnits,
} from './onchain-rule.types';
import {
  MISSION_BRIDGE_ABI,
  requireMissionBridgeContract,
} from '../hst-ledger/onchain/hst-contracts';

export interface OnchainVerifyResult {
  ok: boolean;
  reason?: string;
  bridge?: BridgeEvidence;
  /** Stable failure code the client localizes (bridge missions). */
  code?: string;
  params?: Record<string, string | number>;
}

export interface OnchainDiscoverResult {
  ok: boolean;
  /**
   * 조건을 만족하는 tx 해시 목록 (최신순).
   * 호출자가 글로벌 재사용 여부를 확인한 뒤 미사용 해시 하나를 증빙으로 채택한다.
   */
  hashes: string[];
  /**
   * allowlist 에 걸리는 수신이 없어 발신자를 가리지 않고 찾은 결과인지.
   * true 가 반복되면 파우셋이 지갑을 바꿨다는 신호다 — rule.fromAddresses 를 갱신할 것.
   */
  usedFallback?: boolean;
  reason?: string;
}

/**
 * 사람 단위 네이티브 코인 -> wei. 공용 amountToUnits (가장 짧은 십진 표기 → parseUnits) 를 쓴다.
 * 예전 `toFixed(18)` 은 0.1 을 0.100000000000000006 으로 만들어 최소 금액을 6 wei 올렸고 1e21 이상에서 던졌다 (M1).
 */
function toWei(eth: number): bigint {
  return amountToUnits(eth, 18);
}

/** Erc20Service.verifyTransfer reason 코드 → 사용자 노출 한국어 메시지 */
const TRANSFER_FAIL_REASONS: Record<string, string> = {
  tx_not_found:
    '트랜잭션을 찾을 수 없습니다. 해시를 확인하고 블록 컨펌 후 다시 시도해주세요.',
  tx_reverted:
    '트랜잭션이 실패(revert)했습니다. 성공한 트랜잭션 해시를 제출해주세요.',
  wrong_contract: '지정된 토큰 컨트랙트로 보낸 트랜잭션이 아닙니다.',
  wrong_chain:
    '이 미션의 네트워크에서 보낸 트랜잭션이 아닙니다. / This transaction was not sent on this mission\'s network.',
  wrong_sender: '연결된 지갑에서 보낸 트랜잭션이 아닙니다.',
  not_transfer_call:
    'ERC20 transfer 호출이 아닙니다. 토큰 전송 트랜잭션을 제출해주세요.',
  wrong_recipient: '수취 주소가 미션 조건과 다릅니다.',
  amount_mismatch: '전송 금액이 미션 조건과 다릅니다.',
  transfer_event_mismatch:
    '트랜잭션의 토큰 전송 기록(Transfer 이벤트)이 송금 내용과 맞지 않습니다. 일반 토큰 송금 트랜잭션을 제출해주세요. / The token Transfer events in this transaction do not match the transfer. Submit a plain token transfer.',
  insufficient_confirmations:
    '블록 컨펌이 아직 부족합니다. 잠시 후 다시 제출해주세요. / Not enough confirmations yet, please resubmit shortly.',
  confirmation_check_failed:
    '지금은 체인 조회가 지연되어 확인할 수 없습니다. 잠시 후 다시 제출해주세요. / Chain lookup is delayed right now, please resubmit shortly.',
};

const CHAIN_DELAYED_REASON =
  '지금은 체인 조회가 지연되어 확인할 수 없습니다. 잠시 후 다시 제출해주세요. / Chain lookup is delayed right now, please resubmit shortly.';

/** 미션 시작 이전 블록의 tx (ANY_TX · USDT_TRANSFER · HST_MINT 공통). */
const PREDATES_MISSION_REASON =
  '미션 시작 이전의 트랜잭션입니다. 미션 시작 후 보낸 트랜잭션 해시를 제출해주세요. / This transaction predates the mission. Submit one sent after the mission started.';

/** ANY_TX + eventTopic: 지정 컨트랙트가 지정 이벤트를 내지 않은 tx. */
const EVENT_MISSING_REASON =
  '미션이 지정한 이벤트가 이 트랜잭션에서 발생하지 않았습니다. 대상 컨트랙트에서 해당 동작을 완료한 트랜잭션 해시를 제출해주세요. / This transaction did not emit the event the mission requires. Submit the hash of a transaction that completed that action on the target contract.';

/**
 * ONCHAIN_TX 미션 증빙 자동 검증기 (GIWA Sepolia).
 *
 *   - ANY_TX: from=유저 지갑 && receipt success (+옵션 to filter)
 *   - USDT_TRANSFER: Erc20Service.verifyTransfer 위임 (보낸이/받는이/금액 정확 검증)
 *
 * 방어 원칙: 어떤 입력/RPC 오류도 throw 하지 않고 { ok:false, reason } 로 수렴 —
 * 호출자(submitCompletion)가 reason 을 그대로 사용자에게 노출하고 재시도 허용.
 */
@Injectable()
export class OnchainProofService {
  private bridgeReads = 0;
  private readonly logger = new Logger(OnchainProofService.name);
  private readonly truth = new ChainTruth();

  constructor(
    private readonly reader: BscReaderService,
    private readonly erc20: Erc20Service,
    private readonly explorer: ExplorerApiService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(MISSION_EVENT_SOURCE)
    private readonly events: MissionEventSource = new RpcMissionEventSource(),
  ) {}

  /**
   * INCOMING_TX 전용 — 유저가 해시를 제출하지 않는다.
   * 기준 시각 이후 유저 지갑이 "받은" 네이티브 송금을 익스플로러에서 직접 찾는다.
   *
   * 네이티브 수신은 이벤트 로그가 없어 eth_getLogs 로 못 잡고, 30일치 블록을
   * 훑는 것도 공개 RPC 제한에 걸리므로 Blockscout txlist 를 쓴다.
   *
   * 여러 건이 나오면 전부 반환한다 — 호출자가 이미 다른 미션에 쓴 해시를 걸러내고
   * 남은 것을 채택할 수 있어야 반복 수령한 유저가 막히지 않는다.
   */
  async discoverIncoming(
    rule: OnchainRule,
    userWalletAddress: string,
    sinceUnixSec: number,
  ): Promise<OnchainDiscoverResult> {
    if (!userWalletAddress || typeof userWalletAddress !== 'string') {
      return {
        ok: false,
        hashes: [],
        reason: '지갑 주소가 없습니다. 지갑을 먼저 연결해주세요.',
      };
    }
    const parsed = parseOnchainRule(rule);
    if (!parsed || parsed.kind !== 'INCOMING_TX') {
      return {
        ok: false,
        hashes: [],
        reason:
          '미션의 온체인 검증 규칙이 올바르지 않습니다. 관리자에게 문의해주세요.',
      };
    }

    const wallet = userWalletAddress.toLowerCase();
    const rows = await this.explorer.listAddressTxsSince(
      parsed.network,
      wallet,
      sinceUnixSec,
    );
    // null = 조회 자체 실패. 빈 배열(= 내역 없음)과 반드시 구분해서 안내한다.
    if (rows === null) {
      return {
        ok: false,
        hashes: [],
        reason:
          '블록 익스플로러 조회에 실패했습니다. 잠시 후 다시 시도해주세요.',
      };
    }

    const minWei = toWei(parsed.minValue ?? 0);
    const allowFrom = parsed.fromAddresses;

    /** 발신자 조건만 뺀 공통 판정 — 받은 tx / 성공 / 자기송금 아님 / 최소 금액. */
    const isQualifyingReceipt = (tx: ExplorerTx) => {
      if (!tx.success) return false;
      // 받은 tx 만. 자기 자신에게 보낸 것은 "받았다" 로 치지 않는다.
      if (tx.to !== wallet) return false;
      if (tx.from === wallet) return false;
      let value: bigint;
      try {
        value = BigInt(tx.value);
      } catch {
        return false;
      }
      return value > 0n && value >= minWei;
    };

    const hasAllowlist = !!allowFrom && allowFrom.length > 0;
    // 1순위 — allowlist 에 있는 발신자(파우셋 지갑)에게서 받은 것.
    let matched = rows.filter(
      (tx) =>
        isQualifyingReceipt(tx) &&
        (!hasAllowlist || allowFrom.includes(tx.from)),
    );
    let usedFallback = false;

    // 2순위 — allowlist 에 걸리는 게 없으면 발신자를 가리지 않고 다시 찾는다.
    // 파우셋이 지갑을 바꾸거나 유저가 다른 경로로 가스를 마련한 경우까지 살린다.
    if (matched.length === 0 && hasAllowlist && parsed.fallbackAnySender) {
      matched = rows.filter(isQualifyingReceipt);
      if (matched.length > 0) {
        usedFallback = true;
        const senders = [...new Set(matched.map((tx) => tx.from))];
        this.logger.warn(
          `[INCOMING_TX fallback] allowlist 밖 발신자로 승인 — wallet=${wallet} ` +
            `senders=${senders.slice(0, 3).join(',')} ` +
            `(파우셋 지갑이 바뀌었을 수 있음: onchainRule.fromAddresses 갱신 검토)`,
        );
      }
    }

    const hashes = matched.map((tx) => tx.hash);

    if (hashes.length === 0) {
      return {
        ok: false,
        hashes: [],
        reason:
          '조건에 맞는 수신 내역을 찾지 못했습니다. 수령 후 블록 확정까지 잠시 기다린 뒤 다시 확인해주세요.',
      };
    }
    return { ok: true, hashes, usedFallback };
  }

  /**
   * PARTNER_GOAL — 파트너가 HodlerMissionBridge 에 남긴 달성 기록을 읽어 판정한다.
   * 유저는 아무것도 제출하지 않는다 (INCOMING_TX 와 같은 UX).
   *
   * 브릿지 주소는 레지스트리에서만 가져온다. 미션 규칙이 주소를 정하게 하면 미션
   * 생성자가 항상 true 를 돌려주는 자기 컨트랙트를 가리킬 수 있다.
   */
  async verifyPartnerGoal(
    rule: OnchainRule,
    wallet: string,
    /**
     * 이 시각(unix seconds) 이전에 기록된 달성은 인정하지 않는다. 보통 미션 시작 시각.
     * 없으면 파트너가 과거 달성자 명단을 한꺼번에 올리는 것만으로 미션 개설 즉시
     * 전원이 승인되어 에스크로가 한 번에 빠져나간다.
     */
    notBefore?: number,
  ): Promise<OnchainVerifyResult> {
    if (rule.kind !== 'PARTNER_GOAL' || !rule.goalId) {
      return {
        ok: false,
        reason: '미션 설정이 올바르지 않습니다. 운영자에게 문의해 주세요.',
      };
    }
    let bridge: `0x${string}`;
    try {
      bridge = requireMissionBridgeContract(rule.network);
    } catch {
      return {
        ok: false,
        reason:
          '파트너 미션 검증이 아직 준비되지 않았습니다. 운영자에게 문의해 주세요.',
      };
    }
    try {
      // isCompleted 가 아니라 completedAt 을 읽는다. 호출 한 번으로 달성 여부와
      // 시각을 함께 받아 기간 밖 기록을 걸러낸다.
      const achievedAt = Number(
        await this.reader.client(rule.network).readContract({
          address: bridge,
          abi: MISSION_BRIDGE_ABI,
          functionName: 'completedAt',
          args: [rule.goalId as `0x${string}`, wallet as `0x${string}`],
        }),
      );
      if (!achievedAt) {
        return {
          ok: false,
          reason:
            '파트너 쪽에 아직 달성 기록이 없습니다. 목표를 달성했다면 파트너가 기록할 때까지 잠시 기다렸다가 다시 시도해 주세요.',
        };
      }
      if (notBefore !== undefined && achievedAt < notBefore) {
        return {
          ok: false,
          reason:
            '미션이 시작되기 전에 기록된 달성입니다. 이 미션 기간 안의 달성만 인정됩니다.',
        };
      }
      return { ok: true };
    } catch (err) {
      this.logger.warn(
        `[partner-goal] bridge read failed goalId=${rule.goalId} wallet=${wallet}: ${
          (err as Error)?.message ?? err
        }`,
      );
      return {
        ok: false,
        reason: '체인 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.',
      };
    }
  }

  /**
   * 브릿지에 등록된 목표를 조회한다. 미션을 만들기 전에 goalId 가 실재하는지
   * 확인하는 용도 — 오타 하나로 아무도 승인받지 못하는 미션이 만들어지는 것을 막는다.
   *
   * 판정(verifyPartnerGoal)과 달리 "모름"과 "없음"을 구분한다. 체인 조회가 실패하면
   * exists:false 로 단정하지 않고 unavailable 을 돌려준다. 그래야 RPC 장애 때
   * 멀쩡한 goalId 를 "없는 목표" 라고 잘못 막지 않는다.
   */
  async partnerGoalInfo(
    network: NetworkId,
    goalId: string,
  ): Promise<
    | { status: 'found'; owner: string; name: string }
    | { status: 'missing' }
    | { status: 'unavailable'; reason: string }
  > {
    let bridge: `0x${string}`;
    try {
      bridge = requireMissionBridgeContract(network);
    } catch {
      return {
        status: 'unavailable',
        reason: '이 네트워크에는 파트너 브릿지가 아직 배포되지 않았습니다.',
      };
    }
    try {
      const [owner, name] = (await this.reader.client(network).readContract({
        address: bridge,
        abi: MISSION_BRIDGE_ABI,
        functionName: 'goals',
        args: [goalId as `0x${string}`],
      })) as [string, string];
      if (!owner || /^0x0{40}$/i.test(owner)) return { status: 'missing' };
      return { status: 'found', owner: owner.toLowerCase(), name };
    } catch (err) {
      this.logger.warn(
        `[partner-goal] goal lookup failed goalId=${goalId}: ${
          (err as Error)?.message ?? err
        }`,
      );
      return {
        status: 'unavailable',
        reason: '체인 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.',
      };
    }
  }

  /**
   * ERC20_BALANCE / NATIVE_BALANCE — 유저는 아무것도 제출하지 않는다. 지갑 잔액을 서버가 읽어
   * minAmount 이상이면 통과. 잔액은 두 번 읽어 같을 때만 안다 (ChainTruth.balance 와 같은 규칙:
   * 뒤처진 노드 하나의 답으로 승인하거나 거절하지 않는다). 모르면 "잠시 후" 로 돌려 재시도 유도.
   */
  async verifyBalance(
    rule: OnchainRule,
    userWalletAddress: string,
  ): Promise<OnchainVerifyResult> {
    if (!userWalletAddress || !isAddress(userWalletAddress)) {
      return {
        ok: false,
        reason: '지갑 주소가 없습니다. 지갑을 먼저 연결해주세요.',
      };
    }
    const parsed = parseOnchainRule(rule);
    if (!parsed || !isBalanceRuleKind(parsed.kind)) {
      return {
        ok: false,
        reason:
          '미션의 온체인 검증 규칙이 올바르지 않습니다. 관리자에게 문의해주세요.',
      };
    }
    const wallet = userWalletAddress as `0x${string}`;
    const decimals = parsed.decimals ?? 18;
    // decimals 보다 긴 소수·최소 단위 0 은 규칙 파서가 이미 거른다. 예전에 저장된 규칙도 여기서 막는다 (0 이면 누구나 통과).
    const required = balanceRuleRequiredUnits(parsed.minAmount, decimals);
    if (required === null) {
      return {
        ok: false,
        reason:
          '미션의 보유 기준 수량을 읽을 수 없습니다. 관리자에게 문의해주세요.',
      };
    }
    const client = this.reader.userClient(parsed.network);
    try {
      const truth =
        parsed.kind === 'NATIVE_BALANCE'
          ? await this.truth.balance(client, wallet)
          : await this.erc20Balance(
              client,
              parsed.tokenContract as `0x${string}`,
              wallet,
            );
      if (!isKnown(truth)) {
        this.logger.warn(
          `[onchain-proof] balance 모름(${truth.reason}) wallet=${wallet} kind=${parsed.kind}: ${truth.detail}`,
        );
        return { ok: false, reason: CHAIN_DELAYED_REASON };
      }
      if (truth.value < required) {
        const unit =
          parsed.kind === 'NATIVE_BALANCE'
            ? getNetwork(parsed.network).chain.nativeCurrency.symbol
            : knownTokenSymbol(parsed.network, parsed.tokenContract) ?? 'tokens';
        return {
          ok: false,
          reason:
            `보유량이 부족합니다. 최소 ${parsed.minAmount} ${unit} 이상 보유해야 합니다 (현재 ${formatUnits(truth.value, decimals)} ${unit}). / ` +
            `Balance too low: hold at least ${parsed.minAmount} ${unit} (current ${formatUnits(truth.value, decimals)} ${unit}).`.replace(
              /\s{2,}/g,
              ' ',
            ),
        };
      }
      return { ok: true };
    } catch (e) {
      this.logger.warn(
        `onchain balance RPC error — wallet=${wallet} kind=${parsed.kind}: ${(e as Error)?.message ?? e}`,
      );
      return { ok: false, reason: CHAIN_DELAYED_REASON };
    }
  }

  /** ERC-20 balanceOf 를 두 번 읽어 같을 때만 Known (ChainTruth.balance 와 같은 규칙). */
  private async erc20Balance(
    client: PublicClient,
    token: `0x${string}`,
    wallet: `0x${string}`,
  ): Promise<Truth<bigint>> {
    try {
      const read = () =>
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [wallet],
        }) as Promise<bigint>;
      const first = await read();
      const second = await read();
      if (typeof first !== 'bigint' || typeof second !== 'bigint')
        return {
          kind: 'unknown',
          reason: 'error',
          detail: 'balanceOf returned a non-integer value',
        };
      if (first !== second)
        return {
          kind: 'unknown',
          reason: 'lagging',
          detail: `balance moved between reads (${first}→${second})`,
        };
      return { kind: 'known', value: first, observedAt: Date.now() };
    } catch (error) {
      return toUnknown(error);
    }
  }

  async verify(
    rule: OnchainRule,
    txHash: string,
    userWalletAddress: string,
    sinceUnixSec?: number,
  ): Promise<OnchainVerifyResult> {
    // ── 입력 방어 ──
    if (!ONCHAIN_TX_HASH_REGEX.test(txHash)) {
      return {
        ok: false,
        reason: '올바른 트랜잭션 해시 형식이 아닙니다 (0x + 64자리 hex)',
      };
    }
    if (!userWalletAddress || typeof userWalletAddress !== 'string') {
      return {
        ok: false,
        reason: '지갑 주소가 없습니다. 지갑을 먼저 연결해주세요.',
      };
    }
    const parsed = parseOnchainRule(rule);
    if (!parsed) {
      return {
        ok: false,
        reason:
          '미션의 온체인 검증 규칙이 올바르지 않습니다. 관리자에게 문의해주세요.',
      };
    }

    const hash = txHash as `0x${string}`;
    const wallet = userWalletAddress.toLowerCase();

    try {
      if (parsed.kind === 'GIWA_BRIDGE_DEPOSIT') {
        // Reject excess work immediately instead of building an RPC/DB connection queue.
        if (this.bridgeReads >= 4) return bridgeUnavailable();
        this.bridgeReads++;
        try {
          return await verifyGiwaBridgeDeposit(
            this.reader.ethereumSepoliaClient(),
            this.reader.userClient('giwa-sepolia'),
            hash,
            wallet,
            sinceUnixSec!,
          );
        } finally {
          this.bridgeReads--;
        }
      }
      if (parsed.kind === 'USDT_TRANSFER' || parsed.kind === 'HST_MINT') {
        const result = await this.erc20.verifyTransfer({
          txHash: hash,
          tokenContract: parsed.tokenContract as `0x${string}`,
          expectedFrom: userWalletAddress,
          expectedTo: parsed.expectedTo!,
          expectedAmount: parsed.amount!,
          decimals: parsed.decimals ?? 6,
          network: parsed.network,
        });
        if (!result.ok) {
          return {
            ok: false,
            reason:
              TRANSFER_FAIL_REASONS[result.reason ?? ''] ??
              `온체인 검증 실패 (${result.reason ?? 'unknown'})`,
          };
        }
        // ANY_TX 와 같은 규칙: 미션 시작 이전 블록의 송금은 증빙이 아니다.
        if (Number.isSafeInteger(sinceUnixSec)) {
          if (typeof result.blockNumber !== 'bigint')
            return { ok: false, reason: CHAIN_DELAYED_REASON };
          let timestamp: bigint;
          try {
            const block = await this.reader
              .userClient(parsed.network)
              .getBlock({ blockNumber: result.blockNumber });
            if (
              block.number !== result.blockNumber ||
              typeof block.timestamp !== 'bigint'
            )
              return { ok: false, reason: CHAIN_DELAYED_REASON };
            timestamp = block.timestamp;
          } catch (e) {
            this.logger.warn(
              `[onchain-proof] block 조회 실패 tx=${hash} block=${result.blockNumber}: ${(e as Error)?.message ?? e}`,
            );
            return { ok: false, reason: CHAIN_DELAYED_REASON };
          }
          if (timestamp < BigInt(sinceUnixSec!))
            return { ok: false, reason: PREDATES_MISSION_REASON };
        }
        if (parsed.kind === 'HST_MINT') {
          // A transfer is only the payment leg. COMPLETED is written by the
          // mint flow after HST issuance; pending/failed/refunded payments fail.
          // 해시·지갑 주소는 CHECK 로 소문자만 저장된다: 입력을 소문자로 바꿔 고유 인덱스 동등 비교 (lower(col) 금지).
          // 다중 보낸 주소 tx 의 분할 스냅샷은 txHash 가 "<hash>#<sender>" 이므로 관측 행의 보낸 주소로 키를 만든다.
          // 소유: 스냅샷 userId 의 지갑이 제출한 참여자 지갑과 같아야 한다 (walletAddress 는 unique).
          let mint: { id: string } | null;
          try {
            mint = await MintSnapshots.completedPayment(this.prisma, {
              hash: txHash,
              network: parsed.network,
              chainId: getNetwork(parsed.network).chainId,
              walletAddress: wallet,
              usdtIn: parsed.amount!,
            });
          } catch (e) {
            // DB 조회 실패는 체인 문제가 아니다 — 바깥 catch 의 "RPC 조회 실패" 로 알리지 않는다 (Low).
            this.logger.warn(
              `[onchain-proof] mint record lookup failed tx=${hash}: ${(e as Error)?.message ?? e}`,
            );
            return {
              ok: false,
              reason:
                '지금은 HST 민팅 기록을 확인할 수 없습니다 (서버 내부 조회 실패). 잠시 후 다시 제출해주세요. / The HST mint record cannot be checked right now (internal lookup failed). Please resubmit shortly.',
            };
          }
          if (!mint) {
            return {
              ok: false,
              reason:
                'HST 민팅 완료 내역이 없습니다. HST 민팅 페이지에서 스왑을 완료한 뒤 결제 트랜잭션 해시를 제출해주세요. / Complete the swap on the HST Mint page, then submit its payment transaction hash.',
            };
          }
        }
        return { ok: true };
      }

      // ── ANY_TX ──
      // RPC 거절·지연을 "없음" 으로 유저에게 보내지 않는다 (docs/chain-truth-boundary.md 순위 5).
      const receiptTruth = await this.truth.receipt(
        this.reader.userClient(parsed.network),
        hash,
      );
      if (!isKnown(receiptTruth)) {
        this.logger.warn(
          `[onchain-proof] receipt 모름(${receiptTruth.reason}) tx=${hash}: ${receiptTruth.detail}`,
        );
        return {
          ok: false,
          reason:
            '지금은 체인 조회가 지연되어 확인할 수 없습니다. 잠시 후 다시 제출해주세요. / Chain lookup is delayed right now, please resubmit shortly.',
        };
      }
      if (receiptTruth.value === 'absent') {
        return {
          ok: false,
          reason:
            '트랜잭션을 찾을 수 없습니다. 해시를 확인하고 블록 컨펌 후 다시 시도해주세요.',
        };
      }
      const receipt = receiptTruth.value;
      if (receipt.status !== 'success') {
        return {
          ok: false,
          reason:
            '트랜잭션이 실패(revert)했습니다. 성공한 트랜잭션 해시를 제출해주세요.',
        };
      }

      let tx: Transaction;
      try {
        tx = await this.reader
          .userClient(parsed.network)
          .getTransaction({ hash });
      } catch (e) {
        // 정상 "없음" 응답만 tx 없음이다. RPC 거절·지연은 "잠시 후 다시" (chain-truth 순위 5, Low).
        if ((e as { name?: string })?.name !== 'TransactionNotFoundError') {
          this.logger.warn(
            `[onchain-proof] getTransaction 모름 tx=${hash}: ${(e as Error)?.message ?? e}`,
          );
          return { ok: false, reason: CHAIN_DELAYED_REASON };
        }
        return {
          ok: false,
          reason:
            '트랜잭션을 찾을 수 없습니다. 해시를 확인하고 블록 컨펌 후 다시 시도해주세요.',
        };
      }

      if (parsed.kind === 'ANY_TX' || parsed.kind === 'INCOMING_TX') {
        const invalidEvidence = {
          ok: false,
          reason:
            '현재 체인에서 거래 확정을 확인할 수 없습니다. 잠시 후 다시 제출해주세요. / Cannot verify the transaction on the current chain. Please resubmit shortly.',
        };
        if (receipt.blockNumber == null || !receipt.blockHash)
          return invalidEvidence;
        // A successful orphan receipt is not current chain evidence. Fetch the
        // block by height, not by its old hash, to detect a replaced block.
        const client = this.reader.userClient(parsed.network);
        const [chainId, block] = await Promise.all([
          client.getChainId(),
          client.getBlock({ blockNumber: receipt.blockNumber }),
        ]);
        if (
          chainId !== getNetwork(parsed.network).chainId ||
          (tx.chainId != null && tx.chainId !== chainId) ||
          tx.hash?.toLowerCase() !== hash.toLowerCase() ||
          receipt.transactionHash?.toLowerCase() !== hash.toLowerCase() ||
          tx.blockNumber !== receipt.blockNumber ||
          tx.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
          block.number !== receipt.blockNumber ||
          block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
          !block.transactions.some(
            (entry) => entry.toLowerCase() === hash.toLowerCase(),
          )
        ) {
          return invalidEvidence;
        }
        // 미션 시작 이전의 tx 는 증빙이 아니다 (2026-10-23 까지는 ANY_TX 가 오래된 tx 를 받았다 —
        // 해시 재사용 차단만으로는 "미션 전에 한 행동" 을 막지 못한다).
        if (
          parsed.kind === 'ANY_TX' &&
          Number.isSafeInteger(sinceUnixSec) &&
          typeof block.timestamp === 'bigint' &&
          block.timestamp < BigInt(sinceUnixSec!)
        ) {
          return { ok: false, reason: PREDATES_MISSION_REASON };
        }
        if (parsed.kind === 'INCOMING_TX') {
          if (
            !Number.isSafeInteger(sinceUnixSec) ||
            sinceUnixSec! < 0 ||
            typeof block.timestamp !== 'bigint' ||
            block.timestamp < BigInt(sinceUnixSec!) ||
            !tx.from ||
            !isAddress(tx.from) ||
            tx.from.toLowerCase() === wallet ||
            tx.to?.toLowerCase() !== wallet ||
            typeof tx.value !== 'bigint' ||
            tx.value <= 0n ||
            tx.value < toWei(parsed.minValue ?? 0) ||
            (parsed.fromAddresses?.length &&
              !parsed.fromAddresses.includes(tx.from.toLowerCase()) &&
              !parsed.fallbackAnySender)
          )
            return invalidEvidence;
          return { ok: true };
        }
      }

      if (!tx.from || tx.from.toLowerCase() !== wallet) {
        return {
          ok: false,
          reason: '연결된 지갑에서 보낸 트랜잭션이 아닙니다.',
        };
      }
      // With an event rule the target contract's own log is the evidence: users
      // often reach it through a router or aggregator, so tx.to may differ
      // (2026-10-25 Mezo e2e review). Without an event the call target counts.
      if (parsed.to && !(parsed.kind === 'ANY_TX' && parsed.eventTopic)) {
        if (!tx.to || tx.to.toLowerCase() !== parsed.to.toLowerCase()) {
          return {
            ok: false,
            reason: '미션이 지정한 대상 주소로 보낸 트랜잭션이 아닙니다.',
          };
        }
      }
      if (parsed.kind === 'ANY_TX' && parsed.eventTopic) {
        const target = parsed.to?.toLowerCase();
        const topic = parsed.eventTopic.toLowerCase();
        const emitted =
          !!target &&
          (receipt.logs ?? []).some(
            (l) =>
              !(l as { removed?: boolean }).removed &&
              l.address?.toLowerCase() === target &&
              l.topics?.[0]?.toLowerCase() === topic,
          );
        if (!emitted) return { ok: false, reason: EVENT_MISSING_REASON };
      }
      if (parsed.kind === 'CHOG_TRADE') {
        const network = parsed.network;
        const client = this.reader.userClient(network);
        const contract =
          (network === 'monad'
            ? (process.env.CHOG_WEARABLE_MARKET_ADDRESS ?? CHOG_MARKET_ADDRESS)
            : process.env.MONAD_TESTNET_CHOG_MARKET_ADDRESS) ?? '';
        if (
          !isAddress(contract) ||
          tx.to?.toLowerCase() !== contract.toLowerCase() ||
          !Number.isSafeInteger(sinceUnixSec)
        )
          return { ok: false, reason: 'Invalid mission evidence' };
        const [chainId, finalized, block] = await Promise.all([
          client.getChainId(),
          client.getBlock({ blockTag: 'finalized' }),
          client.getBlock({ blockNumber: receipt.blockNumber }),
        ]);
        if (
          chainId !== getNetwork(network).chainId ||
          tx.chainId !== chainId ||
          tx.hash.toLowerCase() !== hash.toLowerCase() ||
          receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
          tx.blockNumber !== receipt.blockNumber ||
          block.hash !== receipt.blockHash ||
          tx.blockHash !== receipt.blockHash ||
          block.timestamp < BigInt(sinceUnixSec!)
        )
          return { ok: false, reason: 'Invalid mission evidence' };
        if (finalized.number < receipt.blockNumber)
          return { ok: false, reason: 'Pending mission evidence' };
        const abi = parseAbi([
          'event Trade(address indexed account,uint256 indexed id,bool buy,uint256 quantity,uint256 amount,uint256 total)',
        ]);
        for (const log of receipt.logs) {
          if (
            log.address.toLowerCase() !== contract.toLowerCase() ||
            log.removed ||
            log.transactionHash?.toLowerCase() !== hash.toLowerCase() ||
            log.blockHash !== receipt.blockHash ||
            log.blockNumber !== receipt.blockNumber ||
            log.logIndex == null ||
            !Number.isSafeInteger(log.logIndex) ||
            log.logIndex < 0
          )
            continue;
          try {
            const event = decodeEventLog({
              abi,
              data: log.data,
              topics: log.topics,
              strict: true,
            });
            const args = event.args;
            if (
              args.account.toLowerCase() !== wallet ||
              args.buy !== (parsed.tradeSide === 'BUY') ||
              args.quantity <= 0n ||
              (parsed.tokenId != null && args.id.toString() !== parsed.tokenId)
            )
              continue;
            let indexed: boolean;
            try {
              indexed = await this.events.indexed({
                chainId,
                contract: contract.toLowerCase(),
                transactionHash: hash.toLowerCase(),
                blockHash: receipt.blockHash.toLowerCase(),
                blockNumber: receipt.blockNumber.toString(),
                logIndex: log.logIndex,
                account: wallet,
                tokenId: args.id.toString(),
                buy: args.buy,
                quantity: args.quantity.toString(),
              });
            } catch (error) {
              // Do not expose endpoint URLs, tokens or untrusted upstream messages.
              const code =
                error instanceof EnvioSourceError
                  ? error.code
                  : 'MISSION_EVENT_SOURCE_UNAVAILABLE';
              this.logger.warn(
                '[onchain-proof] event source failed code=' +
                  code +
                  ' chainId=' +
                  chainId,
              );
              return {
                ok: false,
                reason:
                  '지금은 체인 조회가 지연되어 확인할 수 없습니다. 잠시 후 다시 제출해주세요. / Chain lookup is delayed right now, please resubmit shortly.',
              };
            }
            if (indexed) return { ok: true };
          } catch {
            /* Unrelated or malformed log: continue looking for a matching event. */
          }
        }
        return { ok: false, reason: 'Pending or unmatched mission evidence' };
      }
      return { ok: true };
    } catch (e) {
      // RPC 다운/타임아웃 등 — 사용자 재시도 유도
      this.logger.warn(
        `onchain verify RPC error — tx=${txHash} kind=${parsed.kind}: ${(e as Error)?.message ?? e}`,
      );
      return {
        ok: false,
        reason: `RPC 조회 실패 — ${getNetwork(parsed.network).label} 네트워크 상태를 확인하고 잠시 후 다시 시도해주세요.`,
      };
    }
  }
}
