// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/solana/skr-escrow.service.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (383-446, 1420-1880, 2289-2433)
//   why:    External reward legs: per-leg claim, status, resume and recovery.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-382 omitted) …
  private asset(row: { rewardNetwork?: string; rewardAsset?: string }) {
    // 아바타 아이템 레그 — 개수 단위(소수점 없음). 토큰 레지스트리·MissionReward 와 무관하다.
    if (isWearableRewardAsset(row.rewardAsset))
      return {
        symbol: WEARABLE_REWARD_SYMBOL,
        network: row.rewardNetwork ?? WEARABLE_REWARD_NETWORK,
        scale: 1,
      };
    return isMonNetwork(row.rewardNetwork)
      ? {
          symbol: rewardSymbol(row.rewardNetwork, row.rewardAsset ?? 'NATIVE'),
          network: row.rewardNetwork,
          scale: 1e18,
        }
      : { symbol: 'SKR', network: 'solana', scale: 1e6 };
  }
  private async evmWallet(userId: string, tx?: Prisma.TransactionClient) {
    const user = await UsersService.readUnique(tx ?? this.db, {
      where: { id: userId },
      select: { walletAddress: true },
    });
    if (!user?.walletAddress || !isAddress(user.walletAddress))
      throw AppError.forbidden('WALLET_REQUIRED', '먼저 지갑을 연결해 주세요.');
    return {
      address: user.walletAddress.toLowerCase(),
      verifiedAt: new Date(0),
    };
  }
  private async treasuryAddress(row: { rewardNetwork?: string }) {
    return isMonNetwork(row.rewardNetwork)
      ? this.mon!.address(row.rewardNetwork)
      : this.chain.treasuryAddress();
  }
  private accounting(row: SolanaMissionEscrow) {
    return {
      network: row.rewardNetwork,
      deposited: BigInt(row.depositedRaw.toFixed()),
      reserved: BigInt(row.reservedRaw.toFixed()),
      paid: BigInt(row.paidRaw.toFixed()),
      refunded: BigInt(row.refundedRaw.toFixed()),
    };
  }
  /** 미션의 외부 자산 레그 전부 (legIndex 순). 예전 단일 행 미션은 레그 하나다. */
  async legs(
    db: Pick<Prisma.TransactionClient, 'solanaMissionEscrow'>,
    missionId: string,
  ) {
    return db.solanaMissionEscrow.findMany({
      where: { missionId },
      orderBy: [{ legIndex: 'asc' }, { rewardAsset: 'asc' }],
    });
  }
  private legKey(row: { missionId: string; rewardAsset: string }) {
    return {
      missionId_rewardAsset: {
        missionId: row.missionId,
        rewardAsset: row.rewardAsset,
      },
    };
  }
  /**
   * 지급 작업 키 — 대표 레그(legIndex 0)는 예전 키 그대로라 운영 중인 행·복구 코드와 그대로 맞물린다.
   * 추가 레그는 자산을 덧붙인다.
   */
// … (lines 447-1419 omitted) …
   */
  /**
   * 외부 레그를 보내기 전에 막힐 조건을 미리 본다 (M2). ClaimService 가 HST 를 외부 레그보다 먼저 지급하는 경로
   * (EVM 레그 + DB 원장) 에서 HST 지급 **전에** 부른다. 지갑이 없거나 승인된 참여자가 아니면 claim() 이 HST 지급 뒤에
   * 403 을 던져, HST 만 나가고 외부 레그는 시작도 못 했다. 여기서 같은 오류를 지급 전에 던진다 (읽기만 한다).
   */
  async precheckClaim(userId: string, missionId: string): Promise<void> {
    const legs = await this.legs(this.db, missionId);
    if (legs.length === 0)
      throw AppError.bad('SKR_ESCROW_NOT_FOUND', '이 미션의 보상 예치 정보를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
    if (isMonNetwork(legs[0].rewardNetwork)) await this.evmWallet(userId);
    const participant = await this.db.missionParticipant.findUnique({
      where: { missionId_userId: { missionId, userId } },
      select: { status: true },
    });
    if (!participant || !['APPROVED', 'COMPLETED'].includes(participant.status))
      throw AppError.forbidden('SKR_NOT_APPROVED', '승인된 참여자만 보상을 받을 수 있습니다. 참여 상태를 확인해 주세요.');
  }

  async claim(userId: string, missionId: string, partnerGoalProof?: VerifiedPartnerGoalClaim) {
    const legs = await this.legs(this.db, missionId);
    if (legs.length === 0)
      throw AppError.bad('SKR_ESCROW_NOT_FOUND', '이 미션의 보상 예치 정보를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
    const escrow = legs[0];
    const native = isMonNetwork(escrow.rewardNetwork);
    const wallet = native
      ? await this.evmWallet(userId)
      : await this.wallets.wallet(userId);
    const proof = native
      ? {
          state: 'VERIFIED',
          mint: wallet!.address,
          address: wallet!.address,
          verifiedAt: wallet!.verifiedAt.toISOString(),
        }
      : await this.seeker.verify(userId);
    if (
      !wallet ||
      proof.state !== 'VERIFIED' ||
      !proof.mint ||
      proof.address !== wallet.address ||
      proof.verifiedAt !== wallet.verifiedAt.toISOString()
    )
      throw AppError.forbidden('SEEKER_REQUIRED', 'Seeker 기기 인증이 필요합니다. 인증한 지갑으로 다시 시도해 주세요.');
    const rewards: Array<{
      type: 'TOKEN' | 'WEARABLE';
      tokenSymbol: string;
      amountRaw: string;
      amount: number;
      signature?: string;
    }> = [];
    let idempotent = true;
    // 레그가 여럿이면 한 레그가 보류·실패해도 나머지 레그를 이번 요청에서 모두 보낸다 (2026-10-25 C1).
    // 끝나지 않은 레그는 모아 두었다가 마지막에 한 번 알린다 — 레그 요약은 claimStatus.legs 에 있다.
    const unsettled: Array<{
      asset: string;
      status: 'PENDING' | 'FAILED';
      code: string;
    }> = [];
    const multiLeg = legs.length > 1;
    // Low: 레그 하나의 다른 오류(지급 상태 오류가 아닌 것)가 이번 요청의 남은 레그를 멈추지 않는다. 첫 오류를 기억하고
    // 그 레그는 실패로 셈한다. 아무 레그도 지급·보류되지 않았으면 그 오류를 그대로 던진다 (레그 하나일 때와 같은 응답).
    let firstLegError: unknown = null;
    const legError = (leg: SolanaMissionEscrow, e: unknown) => {
      firstLegError ??= e;
      unsettled.push({
        asset: this.asset(leg).symbol,
        status: 'FAILED',
        code: errorCodeOf(e) ?? 'SKR_LEG_ERROR',
      });
    };
    for (const leg of legs) {
      let operation: SolanaEscrowOperation;
      try {
        operation = await this.locked(
        missionId,
        async (tx, row, allLegs) => {
          if (!native) await lockSolanaWalletIdentity(tx, userId);
          if (
            row.vaultAddress &&
            (await this.chain.vault(missionId)) !== row.vaultAddress
          )
            throw AppError.conflict('SKR_VAULT_KEY_CHANGED', '보상 보관 주소가 바뀌어 처리를 멈췄습니다. 운영팀에 문의해 주세요.');
          const participant = await tx.missionParticipant.findUnique({
            where: { missionId_userId: { missionId, userId } },
          });
          if (
            !participant ||
            !['APPROVED', 'COMPLETED'].includes(participant.status)
          )
            throw AppError.forbidden('SKR_NOT_APPROVED', '승인된 참여자만 보상을 받을 수 있습니다. 참여 상태를 확인해 주세요.');
          const key = this.claimKey(participant.id, row);
          const old = await tx.solanaEscrowOperation.findUnique({
            where: { operationKey: key },
          });
          const claimRecord =
            (await tx.claimEvent.findUnique({
              where: { missionParticipantId: participant.id },
            })) ??
            (await createMissionClaimRecord(tx, userId, missionId, participant.id));
          const settled = await this.participantChainStatus(
            tx,
            missionId,
            participant.id,
          );
          // HST 레그가 온체인 원장이면 claimLedgerRewards 가 같은 ClaimEvent.chainPlan 에 EVM 분배 배열을 쓰고
          // 커밋 뒤 큐에서 정산한다. 재클레임의 외부 레그가 그 계획을 네이티브 계획으로 덮으면 HST 민팅이 영원히
          // 빠진다 (2026-10-23 검토 2번) — 배열 계획이 있으면 외부 레그는 chainPlan/chainStatus 를 건드리지 않는다.
          if (!Array.isArray(claimRecord.chainPlan))
          await tx.claimEvent.update({
            where: { id: claimRecord.id },
            data: {
              chainStatus: settled,
              // 지급 예정 금액도 계획에 남긴다 (관리자 정산 복구 표가 금액을 보여 준다). 이미 지급 작업이 있으면
              // 그 작업의 금액, 아니면 아래에서 만들 작업과 같은 미션 보상 금액이다. 정산은 이 값을 쓰지 않는다.
              chainPlan: nativeClaimPlan({
                native,
                participantId: participant.id,
                asset: this.asset(allLegs[0]),
                amountRaw: (
                  row.legIndex === 0 && old ? old.amountRaw : allLegs[0].rewardRaw
                ).toFixed(),
                legs:
                  allLegs.length > 1
                    ? allLegs.map((l) => ({
                        rewardAsset: l.rewardAsset,
                        token: this.asset(l).symbol,
                        amountRaw: l.rewardRaw.toFixed(),
                        amount:
                          Number(l.rewardRaw.toFixed()) / this.asset(l).scale,
                      }))
                    : undefined,
              }),
              chainLastError: settled === 'FAILED' ? 'MON_RETRY_LIMIT' : null,
              ...lastAttemptNow(),
              chainSettledAt:
                settled === 'CONFIRMED' ? (old?.finalizedAt ?? new Date()) : null,
            },
          });
          if (old?.status === 'FAILED') return this.retryFailedPayout(tx, row, old);
          if (old) return old;
          if (participant.status !== 'APPROVED') {
            // 추가 레그는 앞 레그가 참여를 이미 COMPLETED 로 올렸을 수 있다 — 대표 레그 작업이 있으면 정상 흐름.
            const primary =
              row.legIndex > 0
                ? await tx.solanaEscrowOperation.findUnique({
                    where: {
                      operationKey: this.claimKey(participant.id, allLegs[0]),
                    },
                    select: { id: true },
                  })
                : null;
            if (!primary)
              throw AppError.conflict('SKR_ALREADY_COMPLETED', '이미 보상을 받은 미션입니다.');
          }
          if (partnerGoalProof && row.legIndex === 0)
            await reserveVerifiedPartnerGoalClaim(
              tx, userId, missionId, partnerGoalProof,
            );
          const nowWallet = native
            ? await this.evmWallet(userId, tx)
            : await tx.solanaWalletConnection.findUnique({
                where: { userId },
              });
          if (
            nowWallet?.address !== wallet.address ||
            nowWallet.verifiedAt.getTime() !== wallet.verifiedAt.getTime()
          )
            throw AppError.conflict('SOLANA_WALLET_CHANGED', '연결된 Solana 지갑이 바뀌었습니다. 지갑을 확인한 뒤 다시 시도해 주세요.');
          const amount = BigInt(row.rewardRaw.toFixed());
          const reserved = reserveSkr(this.accounting(row), amount);
          await tx.solanaMissionEscrow.update({
            where: this.legKey(row),
            data: { reservedRaw: reserved.reserved.toString() },
          });
          return tx.solanaEscrowOperation.create({
            data: {
              operationKey: key,
              missionId,
              rewardAsset: row.rewardAsset,
              kind: 'PAYOUT',
              participantId: participant.id,
              seekerMint: proof.mint,
              recipientAddress: wallet.address,
              amountRaw: amount.toString(),
            },
          });
        },
        leg.rewardAsset,
      );
      } catch (e) {
        const code = errorCodeOf(e);
        if (!multiLeg) throw e;
        if (!code || !LEG_PAYMENT_ERRORS.has(code)) {
          legError(leg, e);
          continue;
        }
        unsettled.push({
          asset: this.asset(leg).symbol,
          status: code === 'SKR_PAYMENT_PENDING' ? 'PENDING' : 'FAILED',
          code,
        });
        continue;
      }
      if (!native && !operation.signature && operation.status === 'PREPARED') {
        const plan = await this.chain.prepareClaim(
          missionId,
          operation.recipientAddress,
          BigInt(operation.amountRaw.toFixed()),
        );
        const height = BigInt(await this.chain.height());
        const prepared = await this.locked(missionId, async (tx) => {
          const current = await tx.solanaEscrowOperation.findUniqueOrThrow({
            where: { id: operation.id },
          });
          if (current.signature || current.status !== 'PREPARED') return current;
          if (
            current.transactionBase64 &&
            current.lastValidBlockHeight != null &&
            current.lastValidBlockHeight >= height
          )
            return current;
          return tx.solanaEscrowOperation.update({
            where: { id: current.id },
            data: plan,
          });
        });
        if (!prepared.signature)
          return {
            success: false as const,
            rewards: [],
            claimTransaction: prepared.transactionBase64!,
            claimAddress: prepared.recipientAddress,
            idempotent: false,
          };
      }
      try {
        await this.sendAndSync(operation.id);
      } catch (e) {
        // The payout row is already persisted (PREPARED, or SUBMITTED with its
        // signed bytes), and the recovery cron resumes it. An RPC outage while
        // signing or checking it is therefore "still on the way", not a 500
        // that hides the legs already paid and skips the remaining ones
        // (2026-10-25 Mezo e2e: HST paid, MUSD stuck, MEZO never tried).
        if (e instanceof HttpException) {
          if (!multiLeg) throw e;
          legError(leg, e);
          continue;
        }
        this.logger.warn(
          `SKR payout deferred for recovery: op=${operation.id} asset=${leg.rewardAsset}: ${(e as Error)?.message?.split('\n')[0] ?? e}`,
        );
      }
      const current = await this.db.solanaEscrowOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      if (current.status !== 'FINALIZED') {
        if (!multiLeg)
          throw current.status === 'FAILED'
            ? AppError.conflict('SKR_PAYMENT_FAILED', '보상 지급에 실패했습니다. 다시 시도해 주세요.')
            : AppError.conflict('SKR_PAYMENT_PENDING', 'SKR_PAYMENT_PENDING');
        unsettled.push({
          asset: this.asset(leg).symbol,
          status: current.status === 'FAILED' ? 'FAILED' : 'PENDING',
          code:
            current.status === 'FAILED' ? 'SKR_PAYMENT_FAILED' : 'SKR_PAYMENT_PENDING',
        });
        continue;
      }
      idempotent &&= operation.status === 'FINALIZED';
      rewards.push({
        type: isWearableRewardAsset(leg.rewardAsset)
          ? ('WEARABLE' as const)
          : ('TOKEN' as const),
        tokenSymbol: this.asset(leg).symbol,
        amountRaw: current.amountRaw.toFixed(),
        amount: Number(current.amountRaw.toFixed()) / this.asset(leg).scale,
        ...(isWearableRewardAsset(leg.rewardAsset) && current.signature
          ? { signature: current.signature }
          : {}),
      });
    }
    if (
      firstLegError &&
      rewards.length === 0 &&
      unsettled.every((u) => u.status === 'FAILED' && !LEG_PAYMENT_ERRORS.has(u.code))
    )
      throw firstLegError;
    if (unsettled.length > 0) {
      // 보류가 하나라도 있으면 보류로 알린다 (프론트는 확인 루프로 claimStatus.legs 를 본다).
      // 보류 없이 실패만 남았으면 첫 실패 코드 — 재시도 상한이면 MON_RETRY_LIMIT.
      const legs = {
        paidLegs: rewards.map((r) => r.tokenSymbol).join(','),
        pendingLegs: unsettled
          .filter((u) => u.status === 'PENDING')
          .map((u) => u.asset)
          .join(','),
        failedLegs: unsettled
          .filter((u) => u.status === 'FAILED')
          .map((u) => u.asset)
          .join(','),
      };
      if (legs.pendingLegs)
        throw AppError.conflict('SKR_PAYMENT_PENDING', 'SKR_PAYMENT_PENDING', legs);
      if (unsettled.some((u) => u.code === 'MON_RETRY_LIMIT'))
        throw AppError.conflict(
          'MON_RETRY_LIMIT',
          '보상 지급 재시도 횟수를 넘었습니다. 운영팀에 문의해 주세요.',
          legs,
        );
      throw AppError.conflict(
        'SKR_PAYMENT_FAILED',
        '보상 지급에 실패했습니다. 다시 시도해 주세요.',
        legs,
      );
    }
    return { success: true as const, rewards, idempotent };
  }
  /** Read-only, participant-owned settlement truth; never exposes signed bytes. */
  async claimStatus(userId: string, missionId: string) {
    const participant = await this.db.missionParticipant.findUnique({
      where: { missionId_userId: { missionId, userId } },
      select: { id: true },
    });
    if (!participant) throw AppError.forbidden('SKR_NOT_APPROVED', '승인된 참여자만 보상을 받을 수 있습니다. 참여 상태를 확인해 주세요.');
    const ops = await this.db.solanaEscrowOperation.findMany({
      where: { missionId, participantId: participant.id, kind: 'PAYOUT' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        signature: true,
        recipientAddress: true,
        amountRaw: true,
        rewardAsset: true,
        failedAttempts: true,
      },
    });
    const legs = await this.claimLegs(missionId, participant.id, ops);
    // 대표 필드(id·status·signature·recipientAddress·amountRaw)는 예전 그대로 대표 레그(먼저 만든 작업)의 값이다.
    // legs[] 에 레그마다 상태·서명·네트워크가 있고, 원장 HST 레그도 함께 싣는다 (2026-10-25 C1).
    const operation = ops[0];
    if (!operation && !legs.some((l) => l.status === 'FINALIZED')) return null;
    return {
      id: operation?.id ?? null,
      status: operation?.status ?? null,
      signature: operation?.signature ?? null,
      recipientAddress: operation?.recipientAddress ?? null,
      amountRaw: operation ? operation.amountRaw.toString() : null,
      userId,
      legs,
    };
  }

  /**
   * 이 참여자에게 다시 클레임하면 이어서 보낼 외부 레그가 있는가 (claim preview 의 재개 판정, 2026-10-25 B-1).
   * 작업이 아직 없거나(장부가 열려 있을 때), 보내는 중이거나, 재시도 예산 안의 실패면 true.
   * 전부 확정됐거나 남은 레그가 재시도 상한·장부 닫힘으로 더 보낼 수 없으면 false.
   */
  async hasResumableLegs(
    missionId: string,
    participantId: string,
  ): Promise<boolean> {
    const ops = await this.db.solanaEscrowOperation.findMany({
      where: { missionId, participantId, kind: 'PAYOUT' },
      select: {
        status: true,
        signature: true,
        amountRaw: true,
        rewardAsset: true,
        failedAttempts: true,
      },
    });
    const legs = await this.claimLegs(missionId, participantId, ops);
    const escrowLegs = await this.legs(this.db, missionId);
    // H3: 외부 레그가 전부 확정됐는데 원장 HST 레그가 아직 기록되지 않았다 (외부 레그 뒤에 HST 를 붙이는 경로 —
    // 파트너 목표·Solana SKR·온체인 원장 — 에서 HST 지급이 실패한 경우). 다시 클레임하면 HST 만 붙는다
    // (claimLedgerRewards 의 grossHst FOR UPDATE 가드가 이중 지급을 막는다).
    const external = legs.filter((leg) => leg.kind === 'EXTERNAL');
    if (
      external.length > 0 &&
      external.every((leg) => leg.status === 'FINALIZED') &&
      legs.some((leg) => leg.kind === 'LEDGER' && leg.status === 'NOT_STARTED')
    )
      return true;
    return legs.some((leg) => {
      if (leg.kind !== 'EXTERNAL') return false;
      if (leg.status === 'FINALIZED') return false;
      if (leg.status === 'FAILED') return leg.retryable;
      if (leg.status === 'NOT_STARTED')
        return !escrowLegs.find((e) => e.rewardAsset === leg.rewardAsset)
          ?.closedAt;
      return true;
    });
  }

  /** 참여자의 레그별 지급 상태 — 에스크로 레그 전부(작업이 아직 없으면 NOT_STARTED) + 원장 HST 레그. */
  private async claimLegs(
    missionId: string,
    participantId: string,
    ops: Array<
      Pick<
        SolanaEscrowOperation,
        'status' | 'signature' | 'amountRaw' | 'rewardAsset' | 'failedAttempts'
      >
    >,
  ): Promise<ClaimLegStatus[]> {
    const escrowLegs = await this.legs(this.db, missionId);
    const out: ClaimLegStatus[] = escrowLegs.map((leg) => {
      const op = ops.find((o) => o.rewardAsset === leg.rewardAsset);
      const asset = this.asset(leg);
      const native = isMonNetwork(leg.rewardNetwork);
      const failures = retryFailuresUsed(op?.failedAttempts);
      const raw = op ? op.amountRaw.toFixed() : leg.rewardRaw.toFixed();
      return {
        kind: 'EXTERNAL',
        rewardAsset: leg.rewardAsset,
        asset: asset.symbol,
        network: asset.network,
        status: (op?.status ?? 'NOT_STARTED') as ClaimLegStatus['status'],
        signature: op?.signature ?? null,
        txHash: native ? (op?.signature ?? null) : null,
        amountRaw: raw,
        amount: Number(raw) / asset.scale,
        retryable:
          op?.status === 'FAILED' &&
          !leg.closedAt &&
          (!native || failures < MON_FAILED_ATTEMPT_LIMIT),
      };
    });
    // 원장 HST 레그 — ClaimEvent.grossHst 가 지급 기록이다 (claimLedgerRewards 의 멱등 가드와 같은 기준).
    const hstRewards = await this.db.missionReward.findMany({
      where: { missionId, type: 'TOKEN', token: { symbol: 'HST' } },
      select: { amount: true, token: { select: { network: true } } },
    });
    const gross = hstRewards.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    if (gross > 0) {
      const record = await this.db.claimEvent.findUnique({
        where: { missionParticipantId: participantId },
        select: { grossHst: true },
      });
      const paid = Number(record?.grossHst ?? 0) > 0;
      out.push({
        kind: 'LEDGER',
        rewardAsset: 'HST',
        asset: 'HST',
        network: hstRewards[0]?.token?.network ?? 'bsc',
        // Unpaid HST is not "on the way": nothing is sending it until the next
        // claim or ledger settlement. PENDING made the page poll and show
        // "Sending" forever (2026-10-25 Mezo e2e review).
        status: paid ? 'FINALIZED' : 'NOT_STARTED',
        signature: null,
        txHash: null,
        amountRaw: null,
        amount: paid ? Number(record?.grossHst) : gross,
        retryable: false,
      });
    }
    return out;
  }
  async submitClaim(userId: string, missionId: string, signed: string) {
// … (lines 1881-2288 omitted) …
  async settleClaimRecord(record: {
    missionId: string;
    missionParticipantId: string;
    chainPlan: unknown;
  }) {
    const plan = record.chainPlan as {
      kind?: string;
      participantId?: string;
    } | null;
    if (plan?.kind !== 'SOLANA_SKR' && plan?.kind !== 'MON_NATIVE')
      return false;
    // 레그마다 지급 작업이 하나씩 — 아직 작업이 만들어지지 않은 레그(앞 레그 실패 뒤)는 참여자의
    // 재클레임(executeClaim)이 지갑 확인과 함께 만든다. 여기서는 있는 작업만 이어서 보낸다.
    const ops = await this.db.solanaEscrowOperation.findMany({
      where: {
        missionId: record.missionId,
        participantId: record.missionParticipantId,
        kind: 'PAYOUT',
      },
      orderBy: { createdAt: 'asc' },
    });
    if (
      ops.length === 0 ||
      ops.some((op) => plan.participantId !== op.participantId)
    )
      throw AppError.conflict('SKR_CLAIM_RECORD_MISMATCH', '보상 지급 기록이 맞지 않습니다. 운영팀에 문의해 주세요.');
    // 복구 크론의 재전송도 한 번의 시도다 (관리자 정산 복구 표의 "마지막 시도").
    await this.db.claimEvent.updateMany({
      where: { missionParticipantId: record.missionParticipantId },
      data: { ...lastAttemptNow() },
    });
    // 레그마다 따로 시도한다 — 한 레그의 MON_RETRY_LIMIT·RPC 오류가 다른 레그를 멈추지 않는다 (2026-10-25 B-2).
    for (const op of ops) {
      try {
        if (op.status === 'FAILED') {
          await this.locked(
            op.missionId,
            async (tx, row) => {
              const fresh = await tx.solanaEscrowOperation.findUniqueOrThrow({
                where: { id: op.id },
              });
              if (fresh.status !== 'FAILED') return;
              await this.retryFailedPayout(tx, row, fresh);
            },
            op.rewardAsset,
          );
        }
        await this.sendAndSync(op.id);
      } catch (e) {
        if (errorCodeOf(e) === 'MON_RETRY_LIMIT') {
          // 이 레그는 더 보내지 않는다 — 기록을 FAILED 로 굳혀 크론이 헛돌지 않게 하고 운영자에게 알린다.
          await this.db.claimEvent.updateMany({
            where: { missionParticipantId: record.missionParticipantId },
            data: {
              chainStatus: 'FAILED',
              chainLastError: 'MON_RETRY_LIMIT',
              chainSettledAt: null,
            },
          });
          const escrow = (await this.legs(this.db, record.missionId)).find(
            (l) => l.rewardAsset === op.rewardAsset,
          );
          this.alertLegGivenUp(
            op,
            escrow?.rewardNetwork ?? 'unknown',
            'MON_RETRY_LIMIT',
          );
        } else
          this.logger.warn(
            `claim leg settlement deferred: op=${op.id} asset=${op.rewardAsset}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
      }
    }
    // 앞 레그가 확정된 뒤 요청이 죽어 뒤 레그 작업이 아예 만들어지지 않은 참여자 (2026-10-23 검토 3번).
    // 참여자는 화면에 완료로 보여 재클레임할 이유가 없으므로 복구가 대표 작업의 수신 주소로 남은 레그를 만든다.
    // 레그 장부가 이미 닫혔으면 FAILED + SKR_LEG_MISSING 으로 굳혀 크론이 헛돌지 않게 하고 관리자 표에 드러낸다.
    const settledOps = await this.db.solanaEscrowOperation.findMany({
      where: {
        missionId: record.missionId,
        participantId: record.missionParticipantId,
        kind: 'PAYOUT',
      },
      orderBy: { createdAt: 'asc' },
    });
    if (settledOps.every((op) => op.status === 'FINALIZED')) {
      const legs = await this.legs(this.db, record.missionId);
      const primary =
        settledOps.find((op) => op.rewardAsset === legs[0]?.rewardAsset) ??
        settledOps[0];
      for (const leg of legs) {
        if (settledOps.some((op) => op.rewardAsset === leg.rewardAsset)) continue;
        const created = await this.locked(
          record.missionId,
          async (tx, row) => {
            const key = this.claimKey(record.missionParticipantId, row);
            const existing = await tx.solanaEscrowOperation.findUnique({
              where: { operationKey: key },
            });
            if (existing) return existing;
            if (row.closedAt) {
              await tx.claimEvent.updateMany({
                where: { missionParticipantId: record.missionParticipantId },
                data: {
                  chainStatus: 'FAILED',
                  chainLastError: 'SKR_LEG_MISSING',
                  chainSettledAt: null,
                },
              });
              return null;
            }
            const amount = BigInt(row.rewardRaw.toFixed());
            const reserved = reserveSkr(this.accounting(row), amount);
            await tx.solanaMissionEscrow.update({
              where: this.legKey(row),
              data: { reservedRaw: reserved.reserved.toString() },
            });
            return tx.solanaEscrowOperation.create({
              data: {
                operationKey: key,
                missionId: record.missionId,
                rewardAsset: row.rewardAsset,
                kind: 'PAYOUT',
                participantId: record.missionParticipantId,
                seekerMint: primary.seekerMint,
                recipientAddress: primary.recipientAddress,
                amountRaw: amount.toString(),
              },
            });
          },
          leg.rewardAsset,
        );
        if (created)
          await this.sendAndSync(created.id).catch((e: unknown) =>
            this.logger.warn(
              `claim leg settlement deferred: op=${created.id}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
          );
      }
    }
    return true;
  }
// … (lines 2434-2616 omitted) …
