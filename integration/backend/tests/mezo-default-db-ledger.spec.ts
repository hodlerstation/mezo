// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/hst-ledger/mezo-default-db-ledger.spec.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    mezo-testnet HST stays on the DB ledger unless HST_ONCHAIN_NETWORKS opts in.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// 컨트랙트 주소가 등록돼 있어도(배포 완료) 기본 설정에서는 DB 원장이어야 한다 — 주소 유무로 우연히 통과하지 않게 켠다.
jest.mock('./onchain/hst-contracts', () => {
  const actual = jest.requireActual('./onchain/hst-contracts');
  return {
    ...actual,
    hasHstContracts: (network: string) =>
      network === 'mezo-testnet' || actual.hasHstContracts(network),
  };
});
import {
  DEFAULT_EXTRA_ONCHAIN_NETWORKS,
  HstLedgerModeService,
} from './hst-ledger-mode.service';
import { HstLedgerRouter } from './hst-ledger.router';
import type { HstLedgerConfigService } from './hst-ledger-config.service';
import type { DbHstLedger } from './providers/db-hst-ledger';
import type { OnchainHstLedger } from './onchain/onchain-hst-ledger';
import type { ChainSettlementService } from './chain-settlement.service';
import { MissionLedgerRoutingService } from '../missions/mission-ledger-routing.service';
import { ClaimService } from '../claim/claim.service';
import type { TokensService } from '../tokens/tokens.service';

/**
 * 2026-10-25 운영자 결정: Mezo 테스트넷 HST 원장 = 기존 DB 원장 (BSC/GIWA 를 운영 DB 모드로 돌릴 때와 같다).
 * HST_ONCHAIN_NETWORKS 를 명시하지 않은 기본 설정에서:
 *   - 미션 HST 예치(차감)·지급(적립)은 그 네트워크 HST tokenId 로 tokens.* 직접,
 *   - 클레임 HST 는 treasury.distributeHst(…, 'mezo-testnet') DB 경로,
 *   - 어느 경로도 온체인 원장·ChainSettlement 를 만들지 않는다.
 */
function defaultModeService(mode: 'DB' | 'GIWA' = 'GIWA') {
  const prevMode = process.env.HST_LEDGER_MODE;
  const prevExtra = process.env.HST_ONCHAIN_NETWORKS;
  process.env.HST_LEDGER_MODE = mode;
  delete process.env.HST_ONCHAIN_NETWORKS;
  try {
    return new HstLedgerModeService({
      get: () => undefined,
    } as unknown as HstLedgerConfigService);
  } finally {
    if (prevMode === undefined) delete process.env.HST_LEDGER_MODE;
    else process.env.HST_LEDGER_MODE = prevMode;
    if (prevExtra === undefined) delete process.env.HST_ONCHAIN_NETWORKS;
    else process.env.HST_ONCHAIN_NETWORKS = prevExtra;
  }
}

function routerFor(mode: HstLedgerModeService) {
  const db = { isOnchain: false } as unknown as DbHstLedger;
  const onchain = {
    isOnchain: true,
    bindTo: jest.fn(() => {
      throw new Error('mezo-testnet must not bind an on-chain ledger');
    }),
  } as unknown as OnchainHstLedger;
  const router = new HstLedgerRouter(db, onchain, mode);
  const forNetwork = jest.spyOn(router, 'forNetwork');
  return { router, forNetwork };
}

const noSettlements = {
  deferInTx: jest.fn(() => {
    throw new Error('ChainSettlement must not be created for mezo-testnet');
  }),
} as unknown as ChainSettlementService;

describe('Mezo testnet HST ledger on the default config', () => {
  it('has no extra on-chain network by default', () => {
    expect(DEFAULT_EXTRA_ONCHAIN_NETWORKS).toBe('');
    for (const m of ['DB', 'GIWA'] as const) {
      const mode = defaultModeService(m);
      expect(mode.extraOnchainNetworks()).toEqual([]);
      expect(mode.isOnchainNetwork('mezo-testnet')).toBe(false);
      expect(mode.isAbstractionNetwork('mezo-testnet')).toBe(false);
      expect(mode.onchainNetworks()).not.toContain('mezo-testnet');
    }
  });

  it('mission HST escrow debit and payout credit go through tokens.* with the mezo HST tokenId', async () => {
    const mode = defaultModeService();
    const { router, forNetwork } = routerFor(mode);
    const tokens = {
      debit: jest.fn().mockResolvedValue(undefined),
      credit: jest.fn().mockResolvedValue(undefined),
    };
    const routing = new MissionLedgerRoutingService(
      tokens as unknown as TokensService,
      router,
      mode,
      noSettlements,
    );
    const tx = {};
    const token = { network: 'mezo-testnet' };
    expect(routing.hstLedgerFor(token)).toBeNull();
    await expect(
      routing.debitSplitHstScoped(
        tx,
        token,
        5,
        'creator',
        [{ sourceType: 'EARNED', amount: 10 }],
        { type: 'MISSION_ESCROW', refId: 'm1' },
      ),
    ).resolves.toBeNull();
    expect(tokens.debit).toHaveBeenCalledWith(
      'creator',
      expect.objectContaining({ tokenId: 5, amount: 10 }),
      tx,
    );
    await expect(
      routing.creditHstScoped(tx, token, 5, 'user', {
        sourceType: 'EARNED',
        amount: 3,
        type: 'MISSION_REWARD',
        refId: 'm1',
      }),
    ).resolves.toBeNull();
    expect(tokens.credit).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ tokenId: 5, amount: 3 }),
      tx,
    );
    expect(forNetwork).not.toHaveBeenCalled();
    expect(noSettlements.deferInTx).not.toHaveBeenCalled();
  });

  it('claim HST is distributed inside the claim transaction on the mezo DB ledger (no chain plan)', async () => {
    const mode = defaultModeService();
    const { router, forNetwork } = routerFor(mode);
    const treasury = { distributeHst: jest.fn().mockResolvedValue(undefined) };
    const service = Object.assign(Object.create(ClaimService.prototype), {
      ledgerMode: mode,
      hst: router,
      treasury,
      referral: { accrue: jest.fn().mockResolvedValue(0) },
      pools: { consume: jest.fn().mockResolvedValue(undefined) },
      revenueAggregator: { recordFee: jest.fn() },
      revenueInjections: { createInTx: jest.fn() },
      logger: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
    }) as unknown as {
      _claimHst: (...args: unknown[]) => Promise<{ amount: number }>;
    };
    const tx = {
      claimEvent: { update: jest.fn().mockResolvedValue({}) },
      hstCycleEvent: { create: jest.fn() },
      activityLog: { create: jest.fn().mockResolvedValue({}) },
      chainSettlement: {
        create: jest.fn(() => {
          throw new Error('no ChainSettlement on mezo-testnet');
        }),
      },
    };
    const chainPlan: unknown[] = [];
    const result = await service._claimHst(
      'user',
      'm1',
      'Mezo mission',
      { amount: 10, creditAmount: 0, tokenId: 5, token: { symbol: 'HST', network: 'mezo-testnet' } },
      false,
      tx,
      'claim-1',
      {
        feeAmount: 1,
        netAmount: 9,
        discountBps: 0,
        discountSource: 'NONE',
        appliedFeeBps: 1000,
      },
      'mezo-testnet',
      chainPlan,
    );
    expect(result.amount).toBe(9);
    expect(chainPlan).toEqual([]);
    expect(treasury.distributeHst).toHaveBeenCalledTimes(1);
    const args = treasury.distributeHst.mock.calls[0];
    expect(args[0]).toBe('user');
    expect(args[1]).toBe(9);
    expect(args[6]).toBe(tx); // 같은 트랜잭션 안에서
    expect(args[9]).toBe('mezo-testnet'); // 그 네트워크 장부만
    expect(tx.claimEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ grossHst: { increment: 10 } }),
      }),
    );
    expect(forNetwork).not.toHaveBeenCalled();
    expect(tx.chainSettlement.create).not.toHaveBeenCalled();
  });
});
