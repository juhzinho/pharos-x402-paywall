import { createFacilitator } from "./facilitator.js";
import { createPaywall } from "./paywall.js";

// One handler for the whole service (node:http locally, one Vercel function in production):
//   /facilitator, /facilitator/supported, /facilitator/verify, /facilitator/settle   — the facilitator
//   /health, /catalog                                                                 — free
//   /api/atlantic/block, /api/pacific/gas, /api/pacific/wallet                         — paid (x402)
// The paywall talks to the facilitator over HTTP, exactly as it would to any other facilitator.

let facilitator = null;
const paywalls = new Map();

export function originOf(req) {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost"}`;
}

/**
 * Where the paywall asks for /verify and /settle. Never derived from the request's Host header: a forged Host would
 * point the paywall at a facilitator that approves anything. FACILITATOR_URL if set; on Vercel the project's
 * production domain; locally this same server over loopback.
 */
export function trustedFacilitatorUrl(req) {
  if (process.env.FACILITATOR_URL) return process.env.FACILITATOR_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/facilitator`;
  return `http://127.0.0.1:${req.socket?.localPort ?? process.env.PORT ?? 3180}/facilitator`;
}

export async function handleApp(req, res) {
  const origin = originOf(req);
  const url = new URL(req.url, origin);
  // On Vercel every route is rewritten to /api/index?path=<original path>: put the original path back
  const rewritten = url.searchParams.get("path");
  if (url.pathname === "/api/index" && rewritten?.startsWith("/")) url.pathname = rewritten;
  if (process.env.VERCEL || url.pathname !== new URL(req.url, origin).pathname) url.searchParams.delete("path");
  facilitator ??= createFacilitator();
  try {
    if (url.pathname === "/facilitator" || url.pathname.startsWith("/facilitator/")) return await facilitator.handle(req, res, url.pathname.slice("/facilitator".length));
    const payTo = process.env.PAY_TO_ADDRESS?.trim(); // a value piped into `vercel env add` keeps its newline
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo ?? "")) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "PAY_TO_ADDRESS is not set: the API does not know where payments go" }));
    }
    const facilitatorUrl = trustedFacilitatorUrl(req);
    if (!paywalls.has(facilitatorUrl)) {
      const info = async () => {
        const r = await fetch(facilitatorUrl).then((x) => x.json()).catch(() => null);
        return r ? { signer: r.signer, canSettle: r.canSettle, gasBalancePHRS: r.gasBalancePHRS } : { reachable: false };
      };
      paywalls.set(facilitatorUrl, createPaywall({ payTo, facilitatorUrl, facilitatorInfo: info }).catch((e) => {
        paywalls.delete(facilitatorUrl);
        throw e;
      }));
    }
    return await (await paywalls.get(facilitatorUrl)).handle(req, res, url);
  } catch (e) {
    if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `the service is not ready: ${String(e.message).split("\n")[0]}` }));
  }
}
