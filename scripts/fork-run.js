// The whole flow on an Anvil fork of Pharos Atlantic — before (or without) real test funds. Fresh test keys are
// generated in memory for this run only; the facilitator gets PHRS and the client test USDC (and a little PHRS for
// its one-time Permit2 approval) on the fork only. The official x402 Permit2 proxy is deployed on the fork if missing.
// The server and its facilitator run in this process against the fork; the client pays, and is refused.
//   node scripts/fork-run.js
import http from "node:http";
import { createPublicClient, http as transport, pad, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startFork } from "../lib/fork.js";

const fork = await startFork({ port: Number(process.env.FORK_PORT ?? 8557) });
const facilitatorKey = generatePrivateKey(), clientKey = generatePrivateKey();
Object.assign(process.env, { FORK_RUN: "1", ATLANTIC_RPC_URL: fork.url, FACILITATOR_PRIVATE_KEY: facilitatorKey, CLIENT_PRIVATE_KEY: clientKey, PAY_TO_ADDRESS: privateKeyToAccount(generatePrivateKey()).address, PORT: process.env.PORT ?? "3189" });
const { USDC } = await import("../lib/config.js");
const { handleApp } = await import("../lib/app.js");
const rpc = (method, params) => createPublicClient({ transport: transport(fork.url) }).request({ method, params });
const { keccak256, encodeAbiParameters } = await import("viem");
const slot = (who) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, USDC.balanceSlot]));
await rpc("anvil_setBalance", [privateKeyToAccount(facilitatorKey).address, "0x8AC7230489E80000"]); // 10 PHRS, fork only
await rpc("anvil_setStorageAt", [USDC.address, slot(privateKeyToAccount(clientKey).address), pad(toHex(1_000_000n))]); // 1 test USDC, fork only
await rpc("anvil_setBalance", [privateKeyToAccount(clientKey).address, "0x16345785D8A0000"]); // 0.1 PHRS for the one-time Permit2 approval, fork only
if (USDC.method === "permit2") {
  // the official x402ExactPermit2Proxy, deployed exactly as on the real chain (CREATE2, published initcode and salt)
  const { deployProxy } = await import("../lib/proxy.js");
  const p = await deployProxy({ privateKey: facilitatorKey, rpc: fork.url });
  console.log(`x402ExactPermit2Proxy ${p.address} · ${p.tx ? `deployed on the fork in ${p.tx}` : "already there"} · PERMIT2() ${p.permit2}`);
}
const server = http.createServer((req, res) => handleApp(req, res)).listen(Number(process.env.PORT));
console.log(`fork ${fork.url} · server http://localhost:${process.env.PORT} · facilitator ${privateKeyToAccount(facilitatorKey).address} · client ${privateKeyToAccount(clientKey).address}`);
try {
  // asynchronous on purpose: the server answering the client runs in THIS process
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["scripts/client.js", "demo", "--base", `http://localhost:${process.env.PORT}`, ...(process.argv.includes("--record") ? ["--record"] : [])], { stdio: "inherit", env: { ...process.env } });
  process.exitCode = await new Promise((r) => child.on("exit", (code) => r(code)));
} finally {
  server.close();
  fork.stop();
}
process.exit(process.exitCode ?? 0);
