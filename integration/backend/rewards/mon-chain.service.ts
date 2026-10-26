// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/solana/mon-chain.service.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (167-235)
//   why:    Reward payout wallet resolution for EVM networks (Mezo rules).
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-166 omitted) …

  /**
   * 지급 지갑 판정. 쓸 수 없으면 이유를 돌려준다 (capabilities·미션 생성 오류가 그대로 노출).
   *   - wallet_missing: 이 체인에서 서명할 지급 지갑이 없다 (Mezo 는 MEZO_REWARDS 행·같은 체인 FEE_COLLECTOR 별칭·
   *     승인된 BSC FEE_COLLECTOR(mezo-testnet 만) 중 하나가 필요하고, 그 밖은 FEE_COLLECTOR 대체도 없음)
   *   - wallet_inactive: 행은 있으나 비활성
   *   - wallet_invalid: 행 주소가 EVM 주소가 아니다
   */
  private async walletState(network: MonNetwork): Promise<
    | {
        ok: true;
        source: {
          address: `0x${string}`;
          kind: string;
          allowAddressFallback: boolean;
        };
      }
    | { ok: false; reason: RewardWalletUnavailableReason }
  > {
    // Keep existing dedicated custody stable. New deployments reuse the existing
    // platform fee wallet (also the Chog administrator), through Treasury's
    // explicit cross-chain signing path. No key is copied or newly generated.
    const kind = rewardWalletKindFor(network);
    const row = await this.db.treasuryWallet.findUnique({
      where: {
        kind_chainId: {
          kind,
          chainId: getNetwork(network).chainId,
        },
      },
      select: { address: true, isActive: true },
    });
    if (!row) {
      // Mezo 계열은 전용 MEZO_REWARDS 행이 있어야만 지급한다. FEE_COLLECTOR 대체는 그 체인 행이 없으면
      // bsc 메인넷 지갑으로 떨어지므로 실자산 키가 다른 체인에서 서명하게 된다 (2026-10-23 검토).
      if (networkFamily(network) === 'mezo') {
        // 서명까지 할 수 있는 지갑(fallbackFrom === null)만 인정한다: 같은 체인의 별칭 행(테스트넷
        // FEE_COLLECTOR), 또는 레지스트리가 승인한 BSC FEE_COLLECTOR 행 (mezo-testnet 의
        // treasuryWalletFromDefault, 2026-10-24 운영자 결정). 승인 없는 BSC 대체(fallbackFrom='bsc',
        // mezo 메인넷 등)는 없는 것으로 본다.
        const resolved = await this.treasury.resolveAddress(kind, network);
        if (!resolved || resolved.fallbackFrom !== null)
          return { ok: false, reason: 'wallet_missing' };
        // 서명은 getWalletClient(kind) 가 같은 행으로 푼다 (findNetworkRow, 폴백 옵션 없음).
        return {
          ok: true,
          source: {
            address: resolved.address,
            kind,
            allowAddressFallback: false,
          },
        };
      }
      const address = await this.treasury.getAddress('FEE_COLLECTOR', network);
      if (!address || !isAddress(address))
        return { ok: false, reason: 'wallet_missing' };
      return {
        ok: true,
        source: { address, kind: 'FEE_COLLECTOR', allowAddressFallback: true },
      };
    }
    if (!row.isActive) return { ok: false, reason: 'wallet_inactive' };
    if (!isAddress(row.address)) return { ok: false, reason: 'wallet_invalid' };
    return {
      ok: true,
      source: { address: row.address, kind, allowAddressFallback: false },
    };
  }

// … (lines 236-501 omitted) …
