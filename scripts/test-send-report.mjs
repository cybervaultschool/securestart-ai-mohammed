// Tests netlify/lib/send-report-core.mjs (the /api/send-report handler) against MOCKED Turnstile, Resend
// and rate-limit store. No network, no real keys.   Run: node scripts/test-send-report.mjs
import { ANSWER_VALUES, DISCLAIMER, NOT_SURE_FIRST_STEP, QUESTIONS } from "../site/assessment.js"
import { FROM, LIMITS, SUBJECT, createHandler } from "../netlify/lib/send-report-core.mjs"

const RESEND_KEY = "test-resend-key-NOT-REAL-0001"
const TURNSTILE_SECRET = "test-turnstile-secret-NOT-REAL-0002"
const SALT = "test-salt-NOT-REAL-0003"
const ENV = { RESEND_API_KEY: RESEND_KEY, TURNSTILE_SECRET_KEY: TURNSTILE_SECRET, RATE_LIMIT_SALT: SALT }

const logged = []
for (const method of ["log", "error", "warn", "info"]) {
  const original = console[method]
  console[method] = (...args) => { logged.push(args.map(String).join(" ")); original(...args) }
}

let passed = 0
const failures = []
const check = (name, ok, detail = "") => {
  if (ok) passed++
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` (${detail})` : ""}`) }
}

// ---- mocks -----------------------------------------------------------------------------------
const makeStore = () => {
  const map = new Map()
  return {
    map,
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : null),
    setJSON: async (key, value) => { map.set(key, structuredClone(value)) }
  }
}
const world = { turnstile: "ok", resend: "ok", resendStatus: 500, calls: [] }
const resetWorld = () => Object.assign(world, { turnstile: "ok", resend: "ok", resendStatus: 500, calls: [] })
const fakeFetch = async (url, init) => {
  world.calls.push({ url: String(url), init })
  if (String(url).includes("challenges.cloudflare.com")) {
    if (world.turnstile === "throw") throw new Error(`network ${TURNSTILE_SECRET}`)
    const params = new URLSearchParams(init.body)
    const good = world.turnstile === "ok" && params.get("response") !== "bad-token"
    return new Response(JSON.stringify({ success: good }), { status: 200 })
  }
  if (world.resend === "throw") throw new Error(`boom ${RESEND_KEY}`)
  if (world.resend === "fail") return new Response(`provider secret body ${RESEND_KEY}`, { status: world.resendStatus })
  return new Response(JSON.stringify({ id: "email_1" }), { status: 200 })
}
const emails = () => world.calls.filter((call) => call.url.includes("api.resend.com"))
const siteverifies = () => world.calls.filter((call) => call.url.includes("challenges.cloudflare.com"))

let clock = 1_800_000_000_000
const build = (overrides = {}) => {
  const store = overrides.store ?? makeStore()
  return { store, handler: createHandler({ env: { ...ENV, ...overrides.env }, fetchImpl: fakeFetch, getStore: () => store, now: () => clock }) }
}

const ids = QUESTIONS.map((question) => question.id)
const allYes = ids.map(() => "yes")
const answersWith = (base, overrides = {}) => ids.map((id) => overrides[id] ?? base)
const MIXED = answersWith("yes", { "admin-mfa": "unsure", passwords: "partly", backups: "no", endpoint: "no", "incident-plan": "partly" })
const good = (extra = {}) => ({ recipientEmail: "owner@example.com", answers: MIXED, turnstileToken: "good-token", ...extra })

const post = async (handler, body, { ip = "203.0.113.10", headers = {}, raw } = {}) => {
  const text = raw ?? JSON.stringify(body)
  try {
    const response = await handler(new Request("http://local/api/send-report", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text }), { ip })
    const out = await response.text()
    let json = null
    try { json = JSON.parse(out) } catch { /* not JSON */ }
    return { status: response.status, json, text: out, headers: response.headers }
  } catch (error) {
    return { status: 599, json: null, text: String(error), headers: new Headers() }
  }
}
const GENERIC_SEND = "We could not send your report. Please try again later."

// ---- the happy path and the email itself -------------------------------------------------------
{
  resetWorld()
  const { handler } = build()
  const r = await post(handler, good({ recipientEmail: "  Owner@Example.COM " }))
  check("valid request -> 200 { ok: true }", r.status === 200 && JSON.stringify(r.json) === '{"ok":true}')
  check("response is JSON and uncached", r.headers.get("content-type")?.includes("application/json") && r.headers.get("cache-control") === "no-store" && r.headers.get("x-content-type-options") === "nosniff")
  const call = emails()[0]
  const sent = JSON.parse(call.init.body)
  check("exactly one email is sent, to the normalised recipient only", emails().length === 1 && JSON.stringify(sent.to) === '["owner@example.com"]')
  check("Resend payload has only from, to, subject, html, text", JSON.stringify(Object.keys(sent)) === '["from","to","subject","html","text"]')
  check("sender and subject are fixed and use the new product name", sent.from === FROM && sent.subject === SUBJECT &&
    FROM.startsWith("Defenssive Security Self-Assessment <") && SUBJECT === "Your Defenssive Security Self-Assessment report")
  check("API key only in the Authorization header", call.init.headers.Authorization === `Bearer ${RESEND_KEY}` && !call.init.body.includes(RESEND_KEY))
  check("score is out of 26, calculated on the server", /18 \/ 26/.test(sent.html) && /Educational score: 18 \/ 26/.test(sent.text))
  check("the three actions are the server's risk-ordered ones: Recovery, Devices, then Find out",
    sent.text.indexOf("Document backups and complete a controlled restore test.") < sent.text.indexOf("Enable and monitor endpoint protection.") &&
    sent.text.indexOf("Enable and monitor endpoint protection.") < sent.text.indexOf("Find out: MFA for administrators") &&
    sent.text.includes(NOT_SURE_FIRST_STEP))
  check("the disclaimer, product name, origin line and contact address are present in both parts",
    [sent.html, sent.text].every((part) => part.includes("Defenssive Security Self-Assessment") && part.includes("You asked for this report at assessment.defenssive.dev") &&
      part.includes("contact@defenssive.com")) && sent.text.includes(DISCLAIMER))
  check("no tracking pixels, images, links or scripts", !/<img|<a\s|<script|<link|<iframe|src=|href=|https?:\/\//i.test(sent.html) && !/https?:\/\//i.test(sent.text))
  check("no SecureStart AI wording left in the email", !/securestart ai/i.test(sent.html + sent.text))
  check("the recipient's address is not repeated inside the email body", !sent.html.includes("owner@example.com") && !sent.text.includes("owner@example.com"))
}

// ---- wording: perfect score, critical gap, bands ------------------------------------------------
{
  const mail = async (answers) => { resetWorld(); const { handler } = build(); await post(handler, good({ answers })); return JSON.parse(emails()[0].init.body) }
  const perfect = await mail(allYes)
  check("all Yes email: score 26 / 26 and the careful wording, no implied security",
    perfect.text.includes("26 / 26") && perfect.text.includes("You answered Yes to all thirteen practices. These are your own answers, not a test of your systems. Repeat this assessment periodically.") &&
    !/all practices are in place|you are secure/i.test(perfect.text) && perfect.text.includes("No priority actions were identified"))
  const critical = await mail(answersWith("yes", { mfa: "no" }))
  check("MFA = No email: the important-gap sentence, never 'most practices'", critical.text.includes("Your answers show at least one important gap. Start with the actions below.") && !/most practices/.test(critical.text + critical.html))
  // The HTML part must carry exactly the same wording as the plain-text part.
  for (const [name, answers] of [["perfect", allYes], ["critical gap", answersWith("yes", { mfa: "no" })], ["middle band", ANSWER_VALUES.length ? ids.map(() => "partly") : []], ["low band", ids.map(() => "unsure")]]) {
    const sent = await mail(answers)
    const headline = sent.text.split(String.fromCharCode(10))[3]
    check("HTML and text carry the same headline (" + name + ")", headline.length > 20 && sent.html.includes(headline) && !/All practices are in place/.test(sent.html))
  }
  const mostly = await mail(answersWith("yes", { sharing: "no" }))
  check("one non-critical No email: 'most practices are in place'", /most practices are in place/.test(mostly.text))
}

// ---- escaping ---------------------------------------------------------------------------------
{
  resetWorld()
  const { handler } = build()
  await post(handler, good({ answers: answersWith("yes", { leavers: "no", sharing: "no" }) }))
  const sent = JSON.parse(emails()[0].init.body)
  check("HTML escapes apostrophes and quotes in approved text", sent.html.includes("leavers&#39; access") && sent.html.includes("&quot;anyone&quot;") && !sent.html.includes("leavers' access"))
  check("plain text keeps the readable characters", sent.text.includes("leavers' access") && sent.text.includes('"anyone"'))
}

// ---- tampering: nothing from the browser except the three allowed fields ---------------------------
const REJECTED = [
  ["extra field score", good({ score: 26 })],
  ["extra field strengths", good({ strengths: ["Identity"] })],
  ["extra field gaps", good({ gaps: [] })],
  ["extra field actions", good({ actions: [{ title: "<script>alert(1)</script>" }] })],
  ["extra field html", good({ html: "<b>pay me</b>" })],
  ["extra field text", good({ text: "arbitrary" })],
  ["extra field subject", good({ subject: "You won" })],
  ["extra field from", good({ from: "ceo@defenssive.com" })],
  ["extra field to", good({ to: ["victim@example.com"] })],
  ["extra field cc", good({ cc: "x@example.com" })],
  ["extra field bcc", good({ bcc: "x@example.com" })],
  ["extra field replyTo", good({ replyTo: "x@example.com" })],
  ["extra field audience", good({ audience: "it-admin" })],
  ["missing turnstileToken", { recipientEmail: "a@example.com", answers: MIXED }],
  ["missing answers", { recipientEmail: "a@example.com", turnstileToken: "t" }],
  ["missing recipientEmail", { answers: MIXED, turnstileToken: "t" }],
  ["10 answers (old format)", good({ answers: MIXED.slice(0, 10) })],
  ["14 answers", good({ answers: [...MIXED, "yes"] })],
  ["empty answers", good({ answers: [] })],
  ["answers is a string", good({ answers: "yes" })],
  ["answers is an object", good({ answers: { 0: "yes" } })],
  ["null answer", good({ answers: MIXED.map((a, i) => (i ? a : null)) })],
  ["old 'Partly / Unsure' value", good({ answers: MIXED.map((a, i) => (i ? a : "Partly / Unsure")) })],
  ["capitalised 'Yes'", good({ answers: MIXED.map((a, i) => (i ? a : "Yes")) })],
  ["script tag as an answer", good({ answers: MIXED.map((a, i) => (i ? a : "<script>alert(1)</script>")) })],
  ["number as an answer", good({ answers: MIXED.map((a, i) => (i ? a : 2)) })],
  ["token not a string", good({ turnstileToken: 123 })],
  ["empty token", good({ turnstileToken: "" })],
  ["token over 2,048 characters", good({ turnstileToken: "x".repeat(2049) })],
  ["recipient list", good({ recipientEmail: "a@example.com,b@example.com" })],
  ["recipient with display name", good({ recipientEmail: "Ada <a@example.com>" })],
  ["recipient with header injection", good({ recipientEmail: "a@example.com\nBcc: b@example.com" })],
  ["recipient with a space", good({ recipientEmail: "a b@example.com" })],
  ["recipient without a domain dot", good({ recipientEmail: "a@localhost" })],
  ["recipient over 254 characters", good({ recipientEmail: `${"a".repeat(60)}@${"b".repeat(250)}.com` })],
  ["recipient as an array", good({ recipientEmail: ["a@example.com"] })],
  ["recipient empty", good({ recipientEmail: "" })]
]
for (const [name, body] of REJECTED) {
  resetWorld()
  const { handler, store } = build()
  const r = await post(handler, body)
  check(`tampered request (${name}) -> 400 generic, no Turnstile call, no email, nothing counted`,
    r.status === 400 && r.json?.ok === false && r.json?.error === "invalid_request" && siteverifies().length === 0 && emails().length === 0 && store.map.size === 0)
}
for (const raw of ["{not json", "[]", "null", '"text"', "42", "", '{"__proto__":{"x":1}}']) {
  resetWorld()
  const { handler } = build()
  const r = await post(handler, null, { raw })
  check(`body ${JSON.stringify(raw)} -> 400, no email`, r.status === 400 && emails().length === 0)
}
{
  resetWorld()
  const { handler } = build()
  const big = await post(handler, good({ padding: "x".repeat(5000) }))
  const multibyte = await post(handler, good({ padding: "é".repeat(2500) }))
  const declared = await post(handler, good(), { headers: { "content-length": "9000" } })
  check("oversized bodies (actual, multi-byte, declared) -> 413, nothing happens", big.status === 413 && multibyte.status === 413 && declared.status === 413 && world.calls.length === 0)
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handler(new Request("http://local/api/send-report", { method }), { ip: "203.0.113.10" })
    check(`${method} -> 405 with Allow: POST`, response.status === 405 && response.headers.get("allow") === "POST")
  }
}

// ---- server recomputes everything: 1,500 random assessments -----------------------------------------
{
  const RISK = ["mfa", "admin-mfa", "remote-access", "backups", "admin-accounts", "updates", "endpoint", "passwords", "leavers", "sharing", "encryption", "awareness", "incident-plan"]
  const byId = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]))
  let seed = 424242
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  let bad = 0
  for (let n = 0; n < 1500; n++) {
    const answers = ids.map(() => ANSWER_VALUES[Math.floor(random() * 4)])
    resetWorld()
    const { handler } = build()
    const r = await post(handler, good({ answers }))
    const sent = JSON.parse(emails()[0]?.init.body ?? "{}")
    const levelOf = Object.fromEntries(ids.map((id, i) => [id, answers[i]]))
    const expected = []
    for (const level of ["no", "unsure", "partly"]) for (const id of RISK) if (levelOf[id] === level) expected.push([id, level])
    const titles = expected.slice(0, 3).map(([id, level]) => (level === "unsure" ? `Find out: ${byId[id].topic}` : byId[id].action.title))
    const score = answers.reduce((sum, a) => sum + (a === "yes" ? 2 : a === "partly" ? 1 : 0), 0)
    const lines = (sent.text ?? "").split("\n").filter((line) => /^\d\. /.test(line))
    const okTitles = lines.length === titles.length && lines.every((line, i) => line.startsWith(`${i + 1}. ${titles[i]} (`))
    if (r.status !== 200 || !(sent.text ?? "").includes(`Educational score: ${score} / 26`) || !okTitles) bad++
  }
  check("1,500 random answer sets: score and the three risk-ordered actions are rebuilt correctly from the answers alone", bad === 0, `${bad} wrong`)
}

// ---- Turnstile and configuration --------------------------------------------------------------------
{
  resetWorld(); world.turnstile = "fail"
  const { handler, store } = build()
  const r = await post(handler, good())
  check("failed bot check -> 400 verification_failed, no email, nothing counted", r.status === 400 && r.json?.error === "verification_failed" && emails().length === 0 && store.map.size === 0)
  check("the bot check uses the secret and the token, and forwards the client IP", (() => {
    const params = new URLSearchParams(siteverifies()[0].init.body)
    return params.get("secret") === TURNSTILE_SECRET && params.get("response") === "good-token" && params.get("remoteip") === "203.0.113.10"
  })())
}
{
  resetWorld(); world.turnstile = "throw"
  const { handler } = build()
  const r = await post(handler, good())
  check("bot-check service down -> generic 502, no email, secret not leaked", r.status === 502 && r.json?.message === GENERIC_SEND && emails().length === 0 && !r.text.includes(TURNSTILE_SECRET))
}
{
  resetWorld()
  for (const [name, env] of [["missing TURNSTILE_SECRET_KEY", { TURNSTILE_SECRET_KEY: undefined }], ["missing RESEND_API_KEY", { RESEND_API_KEY: undefined }]]) {
    const { handler } = build({ env })
    const r = await post(handler, good())
    check(`${name} -> fails closed with a generic 503, no email`, r.status === 503 && r.json?.message === GENERIC_SEND && emails().length === 0)
  }
}

// ---- rate limits: 3 per IP per hour, 2 per recipient per day ---------------------------------------
{
  resetWorld()
  const { handler, store } = build()
  const statuses = []
  for (let i = 0; i < 5; i++) statuses.push((await post(handler, good({ recipientEmail: `person${i}@example.com` }), { ip: "203.0.113.50" })).status)
  check("per IP: the first 3 reports succeed, the 4th and 5th get HTTP 429", statuses.join() === "200,200,200,429,429")
  const blocked = await post(handler, good({ recipientEmail: "person9@example.com" }), { ip: "203.0.113.50" })
  check("the 429 has a generic message and a Retry-After header (seconds, at most one hour)",
    blocked.status === 429 && blocked.json?.error === "rate_limited" && Number(blocked.headers.get("retry-after")) > 0 && Number(blocked.headers.get("retry-after")) <= 3600)
  check("blocked requests send no email", emails().length === 3)
  check("a different IP is not affected", (await post(handler, good({ recipientEmail: "other@example.com" }), { ip: "203.0.113.51" })).status === 200)
  clock += LIMITS.ip.windowMs - 1000
  check("still blocked just before the hour is up", (await post(handler, good({ recipientEmail: "late@example.com" }), { ip: "203.0.113.50" })).status === 429)
  clock += 1500
  check("allowed again after the hour", (await post(handler, good({ recipientEmail: "later@example.com" }), { ip: "203.0.113.50" })).status === 200)
  const keys = [...store.map.keys()].join(" ")
  check("the store holds only hashed keys (no raw IP address or email address) and only counters",
    !keys.includes("203.0.113") && !keys.includes("example.com") && !keys.includes("person") && [...store.map.keys()].every((key) => /^(ip|rcpt):[0-9a-f]{32}$/.test(key)) &&
    [...store.map.values()].every((value) => JSON.stringify(Object.keys(value).sort()) === '["count","start"]'))
}
{
  resetWorld()
  const { handler } = build()
  const statuses = []
  for (let i = 0; i < 4; i++) statuses.push((await post(handler, good({ recipientEmail: i % 2 ? "VICTIM@Example.com " : "victim@example.com" }), { ip: `198.51.100.${i + 1}` })).status)
  check("per recipient: 2 reports a day, the 3rd and 4th get HTTP 429 (case and spaces do not bypass it)", statuses.join() === "200,200,429,429")
  check("the third report to the same address was not sent", emails().length === 2)
  clock += LIMITS.recipient.windowMs + 1000
  check("allowed again after a day", (await post(handler, good({ recipientEmail: "victim@example.com" }), { ip: "198.51.100.77" })).status === 200)
}
{
  resetWorld()
  const { handler } = build()
  for (let i = 0; i < 10; i++) await post(handler, good({ answers: [] }), { ip: "203.0.113.60" })
  const statuses = []
  for (let i = 0; i < 3; i++) statuses.push((await post(handler, good({ recipientEmail: `ok${i}@example.com` }), { ip: "203.0.113.60" })).status)
  check("invalid requests do not use up the IP's allowance", statuses.join() === "200,200,200")
}
{
  resetWorld(); world.resend = "fail"
  const { handler } = build()
  const first = await post(handler, good({ recipientEmail: "x1@example.com" }), { ip: "203.0.113.70" })
  await post(handler, good({ recipientEmail: "x2@example.com" }), { ip: "203.0.113.70" })
  await post(handler, good({ recipientEmail: "x3@example.com" }), { ip: "203.0.113.70" })
  const fourth = await post(handler, good({ recipientEmail: "x4@example.com" }), { ip: "203.0.113.70" })
  check("failed sends still count, so a failing provider cannot be used to bypass the limit", first.status === 502 && fourth.status === 429)
}

// ---- generic errors, nothing leaked ----------------------------------------------------------------------
{
  const SECRET_EMAIL = "secret.person@example.com"
  const SECRET_ANSWERS = JSON.stringify(MIXED)
  resetWorld(); world.resend = "fail"; logged.length = 0
  const { handler } = build()
  const r = await post(handler, good({ recipientEmail: SECRET_EMAIL }), { ip: "203.0.113.99" })
  check("provider error -> generic 502, no provider text", r.status === 502 && r.json?.message === GENERIC_SEND && !r.text.includes("provider secret body") && !r.text.includes(RESEND_KEY))
  resetWorld(); world.resend = "throw"
  const r2 = await post(handler, good({ recipientEmail: "second.person@example.com" }), { ip: "203.0.113.98" })
  check("provider network error -> generic 502, no exception text", r2.status === 502 && r2.json?.message === GENERIC_SEND && !r2.text.includes("boom") && !r2.text.includes(RESEND_KEY))
  resetWorld()
  const brokenStore = { get: async () => { throw new Error(`store down ${SECRET_EMAIL}`) }, setJSON: async () => {} }
  const { handler: h3 } = build({ store: brokenStore })
  const r3 = await post(h3, good({ recipientEmail: SECRET_EMAIL }), { ip: "203.0.113.97" })
  check("rate-limit store failure -> generic 502, fails closed (no email), no detail", r3.status === 502 && r3.json?.message === GENERIC_SEND && emails().length === 0 && !r3.text.includes("store down"))
  const everything = logged.join("\n")
  check("logs never contain an email address, answers, an IP address, a token, a key or a secret",
    ![SECRET_EMAIL, "second.person@", SECRET_ANSWERS, "203.0.113", "good-token", RESEND_KEY, TURNSTILE_SECRET, SALT, "store down"].some((value) => everything.includes(value)))
  check("logs contain only short category lines", logged.every((line) => /^send-report: [a-z ]+( \d+)?$/.test(line)), logged.join(" | "))
}

// ---- route configuration -----------------------------------------------------------------------------
{
  process.env.RESEND_API_KEY = RESEND_KEY
  const { config, default: realHandler } = await import(new URL("../netlify/functions/send-report.mjs", import.meta.url).href)
  check("route is /api/send-report with 3 requests / 60 s burst protection per ip + domain",
    config.path === "/api/send-report" && config.rateLimit?.windowLimit === 3 && config.rateLimit?.windowSize === 60 &&
    JSON.stringify(config.rateLimit?.aggregateBy) === '["ip","domain"]')
  check("the deployed function is a handler", typeof realHandler === "function")
  check("limits are 3 per IP per hour and 2 per recipient per day", LIMITS.ip.max === 3 && LIMITS.ip.windowMs === 3_600_000 && LIMITS.recipient.max === 2 && LIMITS.recipient.windowMs === 86_400_000)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) console.log(failures.map((name) => ` - ${name}`).join("\n"))
process.exit(failures.length ? 1 : 0)
