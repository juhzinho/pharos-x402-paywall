// The paying client.
//   npm run client -- pay /api/atlantic/block                     402 → sign → 200 + PAYMENT-RESPONSE → on-chain check
//   npm run client -- pay /api/pacific/wallet --address 0x…
//   npm run client -- reject                                       underpaid, wrong payTo, forged signature, replay → 402s
//   npm run client -- demo [--record]                              pays all three routes, then the rejections
//   --base http://localhost:3180 (default) or the deployed URL
// The key comes from CLIENT_PRIVATE_KEY (.env) or a .private_key file — never from code or the command line.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

if (existsSync(".env")) process.loadEnvFile(".env");
const { makeClient, pay, ask, usdcBalance } = await import("../lib/client.js");
const { EXPLORER } = await import("../lib/config.js");

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (k, d = null) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const base = flag("base", "http://localhost:3180").replace(/\/$/, "");
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33);
const usd = (a) => `${(Number(a) / 1e6).toString()} USDC`;

const key = process.env.CLIENT_PRIVATE_KEY?.trim() || (existsSync(".private_key") ? readFileSync(".private_key", "utf8").trim() : null);
if (!cmd || !["pay", "reject", "demo", "quote"].includes(cmd)) {
  console.error("usage: npm run client -- pay <path> [--address 0x…] | quote <path> | reject | demo [--record]   [--base <url>]");
  process.exit(2);
}
if (cmd !== "quote" && !/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) {
  console.error("error: set CLIENT_PRIVATE_KEY in .env (or a .private_key file) — run: node scripts/keys.js");
  process.exit(2);
}
const client = makeClient(key ? privateKeyToAccount(key) : privateKeyToAccount("0x" + "1".repeat(64)));
const urlOf = (p, q = {}) => `${base}${p}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ""}`;

function show(label, r) {
  console.log(`\n${bold(label)}`);
  console.log(`  1. GET without payment → ${yellow("402 Payment Required")} · ${usd(r.first.accepts.amount)} to ${r.first.accepts.payTo} on ${r.first.accepts.network}`);
  if (r.approval) console.log(`  ·  one-time: approved Permit2 on the token ${dim(r.approval.hash)}`);
  if (r.signed) console.log(`  2. signed ${r.signed.method === "permit2" ? "a Permit2 witness transfer" : "an EIP-3009 authorization"} ${dim(`from ${r.signed.from} · value ${r.signed.value} · nonce ${r.signed.nonce.slice(0, 18)}…`)}`);
  else console.log("  2. re-sent an earlier signed payment");
  if (r.second.status === 200) {
    console.log(`  3. GET with PAYMENT-SIGNATURE → ${green("200")} · PAYMENT-RESPONSE: success ${r.paymentResponse.success}, tx ${r.paymentResponse.transaction}`);
    console.log(`  4. on Atlantic: block ${r.onchain.block} · ${r.onchain.status} · Transfer ${usd(r.onchain.transfer.value)} ${r.onchain.transfer.from} → ${r.onchain.transfer.to} · ${r.onchain.matches ? green("matches the price and payTo") : red("DOES NOT MATCH")}`);
    console.log(`     ${r.onchain.explorer}`);
  } else console.log(`  3. GET with PAYMENT-SIGNATURE → ${r.second.status === 402 ? red("402 again") : r.second.status} · ${JSON.stringify(r.second.body.error ?? r.second.body).slice(0, 160)}`);
}

const record = {};
try {
  if (cmd === "quote") {
    const r = await ask(client, urlOf(args[1] ?? "/api/atlantic/block"));
    console.log(JSON.stringify({ status: r.status, accepts: r.accepts ?? null, body: r.status === 402 ? undefined : r.body }, null, 2));
    process.exit(0);
  }
  const start = await usdcBalance(client, client.account.address);
  console.log(dim(`client ${client.account.address} · ${usd(start)} on Atlantic · server ${base}`));
  const paid = [];
  if (cmd === "pay" || cmd === "demo") {
    const jobs = cmd === "pay" ? [[args[1], args[1] === "/api/pacific/wallet" ? { address: flag("address", client.account.address) } : {}]] : [["/api/atlantic/block", {}], ["/api/pacific/gas", {}], ["/api/pacific/wallet", { address: "0x08cd62babd8Dac7404504792Df30C12fC5384Df5" }]];
    for (const [p, q] of jobs) {
      const r = await pay(client, urlOf(p, q));
      show(`${p} — paid route`, r);
      if (r.second.status !== 200) throw new Error(`payment for ${p} failed: ${JSON.stringify(r.second.body)}`);
      paid.push({ path: p, query: q, ...r });
    }
  }
  const rejected = [];
  if (cmd === "reject" || cmd === "demo") {
    for (const [kind, label] of [["underpaid", "underpaid by 1 unit"], ["wrong-payTo", "paid to the wrong address"], ["forged", "a forged signature"]]) {
      const r = await pay(client, urlOf("/api/atlantic/block"), { tamper: kind });
      show(`rejection — ${label}`, r);
      rejected.push({ kind, label, status: r.second.status, error: r.second.body, paymentRequired: r.second.headers["payment-required"] ? true : false });
    }
    // a replay: the exact PAYMENT-SIGNATURE of a payment that has already settled
    const prior = paid[0] ?? (await pay(client, urlOf("/api/atlantic/block")));
    if (!paid.length) show("(a payment to replay)", prior);
    const replay = await pay(client, urlOf("/api/atlantic/block"), { header: prior.header });
    show("rejection — the same payment sent again (replay)", replay);
    rejected.push({ kind: "replay", label: "the same payment sent again", status: replay.second.status, error: replay.second.body, of: prior.paymentResponse?.transaction });
  }
  const end = await usdcBalance(client, client.account.address);
  const spent = start - end;
  const expected = paid.reduce((s, p) => s + BigInt(p.first.accepts.amount), 0n) + (cmd === "reject" ? 1000n : 0n);
  console.log(`\n${bold("Balance")} ${usd(start)} → ${usd(end)} · spent ${usd(spent)} · paid routes ${usd(expected)} · ${spent === expected ? green("rejections cost nothing") : red("MISMATCH")}`);
  if (args.includes("--record")) {
    const fork = process.env.FORK_RUN === "1"; // an Anvil fork: real contracts, but these hashes are not on the public explorer
    const out = { recordedAt: new Date().toISOString(), network: "Pharos Atlantic Testnet (eip155:688689)", fork, explorer: EXPLORER, server: base, client: client.account.address, balance: { start: start.toString(), end: end.toString(), spent: spent.toString() }, paid: paid.map(({ header, ...p }) => p), rejected };
    const file = fork ? "fork.json" : "demo.json";
    writeFileSync(new URL(`../public/runs/${file}`, import.meta.url), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log(dim(`wrote public/runs/${file}`));
  }
  process.exit(spent === expected ? 0 : 1);
} catch (e) {
  console.error(`error: ${String(e.message).split("\n")[0]}`);
  process.exit(1);
}
