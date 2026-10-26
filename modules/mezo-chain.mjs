// Mezo network constants used by HodlerStation. Verify against https://mezo.org/docs before production use.
// The backend registry these mirror is excerpted in integration/backend/web3/networks.ts.

// MEZO is an ERC-20 at the same system address on both networks.
export const MEZO_TOKEN = "0x7B7c000000000000000000000000000000000001";

export const MEZO_MAINNET = Object.freeze({
  id: 31612,
  name: "Mezo Mainnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: [
    "https://mainnet.mezo.public.validationcloud.io",
    "https://rpc-http.mezo.boar.network",
  ],
  blockExplorer: "https://explorer.mezo.org",
  tokens: {
    MUSD: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
    MEZO: MEZO_TOKEN,
  },
});

export const MEZO_TESTNET = Object.freeze({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: ["https://rpc.test.mezo.org"],
  blockExplorer: "https://explorer.test.mezo.org",
  blockExplorerApi: "https://api.explorer.test.mezo.org/api",
  faucet: "https://faucet.test.mezo.org",
  tokens: {
    MUSD: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
    MEZO: MEZO_TOKEN,
  },
  // HodlerStation contracts deployed 2026-10-23 (block 16323761). Deployed, not used for minting by default.
  hodlerstation: {
    HstToken: "0x4436c6622741579A08a79382281dE47e8264df77",
    HstTreasury: "0x7167F3a503b3087905a1b02d11c08f4e7D0a15C2",
  },
});

export const MEZO_NETWORKS = Object.freeze([MEZO_TESTNET, MEZO_MAINNET]);
