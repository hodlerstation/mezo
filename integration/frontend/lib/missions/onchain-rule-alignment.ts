// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/lib/missions/onchain-rule-alignment.ts
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    Keeps a mission rule on the same network as its rewards (Mezo-only rules for Mezo missions).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { NETWORKS, isNetworkId, type NetworkId } from "@/lib/web3/networks";
import {
  isEvmRewardNetwork,
  type EvmRewardNetwork,
} from "@/lib/web3/evm-rewards";
import { onchainRuleNetworkAllows, type OnchainRule } from "@/types/mission";
import type { TaskDraft } from "@/types/mission-task-draft";
import { findKnownRuleToken, knownRuleTokens } from "./onchain-rule-token";
import { nextLinkOnOnchainRuleChange, onchainDefaultLink } from "./task-link-rule";

/*
 * 온체인 태스크 규칙 네트워크 ↔ 보상 네트워크 정렬 (2026-10-25).
 *
 * 외부 자산 보상(MUSD·MEZO·MON …)을 걸면 그 보상 네트워크가 곧 미션 네트워크다 (2026-10-23
 * 결정: 보상 선택이 전환의 단일 진입점). 백엔드는 `onchainRule.network !== 보상 네트워크` 면
 * MON_REWARD_NETWORK_MISMATCH 로 거부한다 — 그래서 온체인 태스크 규칙은 전부 그 네트워크로
 * 따라간다. 여기는 그 이동의 순수 함수만 둔다 (폼 훅·빌더 패널·테스트가 같이 쓴다).
 */

/**
 * 온체인 규칙이 따라야 하는 미션 네트워크 — 외부 EVM 자산 보상이 걸렸을 때만 그 네트워크.
 * 보상이 없거나 Solana SKR 이면 null (지금처럼 헤더를 따른다 — Solana 에는 EVM 규칙이 없다).
 */
export function pinnedRuleNetwork(reward: {
  active: boolean;
  network: unknown;
}): EvmRewardNetwork | null {
  return reward.active && isEvmRewardNetwork(reward.network)
    ? reward.network
    : null;
}

/**
 * 외부 EVM 보상 네트워크와 헤더(활성) 네트워크가 다르면 그 보상 네트워크 (2026-10-25 리뷰).
 * 복원한 초안이나 보상을 고른 뒤 헤더를 바꾼 경우 — HST 잔액·최소 보상 풀 검사는 헤더 원장을
 * 읽는데 미션은 보상 네트워크에 생긴다. 맞출 때까지 만들기를 막고 한 번에 전환하게 한다.
 */
export function rewardHeaderMismatch(
  reward: { active: boolean; network: unknown },
  headerNetwork: string
): EvmRewardNetwork | null {
  const pinned = pinnedRuleNetwork(reward);
  return pinned && pinned !== headerNetwork ? pinned : null;
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 규칙 토큰을 새 네트워크로 옮긴다 — 작성자 입력이 아니라 registry 프리셋인 토큰만.
 *
 *  - 새 네트워크에도 있는 주소 → 그대로 (decimals 는 registry 값)
 *  - 이전 네트워크의 결제 토큰(TUSDT·MUSD·USDT) → 새 네트워크의 결제 토큰
 *  - 이전 네트워크의 다른 프리셋(MEZO) → 새 네트워크의 같은 심볼, 없으면 결제 토큰
 *  - 빈 값(기본값) → 새 네트워크의 결제 토큰
 *  - 모르는 컨트랙트(작성자가 붙여 넣은 주소) → null (호출부가 그대로 둔다)
 *
 * 새 네트워크에 결제 토큰이 없으면(Monad) 주소는 "" — 존재하지 않는 컨트랙트를 가리키지 않게.
 */
export function resolveRuleTokenOnNetwork(
  from: NetworkId,
  to: NetworkId,
  contract: string | null | undefined
): { address: string; decimals: number } | null {
  const value = (contract ?? "").trim();
  const payment = NETWORKS[to].usdt;
  const fallback = { address: payment.address ?? "", decimals: payment.decimals };
  if (!value) return fallback;
  const onTarget = findKnownRuleToken(to, value);
  if (onTarget)
    return { address: onTarget.address, decimals: onTarget.decimals };
  const prevPayment = NETWORKS[from].usdt.address;
  if (prevPayment && sameAddress(value, prevPayment)) return fallback;
  const prevKnown = findKnownRuleToken(from, value);
  if (!prevKnown) return null;
  const sameSymbol = knownRuleTokens(to).find(
    (token) => token.symbol === prevKnown.symbol
  );
  return sameSymbol
    ? { address: sameSymbol.address, decimals: sameSymbol.decimals }
    : fallback;
}

export type RuleAlignment =
  | { status: "aligned" }
  | {
      status: "moved";
      rule: OnchainRule;
      from: NetworkId;
      /** 작성자가 넣은 토큰 컨트랙트를 그대로 옮겼다 — 새 네트워크에 있는지 확인하라고 알린다. */
      checkToken: boolean;
    }
  | { status: "blocked"; from: NetworkId };

/**
 * 규칙 하나를 목표 네트워크로 옮긴다.
 *
 * 옮길 수 없는 경우는 blocked — 규칙을 바꾸지 않는다 (작성자가 태스크나 보상을 고른다):
 *  - 목표 네트워크가 그 종류를 받지 않음 (Mezo 의 CHOG 구매·GIWA 브릿지 입금, Monad 의 일반 규칙,
 *    Mezo 메인넷의 송금·민팅)
 *  - 파트너 목표 — goalId 는 그 네트워크 브릿지에 등록된 값이라 옮기면 다른 목표를 가리킨다
 */
export function alignOnchainRule(
  rule: OnchainRule,
  target: NetworkId,
  /** 목표 네트워크의 민팅 트레저리 (GET /treasury/deposit-address). 모르면 null. */
  mintTreasury: string | null = null
): RuleAlignment {
  const from = isNetworkId(rule.network) ? rule.network : null;
  if (from === target) return { status: "aligned" };
  const origin = from ?? target;
  if (
    !onchainRuleNetworkAllows(target, rule.kind) ||
    (rule.kind === "PARTNER_GOAL" && !!rule.goalId)
  )
    return { status: "blocked", from: origin };
  const next: OnchainRule = { ...rule, network: target };
  let checkToken = false;
  if (typeof rule.tokenContract === "string") {
    const resolved = resolveRuleTokenOnNetwork(
      origin,
      target,
      rule.tokenContract
    );
    if (resolved) {
      next.tokenContract = resolved.address;
      next.decimals = resolved.decimals;
    } else {
      checkToken = true;
    }
  }
  // HST_MINT 수취 주소는 그 네트워크의 민팅 트레저리만 서버가 받는다 — 이전 네트워크 트레저리를
  // 들고 가면 저장에서 거절된다. 새 네트워크 주소를 모르면 비워 두고 빌더가 다시 채우게 한다.
  if (rule.kind === "HST_MINT") {
    if (mintTreasury) next.expectedTo = mintTreasury;
    else delete next.expectedTo;
  }
  // ANY_TX 대상이 이전 네트워크의 프리셋 토큰이면 같이 옮긴다 (EOA·모르는 컨트랙트는 그대로).
  if (rule.to && findKnownRuleToken(origin, rule.to)) {
    const resolved = resolveRuleTokenOnNetwork(origin, target, rule.to);
    if (resolved) next.to = resolved.address;
  }
  return { status: "moved", rule: next, from: origin, checkToken };
}

/** 자동 이동 기록 — 보상을 빼면 손대지 않은 규칙을 원래대로 되돌린다. */
export interface RuleMove {
  original: OnchainRule;
  moved: OnchainRule;
  /** 옮기기 전 태스크 링크 — 규칙 기본 링크(익스플로러 주소)였으면 새 네트워크 것으로 바뀐다. */
  originalLink: string;
  movedLink: string;
  from: NetworkId;
  checkToken: boolean;
}

export function sameRule(a: OnchainRule | undefined, b: OnchainRule): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 모든 온체인 태스크를 목표 네트워크로 — 옮긴 태스크는 moves 에, 옮길 수 없는 태스크는 그대로.
 * 바뀐 게 없으면 같은 배열을 돌려준다 (호출부가 불필요한 setState 를 건너뛴다).
 */
export function alignTasksToNetwork(
  tasks: TaskDraft[],
  target: NetworkId,
  mintTreasury: string | null = null
): { tasks: TaskDraft[]; moves: Record<string, RuleMove>; changed: boolean } {
  const moves: Record<string, RuleMove> = {};
  let changed = false;
  const next = tasks.map((task) => {
    if (task.proofType !== "ONCHAIN_TX" || !task.onchainRule) return task;
    const result = alignOnchainRule(task.onchainRule, target, mintTreasury);
    if (result.status !== "moved") return task;
    changed = true;
    // 링크가 규칙 기본값(이전 네트워크 익스플로러의 토큰 주소)이면 새 네트워크 기본값으로 —
    // 직접 넣은 링크는 그대로 (빌더 패널과 같은 규칙).
    const movedLink = nextLinkOnOnchainRuleChange({
      link: task.targetLink,
      prevDefault: onchainDefaultLink(task.onchainRule),
      nextDefault: onchainDefaultLink(result.rule),
    });
    moves[task.id] = {
      original: task.onchainRule,
      moved: result.rule,
      originalLink: task.targetLink,
      movedLink,
      from: result.from,
      checkToken: result.checkToken,
    };
    return { ...task, onchainRule: result.rule, targetLink: movedLink };
  });
  return { tasks: changed ? next : tasks, moves, changed };
}

/** 이어지는 이동을 합친다 — 원래 규칙은 처음 것을 지킨다 (Mezo Testnet → Mezo → 보상 해제 = GIWA). */
export function mergeRuleMoves(
  prev: Record<string, RuleMove>,
  next: Record<string, RuleMove>
): Record<string, RuleMove> {
  const out = { ...prev };
  for (const [id, move] of Object.entries(next)) {
    const earlier = prev[id];
    out[id] = earlier
      ? {
          ...move,
          original: earlier.original,
          originalLink: earlier.originalLink,
          from: earlier.from,
          checkToken: earlier.checkToken || move.checkToken,
        }
      : move;
  }
  return out;
}

/** 보상을 뺐을 때 — 자동으로 옮긴 뒤 손대지 않은 규칙만 원래 네트워크로 되돌린다. */
export function revertRuleMoves(
  tasks: TaskDraft[],
  moves: Record<string, RuleMove>
): TaskDraft[] {
  let changed = false;
  const next = tasks.map((task) => {
    const move = moves[task.id];
    if (!move || !sameRule(task.onchainRule, move.moved)) return task;
    changed = true;
    return {
      ...task,
      onchainRule: move.original,
      targetLink:
        task.targetLink === move.movedLink ? move.originalLink : task.targetLink,
    };
  });
  return changed ? next : tasks;
}

export type TaskNetworkNotice =
  | { kind: "moved"; from: NetworkId; to: NetworkId; checkToken: boolean }
  | { kind: "blocked"; from: NetworkId; to: NetworkId };

/** 태스크 행 안내 — 보상 따라 옮긴 행(moved), 보상 네트워크에서 돌 수 없는 행(blocked). */
export function taskNetworkNotices(
  tasks: TaskDraft[],
  pinned: NetworkId | null,
  moves: Record<string, RuleMove>
): Record<string, TaskNetworkNotice> {
  const out: Record<string, TaskNetworkNotice> = {};
  if (!pinned) return out;
  for (const task of tasks) {
    const rule = task.proofType === "ONCHAIN_TX" ? task.onchainRule : undefined;
    if (!rule) continue;
    if (rule.network !== pinned) {
      out[task.id] = {
        kind: "blocked",
        from: isNetworkId(rule.network) ? rule.network : pinned,
        to: pinned,
      };
      continue;
    }
    const move = moves[task.id];
    if (move && sameRule(rule, move.moved))
      out[task.id] = {
        kind: "moved",
        from: move.from,
        to: pinned,
        checkToken: move.checkToken,
      };
  }
  return out;
}
