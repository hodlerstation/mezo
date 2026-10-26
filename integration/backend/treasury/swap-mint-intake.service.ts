// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/treasury/swap-mint-intake.service.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (115-237)
//   why:    Mint preflight: the same BSC USDT mint flow, parameterised by network (MUSD on Mezo).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-114 omitted) …
   *   3. Treasury FEE_COLLECTOR 주소 존재
   *   4. 민팅 한도 (총한도 / 일한도)
   *
   * 반환: { treasury, chainId, quote } — 프론트가 이 값으로 transfer 실행
   *
   * 주의: 이 검증은 race를 완전히 막지 못한다 (preflight 통과 후 transfer mined
   * 시점 사이에 다른 tx가 한도를 먼저 소진할 수 있음). 따라서 `mintFromTx` 진입
   * 시에도 `mint()` 내부에서 한도를 **재검증**한다.
   */
  async mintPreflight(
    userId: string,
    usdtIn: number,
    network: NetworkId = DEFAULT_NETWORK,
  ) {
    try {
      usdtIn = requirePositiveAmount(usdtIn, '민팅 금액');
    } catch {
      throw AppError.bad(
        ErrorCode.SWAP_INVALID_AMOUNT,
        '수량은 0보다 커야 합니다',
      );
    }

    const user = (await this.users.findRawById(userId, {
      walletAddress: true,
    })) as { walletAddress: string | null } | null;
    if (!user)
      throw AppError.notFound(
        ErrorCode.USER_NOT_FOUND,
        '유저를 찾을 수 없습니다',
      );
    if (!user.walletAddress) {
      throw AppError.bad(
        ErrorCode.WALLET_NOT_LINKED,
        '지갑을 먼저 연결해 주세요.',
      );
    }

    // USDT 컨트랙트 미설정(GIWA placeholder) 시 여기서 throw — 지갑 팝업 전에 차단
    const usdt = requireUsdt(network);

    const treasuryAddress = await this.treasuryWallet.getAddress(
      WalletKind.FEE_COLLECTOR,
      network,
    );
    if (!treasuryAddress) {
      throw AppError.bad(
        ErrorCode.SWAP_UNAVAILABLE,
        '지금은 이 네트워크에서 구매를 받을 수 없습니다. 잠시 후 다시 시도하거나 고객지원에 문의해 주세요.',
      );
    }

    // 입금 발견이 건강하지 않으면 입금을 받지 않는다 (fail closed, 두 네트워크 공통).
    if (!this.depositObservations)
      throw discoveryUnavailableError('observation_service_missing');
    // bsc(실자산) 온체인 모드(BNB)는 받지 않는다 — 그 체인에는 durable 민팅 흐름이 없다.
    // giwa 는 intent 워커, 그 밖의 온체인 네트워크(mezo-testnet)는 커밋 뒤 ChainSettlement 가 발행한다.
    if (network === DEFAULT_NETWORK && this.hst.isOnchainNetwork(network))
      throw discoveryUnavailableError(
        'ledger_mode_unsupported',
        'onchain ledger on this network has no durable mint flow',
      );
    // 온체인 원장 네트워크(mezo-testnet 등)는 커밋 뒤 operator 지갑이 HST 를 발행한다.
    // 그 네트워크 자신의 operator 지갑이 없으면 입금은 받고 발행은 못 하는 상태
    // ("성공했는데 잔액 0") 가 되므로, 지갑 팝업 전에 같은 503 으로 막는다.
    if (network !== DEFAULT_NETWORK && this.hst.isOnchainNetwork(network)) {
      if (!(await this.hasOwnOperatorWallet(network)))
        throw discoveryUnavailableError(
          'operator_missing',
          `no ${HST_OPERATOR_WALLET_KIND} wallet registered for ${network}`,
        );
    }
    const health = await this.depositObservations.discoveryHealth(network);
    if (!health.healthy)
      throw discoveryUnavailableError(health.reason, health.detail);

    const quote = await this.quoteMint(usdtIn, userId, network);
    // 표시용 사전 검사 (지갑 팝업 전에 오늘 한도 초과를 알려준다). 아무것도 보장하지 않는다.
    // 실제 결정은 입금 뒤 접수 트랜잭션의 배정이다.
    await this.limits.enforce(userId, quote.netAmount, network);

    return {
      ok: true as const,
      network,
      treasury: treasuryAddress,
      chainId: this.bscReader.chainIdFor(network),
      usdt: { address: usdt.address, decimals: usdt.decimals },
      quote,
    };
  }

  /**
   * 이 네트워크 자신의 operator 지갑(HST_OPERATOR_V2 또는 HST_OPERATOR)이 활성인가.
   * BSC 지갑으로 대체된 주소(`fallbackFrom`)는 없는 것으로 본다 — 다른 체인 키로는 발행하지 않는다.
   * 예외: 레지스트리가 승인한 공유(`treasuryWalletFromDefault`, mezo-testnet → BSC FEE_COLLECTOR)는
   * resolveAddress 가 `fallbackFrom: null` 로 돌려주고 writer 도 같은 행으로 서명하므로 "있음" 이다.
   */
  private async hasOwnOperatorWallet(network: NetworkId): Promise<boolean> {
    const kinds = [HST_OPERATOR_V2_WALLET_KIND, HST_OPERATOR_WALLET_KIND];
    for (const kind of kinds) {
      const resolved = await this.treasuryWallet.resolveAddress(kind, network);
      if (resolved && resolved.fallbackFrom === null) return true;
    }
    return false;
  }

  /**
   * 온체인 USDT 입금 검증 후 민팅 (2026-09-15 3차 감사 반영).
   *
   * 판정 재료는 서버가 읽은 값뿐이다: receipt 상태·로그(토큰 Transfer), 정규 블록, DB 상태.
   * 클라이언트가 보낸 금액(`_clientAmount`)은 API 호환용이며 지급액은 로그 금액만 쓴다.
   * `txHashInput` 은 입금 tx 해시 또는 분할 스냅샷 키(`<hash>#<보낸 주소>`, 복구 크론 전용).
   *
   * 9차 소유자 결정 (2026-09-18): 입금은 **블록에 포함되는 즉시** 접수한다. 확정(finalized)을 기다리지 않는다.
   *
   * 순서:
   *   1. 이 키의 호출자 소유 행이 끝났거나 처리 중이면 RPC 없이 응답. 다음 시도 시각 전이면 대기 응답.
   *   2. receipt 판독 (성공 + 트레저리 도착 로그 + 그 높이의 합의 정규 블록).
   *   3. 정규 블록으로 확인되기 전: 입금 관찰 기록·판정을 하지 않는다. 호출자 연결 지갑이 보낸 주소일 때만
   *      호출자 소유 대기 행을 둔다 (재조직 중이거나 소스가 아직 그 블록을 모르는 짧은 구간).
   *   4. 확인 후: 보낸 주소를 모두 기록하고 스윕·관리자와 같은 판정(resolveTx)을 한다.
   *      호출자에게 REGISTERED 된 보낸 주소 하나 = 스냅샷 하나 = 그 보낸 주소 금액.
   *   5. PENDING 선점 후 mint(). 접수 트랜잭션이 그 입금 관찰 행을 COVERED 로 만든다.
// … (lines 238-1445 omitted) …
