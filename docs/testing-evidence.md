# Testing evidence

## Setup

All runs used the **public Mezo Testnet (chain 31611)** through `https://rpc.test.mezo.org` and the Blockscout API.

The application ran as a **local full stack**: the production backend and frontend code, against an isolated database and Redis. Production data was not touched. UI scenes were driven by a headless browser with an injected test wallet. API-level runs used the same endpoints the frontend calls.

| Run | Date (UTC) | What |
|---|---|---|
| run 1 | 2026-10-24 | Mint via hash and via deposit discovery. Mission A (hold MUSD) with a MUSD + HST reward |
| run 2 | 2026-10-25 02:00–05:00 | Mission types B–E, a three-leg reward (MUSD + MEZO + HST) with recovery, and rule validation |
| run 3 | 2026-10-25 15:00–16:30 | Demo scenes through the UI: creator builds the mission, two users mint, prove and claim. Wallet relink and mint edge cases |

Each transaction hash in the [README table](../README.md#verified-testnet-transactions) was re-checked on 2026-10-26: the receipt has `status = 1` on the RPC, and the explorer API `gettxinfo` returns `success`. Amounts come from the receipt's `Transfer` logs.

## Mission types A–E

Test wallets: user 1 `0x40D8…Fe70`, partner `0xaf19…c06c`, platform collector / payout wallet `0x6423…d564`.

| Type | Rule | Participant action | Result | Reward payout |
|---|---|---|---|---|
| **A** hold MUSD | `ERC20_BALANCE` MUSD ≥ 1 | none (balance read) | approved on submit | 1 MUSD [`0x22e22b04…`](https://explorer.test.mezo.org/tx/0x22e22b04b1f07fb983ca43fd82339f94d869cc8dda1f7ddea0f7adb5e52c566f), plus 0.1 HST on the ledger |
| **B** send MUSD | `USDT_TRANSFER` exactly 0.5 MUSD → partner | [`0xe6e4c1c8…`](https://explorer.test.mezo.org/tx/0xe6e4c1c83984ad10092b1cbe4b2a7260e372f35078d7e710699b7c48a6ee257a) | approved | 0.5 MUSD [`0x88417848…`](https://explorer.test.mezo.org/tx/0x88417848346618c9c37d2b50cfdf3ee7398eb3ce41ac28b7cf4a408382c137aa) |
| **B** (second mission, new transfer) | same rule | [`0x4b9a06d2…`](https://explorer.test.mezo.org/tx/0x4b9a06d2c3338076acab7dcb85949e06e23bf6d9f7e0d6454cd2db595126c50d) | approved | 0.5 MUSD [`0xb2f879bb…`](https://explorer.test.mezo.org/tx/0xb2f879bbd573458cd149b3bacca95ed38de5a21289b03209120005cfaab829c8) |
| **C** mint HST | `HST_MINT` exactly 2 MUSD → collector | [`0xdef2394b…`](https://explorer.test.mezo.org/tx/0xdef2394ba54e80f89f3d0f25fc7855ead171fcb9a2330f70e4984a5176c1e054) | minted + approved | 0.5 MUSD [`0x56626296…`](https://explorer.test.mezo.org/tx/0x5662629656bf90ef9f289bfe482eb1f9976a3302db8dc4ecdb7a2759df610c10) |
| **D** hold MEZO | `ERC20_BALANCE` MEZO ≥ 1 | none (balance read) | approved | 0.5 MUSD [`0x48a0e2c7…`](https://explorer.test.mezo.org/tx/0x48a0e2c7dd8f93fb546c7b1a97ae4b13b1ae58f961c68f011c3082c340fca24f) |
| **E** contract event | `ANY_TX` to MUSD, `eventTopic` = `Approval` | `approve` [`0x440a6008…`](https://explorer.test.mezo.org/tx/0x440a6008f934f9d1cff06671f97d6680c708bced0272d65e8d4eda0b3be0b604) | approved | 0.5 MUSD [`0x742d33cc…`](https://explorer.test.mezo.org/tx/0x742d33cc640912196a641935d39d00d75de4a84dbd1b966f73165907e6335016) |

The payout hashes for B–E were matched to their missions by order and timestamp, using the payout wallet's token transfers to user 1. Each payout landed within about 30 seconds of the corresponding claim.

## Combined rewards and per-leg payout

| Case | What happened | Evidence |
|---|---|---|
| Three legs (0.5 MUSD + 0.1 MEZO + 0.1 HST) | The first claim call failed on the server side after the HST leg was paid. The two EVM legs stayed unsent (`PREPARED` / `NOT_STARTED`). A second call answered `SKR_PAYMENT_PENDING` with `pendingLegs: MUSD,MEZO`. Both legs were then sent on their own and finished `FINALIZED`. The HST leg was not paid twice | MUSD [`0xee843835…`](https://explorer.test.mezo.org/tx/0xee843835797af409bc56e888659750fe65f06ef995430b5255bcdbcd900b28b7), MEZO [`0x210895fd…`](https://explorer.test.mezo.org/tx/0x210895fdef6254fb7a2487410b0bc71e9aa6b08cf531b97699b859bbaeffb97c) |
| Demo mission (0.1 MUSD + 0.01 MEZO + 0.15 HST), user 1 | Mint page → back to the mission with the hash prefilled → verified → claim. The legs showed *Sending*, then *Paid* with explorer links | mint [`0x3ad4634a…`](https://explorer.test.mezo.org/tx/0x3ad4634ae147c16c0b7cb20d7ed976b11ccd7a61e99bae8b75ca45afb40a1bd3), MUSD [`0x59311bda…`](https://explorer.test.mezo.org/tx/0x59311bdae3fed86d2e3f4dc54fad24cee21b50b6e612c663fa69bd0278947fcb), MEZO [`0x38c91b14…`](https://explorer.test.mezo.org/tx/0x38c91b14e1e98665f0c62583c2a5f2f0e719274e6b53f7a522edef068f4541bc) |
| Same mission, user 2 | same flow | mint [`0x8ee0469f…`](https://explorer.test.mezo.org/tx/0x8ee0469f2f5b6f217c6866ff83f9f2b050298a0e460bb2a158999d644d93b24c), MUSD [`0x5c8c9f9c…`](https://explorer.test.mezo.org/tx/0x5c8c9f9cf3d726d305251679e4c5089a38d4cffdc6e37fb542bf6e424ede3970), MEZO [`0x919cbdab…`](https://explorer.test.mezo.org/tx/0x919cbdab9ccc21409c4c8fc9d4f82abbba4305175130c6d138b329164a4a186e) |
| Claim without a linked wallet, then relink | The first claim was refused with `WALLET_REQUIRED` before any HST moved. After the wallet was linked, the claim paid every leg | MUSD [`0x4a342c61…`](https://explorer.test.mezo.org/tx/0x4a342c615f6ec159326a8067849b3c84e6929ca2727adcb88aff2c048467d68e), MEZO [`0xc78f7342…`](https://explorer.test.mezo.org/tx/0xc78f734289cb0af671c48001b02651feded9daf9e9aaf54cfc72084091c477b4) |

## Minting

| Case | Result | Evidence |
|---|---|---|
| `from-tx` with a 10 MUSD transfer | 9.99 HST credited (0.1% fee) | [`0x34f96e7e…`](https://explorer.test.mezo.org/tx/0x34f96e7e5917a7c5d4ad4d11c750d5a6e4950458e6a1a3ff532b708a67565a06) |
| Transfer found by deposit discovery | credited without submitting the hash | [`0x4c8ec0d6…`](https://explorer.test.mezo.org/tx/0x4c8ec0d61c8410255ff2ead89b2504f10ec39b2ed349b6047eab9b4c78402146) |
| Mint submitted before the RPC sees the transfer | First `SWAP_TX_AWAITING_CONFIRMATION` (`TX_NOT_FOUND`, `retryAfterSec`). The client retried and 1.998 HST was credited. When the same deposit was submitted again, the UI said "This deposit has already been credited" and offered *Back to mission* | [`0x934892e3…`](https://explorer.test.mezo.org/tx/0x934892e3c3a4da9997db5a892446c1dd178cac457bb46bdc94c0c06f0f3600df) |
| Deposit still being processed | The UI said "Deposit received, waiting to be processed (retrying automatically). No need to deposit again" and offered *Back to mission* | [`0xddfd2acc…`](https://explorer.test.mezo.org/tx/0xddfd2acc9eb9874313da6e73a6297570851207acc7825625bafd398cb87601ff) |

## Rule validation (refused at mission creation)

| Input | Response |
|---|---|
| `ERC20_BALANCE` on MEZO without `decimals` | `MISSION_ONCHAIN_RULE_INVALID`: decimals are required unless the token is the network payment token |
| `minAmount` with more fraction digits than the token decimals | `MISSION_ONCHAIN_RULE_INVALID` |

## Automated tests

- `contracts/`: `forge test` → **30 passed, 0 failed** (HstToken 16, HstTreasury 14).
- Backend and frontend unit and integration suites run in the private repositories. A few Mezo-specific specs are copied under [`../integration/backend/tests`](../integration/backend/tests) and [`../integration/frontend/tests`](../integration/frontend/tests) to document behaviour. They do not run in this repository.
