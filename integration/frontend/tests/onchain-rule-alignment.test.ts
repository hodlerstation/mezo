// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/__tests__/missions/onchain-rule-alignment.test.ts
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    Rule alignment behaviour.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

/**
 * 온체인 태스크 규칙 ↔ 보상 네트워크 정렬 (순수 함수).
 *
 *   - 외부 EVM 보상이 걸린 미션만 규칙 네트워크를 고정한다 (Solana SKR·보상 없음은 null)
 *   - 프리셋 토큰(결제 토큰·MEZO)은 새 네트워크 registry 주소·decimals 로, 모르는 주소는 그대로
 *   - 그 네트워크가 받지 않는 종류·파트너 목표는 옮기지 않는다 (blocked)
 *   - 보상을 빼면 자동으로 옮긴 뒤 손대지 않은 규칙만 원래대로
 */
import { describe, expect, it } from "vitest";
import {
  alignOnchainRule,
  alignTasksToNetwork,
  mergeRuleMoves,
  pinnedRuleNetwork,
  resolveRuleTokenOnNetwork,
  revertRuleMoves,
  taskNetworkNotices,
} from "@/lib/missions/onchain-rule-alignment";
import { MEZO_TOKEN_ADDRESS, NETWORKS } from "@/lib/web3/networks";
import { knownRuleTokens } from "@/lib/missions/onchain-rule-token";
import { onchainDefaultLink } from "@/lib/missions/task-link-rule";
import type { OnchainRule } from "@/types/mission";
import type { TaskDraft } from "@/types/mission-task-draft";

const TUSDT = NETWORKS["giwa-sepolia"].usdt.address;
const MUSD_TESTNET = NETWORKS["mezo-testnet"].usdt.address;
const MUSD_MAINNET = NETWORKS.mezo.usdt.address;
const CUSTOM = "0x1234567890abcdef1234567890abcdef1234abcd";

function task(id: string, rule: OnchainRule): TaskDraft {
  return {
    id,
    category: "OTHER",
    subTypes: ["custom"],
    title: id,
    targetLink: "",
    proofType: "ONCHAIN_TX",
    verifyMode: "AUTO",
    required: true,
    onchainRule: rule,
  };
}

const giwaBalance: OnchainRule = {
  network: "giwa-sepolia",
  kind: "ERC20_BALANCE",
  tokenContract: TUSDT,
  minAmount: 5,
  decimals: 6,
};

describe("pinnedRuleNetwork", () => {
  it("pins only to an active external EVM reward network", () => {
    expect(
      pinnedRuleNetwork({ active: true, network: "mezo-testnet" })
    ).toBe("mezo-testnet");
    expect(pinnedRuleNetwork({ active: true, network: "monad" })).toBe(
      "monad"
    );
    // Solana SKR has no EVM on-chain rule; no reward means the header decides as before.
    expect(pinnedRuleNetwork({ active: true, network: "solana" })).toBeNull();
    expect(
      pinnedRuleNetwork({ active: false, network: "mezo-testnet" })
    ).toBeNull();
  });
});

describe("resolveRuleTokenOnNetwork", () => {
  it("moves the payment token to the new network's payment token with registry decimals", () => {
    expect(
      resolveRuleTokenOnNetwork("giwa-sepolia", "mezo-testnet", TUSDT)
    ).toEqual({ address: MUSD_TESTNET, decimals: 18 });
    expect(
      resolveRuleTokenOnNetwork("mezo-testnet", "giwa-sepolia", MUSD_TESTNET)
    ).toEqual({ address: TUSDT, decimals: 6 });
  });

  it("re-resolves a preset by symbol and falls back to the payment token where it does not exist", () => {
    const mezoTestnet = knownRuleTokens("mezo-testnet").find(
      (token) => token.symbol === "MEZO"
    );
    const mezoMainnet = knownRuleTokens("mezo").find(
      (token) => token.symbol === "MEZO"
    );
    expect(mezoTestnet).toBeDefined();
    if (mezoMainnet && mezoTestnet && mezoMainnet.address !== mezoTestnet.address)
      expect(
        resolveRuleTokenOnNetwork("mezo-testnet", "mezo", mezoTestnet.address)
      ).toEqual({ address: mezoMainnet.address, decimals: mezoMainnet.decimals });
    // GIWA has no MEZO — never keep a contract that does not exist there.
    expect(
      resolveRuleTokenOnNetwork("mezo-testnet", "giwa-sepolia", MEZO_TOKEN_ADDRESS)
    ).toEqual({ address: TUSDT, decimals: 6 });
  });

  it("keeps a pasted contract and fills an empty one with the payment token", () => {
    expect(
      resolveRuleTokenOnNetwork("giwa-sepolia", "mezo-testnet", CUSTOM)
    ).toBeNull();
    expect(
      resolveRuleTokenOnNetwork("giwa-sepolia", "mezo-testnet", "")
    ).toEqual({ address: MUSD_TESTNET, decimals: 18 });
  });
});

describe("alignOnchainRule", () => {
  it("moves a generic rule and resolves its preset token", () => {
    const result = alignOnchainRule(giwaBalance, "mezo-testnet");
    expect(result).toEqual({
      status: "moved",
      from: "giwa-sepolia",
      checkToken: false,
      rule: {
        ...giwaBalance,
        network: "mezo-testnet",
        tokenContract: MUSD_TESTNET,
        decimals: 18,
      },
    });
  });

  it("keeps a pasted token contract and asks the author to check it", () => {
    const result = alignOnchainRule(
      { ...giwaBalance, tokenContract: CUSTOM, decimals: 9 },
      "mezo-testnet"
    );
    expect(result.status).toBe("moved");
    if (result.status === "moved") {
      expect(result.rule.tokenContract).toBe(CUSTOM);
      expect(result.rule.decimals).toBe(9);
      expect(result.checkToken).toBe(true);
    }
  });

  it("moves an HST mint rule's recipient to the new network's mint treasury", () => {
    const GIWA_TREASURY = "0x00000000000000000000000000000000000000a1";
    const MEZO_TREASURY = "0x00000000000000000000000000000000000000b2";
    const mint: OnchainRule = {
      network: "giwa-sepolia",
      kind: "HST_MINT",
      tokenContract: TUSDT,
      decimals: 6,
      expectedTo: GIWA_TREASURY,
      amount: 5,
    };
    const moved = alignOnchainRule(mint, "mezo-testnet", MEZO_TREASURY);
    expect(moved.status).toBe("moved");
    if (moved.status === "moved") {
      expect(moved.rule.expectedTo).toBe(MEZO_TREASURY);
      expect(moved.rule.tokenContract).toBe(MUSD_TESTNET);
      expect(moved.rule.decimals).toBe(18);
    }
    // 새 네트워크 주소를 모르면 이전 트레저리를 들고 가지 않는다 (서버가 거절).
    const unknown = alignOnchainRule(mint, "mezo-testnet");
    expect(unknown.status === "moved" && unknown.rule.expectedTo).toBeUndefined();
  });

  it("is a no-op when the rule is already on the target", () => {
    expect(
      alignOnchainRule({ ...giwaBalance, network: "mezo-testnet" }, "mezo-testnet")
    ).toEqual({ status: "aligned" });
  });

  it("blocks kinds the target does not accept and partner goals", () => {
    expect(
      alignOnchainRule({ network: "giwa-sepolia", kind: "ANY_TX" }, "monad")
        .status
    ).toBe("blocked");
    expect(
      alignOnchainRule(
        { network: "giwa-sepolia", kind: "GIWA_BRIDGE_DEPOSIT" },
        "mezo-testnet"
      ).status
    ).toBe("blocked");
    // Mezo mainnet takes no transfer rule (real assets).
    expect(
      alignOnchainRule(
        {
          network: "mezo-testnet",
          kind: "USDT_TRANSFER",
          tokenContract: MUSD_TESTNET,
          expectedTo: CUSTOM,
          amount: 1,
          decimals: 18,
        },
        "mezo"
      ).status
    ).toBe("blocked");
    expect(
      alignOnchainRule(
        {
          network: "giwa-sepolia",
          kind: "PARTNER_GOAL",
          goalId: `0x${"a".repeat(64)}`,
        },
        "mezo-testnet"
      ).status
    ).toBe("blocked");
    // Chog trades move between the Monad networks.
    expect(
      alignOnchainRule({ network: "monad", kind: "CHOG_TRADE" }, "monad-testnet")
        .status
    ).toBe("moved");
  });
});

describe("alignTasksToNetwork + revert", () => {
  const tasks: TaskDraft[] = [
    task("balance", giwaBalance),
    task("bridge", { network: "giwa-sepolia", kind: "GIWA_BRIDGE_DEPOSIT" }),
    {
      ...task("text", giwaBalance),
      proofType: "TEXT",
      onchainRule: undefined,
    },
  ];

  it("moves what it can, leaves the rest, and reports per-row notices", () => {
    const aligned = alignTasksToNetwork(tasks, "mezo-testnet");
    expect(aligned.changed).toBe(true);
    expect(aligned.tasks[0].onchainRule?.network).toBe("mezo-testnet");
    expect(aligned.tasks[0].onchainRule?.tokenContract).toBe(MUSD_TESTNET);
    expect(aligned.tasks[1]).toBe(tasks[1]);
    expect(aligned.tasks[2]).toBe(tasks[2]);
    expect(Object.keys(aligned.moves)).toEqual(["balance"]);
    expect(
      taskNetworkNotices(aligned.tasks, "mezo-testnet", aligned.moves)
    ).toEqual({
      balance: {
        kind: "moved",
        from: "giwa-sepolia",
        to: "mezo-testnet",
        checkToken: false,
      },
      bridge: { kind: "blocked", from: "giwa-sepolia", to: "mezo-testnet" },
    });
    // Already aligned → same array, nothing to set.
    const again = alignTasksToNetwork(aligned.tasks, "mezo-testnet");
    expect(again.changed).toBe(false);
    expect(again.tasks).toBe(aligned.tasks);
  });

  it("restores the pre-reward rule when the reward is removed, unless the author edited it", () => {
    const aligned = alignTasksToNetwork(tasks, "mezo-testnet");
    expect(revertRuleMoves(aligned.tasks, aligned.moves)[0].onchainRule).toEqual(
      giwaBalance
    );
    const edited = aligned.tasks.map((t) =>
      t.id === "balance"
        ? { ...t, onchainRule: { ...t.onchainRule!, minAmount: 9 } }
        : t
    );
    expect(revertRuleMoves(edited, aligned.moves)).toBe(edited);
    expect(taskNetworkNotices(edited, null, aligned.moves)).toEqual({});
  });

  it("moves the rule's default explorer link with it and keeps a link the author typed", () => {
    const autoLink = onchainDefaultLink(giwaBalance);
    expect(autoLink).toContain(TUSDT);
    const linked = [
      { ...task("auto", giwaBalance), targetLink: autoLink },
      { ...task("typed", giwaBalance), targetLink: "https://example.com/hold" },
    ];
    const aligned = alignTasksToNetwork(linked, "mezo-testnet");
    expect(aligned.tasks[0].targetLink).toBe(
      onchainDefaultLink(aligned.tasks[0].onchainRule)
    );
    expect(aligned.tasks[0].targetLink).toContain(MUSD_TESTNET);
    expect(aligned.tasks[1].targetLink).toBe("https://example.com/hold");
    expect(revertRuleMoves(aligned.tasks, aligned.moves)[0].targetLink).toBe(
      autoLink
    );
  });

  it("keeps the first original across consecutive moves", () => {
    const first = alignTasksToNetwork(tasks, "mezo-testnet");
    const second = alignTasksToNetwork(first.tasks, "mezo");
    const merged = mergeRuleMoves(first.moves, second.moves);
    expect(second.tasks[0].onchainRule?.tokenContract).toBe(MUSD_MAINNET);
    expect(merged.balance.from).toBe("giwa-sepolia");
    expect(revertRuleMoves(second.tasks, merged)[0].onchainRule).toEqual(
      giwaBalance
    );
  });
});
