// The whole service as one Vercel function: facilitator, free routes and paid routes (vercel.json rewrites them here).
import { handleApp } from "../lib/app.js";

export default function handler(req, res) {
  return handleApp(req, res);
}
