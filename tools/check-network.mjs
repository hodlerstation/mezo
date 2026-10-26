// Read-only check: every configured RPC of Mezo Testnet (31611) and Mezo Mainnet (31612) must report
// the expected chain ID, and on the testnet the MUSD / MEZO tokens and HodlerStation contracts must have code.
// Never signs or sends a transaction.
//
//   node tools/check-network.mjs            # both networks
//   node tools/check-network.mjs testnet    # only 31611
//   node tools/check-network.mjs mainnet    # only 31612
import { MEZO_MAINNET, MEZO_TESTNET } from "../modules/mezo-chain.mjs";

const pick = process.argv[2];
const networks = [MEZO_TESTNET, MEZO_MAINNET].filter(
  (n) => !pick || (pick === "testnet" ? n.id === 31611 : pick === "mainnet" ? n.id === 31612 : true),
);

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result;
}

let failed = false;
const report = (ok, line) => {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${line}`);
};

for (const net of networks) {
  console.log(`# ${net.name} (${net.id})`);
  for (const url of net.rpcUrls) {
    let id;
    try {
      id = Number.parseInt(await rpc(url, "eth_chainId", []), 16);
      report(id === net.id, `${url} chainId=${id}`);
    } catch (err) {
      report(false, `${url} ${err.message}`);
      continue;
    }
    if (id !== net.id) continue;
    const contracts = { ...net.tokens, ...(net.hodlerstation ?? {}) };
    for (const [name, address] of Object.entries(contracts)) {
      try {
        const code = await rpc(url, "eth_getCode", [address, "latest"]);
        report(typeof code === "string" && code.length > 2, `${url} ${name} ${address} has code`);
      } catch (err) {
        report(false, `${url} ${name} ${address} ${err.message}`);
      }
    }
  }
}
process.exitCode = failed ? 1 : 0;
