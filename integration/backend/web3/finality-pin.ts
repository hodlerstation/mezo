// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/web3/finality-pin.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    Finalized-block pinning shared by BSC / GIWA / Mezo deposit discovery.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { publicChainError } from './public-chain-error';
import { DEFAULT_NETWORK, type NetworkId } from './networks';
import { isRpcNotSent } from './rpc-rate-limit';
import {
  agreeOnRpc,
  hex,
  minAgreeingSources,
  undecidedByNotSent,
  type LogSource,
} from '../treasury/mint-log-sources';

/**
 * 합의 finalized 블록 고정 (8차 D-1).
 *
 * 문제: GIWA Blockscout eth-rpc 는 'finalized'·'safe' 태그와 EIP-1898 블록 해시 인자를 "Invalid block number" 로 거절하고
 * 숫자 블록에만 답한다 (2026-09-16 실측). 태그로 묻는 합의는 GIWA 에서 group 이 하나(노드)뿐이라 늘 판정 불가였다.
 *
 * 방법: 태그를 지원하는 소스들이 준 finalized 번호의 최솟값 F 를 잡고, 모든 소스(Blockscout 포함)에 숫자 블록 hex(F) 를 물어
 * 서로 다른 운영 주체 min 곳 이상이 같은 블록 해시를 줄 때만 F 를 쓴다 (정규 체인 합의). 이후 모든 판독(nonce·잔액·상태)은
 * 태그가 아니라 hex(F) 로 묻는다.
 *
 * 신뢰 모델:
 *  - BSC: 모든 group 이 태그를 지원한다. 태그 답이 min group 이상, 차이 maxSpread 이하, 최솟값 높이의 해시 합의.
 *  - GIWA: 태그를 주는 곳은 노드 경로(한 운영 주체)뿐이다. F 가 finalized 라는 사실 자체는 노드 답에 의존하고, 합의는
 *    "F 가 두 독립 경로에서 같은 정규 블록"임을 보장한다. 선택적으로 L1 앵커가 검증한 L2 블록(l1Anchored)을 주면 F 가 그
 *    블록 이상이어야 한다 (op-proposer 는 finalized 이하만 제안하므로, 앵커보다 낮은 finalized 는 뒤처지거나 틀린 노드다).
 *    같은 높이면 해시도 같아야 한다.
 *  - 합의 가능한 head 가 F 보다 낮으면 (Blockscout 인덱싱 지연) 그 head 로 낮춰 다시 합의한다. finalized 의 조상도 finalized 다.
 */
export interface FinalityPin {
  number: bigint;
  /** lowercase. */
  hash: string;
  timestamp: bigint;
}

/**
 * 실패의 undecided: 소스 부족으로 판정이 안 났고, 그 이유가 우리가 보내지 않은 호출(예산 큐 거절·쿨다운)뿐이다
 * (mint-log-sources 의 NotSentDetail 주석, 2026-10-19). 소스가 준 답(불일치·스프레드·충돌)으로 난 실패는 아니다.
 */
export type FinalityPinResult =
  FinalityPin | { error: string; undecided?: boolean };

export interface FinalityPinOptions {
  /** 해시 합의에 필요한 서로 다른 group 수. 기본 minAgreeingSources(). */
  min?: number;
  /** finalized 태그 답이 필요한 group 수. 기본: bsc = min, giwa-sepolia = 1 (태그 지원 group 이 노드뿐). */
  minTagGroups?: number;
  /** 태그 답 사이 허용 차이. 기본 64. */
  maxSpread?: bigint;
  /** L1 앵커가 검증한 L2 블록 (GIWA). F 는 이 번호 이상이어야 한다. */
  l1Anchored?: { number: bigint; hash?: string | null } | null;
}

export const FINALITY_PIN_MAX_SPREAD = 64n;

export const isFinalityPin = (r: FinalityPinResult): r is FinalityPin =>
  !('error' in r);

/** 고정 블록을 JSON-RPC 블록 인자로 (Blockscout 도 받는 숫자 hex). */
export const pinBlockParam = (pin: Pick<FinalityPin, 'number'>) =>
  hex(pin.number);

function text(reason: string, detail: Record<string, string>) {
  return `${reason} ${JSON.stringify(detail)}`.slice(0, 300);
}

function quantity(v: unknown): bigint {
  if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) return BigInt(v);
  throw new Error('invalid quantity');
}

function blockHash(v: unknown): string {
  if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/i.test(v))
    throw new Error('invalid hash');
  return v.toLowerCase();
}

/** 소스 하나의 결과를 격리해서 모은다 (한 소스의 오류·형식 오류는 그 소스만 뺀다). */
async function perSource<T>(
  sources: readonly LogSource[],
  ask: (s: LogSource) => Promise<T | null>,
): Promise<{
  values: Array<{ source: LogSource; value: T }>;
  detail: Record<string, string>;
  notSent: Set<string>;
}> {
  const values: Array<{ source: LogSource; value: T }> = [];
  const detail: Record<string, string> = {};
  const notSent = new Set<string>();
  await Promise.all(
    sources.map(async (source) => {
      try {
        const value = await ask(source);
        if (value === null) {
          detail[source.id] = 'null';
          return;
        }
        values.push({ source, value });
        detail[source.id] = 'ok';
      } catch (err) {
        if (isRpcNotSent(err)) notSent.add(source.id);
        detail[source.id] =
          `error:${publicChainError(err instanceof Error ? err.message : String(err))!.slice(0, 80)}`;
      }
    }),
  );
  return { values, detail, notSent };
}

/** 실패 결과에 undecided 를 붙인다 (참일 때만, 기존 결과 모양은 그대로). */
const undecidedMark = (flag: boolean): { undecided?: true } =>
  flag ? { undecided: true } : {};

/** perSource 결과가 필요한 group 수에 못 닿은 이유가 보내지 않은 호출뿐인가. */
function perSourceUndecided(
  sources: readonly LogSource[],
  r: { values: Array<{ source: LogSource }>; notSent: Set<string> },
  needed: number,
): boolean {
  return undecidedByNotSent(
    sources,
    new Set(r.values.map((v) => v.source.id)),
    r.notSent,
    needed,
  );
}

async function canonicalAt(
  sources: readonly LogSource[],
  n: bigint,
  min: number,
) {
  return agreeOnRpc(
    sources,
    'eth_getBlockByNumber',
    [hex(n), false],
    min,
    (raw) => {
      if (raw === null || raw === undefined) return null;
      const b = raw as {
        number?: unknown;
        hash?: unknown;
        timestamp?: unknown;
      };
      // 번호를 주면 요청한 높이여야 한다 (다른 블록을 준 소스는 제외).
      if (b.number !== undefined && quantity(b.number) !== n)
        throw new Error('block number mismatch');
      return {
        number: n,
        hash: blockHash(b.hash),
        timestamp: quantity(b.timestamp),
      };
    },
    (b) => `${b.number}:${b.hash}:${b.timestamp}`,
  );
}

/**
 * 성공한 핀의 짧은 공유 캐시 (2026-09-18).
 *
 * ★ 왜 안전한가
 *   finalized 블록은 되돌아가지 않는다. 그래서 조금 지난 핀을 쓰면 결과는 **늘 더
 *   보수적인 쪽**으로만 틀린다: 확정 판정은 더 늦게 나고, 커서 지연은 더 작게 보이고,
 *   hex(F) 로 묻는 nonce·잔액은 더 오래된(이미 확정된) 블록을 본다. 아직 확정되지 않은
 *   블록을 확정으로 보게 만드는 방향으로는 절대 틀리지 않는다. 오차 상한은 TTL 뿐이다.
 *
 * ★ 왜 필요한가
 *   운영 계측(2026-09-18, 11.5시간): 공유 GIWA 예산의 `bulk:eth_getBlockByNumber` 가
 *   73,066건으로 단일 최대 소비원이었다. 스윕·L1 앵커·입금 검사·환불 증명이 각자
 *   같은 finalized 태그를 반복해서 물었기 때문인데, GIWA finalized 는 분 단위로만
 *   움직인다. 같은 창 안의 중복 질문 하나로 합치면 그 수요가 사라진다.
 *
 *   `l1Anchored` 가 주어진 호출은 결과가 그 인자에 따라 달라지므로 캐시하지 않는다.
 *   실패({ error })도 캐시하지 않는다 (복구를 늦추지 않기 위해).
 */
const FINALITY_PIN_CACHE_MS = 30_000;
const finalityPinCache = new Map<string, { at: number; pin: FinalityPin }>();

/** 테스트에서 창 사이의 상태가 새지 않게 비운다. */
export function resetFinalityPinCache(): void {
  finalityPinCache.clear();
}

/**
 * 합의 finalized 블록을 고정한다. 실패는 { error } (판정 불가, 호출자는 시도로 세지 않는다).
 * 성공한 값은 FINALITY_PIN_CACHE_MS 동안 같은 (네트워크·소스·판정 조건) 호출과 공유한다.
 */
export async function pinFinalizedBlock(
  network: NetworkId,
  sources: readonly LogSource[],
  opts: FinalityPinOptions = {},
): Promise<FinalityPinResult> {
  const key = opts.l1Anchored
    ? null
    : JSON.stringify([
        network,
        sources.map((s) => s.id).sort(),
        opts.min ?? null,
        opts.minTagGroups ?? null,
        opts.maxSpread?.toString() ?? null,
      ]);
  if (key) {
    const hit = finalityPinCache.get(key);
    if (hit && Date.now() - hit.at < FINALITY_PIN_CACHE_MS) return hit.pin;
  }
  const result = await pinFinalizedBlockUncached(network, sources, opts);
  if (key && isFinalityPin(result))
    finalityPinCache.set(key, { at: Date.now(), pin: result });
  return result;
}

async function pinFinalizedBlockUncached(
  network: NetworkId,
  sources: readonly LogSource[],
  opts: FinalityPinOptions = {},
): Promise<FinalityPinResult> {
  const min = opts.min ?? minAgreeingSources();
  // 태그 합의에 필요한 운영 주체(group) 수. 기본 네트워크(BSC)는 서로 다른 운영 주체의 공개 RPC 가
  // 여럿이라 min 그대로. 그 밖의 네트워크(GIWA·Mezo 계열)는 노드 group 이 하나뿐이고 Blockscout eth-rpc 는
  // 'finalized'·'safe' 태그를 거절하므로(2026-10-23 실측 "Invalid block number") 태그는 1 group, 해시 합의는 min.
  // 2026-10-23 사고: 'giwa-sepolia' 만 1 로 두어 Mezo 테스트넷은 매 tick finalized 합의에 실패했고
  // (finalized_tag_insufficient) 커서가 생기지 않아 preflight 503 과 알림이 15분마다 반복됐다.
  const minTagGroups =
    opts.minTagGroups ?? (network === DEFAULT_NETWORK ? min : 1);
  const maxSpread = opts.maxSpread ?? FINALITY_PIN_MAX_SPREAD;

  const tag = await perSource(sources, async (s) => {
    const raw = (await s.rpc('eth_getBlockByNumber', ['finalized', false])) as {
      number?: unknown;
      hash?: unknown;
    } | null;
    if (raw === null || raw === undefined) return null;
    return {
      number: quantity(raw.number),
      hash: raw.hash === undefined ? null : blockHash(raw.hash),
    };
  });
  const tagGroups = new Set(tag.values.map((v) => v.source.group));
  if (tagGroups.size < Math.max(1, minTagGroups))
    return {
      error: text('finalized_tag_insufficient', tag.detail),
      ...undecidedMark(
        perSourceUndecided(sources, tag, Math.max(1, minTagGroups)),
      ),
    };
  // 그룹(운영 주체)별 최솟값끼리만 비교한다 — 같은 그룹의 엔드포인트들(LB 뒤 노드)은
  // finalized 뷰가 배치 커밋 타이밍에 수십~수백 블록 어긋나는 게 정상이라 그 차이로
  // 판정을 실패시키면 일시 스큐마다 입금이 막힌다 (2026-09-17 prod: giwa-rpc-0/1 스프레드).
  // 낮은 값을 취하는 건 항상 보수적 — finalized 를 과대평가할 수 없다.
  const groupMins = new Map<string, bigint>();
  for (const v of tag.values) {
    const prev = groupMins.get(v.source.group);
    if (prev === undefined || v.value.number < prev)
      groupMins.set(v.source.group, v.value.number);
  }
  const mins = [...groupMins.values()];
  const lo = mins.reduce((a, b) => (b < a ? b : a));
  const hi = mins.reduce((a, b) => (b > a ? b : a));
  if (hi - lo > maxSpread)
    return { error: text('finalized_spread', tag.detail) };

  const anchor = opts.l1Anchored ?? null;
  if (anchor && lo < anchor.number)
    return { error: text('finalized_below_l1_anchor', tag.detail) };

  const accept = (pin: FinalityPin): FinalityPinResult => {
    // 태그 답과 같은 높이의 해시가 합의 해시와 다르면 그 소스의 finalized 뷰가 정규 체인이 아니다.
    const conflict = tag.values.some(
      (v) =>
        v.value.number === pin.number &&
        v.value.hash !== null &&
        v.value.hash !== pin.hash,
    );
    if (conflict) return { error: text('finalized_hash_conflict', tag.detail) };
    if (
      anchor?.hash &&
      anchor.number === pin.number &&
      anchor.hash.toLowerCase() !== pin.hash
    )
      return { error: text('l1_anchor_hash_conflict', tag.detail) };
    return pin;
  };

  const first = await canonicalAt(sources, lo, min);
  if (first.ok) return accept(first.value);
  if (first.reason !== 'insufficient_sources')
    return { error: text(`canonical_${first.reason}`, first.results) };

  // 합의에 필요한 group 이 F 를 아직 모른다 (인덱싱 지연). group 별 최고 head 의 min 번째 값으로 낮춰 한 번 더.
  const heads = await perSource(sources, async (s) => {
    const raw = await s.rpc('eth_blockNumber', []);
    return raw === null || raw === undefined ? null : quantity(raw);
  });
  const byGroup = new Map<string, bigint>();
  for (const { source, value } of heads.values) {
    const prev = byGroup.get(source.group);
    if (prev === undefined || value > prev) byGroup.set(source.group, value);
  }
  const sorted = [...byGroup.values()].sort((a, b) =>
    a > b ? -1 : a < b ? 1 : 0,
  );
  const reachable = sorted.length >= min ? sorted[min - 1] : null;
  if (
    reachable === null ||
    reachable >= lo ||
    (anchor && reachable < anchor.number)
  )
    return {
      error: text('canonical_insufficient_sources', first.results),
      // F 에서의 정규 해시 합의가 보내지 않은 호출 때문에만 안 났을 때 (낮춘 재시도는 보조 수단이다).
      ...undecidedMark(first.undecided === true),
    };
  const second = await canonicalAt(sources, reachable, min);
  if (!second.ok)
    return {
      error: text(`canonical_${second.reason}`, second.results),
      ...undecidedMark(second.undecided === true),
    };
  return accept(second.value);
}
