// Excerpt from the private HodlerStation repository (hodlerstation-app (frontend))
//   path:   src/hooks/use-onchain-mint.ts
//   commit: d25eaa7e
//   scope:  whole file, unmodified
//   why:    Mint hook: transfer MUSD on Mezo, then submit the hash (same flow as BSC USDT).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { toast } from "sonner";
import { useLocale, useTranslations } from "next-intl";
import { useSwitchToActiveNetwork } from "@/lib/web3/hooks/use-switch-to-bsc";
import { NETWORKS, paymentSymbolOf } from "@/lib/web3/networks";
import { shortenAddress } from "@/lib/web3/utils";
import { useNetworkStore } from "@/stores/network-store";
import { useMintFromTx } from "@/hooks/use-treasury";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePendingMints } from "@/hooks/use-pending-mints";
import type { MintFromTxResult } from "@/hooks/use-treasury-swap";
import apiClient, { unwrap } from "@/lib/api-client";
import { handleApiErrorWith } from "@/lib/errors";
import { BSC_USDT_ABI } from "@/lib/treasury/constants";
import {
  upsertPendingMint,
  recordPendingMintReplacement,
  removeSettledPendingMint,
  updatePendingMint,
  readPendingMints,
  pendingMintsForUser,
  MintStillConfirmingError,
  MintFailureReportedError,
  MintAlreadyCompletedError,
  MintChainFailedError,
  type PendingMint,
} from "@/lib/treasury/pending-mint";
import {
  classifyMintSubmitError,
  isSlowWait,
} from "@/lib/treasury/mint-submit-policy";
import { withMintSubmitLock } from "@/lib/treasury/mint-submit-lock";
import { mintWaitMessage } from "@/lib/treasury/mint-wait-copy";
import {
  discoveryUnavailableReason,
  discoveryUnavailableUserMessage,
  discoveryUserCopyKey,
  isDepositDiscoveryUnavailable,
  MintDiscoveryUnavailableError,
  preflightErrorMessage,
} from "@/lib/treasury/mint-preflight-error";
import {
  applyMintSubmitOutcome,
  markMintInFlight,
  releaseMintInFlowClaim,
  mintCooldownRemainingMs,
  unmarkMintInFlight,
} from "@/lib/treasury/pending-mint-runner";
import {
  MintReviewRequiredError,
  sameMintTransfer,
  type MintTransferReview,
  parseMintAmount,
  MintAmountPrecisionError,
  InvalidMintAmountError,
  validateMintPreflight,
} from "@/lib/treasury/mint-preflight-validation";
import {
  runWalletOperation,
  settleWalletTransaction,
  assertWalletReceipt,
} from "@/lib/web3/transactions/wallet-operation";
import { useAwaitWalletReady } from "@/lib/web3/hooks/use-wallet-ready";
import { useWalletActorGuard } from "@/hooks/use-wallet-actor-guard";

/**
 * USDT → HST 온체인 민팅 훅 (멀티 네트워크).
 *
 * 단계:
 *   0. (UX) 서명 지갑 = 연결 지갑 확인 → preflight
 *   1. 유저 지갑 체인을 activeNetwork 로 스위치 (필요 시)
 *   2. USDT transfer 서명 → 해시를 받는 **즉시** 로컬 목록에 저장
 *   3. 곧바로 from-tx 제출 (서버가 컨펌 부족 건을 기록)
 *   4. receipt 는 옆에서 기다린다: 교체(속도 올리기) 감지, revert 감지, 컨펌 뒤 재제출 시점.
 *
 * 2026-09-15 사고 대응:
 *   - receipt 대기가 실패하면 from-tx 가 영영 안 나갔다 → 해시 저장 후 먼저 제출
 *   - 429/5xx/네트워크 오류에서 바로 끝냈다 → mint-submit-policy 분류로 재시도
 *   - 끝나지 않은 건은 (app) 레이아웃의 `PendingMintRecovery` 가 앱이 열려 있는 동안 계속 제출
 *   - 로컬 기록은 서버가 COMPLETED 를 확인해 준 경우에만 지운다 (pending-mint.ts 규칙)
 */

/** receipt 로 기다릴 컨펌 수: 백엔드 `verifyTransfer` 기준과 같다. */
const REQUIRED_CONFIRMATIONS = 3;
/** receipt 대기 상한. 넘으면 백그라운드 복구로 넘긴다. */
const RECEIPT_TIMEOUT_MS = 120_000;
/** 컨펌 이후 화면 안에서 다시 묻는 간격. 나머지는 백그라운드가 느리게 처리. */
const IN_FLOW_RETRY_DELAYS_MS = [0, 3000, 6000, 12000];
/** 화면 안에서 기다려 줄 수 있는 Retry-After 상한. */
const IN_FLOW_MAX_WAIT_MS = 30_000;
/** 화면이 제출하는 동안 다른 탭의 복구 실행기가 같은 해시를 집지 않게 미뤄 두는 시간. */
const IN_FLOW_CLAIM_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type OnChainMintStep =
  | "idle"
  | "preflight"
  | "switching"
  | "transferring"
  | "confirming"
  | "minting"
  | "recovering";

type ReceiptState =
  "pending" | "success" | "reverted" | "cancelled" | "unknown";

export function useOnChainMint() {
  const { captureActor } = useWalletActorGuard();
  const { address, chainId } = useAccount();
  const activeNetwork = useNetworkStore((s) => s.activeNetwork);
  const net = NETWORKS[activeNetwork];
  const switchToActiveNetwork = useSwitchToActiveNetwork();
  const { writeContractAsync } = useWriteContract();
  const awaitWalletReady = useAwaitWalletReady();
  const publicClient = usePublicClient({ chainId: net.chainId });
  const mintFromTx = useMintFromTx();
  const { data: me } = useCurrentUser();
  const tMint = useTranslations("treasury.mint");
  const tOnchain = useTranslations("treasury.onchainMint");
  const tNetwork = useTranslations("network.labels");
  const locale = useLocale();
  const [step, setStep] = useState<OnChainMintStep>("idle");
  // 동기 더블클릭 방어: setStep 은 다음 렌더까지 반영이 지연된다.
  const inFlight = useRef(false);

  const userId = me?.id ?? null;
  const linkedWallet = me?.walletAddress ?? null;
  // Invalidate reviewed transfers even when selection changes away and back.
  // Exclude wallet chainId: the authorized flow switches that itself.
  const transferIdentity = JSON.stringify([activeNetwork, linkedWallet?.toLowerCase()]);
  const transferScope = useRef({ identity: transferIdentity, generation: 0 });
  if (transferScope.current.identity !== transferIdentity) {
    transferScope.current = {
      identity: transferIdentity,
      generation: transferScope.current.generation + 1,
    };
  }

  // UX 안내일 뿐 보호 장치가 아니다: 서명 지갑 판정은 서버 검증(expectedFrom)이 한다.
  const signerMismatch =
    !!address &&
    !!linkedWallet &&
    address.toLowerCase() !== linkedWallet.toLowerCase();
  const pendingDeposits = usePendingMints(userId, linkedWallet);

  const submitOnce = useCallback(
    (entry: Pick<PendingMint, "txHash" | "usdtAmount" | "network">) =>
      mintFromTx.mutateAsync({
        txHash: entry.txHash,
        usdtAmount: entry.usdtAmount,
        network: entry.network,
        silent: true,
      }),
    [mintFromTx]
  );

  const mint = async (
    inputAmount: string | number,
    reviewed?: MintTransferReview | null
  ) => {
    const assertActor = captureActor(userId);
    const generation = transferScope.current.generation;
    const assertTransferScope = () => {
      assertActor();
      if (
        transferScope.current.identity !== transferIdentity ||
        transferScope.current.generation !== generation
      ) throw new Error("ACCOUNT_CHANGED");
    };
    assertTransferScope();
    if (!address) throw new Error(tMint("connectWalletFirst"));
    let parsedAmount: ReturnType<typeof parseMintAmount>;
    try {
      parsedAmount = parseMintAmount(inputAmount);
    } catch (error) {
      throw new Error(
        tMint(
          error instanceof MintAmountPrecisionError
            ? "amountPrecisionUnsupported"
            : "invalidAmount"
        )
      );
    }
    const { numeric: usdtAmount, decimal: exactAmount } = parsedAmount;
    if (!net.usdt.address) {
      throw new Error(tOnchain("usdtContractMissing", {
          network: tNetwork(net.id),
          token: paymentSymbolOf(net.id),
        }));
    }
    if (!linkedWallet) throw new Error(tMint("connectWalletFirst"));
    // UX: 등록 지갑이 아닌 계정으로 서명하면 서버가 wrong_sender 로 거절한다 (2026-09-15).
    // 돈이 나가기 전에 알려 주는 안내일 뿐, 보호는 서버 검증이 한다.
    if (address.toLowerCase() !== linkedWallet.toLowerCase()) {
      throw new Error(
        tOnchain("signerMismatch", {
          signer: shortenAddress(address),
          linked: shortenAddress(linkedWallet),
        })
      );
    }
    if (inFlight.current) throw new Error(tOnchain("alreadyInFlight"));
    inFlight.current = true;

    setStep("preflight");
    // 화면이 다루는 해시 전부 (교체되면 원래 해시와 새 해시 둘 다).
    const claimed = new Set<string>();
    try {
      // 0. Preflight: 한도·Treasury 주소 사전 검증 (서명 팝업 전에 중단).
      let preflightSnapshot: unknown;
      let validated: ReturnType<typeof validateMintPreflight>;
      try {
        const { data: preRes } = await apiClient.post(
          "/treasury/swap/mint/preflight",
          { usdtAmount, network: activeNetwork }
        );
        preflightSnapshot = unwrap<unknown>(preRes);
        assertTransferScope();
        validated = validateMintPreflight(preflightSnapshot, net, exactAmount);
      } catch (e: unknown) {
        assertTransferScope();
        if (e instanceof Error && e.message === "ACCOUNT_CHANGED") throw e;
        if (e instanceof InvalidMintAmountError)
          throw new Error(tMint("invalidAmount"));
        // 한 번만 묻는다 (재시도 없음). 서버가 거절하면(한도, 입금 감시 불안정 등) 그 문구로
        // 전송을 막는다. 돈이 나가기 전이라 막는 것이 안전하다.
        if (isDepositDiscoveryUnavailable(e)) {
          throw new MintDiscoveryUnavailableError(
            discoveryUserCopyKey(e) === "discoveryLedgerUnsupported"
              ? tOnchain("discoveryLedgerUnsupported", {
                  network: tNetwork(net.id),
                })
              : discoveryUnavailableUserMessage(
                  e,
                  tOnchain("discoveryUnavailable"),
                  locale
                ),
            discoveryUnavailableReason(e)
          );
        }
        throw new Error(preflightErrorMessage(e, tOnchain("preflightFailed")));
      }
      const transferReview: MintTransferReview = {
        ...validated,
        network: activeNetwork,
        chainId: net.chainId,
        account: linkedWallet,
        amount: exactAmount,
      };
      // First click prepares review only. Every confirmation fetches a fresh preflight;
      // rotated token, decimals or recipient require another explicit review.
      if (!reviewed || !sameMintTransfer(reviewed, transferReview)) {
        throw new MintReviewRequiredError(transferReview);
      }
      const { treasury, usdtContract, value } = validated;

      // 1. activeNetwork 체인으로 스위치
      if (chainId !== net.chainId) {
        setStep("switching");
        await switchToActiveNetwork();
        assertTransferScope();
      }

      // 2. USDT transfer
      setStep("transferring");
      await awaitWalletReady();
      assertTransferScope();
      const base = { userId, address, usdtAmount, network: activeNetwork };
      let saved: ReturnType<typeof upsertPendingMint> = null;
      const claim = (hash: string) => {
        claimed.add(hash.toLowerCase());
        markMintInFlight(hash);
        updatePendingMint(hash, {
          nextAttemptAt: Date.now() + IN_FLOW_CLAIM_MS,
        });
      };
      const originalHash = await runWalletOperation({
        operation: "mint",
        network: `eip155:${net.chainId}`,
        account: linkedWallet,
        validate: async () => {
          await awaitWalletReady({
            account: linkedWallet,
            chainId: net.chainId,
          });
          assertTransferScope();
          validateMintPreflight(preflightSnapshot, net, exactAmount);
          // Read durable per-hash records again inside the cross-tab wallet lock.
          // A different tab may have submitted after this screen rendered/reviewed.
          const entries = pendingMintsForUser(
            readPendingMints(),
            userId,
            linkedWallet
          );
          const outstanding = entries.some((entry) => {
            if (
              entry.network !== activeNetwork ||
              entry.address !== linkedWallet.toLowerCase() ||
              entry.chainOutcome ||
              entry.mintStatus === "COMPLETED"
            )
              return false;
            // A replacement predecessor is represented by its successor, if present.
            return (
              entry.status !== "replaced" ||
              !entries.some(
                (next) =>
                  next.txHash === entry.replacedBy &&
                  next.network === entry.network &&
                  next.address === entry.address
              )
            );
          });
          if (outstanding) throw new Error(tOnchain("alreadyInFlight"));
        },
        getTransactionId: (hash) => hash,
        submit: () =>
          writeContractAsync({
            // 위 UX 확인을 통과한 연결 지갑으로 고정한다 (확인 뒤 지갑 계정이 바뀌어도 다른 계정으로 서명하지 않음).
            account: linkedWallet as `0x${string}`,
            address: usdtContract,
            abi: BSC_USDT_ABI,
            functionName: "transfer",
            args: [treasury, value],
            chainId: net.chainId,
            // 공개 RPC 가 가스를 하한 아래로 추정하는 체인(Mezo)은 고정 한도로 보낸다.
            ...(net.paymentTransferGas ? { gas: net.paymentTransferGas } : {}),
          }),
        onSubmitted: (hash) => {
          saved = upsertPendingMint({ ...base, txHash: hash });
          claim(hash);
          if (!saved?.persisted) {
            toast.warning(tOnchain("depositNotPersisted", { hash }), {
              duration: Infinity,
              closeButton: true,
            });
          }
        },
      });

      /** 지금 제출할 해시. 지갑이 교체하면 바뀐다. */
      let currentHash: string = originalHash.toLowerCase();
      const currentEntry = (): PendingMint =>
        readPendingMints().find((e) => e.txHash === currentHash) ??
        saved?.entry ?? {
          txHash: currentHash,
          userId,
          address: address.toLowerCase(),
          usdtAmount,
          network: activeNetwork,
          createdAt: Date.now(),
          attempts: 0,
          nextAttemptAt: Date.now(),
          status: "submitting",
          mintStatus: null,
          replacedBy: null,
          replaces: null,
          support: null,
          serverAcknowledged: false,
          waitReason: null,
          retryAt: null,
          holdReason: null,
          chainOutcome: null,
        };

      // receipt 는 옆에서 기다린다 (교체 감지 + revert 감지 + 컨펌 뒤 재제출 시점).
      const receipt: { state: ReceiptState } = { state: "pending" };
      const receiptDone: Promise<void> = publicClient
        ? publicClient
            .waitForTransactionReceipt({
              hash: originalHash,
              confirmations: REQUIRED_CONFIRMATIONS,
              timeout: RECEIPT_TIMEOUT_MS,
              onReplaced: (replacement) => {
                const newHash = replacement.transaction.hash;
                if (replacement.reason === "cancelled") {
                  // 같은 nonce 의 0 원 자기 송금으로 취소됐다: 원래 transfer 는 영원히 채굴되지 않는다.
                  // 기록은 지우지 않고 표시만 한다. 서버도 행이 없다고 답할 때 정리된다.
                  receipt.state = "cancelled";
                  settleWalletTransaction(
                    `eip155:${net.chainId}`,
                    originalHash,
                    "failed"
                  );
                  updatePendingMint(currentHash, { chainOutcome: "cancelled" });
                  return;
                }
                settleWalletTransaction(
                  `eip155:${net.chainId}`,
                  originalHash,
                  "unknown"
                );
                saved = recordPendingMintReplacement(currentHash, {
                  ...base,
                  txHash: newHash,
                });
                claim(newHash);
                currentHash = newHash.toLowerCase();
                if (!saved?.persisted) {
                  toast.warning(tOnchain("depositNotPersisted", { hash: newHash }), {
                    duration: Infinity,
                    closeButton: true,
                  });
                }
              },
            })
            .then((r) => {
              if (receipt.state === "cancelled") return;
              assertWalletReceipt(r, currentHash);
              receipt.state = r.status === "success" ? "success" : "reverted";
              if (currentHash === originalHash.toLowerCase()) {
                settleWalletTransaction(
                  `eip155:${net.chainId}`,
                  originalHash,
                  r.status === "success" ? "confirmed" : "failed"
                );
              }
            })
            .catch(() => {
              receipt.state = "unknown";
              settleWalletTransaction(
                `eip155:${net.chainId}`,
                originalHash,
                "unknown"
              );
            })
        : Promise.resolve().then(() => {
            receipt.state = "unknown";
            settleWalletTransaction(
              `eip155:${net.chainId}`,
              originalHash,
              "unknown"
            );
          });

      setStep("minting");

      /** 마지막 서버 대기 응답 (안내 문구 선택용). */
      const lastWait = {
        waitReason: null as string | null,
        retryAt: null as number | null,
        holdReason: null as string | null,
        /** 서버가 정한 다음 확인 시각 (retryAfterSec). 안내 문구의 예상 시각. */
        nextAttemptAt: null as number | null,
        retryAfterMs: 0,
      };
      const waitMessage = () =>
        mintWaitMessage(tOnchain, locale, lastWait).text;
      const handOff = (message: string = waitMessage()): never => {
        throw new MintStillConfirmingError(message, currentHash);
      };

      /** 한 번 제출. 끝났으면 결과, 계속 기다려야 하면 null. 고객지원 필요면 throw. */
      const attempt = async (): Promise<MintFromTxResult | null> => {
        const cooldown = mintCooldownRemainingMs();
        if (cooldown > IN_FLOW_MAX_WAIT_MS) return null;
        if (cooldown > 0) await sleep(cooldown);
        const entry = currentEntry();
        // 유저 단위 직렬화: 백그라운드 제출이 끝날 때까지 기다린다.
        const locked = await withMintSubmitLock(async () => {
          assertActor();
          try {
            const result = await submitOnce(entry);
            assertActor();
            removeSettledPendingMint(entry.txHash);
            return { ok: true as const, result };
          } catch (err) {
            return { ok: false as const, err };
          }
        });
        assertActor();
        if (!locked.acquired) return null;
        if (locked.value.ok) return locked.value.result;
        const err = locked.value.err;
        const outcome = classifyMintSubmitError(err);
        const applied = applyMintSubmitOutcome(entry, outcome);
        if (applied.type === "needsSupport") {
          // 지우지 않았다. 해시와 고객지원 안내를 함께 보여준다.
          handleApiErrorWith(err, {
            action: tOnchain("depositFailedSupportAction"),
            detail: tOnchain("depositFailedTxHash", { hash: entry.txHash }),
            duration: 20_000,
          });
          throw new MintFailureReportedError(
            tOnchain("depositFailed"),
            entry.txHash
          );
        }
        if (applied.type === "noDepositClosed") {
          // 입금 없음으로 정상 종료: 실패·고객지원 안내가 아니라 중립 안내.
          throw new MintChainFailedError(
            tOnchain("noDepositClosed"),
            entry.txHash
          );
        }
        if (applied.type === "chainFailedClosed") {
          throw new MintChainFailedError(
            tOnchain("chainFailedNoFunds"),
            entry.txHash
          );
        }
        if (applied.type === "settled") {
          // 서버 행이 COMPLETED: 이미 지급됐다. "처리 대기" 가 아니라 완료로 알린다.
          throw new MintAlreadyCompletedError(
            tOnchain("depositAlreadyCompleted"),
            entry.txHash
          );
        }
        if (applied.type === "accepted") {
          handOff(tOnchain("depositAcceptedToast"));
        }
        if (applied.type === "kept") {
          lastWait.waitReason = applied.waitReason;
          lastWait.retryAt = applied.retryAt;
          lastWait.holdReason = applied.holdReason;
          lastWait.retryAfterMs =
            outcome.kind === "waiting" ? (outcome.retryAfterMs ?? 0) : 0;
          lastWait.nextAttemptAt =
            lastWait.retryAfterMs > 0 ? Date.now() + lastWait.retryAfterMs : null;
          // 한도 초기화 대기: 그 시각 전에는 다시 물어도 같은 답이다. 바로 백그라운드로 넘긴다.
          // 운영자 확인·원장 복귀·발행 대기열도 같다: 몇 초 안에는 답이 바뀌지 않는다.
          // 서버가 화면에서 기다려 줄 수 있는 것보다 긴 간격을 정했으면 그것도 넘긴다.
          if (
            applied.waitReason === "MINT_DAILY_LIMIT" ||
            isSlowWait(applied.waitReason) ||
            lastWait.retryAfterMs > IN_FLOW_MAX_WAIT_MS
          ) {
            handOff();
          }
        }
        return null;
      };

      // 3. 해시 저장 직후 제출: 서버에 입금 기록부터 남긴다.
      const first = await attempt();
      if (first) return { txHash: currentHash, ...first };

      // 4. 컨펌(또는 교체)을 기다린 뒤 짧게 몇 번 더.
      setStep("confirming");
      await receiptDone;
      if (receipt.state === "reverted" || receipt.state === "cancelled") {
        // receipt 로 확인된 체인 실패·취소: 자금 이동 없음. 표시해 두고 서버에 한 번 물어,
        // 서버도 행이 없다고 답하면 기록을 정리한다 (아니면 백그라운드가 계속 확인).
        if (receipt.state === "reverted") {
          updatePendingMint(currentHash, { chainOutcome: "reverted" });
        }
        try {
          await attempt();
        } catch {
          /* 체인 실패 안내가 우선이다 */
        }
        throw new MintChainFailedError(
          tOnchain("chainFailedNoFunds"),
          currentHash
        );
      }
      if (receipt.state !== "success") handOff();

      setStep("minting");
      for (const delay of IN_FLOW_RETRY_DELAYS_MS) {
        // 서버가 정한 간격보다 먼저 묻지 않는다 (그 전에는 같은 답이 캐시에서 온다).
        const wait = Math.max(delay, lastWait.retryAfterMs);
        if (wait > 0) await sleep(wait);
        const result = await attempt();
        if (result) return { txHash: currentHash, ...result };
      }
      return handOff();
    } finally {
      for (const hash of claimed) {
        unmarkMintInFlight(hash);
        // 화면 제출이 끝났다. 남은 건은 백그라운드 실행기가 이어받을 수 있게 선점을 푼다.
        releaseMintInFlowClaim(hash, IN_FLOW_CLAIM_MS);
      }
      setStep("idle");
      inFlight.current = false;
    }
  };

  return {
    mint,
    step,
    isPending: step !== "idle",
    activeNetwork,
    network: net,
    /** 지금 연결된 wagmi 계정 (서명할 지갑). */
    signerAddress: address ?? null,
    /** 등록된 지갑 주소. */
    linkedWallet,
    /** UX 안내용: 서명 지갑이 등록 지갑과 다르다 → 전송 버튼 비활성. */
    signerMismatch,
    /** 이 계정의 입금 기록 (처리 대기·접수됨·고객지원 필요). */
    pendingDeposits,
    /** 컨펌 대기 안내 문구가 필요한지. */
    hasPendingMint:
      step === "confirming" || step === "minting" || step === "recovering",
  };
}
