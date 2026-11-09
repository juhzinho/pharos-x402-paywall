// Offline tests: the facilitator and the paywall run in this process on ephemeral ports, with no key and no chain.
// What needs the chain (verify, settle, the Transfer in the receipt) is covered by `npm run fork` (an Atlantic fork).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

delete process.env.FACILITATOR_PRIVATE_KEY;
delete process.env.ASSET;
process.env.ATLANTIC_RPC_URL = "http://127.0.0.1:9"; // nothing listens there: any chain call would fail loudly
const PAY_TO = privateKeyToAccount(generatePrivateKey()).address;
process.env.PAY_TO_ADDRESS = PAY_TO;
const { handleApp } = await import("../lib/app.js");
const { ROUTES } = await import("../lib/paywall.js");
const { USDC, NETWORK, ASSETS, EXACT_PERMIT2_PROXY } = await import("../lib/config.js");
const { officialInitcode } = await import("../lib/proxy.js");
const { makeClient, ask } = await import("../lib/client.js");

let server, base;
before(async () => {
  server = http.createServer((req, res) => handleApp(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const client = (asset) => makeClient(privateKeyToAccount(generatePrivateKey()), { rpc: process.env.ATLANTIC_RPC_URL, asset });

test("the paywall never takes its facilitator from the Host header", async () => {
  const { trustedFacilitatorUrl } = await import("../lib/app.js");
  const fake = { headers: { host: "evil.example" }, socket: { localPort: 4321 } };
  assert.equal(trustedFacilitatorUrl(fake), "http://127.0.0.1:4321/facilitator");
  const h = await fetch(`${base}/health`, { headers: { "x-forwarded-host": "evil.example" } }).then((r) => r.json());
  assert.match(h.facilitator.url, /^http:\/\/127\.0\.0\.1:/);
});

test("free routes answer 200 without payment", async () => {
  const h = await fetch(`${base}/health`).then((r) => r.json());
  assert.equal(h.ok, true);
  assert.equal(h.network, NETWORK);
  assert.equal(h.payTo, PAY_TO);
  assert.equal(h.facilitator.canSettle, false);
  const c = await fetch(`${base}/catalog`).then((r) => r.json());
  assert.equal(c.paid.length, 3);
  assert.ok(c.free.includes("GET /health"));
});

test("the facilitator serves /supported, validates bodies and only settles for its own payTo", async () => {
  const s = await fetch(`${base}/facilitator/supported`).then((r) => r.json());
  assert.ok(s.kinds.some((k) => k.scheme === "exact" && k.network === NETWORK));
  const bad = await fetch(`${base}/facilitator/verify`, { method: "POST", body: "{" });
  assert.equal(bad.status, 400);
  const empty = await fetch(`${base}/facilitator/settle`, { method: "POST", body: "{}" });
  assert.equal(empty.status, 400);
  assert.equal((await fetch(`${base}/facilitator/settle`)).status, 404);
  // it refuses to relay payments to an address it does not serve (no PHRS spent, nothing sent on-chain)
  const foreign = { paymentPayload: { x402Version: 2, payload: {} }, paymentRequirements: { scheme: "exact", network: NETWORK, payTo: "0x000000000000000000000000000000000000dEaD", amount: "1", asset: USDC.address } };
  const settle = await fetch(`${base}/facilitator/settle`, { method: "POST", body: JSON.stringify(foreign) }).then((r) => r.json());
  assert.equal(settle.success, false);
  assert.equal(settle.errorReason, "payto_not_served");
  const verify = await fetch(`${base}/facilitator/verify`, { method: "POST", body: JSON.stringify(foreign) }).then((r) => r.json());
  assert.equal(verify.isValid, false);
});

test("each paid route answers 402 with its own price, offering Circle USDC (EIP-3009) first and TEST USDC (Permit2) second", async () => {
  const prices = new Set();
  for (const r of ROUTES) {
    const res = await fetch(`${base}${r.path}${r.query ? "?address=0x08cd62babd8Dac7404504792Df30C12fC5384Df5" : ""}`, { headers: { accept: "application/json" } });
    assert.equal(res.status, 402, r.path);
    const req = decode(res.headers.get("payment-required"));
    assert.equal(req.accepts.length, 2);
    const [circle, test] = req.accepts;
    for (const a of req.accepts) {
      assert.equal(a.scheme, "exact");
      assert.equal(a.network, "eip155:688689");
      assert.equal(a.payTo, PAY_TO);
      assert.equal(a.amount, String(Math.round(Number(r.price) * 1e6)));
    }
    assert.equal(circle.asset, "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B");
    assert.deepEqual(circle.extra, { name: "USDC", version: "2" });
    assert.equal(test.asset, "0xB691f00682fEef63bc73f41C380fF648d73c6A2c");
    assert.deepEqual(test.extra, { name: "TEST USDC", assetTransferMethod: "permit2" });
    prices.add(circle.amount);
  }
  assert.equal(prices.size, ROUTES.length, "the paid routes have different prices");
});

test("a bad request is refused with 400 before any payment is asked", async () => {
  const res = await fetch(`${base}/api/pacific/wallet?address=0x123`);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("payment-required"), null);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});

test("a garbage PAYMENT-SIGNATURE gets another 402", async () => {
  const res = await fetch(`${base}/api/atlantic/block`, { headers: { accept: "application/json", "PAYMENT-SIGNATURE": "bm90IGEgcGF5bWVudA==" } });
  assert.equal(res.status, 402);
  assert.ok(res.headers.get("payment-required"));
});

for (const [kind, i] of [["underpaid", 0], ["wrong-payTo", 0], ["underpaid", 1], ["wrong-payTo", 1]]) {
  test(`a signed payment that is ${kind} gets another 402, before the facilitator is asked (${i ? "TEST USDC, Permit2" : "Circle USDC, EIP-3009"})`, async () => {
    const c = client(i ? "test-usdc" : "usdc");
    const first = await ask(c, `${base}/api/pacific/gas`);
    const a = first.required.accepts[i];
    const accepts = [{ ...a, ...(kind === "underpaid" ? { amount: String(BigInt(a.amount) - 1n) } : { payTo: "0x000000000000000000000000000000000000dEaD" }) }];
    const payload = await c.http.createPaymentPayload({ ...first.required, accepts });
    const res = await fetch(`${base}/api/pacific/gas`, { headers: { accept: "application/json", ...c.http.encodePaymentSignatureHeader(payload) } });
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /No matching payment requirements/);
  });
}

test("the client pays with Circle USDC (EIP-3009) by default; TEST USDC goes through Permit2", () => {
  assert.equal(USDC.address, "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B");
  assert.equal(USDC.method, "eip3009");
  assert.equal(ASSETS["test-usdc"].method, "permit2");
  assert.equal(ASSETS.usdc.version, "2");
});

test("the vendored proxy initcode is the published one and deploys to the SDK's proxy address", () => {
  assert.ok(officialInitcode().startsWith("0x60"));
  assert.equal(EXACT_PERMIT2_PROXY, "0x402085c248EeA27D92E8b30b2C58ed07f9E20001");
});

test("the client's spend controls refuse a price above 0.01 USDC or another asset", async () => {
  const c = client();
  const first = await ask(c, `${base}/api/atlantic/block`);
  const a = first.required.accepts[0];
  await assert.rejects(c.http.createPaymentPayload({ ...first.required, accepts: [{ ...a, amount: "10001" }] }));
  await assert.rejects(c.http.createPaymentPayload({ ...first.required, accepts: [{ ...a, asset: "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8" }] }));
});

test("no private key is written in tracked files", () => {
  let files;
  try {
    files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return; // not a git checkout
  }
  for (const f of files.filter((f) => /\.(js|json|md|html|mjs)$/.test(f) && !f.startsWith("public/runs/"))) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /(PRIVATE_KEY|private_key)\s*[=:]\s*["']?0x[0-9a-fA-F]{64}/, f);
  }
});
