#!/usr/bin/env bash
# Deploy HstToken + HstTreasury to Mezo Testnet (31611) with MUSD (18 decimals) as collateral.
# Copied from the private HodlerStation backend (scripts/mezo/deploy-hst.sh); only the repo-root path
# and these header comments differ.
#
# Usage:
#   MEZO_DEPLOYER_KEY_FILE=<path to a file holding the deployer key> HST_ADMIN=<operator address> #     bash scripts/deploy-hst.sh
#
# - The key is read from a file and handed to forge through the environment only; it is never echoed.
# - The deployer needs Mezo testnet BTC for gas: https://faucet.test.mezo.org
# - forge 1.x; foundry.toml keeps evm_version=shanghai (Mezo supports PUSH0).
# - HST_ADMIN becomes admin and operator of both contracts (the backend signer).
# - The script asks forge to verify on Blockscout (api.explorer.test.mezo.org). For the 2026-10-23
#   deployment that verification did NOT complete: the explorer shows the contracts as unverified.
#   Re-run verification separately with `forge verify-contract` if needed.
#
# Output: the token / treasury addresses returned by script/Deploy.s.sol.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
RPC_URL="${MEZO_TESTNET_RPC_URL:-https://rpc.test.mezo.org}"
MUSD="${HST_USDT:-0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503}"
VERIFIER_URL="https://api.explorer.test.mezo.org/api"

if [[ -z "${MEZO_DEPLOYER_KEY_FILE:-}" || ! -f "$MEZO_DEPLOYER_KEY_FILE" ]]; then
  echo "[deploy-hst] MEZO_DEPLOYER_KEY_FILE 가 가리키는 키 파일이 없습니다" >&2
  exit 1
fi
if [[ -z "${HST_ADMIN:-}" || ! "$HST_ADMIN" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
  echo "[deploy-hst] HST_ADMIN 환경변수 필요 (백엔드 HST_OPERATOR 지갑 주소)" >&2
  exit 1
fi
KEY="$(tr -d '[:space:]' < "$MEZO_DEPLOYER_KEY_FILE")"
[[ "$KEY" == 0x* ]] || KEY="0x$KEY"
if [[ ! "$KEY" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "[deploy-hst] 키 형식이 잘못됐습니다 (0x + 64 hex)" >&2
  exit 1
fi

cd "$ROOT/contracts"
echo "[deploy-hst] network  = Mezo Testnet (31611) rpc=$RPC_URL"
echo "[deploy-hst] admin    = $HST_ADMIN"
echo "[deploy-hst] collateral = MUSD $MUSD (18 dec)"
# The key goes to forge through the environment only (kept out of shell history).
HST_ADMIN="$HST_ADMIN" HST_USDT="$MUSD" HST_USDT_DECIMALS=18 PRIVATE_KEY="$KEY" \
  "$FORGE" script script/Deploy.s.sol:Deploy \
    --rpc-url "$RPC_URL" --broadcast --private-key "$KEY" \
    --verify --verifier blockscout --verifier-url "$VERIFIER_URL" \
    ${FORGE_EXTRA_ARGS:-}
echo "[deploy-hst] done - note the token / treasury addresses printed above."
