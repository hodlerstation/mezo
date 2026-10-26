# Architecture and design

This document is adapted from the backend design note for the Mezo integration. Operational details (hosts, database names, internal admin tools, wallet custody procedures) are left out. Code references point to the excerpts in [`../integration/`](../integration/).

## 1. Networks

Mezo joins the network registry as two networks:

| id | chain | gas | payment token | HST ledger | missions | rewards |
|---|---|---|---|---|---|---|
| `mezo-testnet` | 31611 | BTC (18 dec) | MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | yes: DB ledger like BSC. The deployed contracts can be switched on per network | yes | MUSD · MEZO · HST |
| `mezo` | 31612 | BTC | MUSD `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186` | no (`hstEnabled: false`, real assets) | yes (limited rule set) | MUSD · MEZO |

MEZO is an ERC-20 at the system address `0x7B7c000000000000000000000000000000000001` on both networks. The values come from mezo.org/docs and were checked against the public RPC on 2026-10-23:

- chain id
- token symbol and decimals
- Multicall3 at the canonical address
- `finalized` / `safe` block tags
- `eth_getLogs` limited to 10,000 blocks
- no `eth_getBlockReceipts`

Registry: [`integration/backend/web3/networks.ts`](../integration/backend/web3/networks.ts) and [`integration/frontend/lib/web3/networks.ts`](../integration/frontend/lib/web3/networks.ts).

Registry fields that the Mezo work added or generalised:

- `paymentToken`: MUSD on Mezo, USDT on BSC. The mint flow reads it instead of assuming USDT.
- `explorerApiUrl`: on Mezo the Blockscout API host is different from the explorer UI host.
- `testnet`: real-asset rules are turned off when this is false.
- `missionVisibility: 'exclusive'`: Mezo missions appear only while a Mezo network is selected, and only Mezo missions appear then.
- `hstEnabled`: false on Mezo Mainnet.

Every place that used to hard-code a list of networks now reads the registry. That covers the mint DTO, wallet kinds, mission filters, cache keys, HST bootstrap rows, chainId → network lookups and supported mint chains.

## 2. Minting: MUSD → HST

The mint flow is the existing BSC USDT flow, parameterised by network:

1. **Preflight.** `POST /treasury/swap/mint/preflight` returns the collector address, chain id and payment token for the selected network. It also refuses the request before the wallet popup when the network cannot accept deposits: deposit discovery unhealthy, no collector wallet, or a contract-ledger network without its own operator wallet. See [`swap-mint-intake.service.ts`](../integration/backend/treasury/swap-mint-intake.service.ts).
2. **Transfer.** The wallet sends MUSD to the collector on Mezo. See [`use-onchain-mint.ts`](../integration/frontend/hooks/use-onchain-mint.ts). Mezo transfers use a fixed gas limit because the public RPC estimate was unreliable.
3. **Intake.** `POST /treasury/swap/mint/from-tx` with the hash, or **deposit discovery** finds the transfer on its own. The server only trusts what it reads from the chain:
   - receipt status
   - the token `Transfer` log to the collector
   - the canonical block
   
   The amount the client sends is ignored. Logs come from two kinds of source, the public Mezo RPC and Blockscout, read in 5,000-block chunks and pinned to a finalized block. See [`mint-log-sources.ts`](../integration/backend/treasury/mint-log-sources.ts) and [`finality-pin.ts`](../integration/backend/web3/finality-pin.ts).
4. **Credit.** HST is credited on the **DB ledger**, using the `mezo-testnet` HST token row, inside the mint transaction. The exchange rate is 1 HST = 1 MUSD minus a 0.1% service fee. Daily and total mint limits apply per network.

**HST ledger choice.** `isAbstractionNetwork('mezo-testnet')` is false by default, so Mezo HST takes the same DB branch as BSC: minting, mission HST escrow, HST rewards and claims. The contract ledger stays in the code and can be switched on: `HST_ONCHAIN_NETWORKS=mezo-testnet`, plus an operator wallet that holds MUSD collateral for chain 31611, plus a restart. After that, `HstLedgerRouter.forNetwork('mezo-testnet')` returns an on-chain ledger bound to the deployed `HstTreasury` / `HstToken`. BSC can never be put on that list. See [`hst-ledger-mode.service.ts`](../integration/backend/hst-ledger/hst-ledger-mode.service.ts).

## 3. Mission proofs on Mezo

Rule schema: [`onchain-rule.types.ts`](../integration/backend/missions/onchain-rule.types.ts). Verifier: [`onchain-proof.service.ts`](../integration/backend/missions/onchain-proof.service.ts).

| Mission | Rule | What the server checks |
|---|---|---|
| A: hold MUSD | `ERC20_BALANCE` (MUSD, `minAmount`) | `balanceOf(wallet) ≥ min` at verification time. No hash is needed. The proof key is `balance:<missionId>:<wallet>`, so the same wallet cannot be reused through a second account |
| B: send MUSD | `USDT_TRANSFER` (token, `expectedTo`, exact `amount`) | Successful tx from the participant's wallet with a matching `Transfer` log, mined after the mission start |
| C: mint HST | `HST_MINT` (MUSD, collector, exact amount) | Same as B with the collector as recipient, and the mint must have been credited. The frontend opens the Mint page with the exact amount and returns to the mission with the hash |
| D: hold MEZO | `ERC20_BALANCE` (MEZO token) | As A |
| E: contract event | `ANY_TX` + `to` + `eventTopic` | Sender = participant wallet, `tx.to == to`, success, canonical block, mined after the mission start, **and** a receipt log with `address == to` and `topics[0] == eventTopic` |
| (BTC hold) | `NATIVE_BALANCE` | Native balance ≥ min |

Rules on the same network family:

- A Mezo mission may only reference Mezo rules.
- Testnet missions cannot point at mainnet rules, and the other way round.
- On Mezo Mainnet, `USDT_TRANSFER` and `HST_MINT` are refused because they would involve real assets.

The frontend keeps the rule on the reward network as the creator edits the mission. See [`onchain-rule-alignment.ts`](../integration/frontend/lib/missions/onchain-rule-alignment.ts).

## 4. Rewards: one leg per token

A Mezo mission can carry several reward tokens at once, for example **MUSD + MEZO + HST**.

### External legs (MUSD, MEZO)

- **One escrow row per leg.** The escrow has one row per `(missionId, rewardAsset)`. `legIndex` 0 is the primary leg and keeps the original keys, so existing Solana and Monad missions behave exactly as before. The create API takes `externalRewards: [{ asset, amountRaw }]` next to `monRewardNetwork`. See [`escrow-legs.ts`](../integration/backend/rewards/escrow-legs.ts) and [`evm-reward-networks.ts`](../integration/backend/rewards/evm-reward-networks.ts).
- **Reserve on publish.** Publishing reserves every leg. ERC-20 legs also budget gas from the payout wallet's BTC balance.
- **Payout.** The existing EVM payout path pays each leg. It signs offline, uses a durable nonce, verifies the receipt and the `Transfer` log, and allows three attempts.
- **One claim sends every leg.** A single claim call sends all legs, even when an earlier leg is pending or failed. When something is unsettled it answers `SKR_PAYMENT_PENDING` / `SKR_PAYMENT_FAILED` with `paidLegs` / `pendingLegs` / `failedLegs`. See [`skr-escrow.service.ts`](../integration/backend/rewards/skr-escrow.service.ts).

### HST leg

The HST leg is paid from the **DB ledger first**, in its own transaction, guarded against double payment by `ClaimEvent.grossHst`. The EVM legs go out after that. Before any HST moves, `precheckClaim` runs the external-leg checks: a linked EVM wallet and an approved participant. A participant who would be refused therefore receives nothing. See [`claim.service.ts`](../integration/backend/claim/claim.service.ts). With the contract ledger switched on, the HST leg is paid after the external legs are final instead, because an on-chain mint cannot be rolled back.

### Recovery

- A failed leg stays `PENDING` while it has retry budget, and the recovery job resends **that leg only**. One leg running out of retries does not stop the others.
- A leg that used its whole budget marks the claim failed and alerts operations.
- A manual retry re-reads the chain first. The leg's last signed tx must be final and reverted at its nonce, so it can never land, before the leg is signed again with a new nonce.

### Status and UI

`GET /solana/rewards/:id/claim/status` returns `legs[]`, where each leg has:

- `kind`: EXTERNAL or LEDGER
- `asset`, `network`, `status`, `txHash`, `amountRaw`, `retryable`

The mission page lists the legs with *Sending / Paid / Retry* states and an explorer link per leg. It polls until every leg settles. See [`claim-legs.ts`](../integration/frontend/lib/missions/claim-legs.ts), [`use-skr-claim-legs.ts`](../integration/frontend/hooks/use-skr-claim-legs.ts) and [`claim-legs-status.tsx`](../integration/frontend/components/claim-legs-status.tsx).

## 5. Wallets and funding (testnet)

- **One wallet for collection and payouts on Mezo Testnet.** On Mezo Testnet one platform wallet both collects mint payments and pays MUSD/MEZO rewards. Payouts and refunds share its nonce under one lock. Mezo Mainnet always needs a dedicated payout wallet. See [`treasury-wallet.service.ts`](../integration/backend/web3/treasury-wallet.service.ts) and [`mon-chain.service.ts`](../integration/backend/rewards/mon-chain.service.ts).
- **Collector deposits stay apart from reward money.** The reward budget is the collector's MUSD minus the funds that back minted HST and minus unminted deposits that may still be refunded. A refund that would eat into reserved reward obligations is refused.
- **Admin deposits.** A MUSD deposit from a wallet linked to an admin account is held as operator funding. It is never minted.
- **Payouts stay with their funding wallet.** Reserved payouts are bound to the wallet that funded them. If the payout key changes, they stop with `MON_CUSTODY_CHANGED`. They are not paid from a different wallet.

## 6. Contracts

`HstToken` and `HstTreasury` ([`../contracts/src`](../contracts/src)) are the on-chain HST ledger that HodlerStation already runs on GIWA:

- **Accounts.** An account is a `bytes32` id (`keccak256(userId)`). The model is custodial, so users need no gas.
- **Balances.** Each account has PURCHASED, EARNED and CREDIT sub-balances, with lock-up and expiry lots.
- **Operators.** Only operators can mint, burn or move. The treasury and the backend signer are operators.
- **Collateral.** `HstTreasury` holds the collateral, MUSD (18 decimals) on Mezo, and mints purchased HST against it.

They were deployed to Mezo Testnet with [`../scripts/deploy-hst.sh`](../scripts/deploy-hst.sh), which wraps `script/Deploy.s.sol`. They are switched off by default (section 2). They are not verified on the explorer yet.

## 7. What is not done on purpose

- No HST ledger and no minting on Mezo Mainnet (real assets).
- HodlerPoints and SBT contracts are not deployed on Mezo. An SBT reward on a Mezo testnet mission is minted on GIWA.
- `INCOMING_TX` on Mezo relies on the Blockscout `txlist` API.
