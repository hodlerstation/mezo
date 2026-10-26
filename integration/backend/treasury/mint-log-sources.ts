// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/treasury/mint-log-sources.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (1-276)
//   why:    Log source abstraction (public RPC + Blockscout) used for MUSD deposit discovery.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { publicChainError } from '../web3/public-chain-error';
import { createPublicClient, http, type PublicClient } from 'viem';
import { NETWORKS, type NetworkId } from '../web3/networks';
import { sharedGiwaRpcBudget, type GiwaRpcLane } from '../web3/giwa-rpc-budget';
import {
  isRpcNotSent,
  isRpcRateLimit,
  isTransientRpcError,
  rpcRetryAfterMs,
} from '../web3/rpc-rate-limit';
import { mintRpcError } from './mint-rpc-error';

/**
 * 입금·구매·operator 이벤트 발견용 체인 소스 (공급자 무관).
 *
 * 한 블록 범위는 **서로 다른 운영 주체(group) 두 곳 이상이 성공했고 결과가 모두 같을 때만** 완료로 인정한다
 * (crossCheckLogs). 결과에는 범위 양 끝 블록의 해시가 포함된다: 그 블록 헤더를 돌려주지 못하는 소스(보존 기간이 지나
 * 잘라낸 노드)는 합의에서 빠지고, 로그를 조용히 빈 배열로 돌려주는 잘린 노드가 합의를 만들 수 없다.
 * 실패·불일치·범위 끝을 못 보는 소스는 제외, 합의 수가 모자라면 그 범위는 완료가 아니다 (커서 불변 + 알림).
 */
export interface LogQuery {
  address: string;
  /**
   * topics[0..3], null = 아무 값, 배열 = 그중 하나 (OR, eth_getLogs 규칙). 트레저리 주소 이력 전체의 들어온 전송을
   * 한 조회로 받을 때 topics[2] 에 주소 목록을 쓴다 (7차 감사 H4).
   */
  topics: Array<string | null | readonly string[]>;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ChainLog {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  address: string;
  topics: string[];
  data: string;
}

export interface LogSource {
  id: string;
  /** 운영 주체(독립성 단위). 합의는 서로 다른 group 수로 센다 (같은 운영자의 엔드포인트 여러 개는 1). */
  group: string;
  /** 한 번에 조회할 수 있는 최대 블록 수. */
  maxRange: bigint;
  /** 이 소스가 알고 있는 가장 높은 블록 (범위 끝을 모르면 합의에서 제외). */
  headBlock(): Promise<bigint>;
  getLogs(query: LogQuery): Promise<ChainLog[]>;
  /** JSON-RPC 호출 (eth_getBlockByNumber, eth_call, eth_getTransactionCount, eth_getTransactionReceipt). */
  rpc(method: string, params: unknown[]): Promise<unknown>;
  /**
   * 한 범위의 head·양 끝 블록 해시·로그를 한 번에 (지원하면 JSON-RPC batch 한 요청, 같은 노드 시점). 없으면
   * crossCheckLogs 가 개별 호출로 모은다.
   */
  rangeSnapshot?(query: LogQuery): Promise<RangeSnapshot>;
  /** JSON-RPC batch (소스의 크기 상한에 따라 분할 가능). 결과는 호출 순서. 어느 항목이든 오류면 던진다. */
  batch?(
    calls: Array<{ method: string; params: unknown[] }>,
  ): Promise<unknown[]>;
  /**
   * JSON-RPC batch 의 항목별 결과 (8차 D-1). 한 항목의 오류(예: Blockscout 가 'finalized' 태그를 거절)가 같은 요청의
   * 다른 항목을 버리지 않는다. 요청 자체가 실패하면 던진다. 합의 판독(askAll·agreeOnRpcBatch)은 있으면 이것을 쓴다.
   */
  batchSettled?(
    calls: Array<{ method: string; params: unknown[] }>,
  ): Promise<BatchItem[]>;
  /**
   * 과거 tx·receipt·블록 헤더를 보존하는가 (8차 D-2). false 인 소스(BSC 최근 블록 전용 공개 RPC)의 null 은 "없음"이
   * 아니라 "모름"이다: receipt 부재 판정(not_found)에 세지 않는다. 지정하지 않으면 보존으로 본다.
   */
  readonly retainsHistory?: boolean;
}

/** batch 항목 하나의 결과: 값 또는 그 항목의 오류. */
export type BatchItem = { result: unknown } | { error: string };

/** Surface item-level limits to the shared scheduler while retaining successful
 * replies. Unsent items remain errors, never evidence of an absent transaction. */
class BatchRateLimitError extends Error {
  constructor(
    message: string,
    readonly items: BatchItem[],
  ) {
    super(message);
  }
}

/** 과거 데이터를 보존하는 소스인가 (지정이 없으면 보존). */
export const retainsHistory = (s: Pick<LogSource, 'retainsHistory'>) =>
  s.retainsHistory !== false;

/** JSON-RPC 오류 본문을 글자로 (Blockscout eth-rpc 는 error 를 객체가 아니라 문자열로 준다, 2026-09-16 실측). */
export function rpcErrorText(error: unknown): string {
  if (typeof error === 'string') return error.slice(0, 200) || 'rpc error';
  if (error && typeof error === 'object') {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m.slice(0, 200);
  }
  return 'rpc error';
}

/**
 * JSON-RPC batch 응답 본문을 호출 순서의 항목별 결과로 (배열이 아니거나 길이가 다르면 batch 미지원으로 던진다).
 * 항목의 error 는 그 항목만의 실패다.
 */
export function settleBatchBody(
  id: string,
  calls: ReadonlyArray<unknown>,
  body: unknown,
): BatchItem[] {
  if (!Array.isArray(body) || body.length !== calls.length)
    throw new Error(`${id}: batch not supported`);
  const items = body as Array<{
    id?: unknown;
    result?: unknown;
    error?: unknown;
  }>;
  // id → 항목을 한 번만 색인한다 (2026-09-22). 예전에는 항목마다 배열을 훑어 n^2 였다.
  // 영수증·로그 검증 batch 는 한 틱에 수십~수백 호출이고 소스마다 따로 돌아 곱해진다.
  const byId = new Map<number, (typeof items)[number]>();
  for (const b of items) byId.set(Number(b?.id), b);
  return calls.map((_, i): BatchItem => {
    const item = byId.get(i + 1);
    if (!item) return { error: `${id}: batch item missing` };
    if (item.error !== undefined && item.error !== null)
      return { error: `${id}: ${rpcErrorText(item.error)}` };
    return { result: item.result ?? null };
  });
}

/** 항목별 결과를 기존 batch 규칙(어느 항목이든 오류면 던진다)으로. */
export function throwOnItemError(items: readonly BatchItem[]): unknown[] {
  return items.map((it) => {
    if ('error' in it) throw new Error(it.error);
    return it.result;
  });
}

/**
 * 소스에 호출들을 한 번에 묻는다: batchSettled > batch > 순서대로 개별 호출. 항목별 결과를 돌려주고,
 * 요청 자체의 실패만 던진다 (개별 호출 경로에서는 그 호출만 오류 항목).
 */
export async function askSettled(
  source: LogSource,
  calls: ReadonlyArray<{ method: string; params: unknown[] }>,
): Promise<BatchItem[]> {
  if (source.batchSettled) {
    const items = await source.batchSettled([...calls]);
    if (!Array.isArray(items) || items.length !== calls.length)
      throw new Error(`${source.id}: invalid batch result`);
    return items;
  }
  if (source.batch) {
    const results = await source.batch([...calls]);
    if (!Array.isArray(results) || results.length !== calls.length)
      throw new Error(`${source.id}: invalid batch result`);
    return results.map((result) => ({ result }));
  }
  const out: BatchItem[] = [];
  for (const c of calls) {
    try {
      out.push({ result: await source.rpc(c.method, c.params) });
    } catch (err) {
      out.push({
        error: mintRpcError(err),
      });
    }
  }
  return out;
}

export interface RangeSnapshot {
  head: bigint;
  fromHash: string | null;
  toHash: string | null;
  logs: ChainLog[];
}

/**
 * 알려진 운영 주체 (도메인 접미사 → operator). 같은 회사가 운영하는 엔드포인트는 합의에서 하나로 센다 (M4).
 * 설정은 `operator=url` 로 명시할 수 있고, 명시가 없으면 이 표, 표에도 없으면 호스트 이름.
 */
export const KNOWN_OPERATORS: ReadonlyArray<readonly [string, string]> = [
  ['bnbchain.org', 'binance'],
  ['binance.org', 'binance'],
  ['binance.com', 'binance'],
  ['defibit.io', 'binance'],
  ['ninicoin.io', 'binance'],
  ['blxrbdn.com', 'bloxroute'],
  ['48.club', '48club'],
  ['publicnode.com', 'allnodes'],
  ['allnodes.com', 'allnodes'],
  ['drpc.org', 'drpc'],
  ['nodereal.io', 'nodereal'],
  ['ankr.com', 'ankr'],
  ['blockpi.network', 'blockpi'],
  ['quiknode.pro', 'quicknode'],
  ['chainstack.com', 'chainstack'],
  ['llamarpc.com', 'llamanodes'],
  ['tenderly.co', 'tenderly'],
  ['nodies.app', 'nodies'],
  ['onfinality.io', 'onfinality'],
  ['thirdweb.com', 'thirdweb'],
  ['alchemy.com', 'alchemy'],
];

/** 요청 예산 (GIWA 공개 RPC 는 민팅 워커와 같은 프로세스 예산을 쓴다, L-e). */
export interface RequestBudget {
  run<T>(
    method: string,
    params: unknown,
    request: () => Promise<T>,
    lane?: GiwaRpcLane,
    route?: string,
  ): Promise<T>;
}

/** 순서를 지키며 동시에 최대 limit 개만 돌린다. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

export function operatorOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  const hit = KNOWN_OPERATORS.find(
    ([suffix]) => host === suffix || host.endsWith(`.${suffix}`),
  );
  return hit ? hit[1] : host;
}

/** `operator=url` 또는 `url` 설정 한 항목. */
export function parseSourceEntry(entry: string): {
  operator: string;
  url: string;
} {
  const m = /^([a-z0-9._-]+)=(https?:\/\/.+)$/i.exec(entry.trim());
  if (m) return { operator: m[1].toLowerCase(), url: m[2] };
  return { operator: operatorOf(entry.trim()), url: entry.trim() };
}

export const hex = (n: bigint) => `0x${n.toString(16)}`;

function normalizeRpcLog(raw: Record<string, unknown>): ChainLog {
  const text = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v : fallback;
  return {
    txHash: text(raw.transactionHash, '').toLowerCase(),
    logIndex: Number(BigInt(text(raw.logIndex, '0'))),
    blockNumber: BigInt(text(raw.blockNumber, '0')),
    blockHash: text(raw.blockHash, '').toLowerCase(),
    address: text(raw.address, '').toLowerCase(),
    topics: (raw.topics as Array<string | null>)
      .filter((t): t is string => !!t)
      .map((t) => t.toLowerCase()),
    data: text(raw.data, '0x').toLowerCase(),
  };
}

/** JSON-RPC 소스. */
// … (lines 277-1519 omitted) …
