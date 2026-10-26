// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/solana/escrow-legs.spec.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    Leg key behaviour.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import { ESCROW_LEGS_INCLUDE, flattenEscrowLegs } from './escrow-legs';

/**
 * 외부 자산 레그 평탄화 — 목록·상세·크리에이터 응답은 예전처럼 `mission.skrEscrow` 하나를 내려주되
 * `legs` 에 모든 레그를 싣는다. 레그가 하나인 미션은 전과 똑같이 보여야 한다 (프론트 호환).
 */
describe('flattenEscrowLegs', () => {
  const musd = {
    missionId: 'm',
    rewardAsset: 'MUSD',
    legIndex: 0,
    rewardRaw: '1000000000000000000',
    depositedRaw: '0',
  };
  const mezo = {
    missionId: 'm',
    rewardAsset: 'MEZO',
    legIndex: 1,
    rewardRaw: '2000000000000000000',
    depositedRaw: '0',
  };

  it('orders legs by legIndex then rewardAsset (matches the Prisma include)', () => {
    expect(ESCROW_LEGS_INCLUDE).toEqual({
      orderBy: [{ legIndex: 'asc' }, { rewardAsset: 'asc' }],
    });
  });

  it('keeps the single-leg shape: skrEscrow is the row itself with legs = [row]', () => {
    const out = flattenEscrowLegs({ id: 'm', title: 't', skrEscrows: [musd] });
    expect(out).toEqual({
      id: 'm',
      title: 't',
      skrEscrow: { ...musd, legs: [musd] },
    });
    expect('skrEscrows' in out).toBe(false);
  });

  it('puts the primary leg (legIndex 0) on top and every leg in legs, whatever order the rows came in', () => {
    const out = flattenEscrowLegs({ id: 'm', skrEscrows: [mezo, musd] });
    expect(out.skrEscrow).toMatchObject({
      rewardAsset: 'MUSD',
      legIndex: 0,
      rewardRaw: musd.rewardRaw,
    });
    expect(out.skrEscrow!.legs).toEqual([musd, mezo]);
  });

  it('breaks a legIndex tie by rewardAsset so the order is deterministic', () => {
    const out = flattenEscrowLegs({
      id: 'm',
      skrEscrows: [{ ...mezo, legIndex: 0 }, musd],
    });
    expect(out.skrEscrow!.legs.map((leg) => leg.rewardAsset)).toEqual([
      'MEZO',
      'MUSD',
    ]);
  });

  it('returns skrEscrow: null for a mission without external legs (missing or empty relation)', () => {
    expect(flattenEscrowLegs({ id: 'm', skrEscrows: [] }).skrEscrow).toBeNull();
    expect(flattenEscrowLegs({ id: 'm', skrEscrows: null }).skrEscrow).toBeNull();
    expect(flattenEscrowLegs({ id: 'm' }).skrEscrow).toBeNull();
  });
});
