// Mezo network constants. Verify against https://mezo.org/docs before production use.
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
  },
});

export const MEZO_TESTNET = Object.freeze({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
});
