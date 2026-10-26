# Integration excerpts

Unmodified code from the private HodlerStation repositories at the points where Mezo branches off the existing flows. Each file starts with a header giving the source path, the commit and, for partial files, the line ranges kept. The excerpts are for reading only. They import modules that are not in this repository and are not built here.

- Backend: `hodlerstation-backend` at commit `3c2623c5`
- Frontend: `hodlerstation-app` at commit `d25eaa7e`

| Area | Backend | Frontend |
|---|---|---|
| Network registry | `backend/web3/networks.ts` | `frontend/lib/web3/networks.ts` |
| Finality / log sources | `backend/web3/finality-pin.ts`, `backend/treasury/mint-log-sources.ts` | |
| Minting (MUSD → HST) | `backend/treasury/swap-mint-intake.service.ts`, `backend/treasury/swap-mint.service.ts` | `frontend/hooks/use-onchain-mint.ts` |
| HST ledger choice and contracts | `backend/hst-ledger/hst-ledger-mode.service.ts`, `backend/hst-ledger/hst-contracts.mezo.ts` | |
| Mission rules and proofs | `backend/missions/onchain-rule.types.ts`, `backend/missions/onchain-proof.service.ts` | `frontend/lib/missions/onchain-rule-alignment.ts` |
| Reward legs and claim | `backend/rewards/*`, `backend/claim/claim.service.ts` | `frontend/lib/missions/claim-legs.ts`, `frontend/hooks/use-skr-claim-legs.ts`, `frontend/components/claim-legs-status.tsx` |
| Payout wallet sharing | `backend/web3/treasury-wallet.service.ts`, `backend/rewards/mon-chain.service.ts` | |
| Behaviour tests | `backend/tests/*.spec.ts` | `frontend/tests/*` |

Some identifiers still carry their historical names (`skr-escrow`, `mon-chain`, `usdt`). The reward escrow was first built for Solana SKR and Monad MON, and Mezo legs reuse it.
