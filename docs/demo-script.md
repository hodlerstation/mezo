# Demo script

The video follows four scenes on **Mezo Testnet**. Two roles appear: a mission creator (platform admin account) and a participant (`test1`, wallet `0x40D8…Fe70`). Screenshots from the recorded run are in [`../submission/screenshots`](../submission/screenshots).

**Video:** _link to be added_

## Scene 1: one product, many networks (≈ 20 s)

1. Dashboard on BSC Mainnet, the default network.
2. Missions list on BSC: Mezo missions do not appear there.

## Scene 2: switch to Mezo (≈ 30 s)

1. Open the header network menu and pick **Mezo Testnet** ([01-network-switch.png](../submission/screenshots/01-network-switch.png)).
2. The missions list now shows Mezo missions only. Rewards read *0.1 MUSD + 0.01 MEZO* and *Testnet HST* ([02-mezo-missions.png](../submission/screenshots/02-mezo-missions.png)).
3. The *HST Mint* page now uses MUSD. It shows how to prepare (BTC for gas from the faucet, MUSD from the Mezo app), the user's MUSD and HST balances, and the 1 HST = 1 MUSD rate ([03-mint-with-musd.png](../submission/screenshots/03-mint-with-musd.png)).

## Scene 3: creator builds a Mezo mission (≈ 60 s)

1. *Create Mission* with the header on Mezo Testnet.
2. **Rewards:** MUSD 0.1 per participant, *+ MEZO* 0.01, and a Token reward of 0.15 HST ([04-builder-musd-mezo-hst-rewards.png](../submission/screenshots/04-builder-musd-mezo-hst-rewards.png)).
3. **Task:** an on-chain rule, *Completed HST swap*. The MUSD contract, the mint collector and the 18 decimals are filled in and locked, and the exact amount is 2 MUSD ([05-builder-hst-mint-rule.png](../submission/screenshots/05-builder-hst-mint-rule.png)).
4. Review, then publish. Publishing reserves the MUSD and MEZO legs, including the gas budget in BTC.

## Scene 4: participant mints, proves and gets paid (≈ 90 s)

1. Open the mission and *Join*. The on-chain task button opens the **Mint page with 2 MUSD prefilled**.
2. Review the transfer and confirm it in the wallet. The success toast links to the Mezo explorer ([`0x3ad4634a…`](https://explorer.test.mezo.org/tx/0x3ad4634ae147c16c0b7cb20d7ed976b11ccd7a61e99bae8b75ca45afb40a1bd3)).
3. *Back to mission*: the payment hash is already filled into the proof form. Submit it, and the proof is **verified on-chain automatically**.
4. Claim. The preview lists 0.1 MUSD, 0.01 MEZO and 0.15 HST.
5. The reward payout list shows each leg as *Sending*, then **Paid** with its own *View transaction* link ([06-claim-legs-paid.png](../submission/screenshots/06-claim-legs-paid.png)):
   - MUSD [`0x59311bda…`](https://explorer.test.mezo.org/tx/0x59311bdae3fed86d2e3f4dc54fad24cee21b50b6e612c663fa69bd0278947fcb)
   - MEZO [`0x38c91b14…`](https://explorer.test.mezo.org/tx/0x38c91b14e1e98665f0c62583c2a5f2f0e719274e6b53f7a522edef068f4541bc)
   - HST paid on the ledger
6. Portfolio on Mezo Testnet: the HST, BTC, MUSD and MEZO balances, plus the mission reward entry in the history ([07-portfolio-balances.png](../submission/screenshots/07-portfolio-balances.png)).

## Optional closing shot

Open one payout on `explorer.test.mezo.org` to show the MUSD `Transfer` from the platform payout wallet to the participant.
