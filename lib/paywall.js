import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ACCEPTED, NETWORK, assetExtra } from "./config.js";
import { atlanticBlock, pacificGas, pacificWallet, validWallet } from "./data.js";

// The paywalled API, on the official x402 SDK (x402HTTPResourceServer + the "exact" EVM scheme), priced in Atlantic
// test USDC. Free: /health, /catalog. Paid: three routes at three prices. Its facilitator is its own (/facilitator).
// The data is produced BEFORE settling, so a failing data source never charges anyone.

export const ROUTES = [
  { path: "/api/atlantic/block", price: "0.001", label: "Atlantic head block", description: "The latest Pharos Atlantic block: number, time, transactions, gas.", handler: atlanticBlock },
  { path: "/api/pacific/gas", price: "0.002", label: "Pacific gas market", description: "Pharos Pacific Mainnet's fee market over the last 64 blocks: base fee, and how many senders paid above it.", handler: () => pacificGas() },
  { path: "/api/pacific/wallet", price: "0.005", label: "Pacific wallet profile", description: "A Pacific Mainnet wallet: PROS, USDC and WPROS balances, nonce, account type, USDC blacklist.", query: { address: "0x… (required)" }, validate: validWallet, handler: pacificWallet },
];

/** "0.005" → "5000" for 6 decimals, exactly (no floating point). */
export function atomic(price, decimals) {
  const [w, f = ""] = String(price).split(".");
  if (!/^\d+$/.test(w) || !/^\d*$/.test(f) || f.length > decimals) throw new Error(`bad price ${price}`);
  return (BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}
const tokens = () => ACCEPTED.map((a) => ({ label: a.label, address: a.address, decimals: a.decimals, method: a.method }));

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export async function createPaywall({ payTo, facilitatorUrl, facilitatorInfo = () => null }) {
  const scheme = new ExactEvmScheme();
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }));
  resourceServer.register(NETWORK, scheme);
  const config = Object.fromEntries(ROUTES.map((r) => [`GET ${r.path}`, { accepts: ACCEPTED.map((a) => ({ scheme: "exact", price: { amount: atomic(r.price, a.decimals), asset: a.address, extra: assetExtra(a) }, network: NETWORK, payTo, maxTimeoutSeconds: 120 })), description: r.description, mimeType: "application/json", serviceName: "Pharos x402 Paywall" }]));
  const http402 = new x402HTTPResourceServer(resourceServer, config);
  await http402.initialize(); // asks the facilitator's /supported

  const catalog = { name: "Pharos x402 Paywall", network: NETWORK, accepts: tokens(), payTo, facilitator: facilitatorUrl, free: ["GET /health", "GET /catalog", "GET /facilitator/supported"], paid: ROUTES.map((r) => ({ method: "GET", path: r.path, price: `${r.price} USDC`, label: r.label, description: r.description, query: r.query ?? null })) };

  async function handle(req, res, url) {
    const send = (status, body, headers = {}) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE", ...headers });
      res.end(typeof body === "string" ? body : json(body));
    };
    if (req.method === "OPTIONS") return send(204, "", { "access-control-allow-headers": "PAYMENT-SIGNATURE, X-PAYMENT, content-type" });
    if (url.pathname === "/health") return send(200, { ok: true, network: NETWORK, accepts: tokens(), payTo, facilitator: { url: facilitatorUrl, ...(await facilitatorInfo()) }, time: new Date().toISOString() });
    if (url.pathname === "/catalog") return send(200, catalog);
    const route = ROUTES.find((r) => r.path === url.pathname);
    if (!route) return send(404, { error: "no such route", catalog: "/catalog" });
    if (req.method !== "GET") return send(405, { error: "GET" });

    const query = Object.fromEntries(url.searchParams);
    const invalid = route.validate?.(query);
    if (invalid) return send(400, { error: invalid }); // a bad request is refused before any payment

    const paymentHeader = req.headers["payment-signature"] ?? req.headers["x-payment"];
    const adapter = { getHeader: (n) => req.headers[n.toLowerCase()], getMethod: () => req.method, getPath: () => url.pathname, getUrl: () => url.href, getAcceptHeader: () => req.headers.accept ?? "application/json", getUserAgent: () => req.headers["user-agent"] ?? "", getQueryParams: () => query, getQueryParam: (k) => query[k] };
    const result = await http402.processHTTPRequest({ adapter, path: url.pathname, method: req.method, paymentHeader });
    const paymentHeaders = (h) => Object.fromEntries(Object.entries(h ?? {}).filter(([k]) => /^payment-/i.test(k)));
    if (result.type === "payment-error") return send(result.response.status, result.response.body ?? {}, { ...paymentHeaders(result.response.headers), ...(result.response.isHtml ? { "content-type": "text/html; charset=utf-8" } : {}) });
    if (result.type === "no-payment-required") return send(200, await route.handler(query));

    let data;
    try {
      data = await route.handler(query);
    } catch (e) {
      return send(502, { error: `the data source failed, so nothing was charged: ${e.shortMessage ?? e.message}` });
    }
    // settle.headers is the SDK's own PAYMENT-RESPONSE (re-encoding `settle` would nest that header inside itself)
    const settle = await http402.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: { adapter, path: url.pathname, method: req.method } });
    // first line only: a node error carries the whole RPC request (raw transaction included), which is noise to a client
    const brief = (m) => (m == null ? null : String(m).split(/\r?\n/)[0].slice(0, 200));
    if (!settle.success) return send(402, { error: brief(settle.errorReason) ?? "settlement failed", detail: brief(settle.errorMessage) }, paymentHeaders(settle.headers));
    return send(200, { ...data, paid: { amount: `${route.price} USDC`, transaction: settle.transaction, payer: settle.payer } }, paymentHeaders(settle.headers));
  }
  return { handle, catalog };
}
