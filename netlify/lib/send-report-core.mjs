import { DISCLAIMER, REVIEW_LINE, assess, gapLabel, isAnswerArray } from "../../site/assessment.js"

// The report is rebuilt on the server from the answers alone. The browser can never supply the
// score, the actions, any text, a subject, a sender or a second recipient.

export const FROM = "Defenssive Security Self-Assessment <reports@securestart.defenssive.dev>"
export const SUBJECT = "Your Defenssive Security Self-Assessment report"
export const SITE_HOST = "assessment.defenssive.dev"
export const CONTACT = "contact@defenssive.com"

const MAX_BODY_BYTES = 4096
const MAX_TOKEN_CHARS = 2048
const ALLOWED_KEYS = ["recipientEmail", "answers", "turnstileToken"]
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// Per IP address: 3 reports an hour. Per recipient address: 2 reports a day.
export const LIMITS = { ip: { max: 3, windowMs: HOUR }, recipient: { max: 2, windowMs: DAY } }

const GENERIC = "We could not send your report. Please try again later."

const reply = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } })
const fail = (status, error, message, headers) => reply(status, { ok: false, error, message }, headers)

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])

const listHtml = (items, empty) => items.length
  ? `<ul style="margin:0 0 16px;padding-left:20px">${items.map((item) => `<li style="margin:4px 0">${escapeHtml(item)}</li>`).join("")}</ul>`
  : `<p style="margin:0 0 16px;color:#4b5563">${escapeHtml(empty)}</p>`

export const buildHtml = (report) => `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.55">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #d1d5db;border-radius:8px;padding:28px">
    <h1 style="margin:0 0 4px;font-size:22px">Your Defenssive Security Self-Assessment</h1>
    <p style="margin:0 0 20px;color:#4b5563">Educational readiness summary</p>
    <p style="margin:0 0 12px;font-size:18px"><strong style="color:#1d4ed8;font-size:28px">${report.score} / ${report.maxScore}</strong> educational score</p>
    <p style="margin:0 0 20px">${escapeHtml(report.headline)}</p>
    <h2 style="margin:0 0 8px;font-size:16px">Strengths</h2>
    ${listHtml(report.strengths.map((question) => question.area), "No questions were answered Yes.")}
    <h2 style="margin:0 0 8px;font-size:16px">Areas requiring attention</h2>
    ${listHtml(report.gaps.map(gapLabel), "No areas require attention based on your answers.")}
    <h2 style="margin:0 0 8px;font-size:16px">Your priority actions</h2>
    ${report.actions.length ? report.actions.map((action, index) => `
    <div style="margin:0 0 14px;padding:12px 14px;border:1px solid #d1d5db;border-left:4px solid #1d4ed8;border-radius:6px">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4b5563">Priority ${index + 1} · ${escapeHtml(action.area)}</div>
      <div style="font-size:16px;font-weight:bold;margin:4px 0">${escapeHtml(action.title)}</div>
      <div><em>Why it matters — </em>${escapeHtml(action.why)}</div>
      <div><em>First practical step — </em>${escapeHtml(action.first)}</div>
    </div>`).join("") : `<p style="margin:0 0 16px;color:#4b5563">No priority actions were identified from your answers.</p>`}
    <hr style="border:0;border-top:1px solid #d1d5db;margin:20px 0">
    <p style="margin:0 0 8px;font-size:13px;color:#4b5563">${escapeHtml(DISCLAIMER)}</p>
    <p style="margin:0 0 8px;font-size:13px;color:#4b5563">${escapeHtml(REVIEW_LINE)}</p>
    <p style="margin:0;font-size:13px;color:#4b5563">You asked for this report at ${SITE_HOST}. Questions? Contact ${CONTACT}.</p>
  </div>
</body></html>`

export const buildText = (report) => [
  "Your Defenssive Security Self-Assessment", "",
  `Educational score: ${report.score} / ${report.maxScore}`, report.headline, "",
  "Strengths:", ...(report.strengths.length ? report.strengths.map((question) => `- ${question.area}`) : ["- No questions were answered Yes."]), "",
  "Areas requiring attention:", ...(report.gaps.length ? report.gaps.map((gap) => `- ${gapLabel(gap)}`) : ["- No areas require attention based on your answers."]), "",
  "Your priority actions:",
  ...(report.actions.length
    ? report.actions.flatMap((action, index) => [
      `${index + 1}. ${action.title} (${action.area})`,
      `   Why it matters: ${action.why}`,
      `   First practical step: ${action.first}`])
    : ["No priority actions were identified from your answers."]), "",
  DISCLAIMER, REVIEW_LINE, "",
  `You asked for this report at ${SITE_HOST}. Questions? Contact ${CONTACT}.`
].join("\n")

const sha256 = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

// Counters are keyed by a salted hash, so the store holds no raw IP address or email address.
const readCounter = async (store, key, limit, now) => {
  const record = await store.get(key, { type: "json" })
  return record && now - record.start < limit.windowMs ? record : { count: 0, start: now }
}

const verifyTurnstile = async (fetchImpl, secret, token, ip) => {
  const body = new URLSearchParams({ secret, response: token })
  if (ip && ip !== "unknown") body.set("remoteip", ip)
  const response = await fetchImpl(TURNSTILE_URL, { method: "POST", body, signal: AbortSignal.timeout(5000) })
  if (!response.ok) return false
  const result = await response.json()
  return result?.success === true
}

// deps: { env, fetchImpl, getStore, now } so tests can replace every outside service.
export const createHandler = ({ env, fetchImpl, getStore, now = () => Date.now() }) => async (request, context = {}) => {
  try {
    if (request.method !== "POST") return fail(405, "method_not_allowed", "This address only accepts report requests.", { Allow: "POST" })

    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return fail(413, "too_large", "The request is too large.")
    let raw
    try { raw = await request.text() } catch { return fail(400, "invalid_request", "Check the details and try again.") }
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return fail(413, "too_large", "The request is too large.")

    let data
    try { data = JSON.parse(raw) } catch { return fail(400, "invalid_request", "Check the details and try again.") }

    // Exactly three fields, nothing else. Everything in the report is derived on the server.
    const isObject = data !== null && typeof data === "object" && !Array.isArray(data)
    const recipient = isObject && typeof data.recipientEmail === "string" ? data.recipientEmail.trim().toLowerCase() : ""
    const valid = isObject && Object.keys(data).length === ALLOWED_KEYS.length && ALLOWED_KEYS.every((key) => Object.hasOwn(data, key)) &&
      recipient.length > 0 && recipient.length <= 254 && EMAIL_PATTERN.test(recipient) &&
      isAnswerArray(data.answers) &&
      typeof data.turnstileToken === "string" && data.turnstileToken.length > 0 && data.turnstileToken.length <= MAX_TOKEN_CHARS
    if (!valid) return fail(400, "invalid_request", "Check the details and try again.")
    const report = assess(data.answers)

    const apiKey = env.RESEND_API_KEY
    const turnstileSecret = env.TURNSTILE_SECRET_KEY
    if (!apiKey || !turnstileSecret) {
      console.error("send-report: service is not configured")
      return fail(503, "not_configured", GENERIC)
    }

    const ip = context.ip || request.headers.get("x-nf-client-connection-ip") || "unknown"
    const salt = env.RATE_LIMIT_SALT || "defenssive-self-assessment"
    const t = now()
    const store = getStore()
    const ipKey = `ip:${await sha256(`${salt}|ip|${ip}`)}`
    const recipientKey = `rcpt:${await sha256(`${salt}|rcpt|${recipient}`)}`

    const tooMany = (remainingMs) => fail(429, "rate_limited",
      "Too many reports have been requested. Please try again later.", { "Retry-After": String(Math.max(1, Math.ceil(remainingMs / 1000))) })

    const ipCounter = await readCounter(store, ipKey, LIMITS.ip, t)
    if (ipCounter.count >= LIMITS.ip.max) return tooMany(LIMITS.ip.windowMs - (t - ipCounter.start))

    if (!(await verifyTurnstile(fetchImpl, turnstileSecret, data.turnstileToken, ip))) {
      return fail(400, "verification_failed", "Please complete the check and try again.")
    }

    const recipientCounter = await readCounter(store, recipientKey, LIMITS.recipient, t)
    if (recipientCounter.count >= LIMITS.recipient.max) return tooMany(LIMITS.recipient.windowMs - (t - recipientCounter.start))

    // Count the attempt before sending, so a failing provider cannot be used to bypass the limits.
    await store.setJSON(ipKey, { count: ipCounter.count + 1, start: ipCounter.start })
    await store.setJSON(recipientKey, { count: recipientCounter.count + 1, start: recipientCounter.start })

    const sent = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [recipient], subject: SUBJECT, html: buildHtml(report), text: buildText(report) }),
      signal: AbortSignal.timeout(10000)
    })
    if (!sent.ok) {
      console.error("send-report: email provider returned status", sent.status)
      return fail(502, "send_failed", GENERIC)
    }
    return reply(200, { ok: true })
  } catch {
    // Never expose the exception, the answers or the address.
    console.error("send-report: unexpected failure")
    return fail(502, "send_failed", GENERIC)
  }
}
