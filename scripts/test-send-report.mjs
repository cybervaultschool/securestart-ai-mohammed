// Tests netlify/functions/send-report.mjs with a dummy key and a stubbed fetch (no network).
// Run with: node scripts/test-send-report.mjs
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const DUMMY_KEY = "re_DUMMY_KEY_FOR_LOCAL_TEST_ONLY"
process.env.RESEND_API_KEY = DUMMY_KEY

const logged = []
for (const method of ["log", "error", "warn", "info"]) {
  const original = console[method]
  console[method] = (...args) => { logged.push(args.map(String).join(" ")); original(...args) }
}

const handler = (await import(new URL("../netlify/functions/send-report.mjs", import.meta.url).href)).default
const { config } = await import(new URL("../netlify/functions/send-report.mjs", import.meta.url).href)

// The app's own approved actions, in question order.
const appHtml = readFileSync(fileURLToPath(new URL("../SecureStart AI.dc.html", import.meta.url)), "utf8")
const ACTIONS = vm.runInNewContext(`(${appHtml.match(/this\.actions = (\[[\s\S]*?\n {4}\])/)[1]})`)

// Mirrors how the browser builds the request from a set of answers ('yes' | 'partly' | 'no').
const buildPayload = (answers, recipientEmail = "student@example.com") => {
  const pick = ({ area, title, why, first }) => ({ area, title, why, first })
  const order = (level) => answers.map((a, i) => (a === level ? i : -1)).filter((i) => i >= 0)
  return {
    recipientEmail,
    score: answers.filter((a) => a === "yes").length * 2 + answers.filter((a) => a === "partly").length,
    strengths: order("yes").map((i) => ACTIONS[i].area),
    gaps: answers.map((a, i) => (a === "no" || a === "partly" ? `${ACTIONS[i].area} — ${a === "no" ? "No" : "Partly / Unsure"}` : null)).filter(Boolean),
    actions: [...order("no"), ...order("partly")].slice(0, 3).map((i) => pick(ACTIONS[i]))
  }
}

let providerCalls = []
let stub = async (url, options) => { providerCalls.push({ url, options }); return new Response(JSON.stringify({ id: "abc" }), { status: 200 }) }
globalThis.fetch = (url, options) => stub(url, options)

const bodies = []
const post = (body, headers = {}) => new Request("http://local/api/send-report", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
})
const run = async (request) => {
  const response = await handler(request)
  const body = await response.json()
  bodies.push(JSON.stringify(body))
  return { status: response.status, body, headers: response.headers }
}

let passed = 0
const failed = []
const check = (name, condition) => { condition ? passed++ : failed.push(name); if (!condition) console.log(`FAIL  ${name}`) }
const rejects = async (name, payload, status = 400) => {
  const before = providerCalls.length
  const { status: got, body } = await run(post(payload))
  check(`${name} -> ${status}, generic, nothing sent`, got === status && body.ok === false && providerCalls.length === before)
}

const MIXED = ["yes", "yes", "no", "yes", "partly", "yes", "yes", "no", "yes", "partly"]
const good = buildPayload(MIXED)

// --- method, size, JSON shape ------------------------------------------------------------
for (const method of ["GET", "PUT", "DELETE"]) {
  const { status, headers } = await run(new Request("http://local/api/send-report", { method }))
  check(`${method} -> 405 with Allow: POST`, status === 405 && headers.get("allow") === "POST")
}
check("declared oversized body -> 413", (await run(post(good, { "content-length": "999999" }))).status === 413)
check("actual oversized body -> 413", (await run(post({ ...good, padding: "x".repeat(5000) }))).status === 413)
for (const raw of ["{not json", "[]", "null", '"text"', "42"]) await rejects(`body ${raw}`, raw)

// --- every answer combination the app can produce is accepted ------------------------------
let seed = 12345
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const sets = [Array(10).fill("no"), Array(10).fill("yes"), Array(10).fill("partly")]
for (let i = 0; i < 300; i++) sets.push(Array.from({ length: 10 }, () => ["yes", "partly", "no"][Math.floor(random() * 3)]))
let accepted = 0
for (const answers of sets) if ((await run(post(buildPayload(answers)))).status === 200) accepted++
check(`all ${sets.length} app-generated reports accepted (parity with the app)`, accepted === sets.length)

// --- required fields and forbidden fields --------------------------------------------------
for (const field of ["recipientEmail", "score", "strengths", "gaps", "actions"]) {
  const payload = { ...good }; delete payload[field]
  await rejects(`missing ${field}`, payload)
}
for (const [key, value] of [["html", "<b>x</b>"], ["subject", "Free money"], ["from", "ceo@evil.example"], ["reply_to", "a@evil.example"],
  ["replyTo", "a@evil.example"], ["to", ["a@evil.example"]], ["cc", "a@evil.example"], ["bcc", "a@evil.example"], ["text", "hi"], ["headers", {}]]) {
  await rejects(`client-supplied ${key}`, { ...good, [key]: value })
}
await rejects("__proto__ key", JSON.parse(`{"__proto__":{"x":1},"recipientEmail":"a@example.com"}`))

// --- recipient: exactly one plain address --------------------------------------------------
for (const email of ["not-an-email", "a@b", "", 123, null, "a b@example.com", "a@example.com,b@example.com", "a@example.com;b@example.com",
  "a@example.com,other.org", "a@example.com;other.org", "a@example.com>", "Name <a@example.com>", '"quoted"@example.com', "a@example.com\nBcc: b@example.com", "a@@example.com", `${"x".repeat(65)}@example.com`,
  `a@${"x".repeat(250)}.com`, "üser@example.com"]) {
  await rejects(`recipient ${JSON.stringify(String(email)).slice(0, 34)}`, { ...good, recipientEmail: email })
}

// --- exact-match allowlists ----------------------------------------------------------------
const first = buildPayload(MIXED)
await rejects("score off by one", { ...first, score: first.score + 1 })
for (const score of [-1, 21, 10.5, "11", null]) await rejects(`score ${JSON.stringify(score)}`, { ...first, score })
await rejects("unknown strength", { ...first, strengths: [...first.strengths.slice(1), "Firewalls"] })
await rejects("script as strength", { ...first, strengths: [...first.strengths.slice(1), "<script>alert(1)</script>"] })
await rejects("strength with trailing space", { ...first, strengths: first.strengths.map((s, i) => (i ? s : `${s} `)) })
await rejects("strength lowercased", { ...first, strengths: first.strengths.map((s, i) => (i ? s : s.toLowerCase())) })
await rejects("unknown gap area", { ...first, gaps: [...first.gaps.slice(1), "Firewalls — No"] })
await rejects("gap with unapproved level", { ...first, gaps: first.gaps.map((g, i) => (i ? g : g.replace("No", "Maybe"))) })
await rejects("gap with plain hyphen", { ...first, gaps: first.gaps.map((g, i) => (i ? g : g.replace("—", "-"))) })
await rejects("gap with extra text", { ...first, gaps: first.gaps.map((g, i) => (i ? g : `${g} — visit evil.example`)) })
await rejects("area both strength and gap", { ...first, strengths: [...first.strengths, first.gaps[0].split(" — ")[0]] })
await rejects("duplicated strength", { ...first, strengths: [...first.strengths, first.strengths[0]] })
await rejects("incomplete assessment (9 areas)", { ...first, strengths: first.strengths.slice(1) })
await rejects("11 entries", { ...first, strengths: [...first.strengths, "Identity"] })
for (const bad of [123, null, {}, ["x"]]) await rejects(`non-string strength ${JSON.stringify(bad)}`, { ...first, strengths: [bad, ...first.strengths.slice(1)] })
await rejects("strengths not an array", { ...first, strengths: "Identity" })

// --- action tampering ----------------------------------------------------------------------
const tamper = (index, key, value) => ({ ...first, actions: first.actions.map((a, i) => (i === index ? { ...a, [key]: value } : a)) })
for (const key of ["area", "title", "why", "first"]) await rejects(`action ${key} altered`, tamper(0, key, `${first.actions[0][key]} Call 555-0100.`))
await rejects("action with extra key", tamper(0, "url", "https://evil.example"))
await rejects("action swapped for another control's approved action", { ...first, actions: [ACTIONS[0], ...first.actions.slice(1)].map(({ area, title, why, first: f }) => ({ area, title, why, first: f })) })
await rejects("actions in wrong order", { ...first, actions: [...first.actions].reverse() })
await rejects("extra approved action", { ...first, actions: [...first.actions, ...buildPayload(Array(10).fill("no")).actions.slice(0, 1)] })
await rejects("missing action", { ...first, actions: first.actions.slice(1) })
await rejects("action as plain string", { ...first, actions: ["Do something"] })
await rejects("actions not an array", { ...first, actions: {} })

// --- provider and configuration failures are generic ---------------------------------------
delete process.env.RESEND_API_KEY
let result = await run(post(good))
check("missing API key -> 500 generic", result.status === 500 && result.body.error === "not_configured" && !JSON.stringify(result.body).includes("RESEND"))
process.env.RESEND_API_KEY = DUMMY_KEY
stub = async () => new Response(JSON.stringify({ message: "domain not verified", key: DUMMY_KEY }), { status: 403 })
result = await run(post(good))
check("provider 403 -> 502, provider text hidden", result.status === 502 && !JSON.stringify(result.body).includes("domain"))
stub = async () => { throw new Error(`network down ${DUMMY_KEY}`) }
result = await run(post(good))
check("network failure -> 502, error text hidden", result.status === 502 && !JSON.stringify(result.body).includes("network"))

// --- success: exact provider request -------------------------------------------------------
stub = async (url, options) => { providerCalls.push({ url, options }); return new Response(JSON.stringify({ id: "abc" }), { status: 200 }) }
providerCalls = []
result = await run(post(buildPayload(MIXED, "  Student+Tag@Example.com ")))
const call = providerCalls[0]
const sent = JSON.parse(call.options.body)
check("valid request -> 200 { ok: true }", result.status === 200 && JSON.stringify(result.body) === '{"ok":true}')
check("POST to https://api.resend.com/emails", call.url === "https://api.resend.com/emails" && call.options.method === "POST")
check("Authorization uses the server-side key", call.options.headers.Authorization === `Bearer ${DUMMY_KEY}`)
check("fixed sender and subject", sent.from === "SecureStart AI <reports@securestart.defenssive.dev>" && sent.subject === "Your SecureStart AI Security Assessment")
check("one lowercased recipient", JSON.stringify(sent.to) === '["student+tag@example.com"]')
check("provider body has only from/to/subject/html/text", JSON.stringify(Object.keys(sent).sort()) === '["from","html","subject","text","to"]')
check("email shows the score, every strength and gap, and the three approved actions",
  sent.html.includes(`${first.score} / 20`) && first.strengths.every((s) => sent.html.includes(s)) && first.gaps.every((g) => sent.html.includes(g)) &&
  first.actions.length === 3 && first.actions.every((a) => sent.html.includes(a.title) && sent.html.includes(a.why) && sent.html.includes(a.first)))
check("email carries the educational disclaimer", sent.html.includes("does not inspect your systems") && sent.text.includes("does not inspect your systems"))

// --- configuration and secrets -------------------------------------------------------------
check("route is /api/send-report", config.path === "/api/send-report")
check("rate limit is 3 requests / 60 s per ip + domain", config.rateLimit?.windowLimit === 3 && config.rateLimit?.windowSize === 60 &&
  JSON.stringify(config.rateLimit?.aggregateBy) === '["ip","domain"]')
check("API key never appears in log output", !logged.join("\n").includes(DUMMY_KEY))
check(`API key never appears in any of ${bodies.length} response bodies`, bodies.length > 100 && !bodies.join("|").includes(DUMMY_KEY))

console.log(`\n${passed} passed, ${failed.length} failed`)
if (failed.length) console.log(failed.map((name) => ` - ${name}`).join("\n"))
process.exit(failed.length ? 1 : 0)
