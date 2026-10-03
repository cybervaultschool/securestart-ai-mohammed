// Tests netlify/functions/ai-guidance.mjs against a MOCKED Claude API. No network, no real key.
// Run with: node scripts/test-ai-guidance.mjs
import { mock } from "node:test"
import { NOT_SURE_FIRST_STEP, QUESTIONS } from "../site/assessment.js"

const DUMMY_KEY = "test-anthropic-key-NOT-REAL-0000"
const ENV_DEFAULTS = { AI_ADVISOR_ENABLED: "true", ANTHROPIC_API_KEY: DUMMY_KEY, CLAUDE_MODEL: "claude-sonnet-5-5" }
const setEnv = (overrides = {}) => {
  for (const key of Object.keys(ENV_DEFAULTS)) delete process.env[key]
  for (const [key, value] of Object.entries({ ...ENV_DEFAULTS, ...overrides })) if (value !== undefined) process.env[key] = value
}
setEnv()

const logged = []
for (const method of ["log", "error", "warn", "info"]) {
  const original = console[method]
  console[method] = (...args) => { logged.push(args.map(String).join(" ")); original(...args) }
}

const moduleUrl = new URL("../netlify/functions/ai-guidance.mjs", import.meta.url).href
const { default: handler, config } = await import(moduleUrl)

// Independent reference. The approved wording comes from the shared module's data; the scoring,
// risk ordering and fact-building below are written separately from site/assessment.js on purpose.
const IDS = QUESTIONS.map((q) => q.id)
const TEXT = Object.fromEntries(QUESTIONS.map((q) => [q.id, { area: q.area, title: q.action.title, why: q.action.why, first: q.action.first, topic: q.topic }]))
const RISK = ["mfa", "admin-mfa", "remote-access", "backups", "admin-accounts", "updates", "endpoint", "passwords", "leavers", "sharing", "encryption", "awareness", "incident-plan"]
const reference = (answers, audience) => {
  const levelOf = Object.fromEntries(IDS.map((id, i) => [id, answers[i]]))
  const score = answers.reduce((sum, a) => sum + (a === "yes" ? 2 : a === "partly" ? 1 : 0), 0)
  const picked = []
  for (const level of ["no", "unsure", "partly"]) for (const id of RISK) if (levelOf[id] === level) picked.push([id, level])
  return {
    audience, score, maxScore: 26,
    strengthIds: IDS.filter((id) => levelOf[id] === "yes"),
    gapIds: IDS.filter((id) => levelOf[id] !== "yes"),
    actions: picked.slice(0, 3).map(([id, level]) => ({
      controlId: id, area: TEXT[id].area,
      title: level === "unsure" ? "Find out: " + TEXT[id].topic : TEXT[id].title,
      why: TEXT[id].why, first: level === "unsure" ? NOT_SURE_FIRST_STEP : TEXT[id].first, answer: level
    }))
  }
}

// --- mocked Claude API ----------------------------------------------------------------------
let provider = { mode: "ok" }
let calls = []
let lastProviderText = null
const wellBehaved = (facts) => ({
  summary: `You scored ${facts.score} out of ${facts.maxScore}, which shows where to focus first.`,
  positiveFinding: facts.strengthIds.length ? "Some basic practices are already in place." : "",
  priorities: facts.actions.map((a) => ({ controlId: a.controlId, explanation: `This matters for your business (${a.controlId}) because it limits the damage from a common problem.` })),
  limitations: "This is educational guidance based only on your answers and does not inspect any systems, so review it with an appropriate IT or security professional."
})
const useProvider = (next = {}) => { provider = { mode: "ok", ...next }; calls = [] }

globalThis.fetch = async (url, init) => {
  const facts = JSON.parse(JSON.parse(init.body).messages[0].content)
  calls.push({ url, init, facts })
  if (provider.mode === "hang") {
    provider.started = true
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  }
  if (provider.mode === "throw") throw new Error(`boom ${DUMMY_KEY}`)
  if (provider.mode === "status") return new Response(`stack trace SECRET_PROVIDER_TEXT ${DUMMY_KEY}`, { status: provider.status })
  if (provider.mode === "notjson") return new Response("<html>gateway</html>", { status: 200 })
  const output = provider.mode === "custom" ? provider.custom(wellBehaved(facts), facts) : wellBehaved(facts)
  const text = typeof output === "string" ? output : JSON.stringify(output)
  lastProviderText = text
  const body = provider.envelope ? provider.envelope(text) : {
    id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5",
    content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

// --- helpers ---------------------------------------------------------------------------------
const bodies = []
// If the handler ever throws, report it as status 599 so the affected checks fail cleanly
// instead of terminating the whole test run.
const send = async (raw, headers = {}, query = "", method = "POST") => {
  try {
    return await handler(new Request(`http://local/api/ai-guidance${query}`, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : raw }))
  } catch {
    return new Response("THREW", { status: 599 })
  }
}
const ask = async (body, headers, query) => {
  const response = await send(typeof body === "string" ? body : JSON.stringify(body), headers, query)
  const text = await response.text()
  bodies.push(text)
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json, text, headers: response.headers }
}

let passed = 0
const failed = []
const check = (name, condition) => { condition ? passed++ : failed.push(name); if (!condition) console.log(`FAIL  ${name}`) }

const UNAVAILABLE = { ok: false, error: "unavailable", message: "AI Advisor is unavailable right now. Your score and actions are not affected." }
// mfa yes, admin-mfa unsure, admin-accounts yes, passwords partly, backups no, updates yes, endpoint no,
// encryption yes, awareness yes, incident-plan partly, remote-access yes, leavers yes, sharing yes
const MIXED = ["yes", "unsure", "yes", "partly", "no", "yes", "no", "yes", "yes", "partly", "yes", "yes", "yes"]
const idLevels = (map) => IDS.map((id) => map[id] ?? "yes")
const good = { answers: MIXED, audience: "business-owner" }
const isUnavailable = (r) => r.status === 503 && JSON.stringify(r.json) === JSON.stringify(UNAVAILABLE)

const rejects = async (name, body, status = 400, options = {}) => {
  useProvider()
  const r = await ask(body, options.headers)
  check(`${name} -> ${status}, no Claude call`, r.status === status && r.json?.ok === false && calls.length === 0)
}
// Every malformed provider output must be refused by the intended validator (which logs "failed validation"),
// not by the catch-all (which logs "unexpected internal error"), so a validator bug cannot hide behind it.
const refusedByValidator = (since) => {
  const lines = logged.slice(since).join("\n")
  return lines.includes("provider output failed validation") && !lines.includes("unexpected internal error")
}
const outputFails = async (name, custom, extra = {}) => {
  useProvider({ mode: "custom", custom, ...extra })
  const since = logged.length
  const r = await ask(good)
  check(`bad model output (${name}) -> generic 503 via the validator`, isUnavailable(r) && calls.length === 1 && refusedByValidator(since))
}

// --- method -----------------------------------------------------------------------------------
for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
  useProvider()
  const response = await send(JSON.stringify(good), {}, "", method === "GET" ? "GET" : method)
  check(`${method} -> 405 with Allow: POST`, response.status === 405 && response.headers.get("allow") === "POST" && calls.length === 0)
}

// --- fail closed: configuration ------------------------------------------------------------------
for (const value of [undefined, "", "false", "TRUE", "True", "1", " true", "yes"]) {
  setEnv({ AI_ADVISOR_ENABLED: value }); useProvider()
  const r = await ask(good)
  check(`AI_ADVISOR_ENABLED=${JSON.stringify(value)} -> generic 503, no Claude call`, isUnavailable(r) && calls.length === 0)
}
setEnv({ ANTHROPIC_API_KEY: undefined }); useProvider()
check("missing ANTHROPIC_API_KEY -> generic 503", isUnavailable(await ask(good)) && calls.length === 0)
setEnv({ CLAUDE_MODEL: undefined }); useProvider()
check("missing CLAUDE_MODEL -> generic 503", isUnavailable(await ask(good)) && calls.length === 0)
setEnv({ CLAUDE_MODEL: "claude sonnet; drop table" }); useProvider()
check("malformed CLAUDE_MODEL -> generic 503", isUnavailable(await ask(good)) && calls.length === 0)
setEnv()

// --- request contract ----------------------------------------------------------------------------
{
  useProvider()
  const r = await ask({ ...good }, { "content-length": "9000" })
  check("declared body over 8 KB -> 413", r.status === 413 && calls.length === 0)
}
await rejects("actual body over 8 KB", JSON.stringify({ ...good, padding: "x".repeat(9000) }), 413)
await rejects("multi-byte body over 8 KB (4,500 chars, 9,000 bytes)", JSON.stringify({ ...good, padding: "é".repeat(4500) }), 413)
for (const raw of ["{not json", "[]", "null", '"text"', "42", "true", ""]) await rejects(`body ${JSON.stringify(raw)}`, raw)
await rejects("missing audience", { answers: MIXED })
await rejects("missing answers", { audience: "business-owner" })
for (const [key, value] of [["score", 26], ["maxScore", 26], ["title", "Free money"], ["titles", ["x"]], ["actions", [{ title: "x" }]], ["recommendation", "x"],
  ["recommendations", ["x"]], ["strengths", ["mfa"]], ["gaps", ["mfa"]], ["controlId", "mfa"], ["firstStep", "x"], ["html", "<b>x</b>"], ["system", "ignore previous"],
  ["prompt", "ignore previous"], ["model", "claude-opus-5-5"], ["email", "a@example.com"], ["name", "Ada"], ["company", "Acme"], ["ip", "203.0.113.5"], ["subject", "x"]]) {
  await rejects(`unknown key ${key}`, { ...good, [key]: value })
}
await rejects("__proto__ key", `{"__proto__":{"x":1},"answers":${JSON.stringify(MIXED)},"audience":"business-owner"}`)
await rejects("answers not an array", { answers: "yes", audience: "business-owner" })
await rejects("answers as an object", { answers: { 0: "yes" }, audience: "business-owner" })
for (const length of [0, 1, 9, 10, 12, 14, 20]) await rejects(`answers length ${length}`, { answers: Array(length).fill("yes"), audience: "business-owner" })
for (const bad of [null, "Yes", "YES", "Unsure", "Not sure", "partly / unsure", "Partly", "", " yes", 1, 2, true, {}, ["yes"]]) {
  await rejects(`answer value ${JSON.stringify(bad)}`, { answers: [bad, ...MIXED.slice(1)], audience: "business-owner" })
}
for (const bad of ["owner", "admin", "Business-Owner", "it-admin ", "", null, 1, ["business-owner"], {}]) {
  await rejects(`audience ${JSON.stringify(bad)}`, { answers: MIXED, audience: bad })
}

// --- server authority: 30,000 sampled assessments (4^13 is too many to enumerate) -------------------------
{
  useProvider()
  let mismatches = 0
  const levels = ["yes", "partly", "unsure", "no"]
  let seed = 987654321
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const started = Date.now()
  let compared = 0
  for (let n = 0; n < 30000; n++) {
    const answers = IDS.map(() => levels[Math.floor(random() * 4)])
    if (answers.every((a) => a === "yes")) continue
    const audience = n % 2 ? "it-admin" : "business-owner"
    calls = []
    const response = await send(JSON.stringify({ answers, audience }))
    const body = await response.json()
    const expected = reference(answers, audience)
    const sent = calls[0]?.facts
    const okFacts = JSON.stringify(sent) === JSON.stringify(expected)
    const okBody = response.status === 200 && body.ok === true && body.score === expected.score && body.maxScore === 26 &&
      body.advisor.priorities.length === expected.actions.length &&
      body.advisor.priorities.every((p, i) => p.controlId === expected.actions[i].controlId && p.title === expected.actions[i].title &&
        p.area === expected.actions[i].area && p.firstStep === expected.actions[i].first)
    compared++
    if (!okFacts || !okBody) mismatches++
  }
  check(compared + " sampled combinations: server score, strengths, gaps and 3 risk-ordered actions match the reference (" + Math.round((Date.now() - started) / 1000) + " s)", mismatches === 0 && compared > 29000)
}
{
  const none = IDS.map(() => "no")
  useProvider()
  const r1 = await ask({ answers: IDS.map(() => "yes"), audience: "it-admin" })
  check("all Yes -> 400 and no Claude call (nothing to explain)", r1.status === 400 && r1.json?.ok === false && calls.length === 0)
  const r2 = await ask({ answers: none, audience: "it-admin" })
  check("all No -> score 0 of 26, three priorities in risk order", r2.status === 200 && r2.json.score === 0 && r2.json.maxScore === 26 && r2.json.advisor.priorities.map((p) => p.controlId).join() === "mfa,admin-mfa,remote-access")
  const r3 = await ask({ answers: idLevels({ "admin-mfa": "unsure", sharing: "unsure" }), audience: "it-admin" })
  check("Not sure answers become 'Find out' actions with the fixed first step",
    r3.status === 200 && r3.json.advisor.priorities.length === 2 && r3.json.advisor.priorities[0].title === "Find out: MFA for administrators" &&
    r3.json.advisor.priorities.every((p) => p.firstStep === NOT_SURE_FIRST_STEP))
}

// --- what is sent to Claude --------------------------------------------------------------------
{
  useProvider()
  await ask(good); await ask({ answers: Array(13).fill("no"), audience: "it-admin" })
  const first = calls[0], second = calls[1]
  const sentBody = JSON.parse(first.init.body)
  check("calls https://api.anthropic.com/v1/messages with POST", first.url === "https://api.anthropic.com/v1/messages" && first.init.method === "POST")
  check("headers are only x-api-key, anthropic-version, content-type (no beta header)",
    JSON.stringify(Object.keys(first.init.headers).sort()) === '["anthropic-version","content-type","x-api-key"]' &&
    first.init.headers["anthropic-version"] === "2023-06-01" && first.init.headers["x-api-key"] === DUMMY_KEY)
  check("body has only model, max_tokens, system, messages, output_config",
    JSON.stringify(Object.keys(sentBody).sort()) === '["max_tokens","messages","model","output_config","system"]')
  check("no sampling, thinking, tool, stream or metadata parameters",
    !["temperature", "top_p", "top_k", "thinking", "tools", "tool_choice", "stream", "metadata"].some((key) => key in sentBody))
  check("model comes from CLAUDE_MODEL", sentBody.model === "claude-sonnet-5-5")
  check("low effort and a small output limit", JSON.stringify(sentBody.output_config) === '{"effort":"low"}' && Number.isInteger(sentBody.max_tokens) && sentBody.max_tokens > 0 && sentBody.max_tokens <= 2000)
  check("one user message holding only the server-built facts", sentBody.messages.length === 1 && sentBody.messages[0].role === "user" &&
    JSON.stringify(Object.keys(first.facts)) === '["audience","score","maxScore","strengthIds","gapIds","actions"]' &&
    first.facts.actions.every((a) => JSON.stringify(Object.keys(a)) === '["controlId","area","title","why","first","answer"]'))
  check("the facts equal the independent reference", JSON.stringify(first.facts) === JSON.stringify(reference(MIXED, "business-owner")))
  check("each action is the exact approved catalogue entry (controlId, area, title, why, first, answer)",
    first.facts.actions.every((a, i) => JSON.stringify(a) === JSON.stringify(reference(MIXED, "business-owner").actions[i])))
  check("system instruction is fixed on the server (identical for different assessments)", typeof sentBody.system === "string" && sentBody.system.length > 200 &&
    sentBody.system === JSON.parse(second.init.body).system)
  check("request carries an abort signal", first.init.signal instanceof AbortSignal)
  for (const audience of ["business-owner", "it-admin"]) {
    useProvider(); await ask({ answers: MIXED, audience })
    check(`audience ${audience} is forwarded`, calls[0].facts.audience === audience)
  }
}

// --- privacy: nothing personal or secret reaches the provider ------------------------------------
{
  useProvider(); logged.length = 0
  const canaries = ["203.0.113.77", "198.51.100.9", "CANARY_COOKIE", "CANARY_AUTH", "CANARY_UA", "CANARY_REF", "CANARY_NAME", "canary@example.com", "CANARY_CITY"]
  const r = await ask(good, {
    "x-forwarded-for": "203.0.113.77", "x-nf-client-connection-ip": "198.51.100.9", cookie: "session=CANARY_COOKIE",
    authorization: "Bearer CANARY_AUTH", "user-agent": "CANARY_UA", referer: "https://canary.example/CANARY_REF", "x-nf-geo": "CANARY_CITY"
  }, "?email=canary@example.com&name=CANARY_NAME")
  const everything = JSON.stringify({ url: calls[0].url, headers: calls[0].init.headers, body: calls[0].init.body })
  check("request with canary headers and query is accepted", r.status === 200)
  check("no canary (IP, cookie, auth, user agent, referer, name, email, location) reaches the provider request", canaries.every((c) => !everything.includes(c)))
  check("no IP address or email-like text in the provider request body", !/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(calls[0].init.body) && !calls[0].init.body.includes("@"))
  check("the API key appears only in the x-api-key header", calls[0].init.headers["x-api-key"] === DUMMY_KEY && !calls[0].init.body.includes(DUMMY_KEY) && !calls[0].url.includes(DUMMY_KEY))
  check("no canary or key in logs", ![...canaries, DUMMY_KEY].some((c) => logged.join("\n").includes(c)))

  // Everything that can appear in the facts belongs to the approved vocabulary.
  const allowed = new Set([...IDS, "business-owner", "it-admin", "no", "partly", "unsure", NOT_SURE_FIRST_STEP,
    ...Object.values(TEXT).flatMap((a) => [a.area, a.title, a.why, a.first, "Find out: " + a.topic])])
  const strings = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [])
  let stray = 0
  for (let n = 0; n < 400; n++) {
    useProvider()
    await ask({ answers: Array.from({ length: 13 }, (_, i) => ["yes", "partly", "unsure", "no"][(n * 7 + i * 3 + (n >> 3)) % 4]), audience: n % 2 ? "it-admin" : "business-owner" })
    if (!strings(calls[0].facts).every((s) => allowed.has(s))) stray++
  }
  check("400 varied assessments: every string sent to Claude is approved catalogue content", stray === 0)
}

// --- provider failures all give the same generic 503 ---------------------------------------------
for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 529]) {
  useProvider({ mode: "status", status }); logged.length = 0
  const r = await ask(good)
  check(`provider ${status} -> generic 503, no provider text, one call (no retry)`,
    isUnavailable(r) && calls.length === 1 && !r.text.includes("SECRET_PROVIDER_TEXT") && !logged.join("\n").includes("SECRET_PROVIDER_TEXT") && !logged.join("\n").includes(DUMMY_KEY))
}
useProvider({ mode: "throw" }); logged.length = 0
{ const r = await ask(good); check("network error -> generic 503, key not logged", isUnavailable(r) && calls.length === 1 && !logged.join("\n").includes(DUMMY_KEY) && !r.text.includes("boom")) }
useProvider({ mode: "notjson" })
check("provider 200 with a non-JSON body -> generic 503", isUnavailable(await ask(good)))
for (const stop of ["refusal", "max_tokens", "tool_use", "pause_turn"]) {
  useProvider({ mode: "custom", custom: (o) => o, envelope: (text) => ({ content: [{ type: "text", text }], stop_reason: stop, stop_details: { type: "refusal", category: "cyber" } }) })
  check(`stop_reason ${stop} -> generic 503`, isUnavailable(await ask(good)))
}
useProvider({ mode: "custom", custom: (o) => o, envelope: () => ({ content: "not an array", stop_reason: "end_turn" }) })
check("content that is not an array -> generic 503", isUnavailable(await ask(good)))
useProvider({ mode: "custom", custom: (o) => o, envelope: () => ({ content: [{ type: "thinking", thinking: "" }], stop_reason: "end_turn" }) })
check("only a thinking block, no text -> generic 503", isUnavailable(await ask(good)))

// --- application-level timeout (latency and cost control): aborts at 8.5 s, never retries -----------------
{
  useProvider({ mode: "hang" }); logged.length = 0
  mock.timers.enable({ apis: ["setTimeout"] })
  let settled = false
  const pending = ask(good).then((r) => { settled = true; return r })
  while (!provider.started) await new Promise((resolve) => setImmediate(resolve))
  mock.timers.tick(8499); await new Promise((resolve) => setImmediate(resolve))
  const earlyAbort = settled
  mock.timers.tick(1)
  const flush = async () => { for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve)); return "stuck" }
  let r = await Promise.race([pending, flush()])
  const abortedOnTime = r !== "stuck"
  if (!abortedOnTime) { mock.timers.tick(600000); r = await pending }
  mock.timers.reset()
  check("application timeout: request still running at 8,499 ms", earlyAbort === false)
  check("application timeout: aborted at 8,500 ms -> generic 503, one call, no retry", abortedOnTime && isUnavailable(r) && calls.length === 1)
  check("timeout is logged by category only", logged.join("\n").includes("timed out") && !logged.join("\n").includes(DUMMY_KEY))
}

// --- model output must pass strict validation ----------------------------------------------------------
await outputFails("not JSON", () => "Sure! Here is your summary.")
await outputFails("wrapped in a code fence", (o) => "```json\n" + JSON.stringify(o) + "\n```")
await outputFails("JSON array", () => "[]")
await outputFails("JSON null", () => "null")
await outputFails("missing summary", (o) => { delete o.summary; return o })
await outputFails("missing limitations", (o) => { delete o.limitations; return o })
for (const [key, value] of [["score", 5], ["severity", "critical"], ["complianceStatus", "compliant"], ["title", "Require MFA"], ["area", "Identity"], ["firstStep", "Do something else"], ["extra", "x"]]) {
  await outputFails(`unexpected top-level field ${key}`, (o) => ({ ...o, [key]: value }))
}
// A provider priority may hold only controlId and explanation. Even the exact approved wording is refused,
// because the server, not the provider, owns title, area and first step.
for (const [key, fromFacts] of [["title", (a) => a.title], ["area", (a) => a.area], ["firstStep", (a) => a.first]]) {
  await outputFails(`priority returns ${key} (the exact approved value)`, (o, facts) => ({ ...o, priorities: o.priorities.map((p, i) => ({ ...p, [key]: fromFacts(facts.actions[i]) })) }))
  await outputFails(`priority returns ${key} (a rewritten value)`, (o) => ({ ...o, priorities: o.priorities.map((p) => ({ ...p, [key]: "Something else entirely" })) }))
  await outputFails(`only the first priority returns ${key}`, (o, facts) => ({ ...o, priorities: o.priorities.map((p, i) => (i ? p : { ...p, [key]: fromFacts(facts.actions[0]) })) }))
}
for (const [key, value] of [["score", 5], ["severity", "critical"], ["complianceStatus", "compliant"], ["compliance", "non-compliant"], ["extra", "x"]]) {
  await outputFails(`priority returns ${key}`, (o) => ({ ...o, priorities: o.priorities.map((p) => ({ ...p, [key]: value })) }))
}
await outputFails("priority missing explanation", (o) => ({ ...o, priorities: o.priorities.map(({ explanation, ...rest }) => rest) }))
await outputFails("priority missing controlId", (o) => ({ ...o, priorities: o.priorities.map(({ controlId, ...rest }) => rest) }))
await outputFails("changed control ID", (o) => ({ ...o, priorities: o.priorities.map((p, i) => (i ? p : { ...p, controlId: "firewall" })) }))
await outputFails("control ID swapped to another approved control", (o) => ({ ...o, priorities: o.priorities.map((p, i) => (i ? p : { ...p, controlId: "mfa" })) }))
await outputFails("control ID with different case", (o) => ({ ...o, priorities: o.priorities.map((p, i) => (i ? p : { ...p, controlId: p.controlId.toUpperCase() })) }))
await outputFails("reordered priorities", (o) => ({ ...o, priorities: [...o.priorities].reverse() }))
await outputFails("extra priority", (o) => ({ ...o, priorities: [...o.priorities, o.priorities[0]] }))
await outputFails("missing priority", (o) => ({ ...o, priorities: o.priorities.slice(1) }))
await outputFails("no priorities", (o) => ({ ...o, priorities: [] }))
await outputFails("priorities not an array", (o) => ({ ...o, priorities: "none" }))
await outputFails("priority is a string", (o) => ({ ...o, priorities: o.priorities.map((p) => p.controlId) }))
await outputFails("field of the wrong type", (o) => ({ ...o, summary: 42 }))
await outputFails("empty summary", (o) => ({ ...o, summary: "   " }))
await outputFails("summary too long", (o) => ({ ...o, summary: "x".repeat(401) }))
await outputFails("explanation too long", (o) => ({ ...o, priorities: o.priorities.map((p, i) => (i ? p : { ...p, explanation: "x".repeat(351) })) }))
await outputFails("limitations too long", (o) => ({ ...o, limitations: "x".repeat(301) }))
await outputFails("positiveFinding too long", (o) => ({ ...o, positiveFinding: "x".repeat(301) }))
await outputFails("empty positiveFinding although strengths exist", (o) => ({ ...o, positiveFinding: "" }))
for (const [name, text] of [["bold tag", "<b>Act now</b>"], ["script tag", "<script>alert(1)</script>"], ["img tag", "<img src=x onerror=alert(1)>"],
  ["lone angle bracket", "a < b"], ["markdown link", "[click](https://evil.example)"], ["bare https link", "see https://evil.example/x"],
  ["www link", "visit www.evil.example"], ["domain-like text", "go to evil.com now"], ["mailto link", "mailto:a@evil.example"], ["control character", "bad\u0000text"]]) {
  await outputFails(`${name} in explanation`, (o) => ({ ...o, priorities: o.priorities.map((p, i) => (i ? p : { ...p, explanation: text })) }))
}
await outputFails("HTML in summary", (o) => ({ ...o, summary: "<h1>Hi</h1>" }))
await outputFails("link in limitations", (o) => ({ ...o, limitations: "Read more at https://evil.example" }))
{
  useProvider({ mode: "custom", custom: (o) => ({ ...o, positiveFinding: "Great job on everything." }) })
  const r = await ask({ answers: Array(13).fill("no"), audience: "business-owner" })
  check("invented praise when there are no strengths -> generic 503", isUnavailable(r))
}

// --- the priority count is decided by the deterministic server, never by the provider -------------------------
{
  const gapsOf = (...positions) => Array.from({ length: 13 }, (_, i) => (positions.includes(i) ? "no" : "yes"))
  const scenarios = [
    ["five gaps (three actions, the rest cut off)", ["no", "yes", "partly", "no", "unsure", "yes", "yes", "yes", "yes", "partly", "yes", "yes", "yes"], 3],
    ["three gaps", gapsOf(0, 3, 8), 3],
    ["two gaps (one No, one Not sure)", ["yes", "yes", "yes", "yes", "yes", "yes", "no", "yes", "yes", "yes", "yes", "yes", "unsure"], 2],
    ["one gap", gapsOf(8), 1]
  ]
  for (const [name, answers, count] of scenarios) {
    const expectedIds = reference(answers, "it-admin").actions.map((a) => a.controlId)
    useProvider()
    const ok = await ask({ answers, audience: "it-admin" })
    check(`${name}: exactly ${count} priorities, same control IDs in the same order as the server selected`,
      ok.status === 200 && ok.json.advisor.priorities.length === count && ok.json.advisor.priorities.map((p) => p.controlId).join() === expectedIds.join() && expectedIds.length === count)

    const bad = async (label, change) => {
      useProvider({ mode: "custom", custom: change })
      const since = logged.length
      const r = await ask({ answers, audience: "it-admin" })
      check(`${name}: provider ${label} -> generic 503 via the validator`, isUnavailable(r) && calls.length === 1 && refusedByValidator(since))
    }
    const unselected = (facts) => IDS.find((id) => !facts.actions.some((a) => a.controlId === id))
    await bad("adds an entry", (o, facts) => ({ ...o, priorities: [...o.priorities, { controlId: unselected(facts), explanation: "An extra entry." }] }))
    await bad("adds a repeated entry", (o) => ({ ...o, priorities: [...o.priorities, { controlId: o.priorities[0]?.controlId ?? "mfa", explanation: "A repeat." }] }))
    if (count > 0) {
      await bad("drops an entry", (o) => ({ ...o, priorities: o.priorities.slice(0, -1) }))
      await bad("replaces an entry with an unselected control", (o, facts) => ({ ...o, priorities: o.priorities.map((p, i) => (i ? p : { ...p, controlId: unselected(facts) })) }))
    }
    if (count > 1) {
      await bad("duplicates an entry in place of another", (o) => ({ ...o, priorities: [...o.priorities.slice(0, -1), o.priorities[0]] }))
      await bad("reorders the entries", (o) => ({ ...o, priorities: [...o.priorities].reverse() }))
    }
  }
}

// --- success path ----------------------------------------------------------------------------------------
{
  useProvider()
  const r = await ask(good)
  const expected = reference(MIXED, "business-owner")
  const providerOutput = JSON.parse(lastProviderText)
  check("what the provider returns: exactly summary, positiveFinding, priorities, limitations",
    JSON.stringify(Object.keys(providerOutput)) === '["summary","positiveFinding","priorities","limitations"]')
  check("what the provider returns: each priority holds only controlId and explanation",
    providerOutput.priorities.length === 3 && providerOutput.priorities.every((p) => JSON.stringify(Object.keys(p)) === '["controlId","explanation"]'))
  check("the fixed system instruction tells Claude to return only controlId and explanation, and no titles, areas, first steps, scores, severity or compliance",
    typeof JSON.parse(calls[0].init.body).system === "string" &&
    JSON.parse(calls[0].init.body).system.includes("exactly two keys: controlId") &&
    JSON.parse(calls[0].init.body).system.includes("Do not return titles, areas, first steps, scores, severity or compliance statements") &&
    !JSON.parse(calls[0].init.body).system.includes("title copied exactly"))
  check("the server attaches title, area and firstStep from the approved catalogue after validation, and keeps the provider's explanation",
    r.json.advisor.priorities.every((p, i) => p.title === expected.actions[i].title && p.area === expected.actions[i].area &&
      p.firstStep === expected.actions[i].first && p.explanation === providerOutput.priorities[i].explanation))
  check("valid request -> 200 with exactly ok, aiGenerated, score, maxScore, advisor",
    r.status === 200 && JSON.stringify(Object.keys(r.json).sort()) === '["advisor","aiGenerated","maxScore","ok","score"]' && r.json.ok === true && r.json.aiGenerated === true)
  check("score is the server-calculated score out of 26", r.json.score === expected.score && r.json.maxScore === 26)
  check("advisor has exactly summary, positiveFinding, priorities, limitations", JSON.stringify(Object.keys(r.json.advisor)) === '["summary","positiveFinding","priorities","limitations"]')
  check("browser response: each priority has exactly controlId, title, area, explanation, firstStep, with server-approved wording",
    r.json.advisor.priorities.length === 3 && r.json.advisor.priorities.every((p, i) =>
      JSON.stringify(Object.keys(p)) === '["controlId","title","area","explanation","firstStep"]' && p.controlId === expected.actions[i].controlId &&
      p.title === expected.actions[i].title && p.area === expected.actions[i].area && p.firstStep === expected.actions[i].first))
  check("response is JSON, uncached", r.headers.get("content-type")?.includes("application/json") && r.headers.get("cache-control") === "no-store")
  check("exactly one Claude call", calls.length === 1)
}
{
  useProvider({ mode: "custom", custom: (o) => o, envelope: (text) => ({
    content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "redacted_thinking", data: "x" }, { type: "text", text: text.slice(0, 40) }, { type: "text", text: text.slice(40) }],
    stop_reason: "end_turn" }) })
  const r = await ask(good)
  check("thinking blocks before the text are ignored; text blocks are joined", r.status === 200 && r.json.ok === true)
}
{
  useProvider({ mode: "custom", custom: (o) => ({ ...o, summary: "  Spaced \n out \t text.  " }) })
  const r = await ask(good)
  check("whitespace in model text is normalised, not rejected", r.status === 200 && r.json.advisor.summary === "Spaced out text.")
}

// --- unexpected internal exceptions: the same generic 503, nothing leaked, no retry --------------------------
const SECRET_DETAIL = "SECRET_INTERNAL_DETAIL_7731"
const PROVIDER_SECRET = "PROVIDER_BODY_SECRET_5520"
const NEVER_EXPOSED = [SECRET_DETAIL, PROVIDER_SECRET, DUMMY_KEY, JSON.stringify(MIXED), "claude-sonnet-5-5", "stack", "TypeError"]
const catchAllCase = async (name, { trigger, provider: providerOptions, expectedProviderCalls }) => {
  useProvider(providerOptions)
  const since = logged.length
  const outcome = await trigger()
  const lines = logged.slice(since).join("\n")
  check(`${name}: generic 503 unavailable contract`, outcome.threw === false && isUnavailable(outcome))
  check(`${name}: no exception message, stack, answers, provider text, key or environment value in the response`, NEVER_EXPOSED.every((value) => !outcome.text.includes(value)))
  check(`${name}: the log records only the generic category, with no sensitive value`,
    lines.includes("ai-guidance: unexpected internal error") && NEVER_EXPOSED.every((value) => !lines.includes(value)))
  check(`${name}: ${expectedProviderCalls} provider call(s), so no retry`, calls.length === expectedProviderCalls)
}
const viaHandler = async (...args) => {
  try {
    const response = await handler(...args)
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { threw: false, status: response.status, json, text }
  } catch {
    return { threw: true, status: 0, json: null, text: "" }
  }
}

// A: the very first property access on the request throws.
await catchAllCase("exception at the handler boundary", {
  expectedProviderCalls: 0,
  trigger: () => viaHandler(new Proxy({}, { get() { throw new Error(`${SECRET_DETAIL} ${DUMMY_KEY}`) } }))
})

// B: after the body, which contains the answers, has been read and before any provider call.
{
  const RealTextEncoder = globalThis.TextEncoder
  globalThis.TextEncoder = class { encode() { throw new TypeError(`${SECRET_DETAIL} ${JSON.stringify(MIXED)} ${DUMMY_KEY}`) } }
  try {
    await catchAllCase("exception while holding the assessment answers", {
      expectedProviderCalls: 0,
      trigger: () => viaHandler(new Request("http://local/api/ai-guidance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good) }))
    })
  } finally {
    globalThis.TextEncoder = RealTextEncoder
  }
}

// C: after the provider has already answered with text that must never be echoed.
{
  const realHasOwn = Object.hasOwn
  Object.hasOwn = (object, key) => {
    if (key === "summary") throw new Error(`${SECRET_DETAIL} ${PROVIDER_SECRET} ${DUMMY_KEY}`)
    return realHasOwn(object, key)
  }
  try {
    await catchAllCase("exception after the provider answered", {
      expectedProviderCalls: 1,
      provider: { mode: "custom", custom: (o) => ({ ...o, summary: `Summary ${PROVIDER_SECRET}` }) },
      trigger: () => viaHandler(new Request("http://local/api/ai-guidance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good) }))
    })
  } finally {
    Object.hasOwn = realHasOwn
  }
}

// Intentional request errors are still returned as themselves, not as the generic 503.
{
  useProvider()
  const invalidBody = await ask({ answers: MIXED })
  const oversized = await ask({ ...good, padding: "x".repeat(9000) })
  const wrongMethod = await send("", {}, "", "GET")
  check("with the catch-all in place: 400 invalid request, 405 wrong method and 413 oversized body are unchanged",
    invalidBody.status === 400 && invalidBody.json?.error === "invalid_request" && oversized.status === 413 && oversized.json?.error === "too_large" &&
    wrongMethod.status === 405 && wrongMethod.headers.get("allow") === "POST" && calls.length === 0)
}

// --- configuration and secrets -------------------------------------------------------------------------
check("route is /api/ai-guidance", config.path === "/api/ai-guidance")
check("rate limit is 3 requests per 180 seconds, by ip and domain",
  config.rateLimit?.windowLimit === 3 && config.rateLimit?.windowSize === 180 && JSON.stringify(config.rateLimit?.aggregateBy) === '["ip","domain"]')
check("the key never appears in any log line", !logged.join("\n").includes(DUMMY_KEY))
check("no exception detail or provider text appears in any log line", ![SECRET_DETAIL, PROVIDER_SECRET].some((value) => logged.join("\n").includes(value)))
check("the catch-all fired only for the 3 deliberately triggered exceptions (no validator bug is hiding behind it)",
  logged.filter((line) => line.includes("unexpected internal error")).length === 3)
check(`the key never appears in any of ${bodies.length} response bodies`, bodies.length > 200 && !bodies.join("|").includes(DUMMY_KEY))

console.log(`\n${passed} passed, ${failed.length} failed`)
if (failed.length) console.log(failed.map((name) => ` - ${name}`).join("\n"))
process.exit(failed.length ? 1 : 0)
