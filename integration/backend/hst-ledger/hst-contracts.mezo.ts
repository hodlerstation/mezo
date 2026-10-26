// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/hst-ledger/onchain/hst-contracts.ts
//   commit: 3c2623c5
//   scope:  selected line ranges, unmodified (349-372)
//   why:    Deployed HstToken / HstTreasury addresses for mezo-testnet.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

// … (lines 1-348 omitted) …
  },
  /**
   * Mezo Testnet (Buildathon 2026-10). HstToken/HstTreasury 는 contracts/script/Deploy.s.sol 로
   * MUSD(18 dec) 담보로 배포한다. 배포 전에는 zero → hasHstContracts 가 false 라 DB 원장으로 돈다.
   * 배포 후 주소를 여기 하드코딩하고 env 는 재배포 override 용으로만 둔다 (GIWA 와 같은 규약).
   */
  // 2026-10-24 배포 (Mezo Testnet 31611, block 16323761, 담보 MUSD 18 dec, admin/operator 0x6423…d564).
  // env 는 재배포 때의 임시 오버라이드용.
  'mezo-testnet': {
    token:
      (process.env.MEZO_TESTNET_HST_TOKEN as `0x${string}`) ||
      '0x4436c6622741579A08a79382281dE47e8264df77',
    treasury:
      (process.env.MEZO_TESTNET_HST_TREASURY as `0x${string}`) ||
      '0x7167F3a503b3087905a1b02d11c08f4e7D0a15C2',
    sbt: (process.env.MEZO_TESTNET_SBT_CONTRACT as `0x${string}`) || ZERO_ADDRESS,
    points: ZERO_ADDRESS,
    pointsV4: ZERO_ADDRESS,
    pointsToken: ZERO_ADDRESS,
    missionBridge:
      (process.env.MEZO_TESTNET_MISSION_BRIDGE_CONTRACT as `0x${string}`) ||
      ZERO_ADDRESS,
  },
};
// … (lines 373-555 omitted) …
