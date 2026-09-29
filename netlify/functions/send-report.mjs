const FROM = "SecureStart AI <reports@securestart.defenssive.dev>"
const SUBJECT = "Your SecureStart AI Security Assessment"
const MAX_BODY_CHARS = 4000
const ALLOWED_KEYS = new Set(["recipientEmail", "score", "strengths", "gaps", "actions"])
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/

// Approved assessment content, in question order. It must match `this.actions` in the app;
// scripts/verify-site.mjs fails the Netlify build if the two ever differ.
const APPROVED_ACTIONS = [
  {
    "area": "Identity",
    "title": "Require MFA for email and administrator accounts.",
    "why": "MFA adds protection when a password is stolen.",
    "first": "Identify email and administrator accounts that do not require MFA."
  },
  {
    "area": "Passwords",
    "title": "Adopt unique passwords and an approved password manager.",
    "why": "Reused passwords allow one stolen password to affect several accounts.",
    "first": "Identify shared or reused passwords and select an approved password manager."
  },
  {
    "area": "Recovery",
    "title": "Document backups and complete a controlled restore test.",
    "why": "A backup provides value only when the business can restore its information.",
    "first": "Select one important file and complete a controlled restore test."
  },
  {
    "area": "Updates",
    "title": "Create a regular update process.",
    "why": "Updates correct known security weaknesses and software defects.",
    "first": "List business devices and confirm whether automatic updates are enabled."
  },
  {
    "area": "Devices",
    "title": "Enable and monitor endpoint protection.",
    "why": "Endpoint protection helps identify and contain malicious activity on business devices.",
    "first": "Confirm which devices lack active protection or central monitoring."
  },
  {
    "area": "Data protection",
    "title": "Enable full-disk encryption on portable business devices.",
    "why": "Encryption reduces data exposure if a device is lost or stolen.",
    "first": "Check the encryption status of every business laptop."
  },
  {
    "area": "People",
    "title": "Provide practical phishing-awareness training.",
    "why": "Employees need a clear way to recognize and report suspicious messages.",
    "first": "Schedule a short training session and explain how to report suspicious email."
  },
  {
    "area": "Access",
    "title": "Separate administrator accounts from daily-use accounts.",
    "why": "Separate accounts reduce unnecessary use of powerful permissions.",
    "first": "Identify people who use administrator access for email or normal browsing."
  },
  {
    "area": "Response",
    "title": "Create a one-page incident contact and response plan.",
    "why": "Clear contacts and first steps reduce confusion during an incident.",
    "first": "Document who employees contact when they suspect phishing or account compromise."
  },
  {
    "area": "Remote access",
    "title": "Restrict remote access and require MFA.",
    "why": "Exposed or weakly protected remote access can provide entry to business systems.",
    "first": "List remote-access methods and confirm the approved users and MFA status."
  }
]

const LEVEL_LABEL = { no: "No", partly: "Partly / Unsure" }
const AREAS = new Set(APPROVED_ACTIONS.map((action) => action.area))
const GAP_LOOKUP = new Map(APPROVED_ACTIONS.flatMap((action) =>
  Object.entries(LEVEL_LABEL).map(([level, label]) => [`${action.area} — ${label}`, { area: action.area, level }])))

const reply = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })

const fail = (status, error, message, headers) =>
  reply(status, { ok: false, error, message }, headers)

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char])

// Rebuilds the whole report from approved content. Returns null unless the request is exactly
// what the app itself would send for one complete assessment.
const deriveReport = (data) => {
  if (!Array.isArray(data.strengths) || !Array.isArray(data.gaps) || !Array.isArray(data.actions)) return null

  const levels = new Map()
  for (const area of data.strengths) {
    if (!AREAS.has(area) || levels.has(area)) return null
    levels.set(area, "yes")
  }
  for (const gap of data.gaps) {
    const match = GAP_LOOKUP.get(gap)
    if (!match || levels.has(match.area)) return null
    levels.set(match.area, match.level)
  }
  if (levels.size !== APPROVED_ACTIONS.length) return null

  const withLevel = (level) => APPROVED_ACTIONS.filter((action) => levels.get(action.area) === level)
  const yes = withLevel("yes")
  const no = withLevel("no")
  const partly = withLevel("partly")
  const report = {
    score: yes.length * 2 + partly.length,
    strengths: yes.map((action) => action.area),
    gaps: APPROVED_ACTIONS.filter((action) => levels.get(action.area) !== "yes")
      .map((action) => `${action.area} — ${LEVEL_LABEL[levels.get(action.area)]}`),
    actions: [...no, ...partly].slice(0, 3)
  }

  const sameAction = (given, expected) =>
    given !== null && typeof given === "object" && !Array.isArray(given) &&
    Object.keys(given).length === 4 && ["area", "title", "why", "first"].every((key) => given[key] === expected[key])

  const matches = data.score === report.score &&
    data.actions.length === report.actions.length &&
    data.actions.every((given, index) => sameAction(given, report.actions[index]))
  return matches ? report : null
}

const listHtml = (items, empty) => items.length
  ? `<ul style="margin:0 0 16px;padding-left:20px">${items.map((item) => `<li style="margin:4px 0">${escapeHtml(item)}</li>`).join("")}</ul>`
  : `<p style="margin:0 0 16px;color:#5b6770">${empty}</p>`

const buildHtml = ({ score, strengths, gaps, actions }) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f2f2f2;font-family:Arial,Helvetica,sans-serif;color:#1f2a30;line-height:1.55">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #d9dddf;border-radius:8px;padding:28px">
    <h1 style="margin:0 0 4px;font-size:22px">Your SecureStart AI assessment</h1>
    <p style="margin:0 0 20px;color:#5b6770">Educational readiness summary</p>
    <p style="margin:0 0 20px;font-size:18px"><strong style="color:#2d7d7a;font-size:28px">${score} / 20</strong> educational score</p>
    <h2 style="margin:0 0 8px;font-size:16px">Strengths</h2>
    ${listHtml(strengths, "No questions were answered Yes.")}
    <h2 style="margin:0 0 8px;font-size:16px">Areas requiring attention</h2>
    ${listHtml(gaps, "No areas require attention based on your answers.")}
    <h2 style="margin:0 0 8px;font-size:16px">Your priority actions</h2>
    ${actions.length ? actions.map((action, index) => `
    <div style="margin:0 0 14px;padding:12px 14px;border:1px solid #d9dddf;border-left:4px solid #2d7d7a;border-radius:6px">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5b6770">Priority ${index + 1} · ${escapeHtml(action.area)}</div>
      <div style="font-size:16px;font-weight:bold;margin:4px 0">${escapeHtml(action.title)}</div>
      <div><em>Why it matters — </em>${escapeHtml(action.why)}</div>
      <div><em>First practical step — </em>${escapeHtml(action.first)}</div>
    </div>`).join("") : `<p style="margin:0 0 16px;color:#5b6770">No priority actions were identified.</p>`}
    <hr style="border:0;border-top:1px solid #d9dddf;margin:20px 0">
    <p style="margin:0 0 8px;font-size:13px;color:#5b6770">SecureStart AI provides educational guidance based only on your answers. It does not inspect your systems or replace a professional security assessment.</p>
    <p style="margin:0;font-size:13px;color:#5b6770">Review these actions with an appropriate IT or security professional before implementation.</p>
  </div>
</body></html>`

const buildText = ({ score, strengths, gaps, actions }) => [
  "Your SecureStart AI assessment", "",
  `Educational score: ${score} / 20`, "",
  "Strengths:", ...(strengths.length ? strengths.map((item) => `- ${item}`) : ["- No questions were answered Yes."]), "",
  "Areas requiring attention:", ...(gaps.length ? gaps.map((item) => `- ${item}`) : ["- No areas require attention based on your answers."]), "",
  "Your priority actions:",
  ...actions.flatMap((action, index) => [
    `${index + 1}. ${action.title} (${action.area})`,
    `   Why it matters: ${action.why}`,
    `   First practical step: ${action.first}`
  ]), "",
  "SecureStart AI provides educational guidance based only on your answers. It does not inspect your systems or replace a professional security assessment.",
  "Review these actions with an appropriate IT or security professional before implementation."
].join("\n")

export default async (request) => {
  if (request.method !== "POST") {
    return fail(405, "method_not_allowed", "This address only accepts report requests.", { Allow: "POST" })
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_BODY_CHARS) {
    return fail(413, "too_large", "The report is too large to send.")
  }

  let raw
  try {
    raw = await request.text()
  } catch {
    return fail(400, "invalid_request", "Check the report details and try again.")
  }
  if (raw.length > MAX_BODY_CHARS) {
    return fail(413, "too_large", "The report is too large to send.")
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return fail(400, "invalid_request", "Check the report details and try again.")
  }

  // Only the five approved fields are accepted: the client can never supply HTML,
  // a subject, a sender, a reply-to address, or extra recipients.
  const isPlainObject = data !== null && typeof data === "object" && !Array.isArray(data)
  const recipient = isPlainObject && typeof data.recipientEmail === "string" ? data.recipientEmail.trim().toLowerCase() : ""
  const report = isPlainObject &&
    Object.keys(data).every((key) => ALLOWED_KEYS.has(key)) &&
    recipient.length > 0 && recipient.length <= 254 && EMAIL_PATTERN.test(recipient)
    ? deriveReport(data)
    : null

  if (!report) {
    return fail(400, "invalid_request", "Check the report details and try again.")
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.error("send-report: email service is not configured")
    return fail(500, "not_configured", "We could not send your report. Please try again later.")
  }

  try {
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [recipient],
        subject: SUBJECT,
        html: buildHtml(report),
        text: buildText(report)
      })
    })

    if (!resendResponse.ok) {
      console.error("send-report: email provider returned status", resendResponse.status)
      return fail(502, "send_failed", "We could not send your report. Please try again later.")
    }
    return reply(200, { ok: true })
  } catch {
    console.error("send-report: email provider request failed")
    return fail(502, "send_failed", "We could not send your report. Please try again later.")
  }
}

export const config = {
  path: "/api/send-report",
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ["ip", "domain"]
  }
}
