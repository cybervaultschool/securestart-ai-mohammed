// Browser tests for the SecureStart interface: every AI Advisor state plus the non-AI journey.
// No dependencies: Node's HTTP server serves ./site and mocks /api/ai-guidance and /api/send-report,
// and headless Edge/Chrome is driven over the DevTools protocol with Node's built-in WebSocket.
//   node scripts/test-ui.mjs                            run all tests
//   node scripts/test-ui.mjs --shots <dir>              also save screenshots of each state
//   node scripts/test-ui.mjs --serve 8750 [--root dir]  only serve the site with the API mock (preview)
import http from "node:http"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const ROOT = resolve(option("--root") ?? join(REPO, "site"))
const SHOTS = option("--shots")

// --- approved content and the reference rules, read from the app itself ------------------------------
const pageSource = readFileSync(join(ROOT, "index.html"), "utf8")
const ACTIONS = vm.runInNewContext(`(${pageSource.match(/this\.actions = (\[[\s\S]*?\n {4}\])/)[1]})`)
const IDS = ["mfa", "passwords", "backups", "updates", "endpoint", "encryption", "awareness", "admin-accounts", "incident-plan", "remote-access"]
const assess = (answers) => {
  const at = (level) => answers.map((a, i) => (a === level ? i : -1)).filter((i) => i >= 0)
  return {
    score: answers.reduce((sum, a) => sum + (a === "yes" ? 2 : a === "partly" ? 1 : 0), 0),
    strengths: at("yes"),
    actions: [...at("no"), ...at("partly")].slice(0, 3)
  }
}
const EVIL = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> &lt;b&gt;bold&lt;/b&gt; "double" 'single'`

// --- mock server -----------------------------------------------------------------------------------------
const mock = {
  ai: { mode: "ok", delay: 0, log: [] },
  email: { log: [] },
  reset() { this.ai = { mode: "ok", delay: 0, log: [] }; this.email = { log: [] } }
}
const aiBody = (request, mode) => {
  const a = assess(request.answers)
  const evil = mode === "evil"
  const priorities = a.actions.map((i, n) => ({
    controlId: IDS[i], title: ACTIONS[i].title, area: ACTIONS[i].area, firstStep: ACTIONS[i].first,
    explanation: evil ? EVIL : `Explanation ${n + 1}: this matters for ${ACTIONS[i].area.toLowerCase()} in your business.`
  }))
  const body = {
    ok: true, aiGenerated: true, score: a.score, maxScore: 20,
    advisor: {
      summary: evil ? EVIL : `You scored ${a.score} out of 20, so a few areas come first.`,
      positiveFinding: a.strengths.length ? (evil ? EVIL : "Some basic practices are already in place.") : "",
      priorities,
      limitations: evil ? EVIL : "This is educational guidance based only on your answers and does not inspect any systems."
    }
  }
  if (mode === "mismatch-score") body.score += 1
  if (mode === "mismatch-title") body.advisor.priorities[0].title += " (changed)"
  if (mode === "mismatch-first") body.advisor.priorities[0].firstStep = "Something else"
  if (mode === "mismatch-count") body.advisor.priorities.pop()
  if (mode === "not-ok") return { ok: false, error: "unavailable" }
  return body
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webp": "image/webp" }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local")
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")

  if (url.pathname === "/__mode") { mock.ai.mode = url.searchParams.get("m") ?? "ok"; mock.ai.delay = Number(url.searchParams.get("delay") ?? 0); res.end("ok"); return }
  if (url.pathname === "/__log") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ai: mock.ai.log, email: mock.email.log })); return }

  if (url.pathname === "/api/send-report" && req.method === "POST") {
    mock.email.log.push(raw)
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); return
  }
  if (url.pathname === "/api/ai-guidance" && req.method === "POST") {
    mock.ai.log.push({ contentType: req.headers["content-type"], raw })
    const { mode } = mock.ai
    const respond = () => {
      if (mode === "drop") { req.socket.destroy(); return }
      if (mode === "429") { res.writeHead(429, { "Content-Type": "application/json" }); res.end(); return }
      if (mode === "429html") { res.writeHead(429, { "Content-Type": "text/html" }); res.end("<html><body>Too many requests</body></html>"); return }
      if (mode === "500") { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"boom"}'); return }
      if (mode === "503") { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"unavailable","message":"AI Advisor is unavailable right now."}'); return }
      if (mode === "malformed") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{not json"); return }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(aiBody(JSON.parse(raw), mode)))
    }
    mock.ai.delay ? setTimeout(respond, mock.ai.delay) : respond()
    return
  }
  const file = join(ROOT, normalize(url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)))
  if (file.startsWith(ROOT) && existsSync(file)) { res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" }); res.end(readFileSync(file)); return }
  res.writeHead(404); res.end("not found")
})

if (option("--serve")) {
  server.listen(Number(option("--serve")), "127.0.0.1", () => console.log(`serving ${ROOT} with the API mock on http://127.0.0.1:${option("--serve")}/ (control: /__mode?m=ok|429|500|evil&delay=ms)`))
} else {
  await runTests()
}

// --- helpers that run inside the page ----------------------------------------------------------------------
function installHelpers() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, ms = 9000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { try { if (fn()) return true } catch { /* keep waiting */ } await wait(40) }
    return false
  }
  const btn = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t)
  const answerRadio = (v) => document.querySelector(`input[type=radio][name="answer"][value="${v}"]`)
  const text = () => (document.querySelector("main") ? document.querySelector("main").innerText : "")
  const ai = () => document.querySelector('[data-section="ai-advisor"]')
  const actionCards = () => [...document.querySelectorAll("main .card")].filter((c) => !c.dataset.section && /priority \d/i.test(c.innerText))
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })) }
  async function toPlan(answers) {
    if (btn("Start a New Assessment")) { btn("Start a New Assessment").click(); await wait(100) }
    btn("Start Assessment").click(); await waitFor(() => /Question 1 of 10/i.test(text()))
    for (const a of answers) { answerRadio(a).click(); await wait(30); btn("Continue").click(); await wait(30) }
    btn("Calculate Results").click(); await waitFor(() => /\/ 20/.test(text()))
    btn("View My Action Plan").click(); await waitFor(() => !!ai())
  }
  const snapshot = () => {
    const card = ai()
    return {
      aiText: card ? card.innerText : "",
      status: card ? [...card.querySelectorAll("[role=status],[role=alert]")].map((e) => e.textContent.trim()) : [],
      button: card && btn("Generate AI Guidance") ? { disabled: btn("Generate AI Guidance").disabled, label: btn("Generate AI Guidance").textContent.trim() } : null,
      generating: card ? !!btn("Generating…") : false,
      radios: card ? [...card.querySelectorAll("input[type=radio]")].map((r) => ({ value: r.value, checked: r.checked, disabled: r.disabled, label: r.labels[0] ? r.labels[0].innerText.trim() : "" })) : [],
      guidance: !!(card && card.querySelector("#ai-guidance-title")),
      actionCards: actionCards().length
    }
  }
  window.T = { wait, waitFor, btn, answerRadio, text, ai, actionCards, setValue, toPlan, snapshot }
}

// --- the test run ------------------------------------------------------------------------------------------------
async function runTests() {
  const edge = [process.env.BROWSER, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p))
  if (!edge) { console.log("No Edge or Chrome found. Set BROWSER to a Chromium-based browser."); process.exit(2) }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const debugPort = 9300 + Math.floor(Math.random() * 600)
  const profile = mkdtempSync(join(tmpdir(), "securestart-ui-"))
  const browser = spawn(edge, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" })

  let targets
  for (let i = 0; i < 60 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  const page = targets?.find((t) => t.type === "page")
  if (!page) { console.log("Could not reach the browser's DevTools endpoint."); browser.kill(); process.exit(2) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 0
  const pending = new Map()
  const exceptions = []
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id && pending.has(data.id)) { const { resolve, reject } = pending.get(data.id); pending.delete(data.id); data.error ? reject(new Error(data.error.message)) : resolve(data.result) }
    if (data.method === "Runtime.exceptionThrown") exceptions.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text)
  }
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  await cdp("Page.enable"); await cdp("Runtime.enable")
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${installHelpers})()` })

  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const run = (fn, ...fnArgs) => evaluate(`(${fn})(...${JSON.stringify(fnArgs)})`)
  const viewport = (width, height, mobile = false) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile })
  const navigate = async (path) => {
    await cdp("Page.navigate", { url: base + path })
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 200))
      try { if (await evaluate(`!!document.querySelector('main') && document.querySelector('main').innerText.length > 20 && !document.querySelector('main').innerText.includes('{{')`)) return } catch { /* page still loading */ }
    }
    throw new Error("the page did not render (is the network available for React and fonts?)")
  }
  const fresh = async () => { mock.reset(); await navigate("/"); await evaluate("localStorage.clear()"); await navigate("/") }
  const shot = async (name, selector = '[data-section="ai-advisor"]') => {
    if (!SHOTS) return
    mkdirSync(SHOTS, { recursive: true })
    const clip = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'start'}); const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left + scrollX - 12), y: Math.max(0, r.top + scrollY - 12), width: Math.min(innerWidth, r.width + 24), height: r.height + 24, scale: 1 } })()`)
    if (!clip) return
    const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip })
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(image.data, "base64"))
  }

  let passed = 0
  const failed = []
  const check = (name, condition) => { condition ? passed++ : failed.push(name); if (!condition) console.log(`FAIL  ${name}`) }

  const MIXED = ["yes", "partly", "no", "yes", "partly", "yes", "no", "yes", "yes", "partly"]   // 13/20: Recovery, People, Passwords
  const ALL_YES = Array(10).fill("yes")
  const ONE_GAP = ALL_YES.map((a, i) => (i === 8 ? "no" : a))
  const TWO_GAPS = ALL_YES.map((a, i) => (i === 1 ? "partly" : i === 6 ? "no" : a))
  const expectedCards = (answers) => assess(answers).actions.map((i) => ACTIONS[i])
  const GENERIC_ERROR = "AI Advisor is unavailable right now"
  const RATE_LIMITED = "wait about three minutes"
  await viewport(1000, 1100)

  // Visual capture only: node scripts/test-ui.mjs [--root dir] --plan-shot out.png [--screen home|assessment|review|results|plan] [--generate] [--width 375]
  if (option("--plan-shot")) {
    if (option("--width")) await viewport(Number(option("--width")), 900, Number(option("--width")) < 600)
    await fresh()
    await evaluate(`localStorage.setItem('securestart_v1', JSON.stringify({ screen: ${JSON.stringify(option("--screen") ?? "plan")}, qIndex: 3, answers: ${JSON.stringify(MIXED)} }))`)
    await navigate("/")
    if (args.includes("--generate")) await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
    const size = await evaluate("({ w: Math.ceil(document.documentElement.scrollWidth), h: Math.ceil(document.documentElement.scrollHeight) })")
    const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } })
    writeFileSync(option("--plan-shot"), Buffer.from(image.data, "base64"))
    console.log(`saved ${option("--plan-shot")} (${size.w}x${size.h})`)
    ws.close(); browser.kill(); server.close()
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* ignore */ }
    process.exit(0)
  }

  try {
    // 1. Non-AI regression: the whole five-screen journey, scoring and recommendations ------------------------------
    await fresh()
    const home = await run(() => ({ text: T.text(), buttons: [...document.querySelectorAll("main button")].map((b) => b.textContent.trim()) }))
    check("home: purpose, limitation notice and Start Assessment", home.text.includes("Understand Your Basic Security Readiness") &&
      home.text.includes("SecureStart AI provides educational guidance based only on your answers. It does not inspect your systems or replace a professional security assessment.") && home.buttons.includes("Start Assessment"))
    const flow = await run(async (answers) => {
      const out = {}
      T.btn("Start Assessment").click(); await T.waitFor(() => /Question 1 of 10/i.test(T.text()))
      out.question1 = /Question 1 of 10/i.test(T.text())
      T.btn("Continue").click(); await T.wait(80)
      out.validation = T.text().includes("Please select an answer before continuing.")
      T.answerRadio(answers[0]).click(); await T.wait(40); T.btn("Continue").click(); await T.wait(60)
      T.btn("Back").click(); await T.wait(80)
      out.backKeepsAnswer = T.answerRadio(answers[0]).checked
      T.btn("Continue").click(); await T.wait(60)
      for (const a of answers.slice(1)) { T.answerRadio(a).click(); await T.wait(30); T.btn("Continue").click(); await T.wait(30) }
      out.review = T.text().includes("Review Your Answers"); out.calcEnabled = !T.btn("Calculate Results").disabled
      T.btn("Calculate Results").click(); await T.waitFor(() => /\/ 20/.test(T.text()))
      out.score = (T.text().match(/(\d+)\s*\n?\s*\/ 20/) || [])[1]
      out.results = /Strengths/i.test(T.text()) && /Areas requiring attention/i.test(T.text())
      out.resultsNoAi = !document.querySelector('[data-section="ai-advisor"]')
      T.btn("View My Action Plan").click(); await T.waitFor(() => !!T.ai())
      out.headline = document.querySelector("main h1").innerText
      out.cards = T.actionCards().map((c) => c.innerText)
      out.closing = T.text().includes("Review these actions with an appropriate IT or security professional before implementation.")
      out.emailCard = !!document.getElementById("report-email")
      out.footer = document.querySelector("footer") ? document.querySelector("footer").innerText.trim() : null
      out.buttons = [...document.querySelectorAll("main button")].map((b) => b.textContent.trim())
      out.heights = [...new Set([...document.querySelectorAll("main button")].map((b) => Math.round(b.getBoundingClientRect().height)))]
      return out
    }, MIXED)
    check("journey: Q1, required-answer validation, Back keeps the answer", flow.question1 && flow.validation && flow.backKeepsAnswer)
    check("journey: review screen with Calculate Results enabled", flow.review && flow.calcEnabled)
    check("journey: score 13 / 20 with strengths and areas requiring attention, no AI card on Results", flow.score === "13" && flow.results && flow.resultsNoAi)
    check("journey: Action Plan lists the three deterministic actions in order", flow.headline === "Your Three Priority Actions" && flow.cards.length === 3 &&
      expectedCards(MIXED).every((a, i) => flow.cards[i].includes(a.title) && flow.cards[i].includes(a.first) && flow.cards[i].includes(a.area)))
    check("journey: closing professional-review line, Email card and Day 6 footer intact", flow.closing && flow.emailCard && flow.footer === "Training deployment: Day 6")
    check("journey: all Action Plan buttons share one size", flow.heights.length === 1 && ["Generate AI Guidance", "Email My Report", "Review My Answers", "Start a New Assessment", "Print Action Plan"].every((b) => flow.buttons.includes(b)))
    check("journey: no AI request is made until the visitor asks", mock.ai.log.length === 0)

    // 2. Email My Report still works and carries no AI content --------------------------------------------------------
    const mailed = await run(async () => {
      T.setValue(document.getElementById("report-email"), "delivered@resend.dev"); await T.wait(80)
      T.btn("Email My Report").click()
      await T.waitFor(() => T.text().includes("Your report was sent."))
      return { sent: T.text().includes("Your report was sent.") }
    })
    const mail = JSON.parse(mock.email.log[0] ?? "{}")
    check("email: Email My Report still succeeds", mailed.sent && mock.email.log.length === 1)
    check("email: request has exactly the approved fields and no AI content",
      JSON.stringify(Object.keys(mail)) === '["recipientEmail","score","strengths","gaps","actions"]' && mail.score === 13 && !/advisor|AI Advisor|Explanation/i.test(mock.email.log[0]))

    // 3. Idle state, audience choice, deterministic content stays visible ----------------------------------------------
    await fresh()
    await run((a) => T.toPlan(a), MIXED)
    let s = await run(() => T.snapshot())
    check("idle: AI Advisor card shows beside the deterministic plan, which stays visible", s.actionCards === 3 && s.aiText.includes("AI Advisor") && !s.guidance)
    check("idle: audience choice has exactly two values, Business owner (default) and IT administrator",
      JSON.stringify(s.radios.map((r) => [r.value, r.label, r.checked])) === '[["business-owner","Business owner",true],["it-admin","IT administrator",false]]')
    check("idle: one primary button labelled Generate AI Guidance, enabled", s.button?.label === "Generate AI Guidance" && s.button.disabled === false)
    check("idle: says nothing has been requested and that the plan is complete", s.status.some((t) => t.includes("has not been requested yet")))
    // Disclosure: visible before the request, and accurate about who receives what.
    const EXPECTED_DISCLOSURE = "Your ten assessment answers and selected audience are sent securely to the SecureStart service. Claude receives only your selected audience and a server-calculated summary of the result, including the score, strength and gap identifiers, and approved priority actions. Your name, company and email address are not sent to Claude."
    const disclosure = await run(() => {
      const el = document.getElementById("ai-disclosure")
      if (!el) return null
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
      return { text: el.innerText.replace(/\s+/g, " ").trim(), visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
        aboveButton: r.top < T.btn("Generate AI Guidance").getBoundingClientRect().top }
    })
    check("disclosure: visible before any request is made, above the Generate button", !!disclosure && disclosure.visible && disclosure.aboveButton && mock.ai.log.length === 0)
    check("disclosure: the approved wording, exactly", disclosure?.text === EXPECTED_DISCLOSURE)
    const sentences = (disclosure?.text ?? "").split(/(?<=\.)\s+/)
    const aboutService = sentences.filter((t) => t.includes("SecureStart service"))
    const aboutClaude = sentences.filter((t) => /Claude/.test(t))
    check("disclosure: separates the SecureStart service (gets the answers and audience) from Claude (gets the audience and a server-calculated summary)",
      aboutService.length === 1 && aboutService[0] === "Your ten assessment answers and selected audience are sent securely to the SecureStart service." &&
      aboutClaude.length === 2 && aboutClaude[0].startsWith("Claude receives only your selected audience and a server-calculated summary of the result"))
    check("disclosure: never claims that the raw answers, name, company or email address go to Claude",
      aboutClaude.length === 2 && !aboutClaude.some((t) => /\b(ten|assessment answers|raw answers)\b/i.test(t)) &&
      aboutClaude[1] === "Your name, company and email address are not sent to Claude." && !/AI provider|Anthropic/i.test(disclosure.text))
    const a11y = await run(() => {
      const group = document.querySelector('[role=radiogroup][aria-labelledby="ai-audience-label"]')
      return { group: !!group && !!document.getElementById("ai-audience-label"), labels: [...document.querySelectorAll('input[name="ai-audience"]')].every((r) => r.labels.length === 1 && r.labels[0].innerText.trim().length > 0),
        card: document.querySelector('[data-section="ai-advisor"]').hasAttribute("data-no-print"), heading: document.querySelector("#ai-advisor-title")?.tagName }
    })
    check("idle: accessible radio group with connected labels and a real heading", a11y.group && a11y.labels && a11y.heading === "H2")

    // One primary action on the Action Plan screen; Print and Email stay secondary, same size, same behaviour.
    const buttons = await run(() => [...document.querySelectorAll("main button")].map((b) => {
      const cs = getComputedStyle(b)
      return { label: b.textContent.trim(), cls: b.className, border: cs.borderTopColor, color: cs.color, height: Math.round(b.getBoundingClientRect().height), enabled: !b.disabled }
    }))
    const ACCENT = "rgb(45, 125, 122)"
    const generate = buttons.find((b) => b.label === "Generate AI Guidance")
    const others = buttons.filter((b) => b.label !== "Generate AI Guidance")
    check("primary action: Generate AI Guidance is the only button with the primary class on the Action Plan screen", buttons.filter((b) => b.cls.includes("btn-primary")).map((b) => b.label).join() === "Generate AI Guidance")
    check("primary action: it alone has the accent border and text colour", generate.border === ACCENT && generate.color === ACCENT && others.every((b) => b.border !== ACCENT && b.color !== ACCENT))
    check("primary action: Print Action Plan, Email My Report, Review My Answers and Start a New Assessment are all secondary",
      ["Print Action Plan", "Email My Report", "Review My Answers", "Start a New Assessment"].every((l) => buttons.find((b) => b.label === l)?.cls.includes("btn-secondary")))
    check("primary action: every Action Plan button keeps the same height and stays enabled", new Set(buttons.map((b) => b.height)).size === 1 && buttons.every((b) => b.enabled))
    const printed = await run(async () => { window.__printed = 0; window.print = () => { window.__printed++ }; T.btn("Print Action Plan").click(); await T.wait(60); return window.__printed })
    check("primary action: Print Action Plan still prints", printed === 1)
    const focusable = await run(() => { const b = T.btn("Print Action Plan"); b.focus(); return document.activeElement === b })
    check("primary action: Print Action Plan is still keyboard-focusable", focusable)
    check("print: the AI card is marked data-no-print", a11y.card)
    await cdp("Emulation.setEmulatedMedia", { media: "print" })
    const printHidden = await evaluate(`getComputedStyle(document.querySelector('[data-section="ai-advisor"]')).display === 'none'`)
    await cdp("Emulation.setEmulatedMedia", { media: "" })
    check("print: the AI card is hidden in print output", printHidden)
    await shot("1-idle")

    // Spacing: the design-system tokens exist, so cards and the page have real padding.
    const spacing = await run(() => {
      const pad = (el) => { const c = getComputedStyle(el); return [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map(parseFloat) }
      const root = getComputedStyle(document.documentElement)
      const aiCard = T.ai(), emailCard = document.getElementById("report-email").closest(".card")
      const aiRect = aiCard.getBoundingClientRect(), emailRect = emailCard.getBoundingClientRect()
      const heading = document.getElementById("ai-advisor-title").getBoundingClientRect()
      const row = T.btn("Print Action Plan").parentElement.getBoundingClientRect()
      const footer = document.querySelector("footer").getBoundingClientRect()
      return { tokens: ["--space-5", "--space-7"].map((n) => root.getPropertyValue(n).trim()), ai: pad(aiCard), email: pad(emailCard), actions: T.actionCards().map(pad),
        main: pad(document.querySelector("main")), headingInset: heading.left - aiRect.left,
        aligned: Math.abs(aiRect.left - emailRect.left) < 1 && Math.abs(aiRect.right - emailRect.right) < 1, gapAboveFooter: footer.top - row.bottom }
    })
    const near = (a, b) => Math.abs(a - b) < 0.6
    check("spacing: --space-5 (23px) and --space-7 (32.2px) are defined", spacing.tokens[0] === "23px" && spacing.tokens[1] === "32.2px")
    check("spacing: the AI Advisor card has 23px of internal padding on every side", spacing.ai.every((v) => near(v, 23)))
    check("spacing: existing cards (three action cards, Email card) have the same padding as the AI card",
      spacing.actions.length === 3 && [spacing.email, ...spacing.actions].every((p) => p.every((v) => near(v, 23))))
    check("spacing: card text sits inside the card, not on its border", spacing.headingInset >= 20)
    check("spacing: the AI card lines up with the Email card", spacing.aligned)
    check("spacing: the page has its designed padding (32.2px top, 18.4px sides, 36.8px bottom)",
      near(spacing.main[0], 32.2) && near(spacing.main[1], 18.4) && near(spacing.main[2], 36.8) && near(spacing.main[3], 18.4))
    check("spacing: the long Action Plan screen has space above the footer", spacing.gapAboveFooter >= 30)

    // 4. Request contract, audience choice, success rendering ---------------------------------------------------------------
    mock.ai = { mode: "ok", delay: 0, log: [] }
    await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
    s = await run(() => T.snapshot())
    const sent = JSON.parse(mock.ai.log[0]?.raw ?? "{}")
    check("request: exactly one POST with only answers and audience", mock.ai.log.length === 1 && JSON.stringify(Object.keys(sent)) === '["answers","audience"]' && mock.ai.log[0].contentType === "application/json")
    check("request: the current answers and the Business owner audience value", JSON.stringify(sent.answers) === JSON.stringify(MIXED) && sent.audience === "business-owner")
    const exp = expectedCards(MIXED)
    const view = await run(() => {
      const guidance = document.querySelector("#ai-guidance-title").closest("section")
      return { heading: document.querySelector("#ai-guidance-title").innerText, text: guidance.innerText, inCard: !!guidance.closest('[data-section="ai-advisor"]'),
        blocks: [...guidance.querySelectorAll(":scope > div")].map((d) => d.innerText), tag: !!guidance.querySelector(".tag") }
    })
    check("success: section labelled AI Advisor Guidance, written for the chosen audience", view.heading === "AI Advisor Guidance" && view.inCard && view.text.includes("Written for: Business owner"))
    check("success: AI summary and positive finding shown", view.text.includes("You scored 13 out of 20") && view.text.includes("Some basic practices are already in place."))
    check("success: three priorities in the server's order, each with a separate AI explanation",
      exp.every((a, i) => view.text.indexOf(a.title) !== -1 && view.text.includes(`Explanation ${i + 1}:`)) && view.text.includes("AI explanation —"))
    check("success: title, area and first step are the deterministic approved values", exp.every((a) => view.text.includes(a.title) && view.text.includes(a.area) && view.text.includes(a.first)) && view.text.includes("First practical step (approved) —"))
    check("success: limitations statement sits in the same section as the guidance", view.text.includes("Limitations —") && view.text.includes("does not inspect any systems"))
    check("success: the deterministic plan, Email card and Print button are still there", s.actionCards === 3 && (await run(() => !!document.getElementById("report-email") && !!T.btn("Print Action Plan"))))
    check("success: the button is usable again for another request", s.button?.disabled === false && s.button.label === "Generate AI Guidance")
    await shot("2-success")
    // change the audience and ask again
    await run(async () => { document.querySelector('input[name="ai-audience"][value="it-admin"]').click(); await T.wait(80) })
    s = await run(() => T.snapshot())
    check("audience: choosing IT administrator keeps the existing guidance until a new request", s.radios[1].checked && s.guidance)
    await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => document.querySelector("#ai-guidance-title") && document.querySelector("#ai-guidance-title").closest("section").innerText.includes("Written for: IT administrator")) })
    check("audience: the second request sends it-admin and the guidance is relabelled",
      mock.ai.log.length === 2 && JSON.parse(mock.ai.log[1].raw).audience === "it-admin" && (await run(() => T.snapshot())).aiText.includes("Written for: IT administrator"))

    // 5. Sending state and duplicate-submission protection ------------------------------------------------------------------
    await fresh()
    await run((a) => T.toPlan(a), MIXED)
    mock.ai = { mode: "ok", delay: 900, log: [] }
    const sending = await run(async () => {
      const b = T.btn("Generate AI Guidance")
      b.click(); b.click()                       // two clicks in the same tick
      await T.wait(120); const during = T.snapshot()
      T.btn("Generating…").click()               // a click on the disabled button
      document.querySelector('input[name="ai-audience"][value="it-admin"]').click()
      await T.wait(60); const duringAfterClicks = T.snapshot()
      await T.waitFor(() => !!document.querySelector("#ai-guidance-title"), 6000)
      return { during, duringAfterClicks, after: T.snapshot() }
    })
    check("sending: button disabled and relabelled, radios disabled, status announced",
      sending.during.generating && sending.during.radios.every((r) => r.disabled) && sending.during.status.some((t) => t.includes("Generating AI guidance")))
    check("sending: duplicate clicks (same tick and on the disabled button) produce exactly one request", mock.ai.log.length === 1)
    check("sending: the audience cannot change while a request is running", sending.duringAfterClicks.radios.find((r) => r.checked).value === "business-owner")
    check("sending: the deterministic plan stays visible while waiting", sending.during.actionCards === 3)
    check("sending: success follows and re-enables the controls", sending.after.guidance && sending.after.button?.disabled === false && sending.after.radios.every((r) => !r.disabled))
    await fresh()
    await run((a) => T.toPlan(a), MIXED)
    mock.ai = { mode: "ok", delay: 1500, log: [] }
    await run(async () => { T.btn("Generate AI Guidance").click(); await T.wait(300) })
    await shot("3-sending")

    // 6. Rate-limited: an HTTP 429 with an empty body is handled before any JSON parsing -------------------------------
    for (const mode of ["429", "429html"]) {
      await fresh()
      await run((a) => T.toPlan(a), MIXED)
      mock.ai = { mode, delay: 0, log: [] }
      await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => T.snapshot().status.some((t) => /wait about three minutes/.test(t))) })
      s = await run(() => T.snapshot())
      check(`rate-limited (${mode === "429" ? "empty body" : "HTML body"}): plain-language wait-and-try-again message`, s.status.some((t) => t.includes(RATE_LIMITED) && t.includes("not affected")))
      check(`rate-limited (${mode}): it is not shown as the generic failure, and there is no guidance`, !s.aiText.includes(GENERIC_ERROR) && !s.guidance)
      check(`rate-limited (${mode}): the score and deterministic plan stay usable and the button is enabled again`, s.actionCards === 3 && s.button?.disabled === false)
      if (mode === "429") await shot("4-rate-limited")
    }
    // recovery: the next request succeeds
    mock.ai.mode = "ok"
    await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
    check("rate-limited: trying again later works", (await run(() => T.snapshot())).guidance)

    // 7. Generic failure: every other problem looks the same and never breaks the deterministic plan -----------------------
    const failures = [["500", "HTTP 500"], ["503", "HTTP 503"], ["malformed", "malformed JSON"], ["drop", "network failure"], ["not-ok", "ok:false body"],
      ["mismatch-score", "score that disagrees with the page"], ["mismatch-title", "changed action title"], ["mismatch-first", "changed first step"], ["mismatch-count", "missing priority"]]
    for (const [mode, label] of failures) {
      await fresh()
      await run((a) => T.toPlan(a), MIXED)
      mock.ai = { mode, delay: 0, log: [] }
      await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => T.snapshot().status.some((t) => /unavailable right now/.test(t))) })
      s = await run(() => T.snapshot())
      const intact = await run(() => ({ email: !!document.getElementById("report-email"), print: !!T.btn("Print Action Plan"), review: !!T.btn("Review My Answers") }))
      check(`failure (${label}): generic unavailable message, no AI text, plan intact`,
        s.status.some((t) => t.includes(GENERIC_ERROR) && t.includes("not affected")) && !s.guidance && s.actionCards === 3 && s.button?.disabled === false && intact.email && intact.print && intact.review)
      if (mode === "500") await shot("5-error")
    }

    // 8. Recovery after a failure, and no stale AI text after answers change or restart -------------------------------------
    mock.ai.mode = "ok"
    await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
    check("failure: retrying after an error can succeed", (await run(() => T.snapshot())).guidance)
    const restarted = await run(async (answers) => {
      T.btn("Start a New Assessment").click(); await T.wait(120)
      const home = T.text().includes("Understand Your Basic Security Readiness")
      await T.toPlan(answers)
      return { home, snap: T.snapshot() }
    }, MIXED)
    check("restart: a new assessment starts with no AI text, the idle message and the Business owner default",
      restarted.home && !restarted.snap.guidance && restarted.snap.status.some((t) => t.includes("has not been requested yet")) && restarted.snap.radios[0].checked)
    mock.ai = { mode: "ok", delay: 1300, log: [] }
    const stale = await run(async () => {
      T.btn("Generate AI Guidance").click(); await T.wait(150)                  // request in flight
      T.btn("Review My Answers").click(); await T.wait(150)
      ;[...document.querySelectorAll("main a")].find((a) => a.textContent.trim() === "Edit").click(); await T.wait(150)
      T.answerRadio("no").click(); await T.wait(60)                              // changes answer 1 from "yes" to "no"
      for (let i = 0; i < 10; i++) { if (T.btn("Calculate Results")) break; T.btn("Continue").click(); await T.wait(40) }
      T.btn("Calculate Results").click(); await T.waitFor(() => /\/ 20/.test(T.text()))
      T.btn("View My Action Plan").click(); await T.waitFor(() => !!T.ai())
      await T.wait(1800)                                                         // the old response arrives now
      return T.snapshot()
    })
    check("stale: a response that arrives after the answers changed is ignored", !stale.guidance && stale.status.some((t) => t.includes("has not been requested yet")) && !stale.generating)

    // 9. No gaps: no unnecessary request ---------------------------------------------------------------------------------------
    await fresh()
    await run((a) => T.toPlan(a), ALL_YES)
    mock.ai = { mode: "ok", delay: 0, log: [] }
    s = await run(() => T.snapshot())
    check("no gaps: AI card says no priority explanation is needed", s.aiText.includes("No priority explanation is needed") && s.button === null && s.radios.length === 0)
    check("no gaps: no AI request can be made and the congratulation message stays", mock.ai.log.length === 0 && (await run(() => T.text().includes("You answered Yes to all ten questions"))))
    check("no gaps: no data-flow disclosure is shown because nothing can be sent, and no button on the screen uses the primary style",
      !s.aiText.includes("sent securely") && (await run(() => document.querySelectorAll("main button.btn-primary").length === 0)))
    await shot("6-no-gaps")
    for (const [answers, count] of [[ONE_GAP, 1], [TWO_GAPS, 2]]) {
      await fresh()
      await run((a) => T.toPlan(a), answers)
      await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
      const rows = await run(() => [...document.querySelector("#ai-guidance-title").closest("section").children].filter((c) => /^priority \d/i.test(c.innerText)).length)
      check(`${count} gap${count > 1 ? "s" : ""}: ${count} AI priorit${count > 1 ? "ies" : "y"} shown`, rows === count && JSON.parse(mock.ai.log[0].raw).answers.join() === answers.join())
    }

    // 10. Model text is rendered as plain text, never as HTML --------------------------------------------------------------------
    await fresh()
    await run((a) => T.toPlan(a), MIXED)
    mock.ai = { mode: "evil", delay: 0, log: [] }
    await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
    const evil = await run(() => {
      const card = T.ai()
      return { text: card.innerText, nodes: card.querySelectorAll("img,script,iframe,object,embed,svg,style,link").length, xss: window.__xss, html: card.innerHTML.includes("&lt;img src=x onerror"), onerror: card.querySelectorAll("[onerror],[onload]").length }
    })
    check("safe text: hostile HTML in model text appears literally on the page", evil.text.includes('<img src=x onerror="window.__xss=1">') && evil.text.includes("<script>window.__xss=2</script>"))
    check("safe text: it creates no elements and runs no script", evil.nodes === 0 && evil.xss === undefined && evil.onerror === 0 && evil.html)
    check("safe text: the app source contains no innerHTML or similar insertion", !/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write/.test(pageSource))
    await shot("7-hostile-text")

    // 11. Mobile layout -------------------------------------------------------------------------------------------------------------
    await viewport(375, 812, true)
    for (const mode of ["ok", "429"]) {
      await fresh()
      await run((a) => T.toPlan(a), MIXED)
      mock.ai = { mode, delay: 0, log: [] }
      await run(async () => { T.btn("Generate AI Guidance").click(); await T.wait(500) })
      const layout = await run(() => {
        const card = T.ai(); const over = [...card.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
        const rect = card.getBoundingClientRect(), emailRect = document.getElementById("report-email").closest(".card").getBoundingClientRect()
        const footer = document.querySelector("footer").getBoundingClientRect(), row = T.btn("Print Action Plan").parentElement.getBoundingClientRect()
        return { scroll: document.documentElement.scrollWidth <= innerWidth, over: over.length, button: T.btn("Generate AI Guidance").getBoundingClientRect().height,
          radioHeights: [...card.querySelectorAll("label.radio")].map((l) => l.getBoundingClientRect().height),
          left: rect.left, right: innerWidth - rect.right, aligned: Math.abs(rect.left - emailRect.left) < 1 && Math.abs(rect.right - emailRect.right) < 1,
          padLeft: parseFloat(getComputedStyle(card).paddingLeft), gapAboveFooter: footer.top - row.bottom }
      })
      check(`mobile 375 px (${mode === "ok" ? "success" : "rate-limited"}): no horizontal scroll, nothing overflows the card, comfortable tap targets`,
        layout.scroll && layout.over === 0 && layout.button >= 36 && layout.radioHeights.every((h) => h >= 36))
      check(`mobile 375 px (${mode === "ok" ? "success" : "rate-limited"}): page margins (18.4 px each side), card padding (23 px), alignment with the Email card, and space above the footer`,
        Math.abs(layout.left - 18.4) < 0.6 && Math.abs(layout.right - 18.4) < 0.6 && Math.abs(layout.padLeft - 23) < 0.6 && layout.aligned && layout.gapAboveFooter >= 30)
      await shot(mode === "ok" ? "8-mobile-success" : "9-mobile-rate-limited")
    }
    await viewport(1000, 1100)
  } catch (error) {
    failed.push(`test run aborted: ${error.message}`)
    console.log(`FAIL  test run aborted: ${error.stack}`)
  }

  check("no uncaught JavaScript exceptions in the page during the whole run", exceptions.length === 0)
  if (exceptions.length) console.log(exceptions.slice(0, 3).join("\n"))
  console.log(`\n${passed} passed, ${failed.length} failed`)
  if (failed.length) console.log(failed.map((name) => ` - ${name}`).join("\n"))
  ws.close(); browser.kill(); server.close()
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* the browser may still hold files */ }
  process.exit(failed.length ? 1 : 0)
}
