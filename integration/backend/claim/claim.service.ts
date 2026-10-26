// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/claim/claim.service.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (664-810)
//   why:    Claim entry point: HST ledger leg first (DB ledger), then external MUSD/MEZO legs.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-663 omitted) …

  // ═══════════════════════════════════════════════════════════════════
  //  EXECUTE CLAIM — Phase 17 single entry point (all-or-nothing)
  // ═══════════════════════════════════════════════════════════════════

  async executeClaim(
    userId: string,
    missionId: string,
    opts?: ExecuteClaimOpts,
  ): Promise<ExecuteClaimResult> {
    const mission: PrefetchedMissionForClaim | null =
      opts?.mission ??
      ((await this.prisma.mission.findUnique({
        where: { id: missionId },
        include: {
          rewards: {
            include: {
              token: { select: { id: true, symbol: true, network: true } },
              achievement: { select: { id: true, name: true, iconUrl: true } },
            },
          },
        },
      })));
    if (!mission)
      throw AppError.notFound(ErrorCode.MISSION_NOT_FOUND, 'Mission not found');

    const participant =
      opts?.participant ??
      (await this.prisma.missionParticipant.findUnique({
        where: { missionId_userId: { missionId, userId } },
      }));
    if (!participant)
      throw AppError.notFound(
        ErrorCode.MISSION_NO_PARTICIPATION,
        '참여 기록 없음',
      );

    const skr = await this.skrEscrow?.view(missionId);

    // Idempotency check — ClaimEvent 가 이미 있으면 재구성해서 반환
    const existingClaim = await this.prisma.claimEvent.findUnique({
      where: { missionParticipantId: participant.id },
    });
    if (existingClaim && !skr) {
      return {
        success: true,
        rewards: this.reconstructIdempotentRewards(mission, existingClaim),
        idempotent: true,
      };
    }

    const partnerGoal = mission.proofType === 'ONCHAIN_TX' &&
      parseOnchainRule(mission.onchainRule)?.kind === 'PARTNER_GOAL';
    if (partnerGoal && !opts?.partnerGoalProof) throw AppError.bad(
      ErrorCode.MISSION_CLAIM_NOT_READY, 'Partner goal verification required.',
    );

    // Chain transport differs, but the adapter writes the same ClaimEvent anchor
    // and can be resumed by settleClaimChain / ClaimChainRecoveryCron.
    if (skr) {
      await assertRequiredMintTasks(this.prisma, userId, mission);
      // 외부 자산(MUSD/MEZO/MON/SKR)과 함께 걸린 원장 보상(HST) — 같은 참여·같은 ClaimEvent 에 붙인다
      // (2026-10-23, "0.1 MEZO + 1 MUSD + 10 HST" 미션). 원장 레그는 HST 뿐이다. 외부 자산의 MissionReward 행은
      // rewardLedger 가 장부 표시용으로 만든 것이라 여기서 다시 적립하면 온체인 지급 위에 내부 잔액이 한 번 더 생긴다.
      const hstLegs = this.hstLedgerRewards(mission);
      const hasLedgerLegs = hstLegs.length > 0;
      // DB 원장(기본 — Mezo 테스트넷 포함)이면 HST 를 외부 레그보다 **먼저** 같은 요청에서 지급한다 (2026-10-25 B-1).
      // 외부 레그가 보류·실패해도 HST 가 걸려 있지 않게 하려는 것. 자체 트랜잭션 + grossHst 멱등 가드이고,
      // 참여 상태는 바꾸지 않는다 (외부 레그 확정이 COMPLETED 로 올린다 — 먼저 올리면 외부 레그가 막힌다).
      // 온체인 원장(휴면 경로)은 롤백 불가 민팅이라 예전처럼 외부 지급 확정 뒤에 붙인다.
      // 파트너 목표 미션도 뒤에 붙인다 — 지갑 축 소비원장은 외부 경로(대표 레그)가 먼저 써야 같은 지갑의
      // 두 번째 계정이 HST 만 받아 가지 못한다. 확정 뒤 처리기(payLedgerLegsAfterExternal)가 빠짐을 막는다.
      // Only EVM legs (Mezo, Monad) are paid HST-first. A Solana SKR leg first
      // checks the participant's Seeker device and may hand back a transaction
      // to sign (success:false); paying HST before that check paid HST to
      // participants the external leg then refused (2026-10-25 Mezo e2e review).
      const ledgerOnDb =
        hasLedgerLegs &&
        !partnerGoal &&
        isEvmRewardNetwork(skr.rewardNetwork) &&
        hstLegs.every(
          (r) =>
            !this.hst.isOnchainNetwork(
              (r.token?.network ?? DEFAULT_NETWORK) as NetworkId,
            ),
        );
      this.externalClaimsInFlight.add(participant.id);
      let ledger: ExecuteClaimResult | null = null;
      let result: ExecuteClaimResult;
      try {
        if (ledgerOnDb) {
          // M2: 외부 레그가 지갑·참여 상태로 거절될 요청이면 HST 를 먼저 지급하지 않는다.
          await this.skrEscrow!.precheckClaim(userId, missionId);
          ledger = await this.claimLedgerRewards(
            userId,
            missionId,
            mission,
            participant,
            opts,
            true,
            true,
          );
        }
        result = await this.skrEscrow!.claim(userId, missionId, opts?.partnerGoalProof);
        if (!result.success) return result;
        if (hasLedgerLegs && !ledgerOnDb)
          ledger = await this.claimLedgerRewards(
            userId,
            missionId,
            mission,
            participant,
            opts,
            true,
          );
      } finally {
        this.externalClaimsInFlight.delete(participant.id);
      }
      return {
        ...result,
        rewards: [
          // 외부 레그 지급은 SkrEscrowService.sendAndSync 가 레그마다 CLAIM 활동 로그를 이미 남겼다 (B-8).
          ...result.rewards.map((r) => ({ ...r, external: true })),
          ...(ledger?.rewards ?? []),
          ...mission.rewards
            .filter((r) => r.type === 'SBT' && r.achievementId)
            .map((r) => ({
              type: 'SBT' as const,
              achievementId: r.achievementId!,
            })),
        ],
        idempotent: (result.idempotent ?? false) && (ledger?.idempotent ?? true),
      };
    }

    return this.claimLedgerRewards(
      userId,
      missionId,
      mission,
      participant,
      opts,
      false,
    );
  }

  /**
   * 원장 보상(HST·크리에이터 토큰)·SBT·CUSTOM 을 한 DB 트랜잭션으로 지급하고, 미뤄둔
   * 온체인 분배(chainPlan)를 커밋 뒤 큐에 건다 — 기존 executeClaim 본문 그대로.
// … (lines 811-1900 omitted) …
