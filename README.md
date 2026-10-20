# HodlerStation × Mezo

Public repository for HodlerStation's Mezo integration. The existing product's user accounts, mission eligibility, budgets and claim accounting remain private.

- Product: https://app.hodlerstation.xyz
- X: https://x.com/hodlerstation

## Contents

- `modules/mezo-chain.mjs`: Mezo mainnet (chain 31612) and testnet (31611) constants, native BTC and the MUSD token address.
- `tools/check-network.mjs`: read-only check that each configured RPC reports chain 31612. It never signs or sends a transaction.

```sh
node tools/check-network.mjs
```

## License

[MIT](LICENSE) covers the HodlerStation-authored source in this repository. Private product repositories are excluded.
