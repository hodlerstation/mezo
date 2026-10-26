// Excerpt from the private HodlerStation repository (hodlerstation-backend)
//   path:   src/web3/mezo-network.spec.ts
//   commit: 3c2623c5
//   scope:  whole file, unmodified
//   why:    Registry behaviour for the Mezo networks.
// Shown for review only: it imports modules that are not part of this repository and does not build here.

import {
  ALL_NETWORK_IDS,
  MEZO_MUSD_MAINNET_DEFAULT,
  MEZO_MUSD_TESTNET_DEFAULT,
  NETWORKS,
  SELECTABLE_MISSION_NETWORKS,
  TREASURY_WALLET_NETWORKS,
  explorerApiBase,
  getNetwork,
  isExclusiveMissionNetwork,
  isTestnetNetwork,
  networkIdForChainId,
  parseNetworkId,
  paymentSymbolOf,
  requireUsdt,
  scopedMissionNetworkIds,
} from './networks';

describe('Mezo networks reuse the existing registry', () => {
  it.each([
    ['mezo-testnet', 31611, MEZO_MUSD_TESTNET_DEFAULT, true],
    ['mezo', 31612, MEZO_MUSD_MAINNET_DEFAULT, false],
  ] as const)(
    'resolves %s without a BSC fallback',
    (network, chainId, musd, testnet) => {
      expect(getNetwork(network).chainId).toBe(chainId);
      expect(networkIdForChainId(chainId)).toBe(network);
      expect(parseNetworkId(network)).toBe(network);
      expect(isTestnetNetwork(network)).toBe(testnet);
      // MUSD is an 18-decimal ERC-20 on both Mezo networks (verified on chain 2026-10-23).
      expect(requireUsdt(network)).toEqual({ address: musd, decimals: 18 });
      expect(paymentSymbolOf(network)).toBe('MUSD');
      expect(getNetwork(network).chain.nativeCurrency.symbol).toBe('BTC');
      expect(getNetwork(network).chain.nativeCurrency.decimals).toBe(18);
    },
  );

  it('opens an HST ledger only on the testnet', () => {
    expect(ALL_NETWORK_IDS).toContain('mezo-testnet');
    expect(ALL_NETWORK_IDS).not.toContain('mezo');
    expect(NETWORKS.mezo.hstEnabled).toBe(false);
  });

  it('keeps Mezo missions out of other feeds and other missions out of Mezo', () => {
    expect(scopedMissionNetworkIds()).toEqual(
      expect.arrayContaining(['monad', 'monad-testnet', 'mezo', 'mezo-testnet']),
    );
    expect(isExclusiveMissionNetwork('mezo-testnet')).toBe(true);
    expect(isExclusiveMissionNetwork('mezo')).toBe(true);
    expect(isExclusiveMissionNetwork('monad')).toBe(false);
    expect(isExclusiveMissionNetwork('bsc')).toBe(false);
    expect(isExclusiveMissionNetwork(undefined)).toBe(false);
  });

  it('uses the separate Blockscout API host', () => {
    expect(explorerApiBase('mezo-testnet')).toBe(
      'https://api.explorer.test.mezo.org',
    );
    expect(explorerApiBase('giwa-sepolia')).toBe(
      'https://sepolia-explorer.giwa.io',
    );
  });

  it('exposes both Mezo networks to admin wallets and mission filters', () => {
    expect(TREASURY_WALLET_NETWORKS).toEqual(
      expect.arrayContaining(['mezo', 'mezo-testnet', 'solana']),
    );
    expect(SELECTABLE_MISSION_NETWORKS).toEqual(
      expect.arrayContaining(['mezo', 'mezo-testnet']),
    );
  });

  it('keeps the existing payment symbols for BSC and GIWA', () => {
    expect(paymentSymbolOf('bsc')).toBe('USDT');
    expect(paymentSymbolOf('giwa-sepolia')).toBe('TUSDT');
  });
});
