// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/treasury/swap-mint.service.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (185-206)
//   why:    Mint execution: ledger choice per network (DB ledger HST token row for mezo-testnet).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-184 omitted) …
      throw AppError.bad(
        ErrorCode.SWAP_INVALID_AMOUNT,
        '수량은 0보다 큰 유한한 숫자여야 합니다',
      );
    }
    // 회계(수수료 KPI/RevenueInjection 등)는 bsc 장부에서만 기록.
    const isBscLedger = network === DEFAULT_NETWORK;
    // 요청 네트워크의 provider를 고정한다. GIWA 모드에서도 BSC는 DB 원장이다.
    // 동적 라우터 자체를 보관하면 중간 모드 전환이 지급/동기화 대상을 바꿀 수 있다.
    const mintLedger: IHstLedger | null = isBscLedger
      ? this.hst.forNetwork(network)
      : this.ledgerMode.isAbstractionNetwork(network)
        ? this.hst.forNetwork(network)
        : null;
    // H2: PENDING 선점 때 기록한 원장 종류와 지금 원장이 다르면 (선점 뒤 모드 전환) 체인·원장 쓰기 전에 거절한다.
    if (source.type === 'onchain') {
      const actual: LedgerKind = mintLedger?.isOnchain ? 'ONCHAIN' : 'DB';
      if (actual !== source.ledgerKind)
        throw new MintLedgerKindChangedError(source.ledgerKind, actual);
    }
    // 지급과 커밋 후 캐시 동기화 모두 요청 네트워크의 토큰만 사용한다.
    const networkHstId = await this.tokens.getTokenIdBySymbol(
// … (lines 207-768 omitted) …
