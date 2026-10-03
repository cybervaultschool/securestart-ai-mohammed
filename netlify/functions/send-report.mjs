import { getStore } from "@netlify/blobs"
import { createHandler } from "../lib/send-report-core.mjs"

// The report is rebuilt on the server from the answers alone (see netlify/lib/send-report-core.mjs).
// Secrets live only in Netlify environment variables: RESEND_API_KEY, TURNSTILE_SECRET_KEY and
// optionally RATE_LIMIT_SALT. None of them is ever logged or returned.
export default createHandler({
  env: process.env,
  fetchImpl: (...args) => fetch(...args),
  getStore: () => getStore({ name: "report-limits", consistency: "strong" })
})

// Burst protection at the edge (Netlify ignores windows outside 10-180 seconds). The hourly per-IP
// and daily per-recipient limits are enforced in code, in netlify/lib/send-report-core.mjs.
export const config = {
  path: "/api/send-report",
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ["ip", "domain"]
  }
}
