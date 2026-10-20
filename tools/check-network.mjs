// Read-only check: every configured RPC must report the expected chain ID.
// Never signs or sends a transaction.
import { MEZO_MAINNET } from "../modules/mezo-chain.mjs";

let failed = false;
for (const url of MEZO_MAINNET.rpcUrls) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const { result } = await res.json();
    const id = Number.parseInt(result, 16);
    const ok = id === MEZO_MAINNET.id;
    if (!ok) failed = true;
    console.log(`${ok ? "OK  " : "FAIL"} ${url} chainId=${id}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${url} ${err.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
