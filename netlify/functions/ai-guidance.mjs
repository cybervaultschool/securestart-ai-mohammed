const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
const MAX_BODY_BYTES = 8192
// Application-level latency and cost control for a short explanation. It is not a platform limit:
// Netlify's synchronous function limit is 60 seconds.
const TIMEOUT_MS = 8500
const MAX_OUTPUT_TOKENS = 1500
const MAX_SCORE = 20
const AUDIENCES = new Set(["business-owner", "it-admin"])
const LEVELS = new Set(["yes", "partly", "no"])

// Approved catalogue, in question order. It must match `this.actions` in the app (plus the control
// ids); scripts/verify-site.mjs fails the Netlify build if the two ever differ.
const APPROVED_CATALOGUE = [
  {
    "id": "mfa",
    "area": "Identity",
    "title": "Require MFA for email and administrator accounts.",
    "why": "MFA adds protection when a password is stolen.",
    "first": "Identify email and administrator accounts that do not require MFA."
  },
  {
    "id": "passwords",
    "area": "Passwords",
    "title": "Adopt unique passwords and an approved password manager.",
    "why": "Reused passwords allow one stolen password to affect several accounts.",
    "first": "Identify shared or reused passwords and select an approved password manager."
  },
  {
    "id": "backups",
    "area": "Recovery",
    "title": "Document backups and complete a controlled restore test.",
    "why": "A backup provides value only when the business can restore its information.",
    "first": "Select one important file and complete a controlled restore test."
  },
  {
    "id": "updates",
    "area": "Updates",
    "title": "Create a regular update process.",
    "why": "Updates correct known security weaknesses and software defects.",
    "first": "List business devices and confirm whether automatic updates are enabled."
  },
  {
    "id": "endpoint",
    "area": "Devices",
    "title": "Enable and monitor endpoint protection.",
    "why": "Endpoint protection helps identify and contain malicious activity on business devices.",
    "first": "Confirm which devices lack active protection or central monitoring."
  },
  {
    "id": "encryption",
    "area": "Data protection",
    "title": "Enable full-disk encryption on portable business devices.",
    "why": "Encryption reduces data exposure if a device is lost or stolen.",
    "first": "Check the encryption status of every business laptop."
  },
  {
    "id": "awareness",
    "area": "People",
    "title": "Provide practical phishing-awareness training.",
    "why": "Employees need a clear way to recognize and report suspicious messages.",
    "first": "Schedule a short training session and explain how to report suspicious email."
  },
  {
    "id": "admin-accounts",
    "area": "Access",
    "title": "Separate administrator accounts from daily-use accounts.",
    "why": "Separate accounts reduce unnecessary use of powerful permissions.",
    "first": "Identify people who use administrator access for email or normal browsing."
  },
  {
    "id": "incident-plan",
    "area": "Response",
    "title": "Create a one-page incident contact and response plan.",
    "why": "Clear contacts and first steps reduce confusion during an incident.",
    "first": "Document who employees contact when they suspect phishing or account compromise."
  },
  {
    "id": "remote-access",
    "area": "Remote access",
    "title": "Restrict remote access and require MFA.",
    "why": "Exposed or weakly protected remote access can provide entry to business systems.",
    "first": "List remote-access methods and confirm the approved users and MFA status."
  }
]

const SYSTEM_PROMPT = [
  "You write short, plain-language explanations for SecureStart AI, an educational small-business security self-assessment.",
  "You receive one JSON object of server-verified facts: audience, score, maxScore, strengthIds, gapIds and actions. Use only those facts.",
  "Rules:",
  "- Do not add, remove, reorder or rename controls or actions. Do not invent scores, severity, risk ratings, statistics or deadlines.",
  "- Never say the business is secure, safe, unsafe, insecure, compliant or non-compliant, and never claim certification or a guarantee.",
  "- Write plain text only: no links, no HTML, no markdown, no line breaks.",
  '- audience "business-owner" is a non-technical owner or office manager: use everyday words and no jargon. audience "it-admin" is the person who manages IT for the business: brief technical terms are fine.',
  "Return only one JSON object, with no code fences and no other text, using exactly these keys:",
  "summary: two sentences at most that put the score out of maxScore in context.",
  "positiveFinding: one sentence about the strengths named in strengthIds. Use an empty string if strengthIds is empty.",
  "priorities: one entry for each item in actions, in the same order, with no extra, missing or repeated entries (an empty array if actions is empty). Each entry has exactly two keys: controlId, copied exactly from the action, and explanation: one or two sentences on why this matters for this business. Do not return titles, areas, first steps, scores, severity or compliance statements; the server adds the approved wording itself.",
  "limitations: one sentence saying this is educational guidance based only on the answers, that it does not inspect any systems, and that it should be reviewed with an appropriate IT or security professional."
].join("\n")

const UNAVAILABLE = {
  ok: false,
  error: "unavailable",
  message: "AI Advisor is unavailable right now. Your score and actions are not affected."
}

const reply = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })

const unavailable = () => reply(503, UNAVAILABLE)
const invalid = (status, error) => reply(status, { ok: false, error, message: "Check the request and try again." })

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const hasExactKeys = (value, keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

// Server authority: the score, strengths, gaps and the three actions come only from the answers
// and the approved catalogue. Nothing about them is ever taken from the client.
const assess = (answers) => {
  let score = 0
  const noActions = []
  const partlyActions = []
  answers.forEach((level, index) => {
    if (level === "yes") score += 2
    else if (level === "partly") { score += 1; partlyActions.push(APPROVED_CATALOGUE[index]) }
    else noActions.push(APPROVED_CATALOGUE[index])
  })
  return {
    score,
    strengths: APPROVED_CATALOGUE.filter((_, index) => answers[index] === "yes"),
    gaps: APPROVED_CATALOGUE.filter((_, index) => answers[index] !== "yes"),
    actions: [...noActions, ...partlyActions].slice(0, 3)
  }
}

// The only content ever sent to Claude.
const buildFacts = (audience, { score, strengths, gaps, actions }) => ({
  audience,
  score,
  maxScore: MAX_SCORE,
  strengthIds: strengths.map((entry) => entry.id),
  gapIds: gaps.map((entry) => entry.id),
  actions: actions.map(({ id, area, title, why, first }) => ({ controlId: id, area, title, why, first }))
})

const LINK_PATTERNS = [
  /(?:https?:|ftp:|mailto:|www\.)/i,
  /\]\(/,
  /\b[a-z0-9-]{2,}\.(?:com|net|org|io|co|app|dev|ai|gov|edu|info|biz|xyz|me|us|uk)\b/i
]

// Returns the cleaned text, or null if it is not an acceptable plain-text field.
const cleanText = (value, { min, max }) => {
  if (typeof value !== "string") return null
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length < min || text.length > max) return null
  if (/[\u0000-\u001F\u007F]/.test(text) || /[<>]/.test(text)) return null
  if (LINK_PATTERNS.some((pattern) => pattern.test(text))) return null
  return text
}

// Validates Claude's JSON against the server-selected facts. Each provider priority may contain
// only controlId and explanation. The server alone decides how many priorities exist and in which
// order, and attaches the title, area and first step from the approved catalogue afterwards.
const validateAdvisor = (text, assessment) => {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, ["summary", "positiveFinding", "priorities", "limitations"])) return null

  const summary = cleanText(parsed.summary, { min: 1, max: 400 })
  const limitations = cleanText(parsed.limitations, { min: 1, max: 300 })
  const hasStrengths = assessment.strengths.length > 0
  const positiveFinding = cleanText(parsed.positiveFinding, { min: hasStrengths ? 1 : 0, max: hasStrengths ? 300 : 0 })
  if (summary === null || limitations === null || positiveFinding === null) return null

  const expected = assessment.actions
  if (!Array.isArray(parsed.priorities) || parsed.priorities.length !== expected.length) return null

  const priorities = []
  for (const [index, item] of parsed.priorities.entries()) {
    if (!isPlainObject(item) || !hasExactKeys(item, ["controlId", "explanation"])) return null
    if (item.controlId !== expected[index].id) return null
    const explanation = cleanText(item.explanation, { min: 1, max: 350 })
    if (explanation === null) return null
    const { id, title, area, first } = expected[index]
    priorities.push({ controlId: id, title, area, explanation, firstStep: first })
  }
  return { summary, positiveFinding, priorities, limitations }
}

// Calls the Claude Messages API once. Returns the concatenated text blocks, or null for any failure.
// Failures are logged by category only: never provider bodies, answers or secrets.
const askClaude = async ({ apiKey, model, facts }) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(facts) }],
        output_config: { effort: "low" }
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      console.error("ai-guidance: provider returned status", response.status)
      return null
    }
    const data = await response.json()
    if (data?.stop_reason !== "end_turn") {
      console.error("ai-guidance: provider stopped early, stop_reason", String(data?.stop_reason).slice(0, 24))
      return null
    }
    // Content is read by block type: a thinking block may come first.
    const text = Array.isArray(data.content)
      ? data.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("")
      : ""
    return text.length > 0 ? text : null
  } catch {
    console.error(controller.signal.aborted ? "ai-guidance: provider request timed out" : "ai-guidance: provider request failed")
    return null
  } finally {
    clearTimeout(timer)
  }
}

const handle = async (request) => {
  if (request.method !== "POST") {
    return reply(405, { ok: false, error: "method_not_allowed", message: "This address only accepts POST requests." }, { Allow: "POST" })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  const model = process.env.CLAUDE_MODEL
  if (process.env.AI_ADVISOR_ENABLED !== "true" || !apiKey || !model || !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(model)) {
    return unavailable()
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return invalid(413, "too_large")
  let raw
  try { raw = await request.text() } catch { return invalid(400, "invalid_request") }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return invalid(413, "too_large")

  let data
  try { data = JSON.parse(raw) } catch { return invalid(400, "invalid_request") }

  const valid = isPlainObject(data) && hasExactKeys(data, ["answers", "audience"]) &&
    typeof data.audience === "string" && AUDIENCES.has(data.audience) &&
    Array.isArray(data.answers) && data.answers.length === APPROVED_CATALOGUE.length &&
    data.answers.every((answer) => typeof answer === "string" && LEVELS.has(answer))
  if (!valid) return invalid(400, "invalid_request")

  const assessment = assess(data.answers)
  const text = await askClaude({ apiKey, model, facts: buildFacts(data.audience, assessment) })
  const advisor = text === null ? null : validateAdvisor(text, assessment)
  if (advisor === null) {
    if (text !== null) console.error("ai-guidance: provider output failed validation")
    return unavailable()
  }

  return reply(200, { ok: true, aiGenerated: true, score: assessment.score, maxScore: MAX_SCORE, advisor })
}

// Public boundary. Intentional request errors (400, 405, 413) are returned by `handle`, never thrown.
// Anything unexpected becomes the same generic 503 as provider and configuration failures; the
// exception itself (message, stack, answers, provider text, environment values) is never used.
export default async (request) => {
  try {
    return await handle(request)
  } catch {
    console.error("ai-guidance: unexpected internal error")
    return unavailable()
  }
}

// Netlify only accepts a rate-limit window of 10 to 180 seconds and silently ignores anything else.
export const config = {
  path: "/api/ai-guidance",
  rateLimit: {
    windowLimit: 3,
    windowSize: 180,
    aggregateBy: ["ip", "domain"]
  }
}
