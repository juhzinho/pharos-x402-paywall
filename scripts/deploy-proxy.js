// Puts the official x402ExactPermit2Proxy on Atlantic (once per chain; anyone can, the address is fixed by CREATE2).
// Refuses unless the vendored initcode hashes to the published address. Sent from FACILITATOR_PRIVATE_KEY (.env).
//   node scripts/deploy-proxy.js            status, and deploy if missing
//   node scripts/deploy-proxy.js --check    status only
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const { deployProxy, proxyStatus, officialInitcode } = await import("../lib/proxy.js");
const { EXPLORER } = await import("../lib/config.js");

officialInitcode(); // throws if the file is not the published initcode
const s = await proxyStatus();
console.log(`x402ExactPermit2Proxy ${s.address}: ${s.deployed ? `deployed · PERMIT2() ${s.permit2} ${s.ok ? "(canonical)" : "(NOT canonical)"}` : "not deployed"}`);
if (s.deployed || process.argv.includes("--check")) process.exit(s.deployed && !s.ok ? 1 : 0);
const key = process.env.FACILITATOR_PRIVATE_KEY?.trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) {
  console.error("error: set FACILITATOR_PRIVATE_KEY in .env (it pays the deployment gas)");
  process.exit(2);
}
const d = await deployProxy({ privateKey: key });
console.log(`deployed in block ${d.block}: ${EXPLORER}/tx/${d.tx}`);
