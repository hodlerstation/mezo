// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/hst-ledger/hst-ledger-mode.service.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (319-387)
//   why:    Which networks run the DB ledger vs the contract ledger (mezo-testnet = DB by default).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-318 omitted) …

  /**
   * 모드와 무관하게 **항상 온체인**인 네트워크 — env `HST_ONCHAIN_NETWORKS` (쉼표 구분).
   * 2026-10-25 운영자 결정: 기본값은 빈 값 — 어떤 네트워크도 env 를 명시하지 않으면 온체인이 아니다.
   * Mezo 테스트넷 HST 원장은 BSC 처럼 DB 원장으로 돈다. 컨트랙트(배포 완료)를 켜려면
   * `HST_ONCHAIN_NETWORKS=mezo-testnet` 을 두고 재시작한다 (메커니즘은 그대로 남겨 둔다).
   * 규칙: 등록된 원장 네트워크(hstEnabled)만, bsc(실자산)는 불가, 모드 네트워크와 겹치면 무시.
   * 런타임 전환 대상이 아니다 — 바꾸려면 재시작 (열린 민팅 검사가 필요 없는 이유).
   */
  // 값이 없으면 추가 온체인 네트워크도 없다 (DEFAULT_EXTRA_ONCHAIN_NETWORKS = '').
  private readonly extraOnchain: readonly NetworkId[] = resolveExtraOnchainNetworks(
    process.env.HST_ONCHAIN_NETWORKS ?? DEFAULT_EXTRA_ONCHAIN_NETWORKS,
    this.logger,
  );

  extraOnchainNetworks(): readonly NetworkId[] {
    // 테스트가 prototype 만 빌려 만든 인스턴스는 필드 초기화를 건너뛴다 — 추가 네트워크 없음으로 본다.
    return this.extraOnchain ?? [];
  }

  isExtraOnchainNetwork(network: NetworkId): boolean {
    return (
      this.extraOnchainNetworks().includes(network) &&
      network !== this.getNetworkForMode()
    );
  }

  /** 온체인 원장인 네트워크 — 모드 네트워크 + 추가 네트워크. */
  isOnchainNetwork(network: NetworkId): boolean {
    return (
      this.getNetworkForMode() === network ||
      this.isExtraOnchainNetwork(network)
    );
  }

  /** 지금 온체인으로 도는 네트워크 전부 (인덱서·관리 화면용). */
  onchainNetworks(): NetworkId[] {
    const mode = this.getNetworkForMode();
    return [
      ...(mode ? [mode] : []),
      ...this.extraOnchainNetworks().filter((n) => n !== mode),
    ];
  }

  /**
   * HST 라우팅 공통 헬퍼: 해당 네트워크가 **IHstLedger 추상화가 담당하는 네트워크**인지.
   * true 면 IHstLedger 경유, false 면 그 네트워크의 HST Token row 로 DB 직접
   * (tokens.credit/debit / treasury.*(…, network)).
   *
   *   - DB   → bsc 만 true  (DbHstLedger = 기존 bsc Prisma 원장: 기존 동작 100% 동일)
   *   - BNB  → bsc 만 true  (BNB 온체인)
   *   - GIWA → giwa-sepolia 만 true (GIWA 온체인): **bsc 는 false** →
   *            BSC 실 자산 거래가 테스트넷 체인에 기록되는 사고 차단 (2026-08 결함 수정).
   *   - 추가 온체인 네트워크(HST_ONCHAIN_NETWORKS) 는 모드와 무관하게 true.
   */
  isAbstractionNetwork(network: NetworkId): boolean {
    return (
      network === (this.getNetworkForMode() ?? DEFAULT_NETWORK) ||
      this.isExtraOnchainNetwork(network)
    );
  }
}

/** `HST_ONCHAIN_NETWORKS` 파싱 — 잘못된 항목은 버리고 경고만 남긴다 (부팅을 막지 않는다). */
/**
 * HST_ONCHAIN_NETWORKS 가 없을 때의 기본값 — 비어 있다 (2026-10-25 운영자 결정: Mezo 테스트넷도 DB 원장).
 * 컨트랙트 원장은 env 로 명시했을 때만 켜진다.
 */
export const DEFAULT_EXTRA_ONCHAIN_NETWORKS = '';
// … (lines 388-426 omitted) …
