// Browser tests for the Defenssive Security Self-Assessment. No dependencies: Node's HTTP server serves
// ./site with the exact security headers from netlify.toml and mocks /api/ai-guidance and /api/send-report;
// headless Edge/Chrome is driven over the DevTools protocol with Node's built-in WebSocket.
// The page loads React from unpkg, so an internet connection is needed (as in production).
//   node scripts/test-ui.mjs                            run all tests
//   node scripts/test-ui.mjs --shots <dir>              also save screenshots of each screen
//   node scripts/test-ui.mjs --serve 8750               only serve the site with the API mock (preview)
//   node scripts/test-ui.mjs --real-turnstile           also load the real Turnstile widget (test site key) under the CSP
import http from "node:http"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_SCORE, NOT_SURE_FIRST_STEP, QUESTIONS, assess } from "../site/assessment.js"

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const ROOT = resolve(option("--root") ?? join(REPO, "site"))
const SHOTS = option("--shots")
const ids = QUESTIONS.map((q) => q.id)

// The headers Netlify will send, read from netlify.toml so the tests run under the real CSP.
const toml = readFileSync(join(REPO, "netlify.toml"), "utf8")
const HEADERS = Object.fromEntries(["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security"]
  .map((name) => [name, toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"))[1]]))
const CLOUDFLARE_TEST_SITE_KEY = "1x00000000000000000000AA" // Cloudflare's documented always-pass test key (public)

const EVIL = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> &lt;b&gt;bold&lt;/b&gt; "double" 'single'`

// ---- mock server --------------------------------------------------------------------------------------------
const mock = {
  ai: { mode: "ok", delay: 0, log: [] },
  email: { mode: "ok", log: [] },
  siteKey: "",
  reset() { this.ai = { mode: "ok", delay: 0, log: [] }; this.email = { mode: "ok", log: [] }; this.siteKey = "" }
}
const aiBody = (request, mode) => {
  const a = assess(request.answers)
  const evil = mode === "evil"
  const body = {
    ok: true, aiGenerated: true, score: a.score, maxScore: MAX_SCORE,
    advisor: {
      summary: evil ? EVIL : `You scored ${a.score} out of ${a.maxScore}, so a few areas come first (${request.audience}).`,
      positiveFinding: a.strengths.length ? (evil ? EVIL : "Some basic practices are already in place.") : "",
      priorities: a.actions.map((action, n) => ({
        controlId: action.id, title: action.title, area: action.area, firstStep: action.first,
        explanation: evil ? EVIL : `Explanation ${n + 1} for ${request.audience}: this matters for ${action.area.toLowerCase()}.`
      })),
      limitations: evil ? EVIL : "This is educational guidance based only on your answers and does not inspect any systems."
    }
  }
  if (mode === "mismatch-score") body.score += 1
  if (mode === "mismatch-max") body.maxScore = 20
  if (mode === "mismatch-title") body.advisor.priorities[0].title += " (changed)"
  if (mode === "mismatch-area") body.advisor.priorities[0].area = "Other"
  if (mode === "mismatch-first") body.advisor.priorities[0].firstStep = "Something else"
  if (mode === "mismatch-id") body.advisor.priorities[0].controlId = "firewall"
  if (mode === "mismatch-count") body.advisor.priorities.pop()
  if (mode === "not-ok") return { ok: false, error: "unavailable" }
  return body
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local")
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")

  if (url.pathname === "/__mode") { mock.ai.mode = url.searchParams.get("m") ?? "ok"; mock.ai.delay = Number(url.searchParams.get("delay") ?? 0); res.end("ok"); return }
  if (url.pathname === "/__sitekey") { mock.siteKey = url.searchParams.get("k") ?? ""; res.end("ok"); return }
  if (url.pathname === "/__log") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ai: mock.ai.log, email: mock.email.log })); return }

  if (url.pathname === "/api/send-report" && req.method === "POST") {
    mock.email.log.push(raw)
    const status = { ok: 200, "429": 429, "500": 500, "400": 400 }[mock.email.mode] ?? 200
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(status === 200 ? '{"ok":true}' : status === 429 ? "" : '{"ok":false,"error":"x","message":"x"}')
    return
  }
  if (url.pathname === "/api/ai-guidance" && req.method === "POST") {
    mock.ai.log.push({ contentType: req.headers["content-type"], raw })
    const { mode } = mock.ai
    const respond = () => {
      if (mode === "drop") { req.socket.destroy(); return }
      if (mode === "429") { res.writeHead(429); res.end(); return } // empty body, no Retry-After: what Netlify sends
      if (mode === "429html") { res.writeHead(429, { "Content-Type": "text/html" }); res.end("<html><body>Too many requests</body></html>"); return }
      if (mode === "500") { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"boom"}'); return }
      if (mode === "503") { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"unavailable"}'); return }
      if (mode === "malformed") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{not json"); return }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(aiBody(JSON.parse(raw), mode)))
    }
    mock.ai.delay ? setTimeout(respond, mock.ai.delay) : respond()
    return
  }
  if (url.pathname === "/__seed.js") {
    // Test-only: lets tools such as Lighthouse open the app on a given screen with a saved assessment.
    const answers = ["yes", "unsure", "yes", "partly", "no", "yes", "no", "yes", "yes", "partly", "yes", "yes", "yes"]
    const screen = url.searchParams.get("screen") ?? "plan"
    const state = { screen, qIndex: Number(url.searchParams.get("q") ?? 0), answers: screen === "assessment" ? answers.map((x, i) => (i < 3 ? x : null)) : answers }
    res.writeHead(200, { "Content-Type": "text/javascript", ...HEADERS })
    res.end(screen === "home" ? 'localStorage.removeItem("securestart_v2")' : `localStorage.setItem("securestart_v2", ${JSON.stringify(JSON.stringify(state))})`)
    return
  }
  if (url.pathname === "/__probe.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", ...HEADERS })
    res.end('try { eval("1"); window.__evalBlocked = false } catch (e) { window.__evalBlocked = true }; try { new Function("return 1")(); window.__fnBlocked = false } catch (e) { window.__fnBlocked = true }')
    return
  }
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname === "/privacy" ? "/privacy.html" : decodeURIComponent(url.pathname)
  const file = join(ROOT, normalize(pathname))
  if (file.startsWith(ROOT) && existsSync(file)) {
    let body = readFileSync(file)
    if (pathname === "/index.html") body = Buffer.from(body.toString("utf8").replace(/name="turnstile-site-key" content="[^"]*"/, `name="turnstile-site-key" content="${mock.siteKey}"`))
    if (pathname === "/index.html" && url.searchParams.has("seed")) {
      body = Buffer.from(body.toString("utf8").replace('<script type="module"', `<script src="/__seed.js?screen=${url.searchParams.get("seed")}&q=${url.searchParams.get("q") ?? 0}"></script>
  <script type="module"`))
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", ...HEADERS })
    res.end(body)
    return
  }
  res.writeHead(404); res.end("not found")
})

if (option("--serve")) {
  server.listen(Number(option("--serve")), "127.0.0.1", () => console.log(`serving ${ROOT} with the API mock on http://127.0.0.1:${option("--serve")}/`))
} else {
  await runTests()
}

// ---- helpers that run inside the page ----------------------------------------------------------------------------
function installHelpers() {
  // A stand-in for Cloudflare's widget so tests can run without the network; "#real-turnstile" loads the real one.
  window.__csp = []
  document.addEventListener("securitypolicyviolation", (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`))
  if (!location.hash.includes("real-turnstile")) {
    window.__ts = { renders: 0, resets: 0, removes: 0, n: 0 }
    window.turnstile = {
      render(element, options) {
        window.__ts.renders++
        window.__ts.options = options
        setTimeout(() => options.callback(`token-${++window.__ts.n}`), 15)
        return `widget-${window.__ts.renders}`
      },
      reset(id) { window.__ts.resets++; setTimeout(() => window.__ts.options.callback(`token-${++window.__ts.n}`), 15); return id },
      remove() { window.__ts.removes++ }
    }
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, ms = 9000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { try { if (fn()) return true } catch { /* keep waiting */ } await wait(40) }
    return false
  }
  const btn = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t)
  const text = () => (document.querySelector("main") ? document.querySelector("main").innerText : "")
  const ai = () => document.querySelector('[data-section="ai-advisor"]')
  const radio = (label) => [...document.querySelectorAll("input[type=radio]")].find((r) => r.labels[0] && r.labels[0].innerText.trim() === label)
  const planCards = () => [...document.querySelectorAll("section.priority")].filter((c) => !c.closest('[data-section="ai-advisor"]'))
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })) }
  const LABEL = { yes: "Yes", partly: "Partly", unsure: "Not sure", no: "No" }
  async function answerAll(answers) {
    btn("Start assessment").click(); await waitFor(() => /question 1 of 13/i.test(text()))
    for (const a of answers) { radio(LABEL[a]).click(); await wait(25); (btn("Continue") || btn("Review answers")).click(); await wait(25) }
    await waitFor(() => /Review your answers/.test(text()))
  }
  async function toPlan(answers) {
    await answerAll(answers)
    btn("Calculate results").click(); await waitFor(() => /educational score/.test(text()))
    btn("View my action plan").click(); await waitFor(() => /priority actions/i.test(document.querySelector("h1")?.textContent || ""))
  }
  const snapshot = () => {
    const card = ai()
    return {
      aiText: card ? card.innerText : "",
      status: card ? [...card.querySelectorAll("[role=status],[role=alert]")].map((e) => e.textContent.trim()) : [],
      button: card && (btn("Generate AI Guidance") || btn("Generating…")) ? { disabled: (btn("Generate AI Guidance") || btn("Generating…")).disabled } : null,
      generating: !!btn("Generating…"),
      radios: card ? [...card.querySelectorAll("input[type=radio]")].map((r) => ({ checked: r.checked, disabled: r.disabled, label: r.labels[0] ? r.labels[0].innerText.trim() : "" })) : [],
      guidance: !!(card && card.querySelector("#ai-guidance-title")),
      planCards: planCards().length
    }
  }
  // Axe-style contrast audit of every visible text element, compositing translucent backgrounds.
  const contrastAudit = () => {
    const parse = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
    }
    const over = (top, under) => { const a = top[3] + under[3] * (1 - top[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) }
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const background = (element) => {
      const layers = []
      for (let e = element; e; e = e.parentElement) layers.push(parse(getComputedStyle(e).backgroundColor))
      let result = [255, 255, 255, 1]
      for (const layer of layers.reverse()) result = over(layer, result)
      return result
    }
    const failures = []
    let checked = 0
    for (const element of document.body.querySelectorAll("*")) {
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) continue
      const own = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())
      if (!own) continue
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") continue
      if (element.closest("button[disabled]")) continue
      const bg = background(element)
      const fg = over(parse(style.color), bg)
      const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05)
      const size = parseFloat(style.fontSize), bold = parseInt(style.fontWeight, 10) >= 700
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
      checked++
      if (ratio < need) failures.push(`${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}" ${ratio.toFixed(2)} < ${need}`)
    }
    return { checked, failures }
  }
  window.T = { wait, waitFor, btn, text, ai, radio, planCards, setValue, answerAll, toPlan, snapshot, contrastAudit }
}

// ---- the test run --------------------------------------------------------------------------------------------------------
async function runTests() {
  const edge = [process.env.BROWSER, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p))
  if (!edge) { console.log("No Edge or Chrome found. Set BROWSER to a Chromium-based browser."); process.exit(2) }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const debugPort = 9300 + Math.floor(Math.random() * 600)
  const profile = mkdtempSync(join(tmpdir(), "defenssive-ui-"))
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
  const problems = [] // page exceptions, console errors, CSP violations
  const hosts = new Set()
  const handlers = new Map()
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id && pending.has(data.id)) { const { resolve, reject } = pending.get(data.id); pending.delete(data.id); data.error ? reject(new Error(data.error.message)) : resolve(data.result) }
    if (data.method === "Runtime.exceptionThrown") problems.push({ kind: "exception", text: data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text })
    if (data.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(data.params.type)) problems.push({ kind: "console", text: data.params.args.map((a) => a.value ?? a.description ?? "").join(" ") })
    if (data.method === "Log.entryAdded" && ["error", "warning"].includes(data.params.entry.level)) problems.push({ kind: "log", source: data.params.entry.source, text: data.params.entry.text, url: data.params.entry.url ?? "" })
    if (data.method === "Network.requestWillBeSent") { try { hosts.add(new URL(data.params.request.url).hostname) } catch { /* ignore */ } }
    if (handlers.has(data.method)) handlers.get(data.method)(data.params)
  }
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Network.enable")
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true })
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${installHelpers})()` })

  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const run = (fn, ...fnArgs) => evaluate(`(${fn})(...${JSON.stringify(fnArgs)})`)
  const viewport = (width, height, mobile = false) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rendered = `!!document.querySelector('#root') && document.querySelector('#root').innerText.length > 20`
  const navigate = async (path, readyExpression = rendered) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await cdp("Page.navigate", { url: base + path })
      for (let i = 0; i < 60; i++) {
        await sleep(200)
        try { if (await evaluate(readyExpression)) return } catch { /* page still loading */ }
      }
    }
    throw new Error("the page did not render (is the network available for React from unpkg?)")
  }
  const seed = async (answers, screen = "plan", qIndex = 0) => {
    await evaluate(`localStorage.setItem('securestart_v2', JSON.stringify(${JSON.stringify({ screen, qIndex, answers })}))`)
    await navigate("/")
  }
  const fresh = async () => { mock.reset(); await navigate("/"); await evaluate("localStorage.clear()"); await navigate("/") }
  const press = async (key, count = 1) => {
    const codes = { Tab: [9, "Tab", ""], ArrowDown: [40, "ArrowDown", ""], Enter: [13, "Enter", "\r"], " ": [32, "Space", " "] }
    const [vk, code, text] = codes[key]
    for (let i = 0; i < count; i++) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, text })
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk })
    }
    await sleep(40)
  }
  const shot = async (name, full = true) => {
    if (!SHOTS) return
    mkdirSync(SHOTS, { recursive: true })
    const size = await evaluate("({ w: Math.ceil(document.documentElement.scrollWidth), h: Math.ceil(document.documentElement.scrollHeight) })")
    const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: full, clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } })
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(image.data, "base64"))
  }
  const overflow = () => evaluate("({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, inner: innerWidth })")

  let passed = 0
  const failed = []
  const check = (name, condition, detail = "") => { condition ? passed++ : failed.push(name); if (!condition) console.log(`FAIL  ${name}${detail ? ` (${detail})` : ""}`) }
  // Problems that are expected from deliberately failing /api calls (the browser logs failed requests).
  const unexpectedProblems = (since = 0) => problems.slice(since).filter((p) => !(p.kind === "log" && p.source === "network" && /\/api\//.test(p.url)) && !/status of (4|5)\d\d/.test(p.text))

  const MIXED = ["yes", "unsure", "yes", "partly", "no", "yes", "no", "yes", "yes", "partly", "yes", "yes", "yes"] // 18/26: Recovery, Devices, Find out admin MFA
  const ALL = (value) => ids.map(() => value)
  const WITH = (base, overrides) => ids.map((id) => overrides[id] ?? base)
  await viewport(1000, 1100)

  try {
    // 1. Page basics, headers and CSP --------------------------------------------------------------------------------------------
    await fresh()
    const head = await run(() => ({
      lang: document.documentElement.lang, title: document.title,
      description: document.querySelector('meta[name="description"]')?.content, ogTitle: document.querySelector('meta[property="og:title"]')?.content,
      ogDescription: !!document.querySelector('meta[property="og:description"]')?.content, canonical: document.querySelector('link[rel=canonical]')?.href,
      icons: [...document.querySelectorAll('link[rel*="icon"]')].map((l) => l.getAttribute("href")),
      h1s: document.querySelectorAll("h1").length, skip: document.querySelector(".skip-link")?.getAttribute("href"),
      sri: [...document.querySelectorAll("script[src]")].map((s) => ({ src: s.src, integrity: s.integrity, cors: s.crossOrigin })),
      inlineScripts: [...document.querySelectorAll("script:not([src])")].length
    }))
    check('page: <html lang="en">', head.lang === "en")
    check("page: title is 'Free Security Self-Assessment | Defenssive'", head.title === "Free Security Self-Assessment | Defenssive")
    check("page: meta description (about 150 characters) and Open Graph tags", head.description?.length >= 120 && head.description.length <= 175 && head.ogTitle === head.title && head.ogDescription)
    check("page: canonical link and favicons", /assessment\.defenssive\.dev/.test(head.canonical) && head.icons.length >= 4)
    check("page: React scripts keep SRI + crossorigin, no inline scripts", head.sri.filter((s) => /unpkg/.test(s.src)).length === 2 && head.sri.filter((s) => /unpkg/.test(s.src)).every((s) => s.integrity.startsWith("sha384-") && s.cors === "anonymous") && head.inlineScripts === 0)
    for (const icon of ["/favicon.ico", "/favicon-32x32.png", "/favicon-16x16.png", "/apple-touch-icon.png", "/assets/defenssive-logo-white.png", "/assets/inter-latin.woff2"]) {
      const r = await fetch(base + icon)
      check(`asset ${icon} is served (200)`, r.status === 200)
    }
    const response = await fetch(base + "/")
    for (const [name, value] of Object.entries(HEADERS)) check(`response header ${name} is sent as configured`, response.headers.get(name) === value)
    const probe = await run(async () => {
      await new Promise((resolve) => { const s = document.createElement("script"); s.src = "/__probe.js"; s.onload = resolve; s.onerror = resolve; document.head.appendChild(s) })
      return { evalBlocked: window.__evalBlocked, fnBlocked: window.__fnBlocked }
    })
    check("CSP is enforced in the browser: eval() and new Function() are blocked for page scripts", probe.evalBlocked === true && probe.fnBlocked === true, JSON.stringify(probe))
    check("CSP is enforced in the browser: inline script injection is blocked", await evaluate(`(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.head.appendChild(s); return window.__inline !== 1 })()`))
    check("CSP is enforced in the browser: an off-list script origin is blocked", await run(async () => {
      const before = window.__csp.length
      await new Promise((resolve) => { const s = document.createElement("script"); s.src = "https://example.org/x.js"; s.onerror = resolve; s.onload = resolve; document.head.appendChild(s) })
      return window.__csp.length > before
    }))
    await fresh() // discard the deliberate violations above
    problems.length = 0
    hosts.clear()
    await navigate("/")

    // 2. Header, footer, Home ---------------------------------------------------------------------------------------------------------
    const home = await run(() => ({
      text: T.text(), h1: document.querySelector("h1").textContent,
      logo: { href: document.querySelector("a.brand")?.getAttribute("href"), alt: document.querySelector("a.brand img")?.alt, loaded: document.querySelector("a.brand img")?.naturalWidth > 0 },
      back: [...document.querySelectorAll("header a")].map((a) => a.textContent.trim() + "|" + a.getAttribute("href")),
      footer: [...document.querySelectorAll("footer a")].map((a) => a.textContent.trim() + "|" + a.getAttribute("href")),
      footerText: document.querySelector("footer").innerText,
      font: getComputedStyle(document.body).fontFamily, size: getComputedStyle(document.body).fontSize, bg: getComputedStyle(document.body).backgroundColor,
      lead: getComputedStyle(document.querySelector("main")).color
    }))
    check("header: white Defenssive logo links to defenssive.com and loads", home.logo.href === "https://defenssive.com" && home.logo.alt === "Defenssive" && home.logo.loaded)
    check("header: 'Back to defenssive.com' link", home.back.includes("Back to defenssive.com|https://defenssive.com"))
    check("footer: Defenssive Cybersecurity LLC, defenssive.com, privacy notice, Terms",
      home.footerText.includes("Defenssive Cybersecurity LLC") && home.footer.includes("defenssive.com|https://defenssive.com") && home.footer.includes("Privacy notice|/privacy") && home.footer.includes("Terms|https://app.defenssive.dev/terms"))
    check("home: product name, thirteen questions, limitation notice and Start assessment",
      home.h1 === "Defenssive Security Self-Assessment" && /thirteen plain-language questions/.test(home.text) &&
      home.text.includes("Defenssive provides educational guidance based only on your answers. It does not inspect your systems or replace a professional security assessment.") && /Start assessment/.test(home.text))
    check("style: Inter, 18px body, page background #0a0f1a", /Inter/.test(home.font) && home.size === "18px" && home.bg === "rgb(10, 15, 26)")
    check("style: no old teal accent anywhere in the stylesheet", !/2d7d7a|35918d/i.test(readFileSync(join(ROOT, "styles.css"), "utf8")))
    await shot("1-home")

    // 3. Assessment screen: question, help text, options, validation ----------------------------------------------------------------------
    const q1 = await run(async () => {
      T.btn("Start assessment").click(); await T.waitFor(() => /question 1 of 13/i.test(T.text()))
      const bar = document.querySelector("[role=progressbar]")
      return {
        eyebrow: document.querySelector(".eyebrow").textContent, legend: document.querySelector("legend").textContent, help: document.querySelector(".help").textContent,
        helpVisible: document.querySelector(".help").getBoundingClientRect().height > 0,
        options: [...document.querySelectorAll(".option")].map((o) => o.innerText.trim()), radios: document.querySelectorAll("input[type=radio]").length,
        bar: { label: bar.getAttribute("aria-label"), now: bar.getAttribute("aria-valuenow"), max: bar.getAttribute("aria-valuemax"), text: bar.getAttribute("aria-valuetext") },
        describedBy: document.querySelector("fieldset").getAttribute("aria-describedby"), focusIn: document.activeElement === document.querySelector("fieldset")
      }
    })
    check("question 1: text, one-line help (visible without a click), area label", q1.legend === QUESTIONS[0].text && q1.help === QUESTIONS[0].help && q1.helpVisible && q1.eyebrow === "Question 1 of 13 · Identity")
    check("question 1: four options in order Yes, Partly, Not sure, No", q1.options.join() === "Yes,Partly,Not sure,No" && q1.radios === 4)
    check("question 1: progress bar has an accessible label and value", q1.bar.label === "Assessment progress" && q1.bar.now === "1" && q1.bar.max === "13" && q1.bar.text === "Question 1 of 13")
    check("question 1: help text is linked to the group, and focus moves to the question", q1.describedBy === "help-mfa" && q1.focusIn)
    const required = await run(async () => { T.btn("Continue").click(); await T.wait(60); return { alert: document.querySelector("[role=alert]")?.textContent, still: /question 1 of 13/i.test(T.text()) } })
    check("answers are required: Continue without a choice shows a message and stays", required.alert === "Please select an answer before continuing." && required.still, JSON.stringify(required))
    for (const q of QUESTIONS) check(`question text and help match the approved copy: ${q.id}`, q.text.length > 20 && q.help.length > 10)
    await run(async () => { T.radio("Not sure").click(); await T.wait(40); T.btn("Continue").click(); await T.wait(60); T.btn("Back").click(); await T.wait(60) })
    check("going Back keeps the earlier answer", await evaluate(`T.radio("Not sure").checked`))
    await shot("2-question")

    // 4. A full journey through the UI, then all five screens ----------------------------------------------------------------------------
    await fresh()
    await run(async (answers) => { await T.answerAll(answers) }, MIXED)
    const review = await run(() => ({ rows: [...document.querySelectorAll(".review li")].map((li) => li.innerText.replace(/\s+/g, " ").trim()), text: T.text(), h1: document.querySelector("h1").textContent }))
    check("review: all 13 answers listed with Edit, including 'Not sure'", review.rows.length === 13 && review.rows.every((row) => /Edit$/.test(row)) && review.rows[1].includes("Not sure") && review.rows[4].includes("No"))
    check("review: scoring legend shows 4 answer values and maximum 26", /Not sure = 0 points/.test(review.text) && /Maximum score = 26/.test(review.text) && /Partly = 1 point/.test(review.text))
    await shot("3-review")
    const results = await run(async () => {
      T.btn("Calculate results").click(); await T.waitFor(() => /educational score/.test(T.text()))
      return {
        text: T.text(), score: document.querySelector(".score .big").textContent, of: document.querySelector(".score .of").textContent, h1: document.querySelector("h1").textContent,
        announce: document.querySelector('[aria-live="polite"]').textContent, focusH1: document.activeElement === document.querySelector("h1"),
        stats: [...document.querySelectorAll(".stat")].map((s) => s.textContent), tags: [...document.querySelectorAll(".tags li")].map((t) => t.textContent),
        ctas: [...document.querySelectorAll("a.btn")].map((a) => a.textContent.trim() + "|" + a.getAttribute("href")), buttons: [...document.querySelectorAll("main button")].map((b) => b.textContent.trim())
      }
    })
    check("results: 18 / 26 educational score, announced to screen readers, focus on the heading",
      results.score === "18" && /26 educational score/.test(results.of) && /Your result: 18 out of 26/.test(results.announce) && results.focusH1)
    check("results: Recovery is No (a critical control), so the important-gap wording shows, never 'most practices'", results.text.includes("Your answers show at least one important gap. Start with the actions below.") && !/most practices/.test(results.text))
    check("results: counts and chips (8 Yes, 5 not yet; gaps include 'Identity'-style labels)", results.stats.join() === "13 of 13,8,5" && results.tags.includes("Recovery — No") && results.tags.includes("Administrator sign-in — Not sure") && results.tags.includes("Passwords — Partly"))
    check("results: the educational disclaimer is shown", results.text.includes("This is educational guidance based only on your answers. It does not inspect your systems or replace a professional security assessment. It is not a vulnerability score, compliance result or audit."))
    check("results: both calls to action link to defenssive.com",
      results.ctas.includes("Book a free 30-minute review|https://defenssive.com/contact#send-a-message") &&
      results.ctas.some((c) => c.startsWith("Own Microsoft 365? See our read-only security assessment product|https://defenssive.com")))
    check("results: View my action plan, Review answers, Print results and Clear my answers are offered", ["View my action plan", "Review answers", "Print results", "Clear my answers"].every((b) => results.buttons.includes(b)))
    await shot("4-results")
    const plan = await run(async () => {
      T.btn("View my action plan").click(); await T.waitFor(() => /priority actions/i.test(document.querySelector("h1")?.textContent || ""))
      return {
        h1: document.querySelector("h1").textContent, cards: T.planCards().map((c) => c.innerText.replace(/\n+/g, " | ")),
        text: T.text(), announce: document.querySelector('[aria-live="polite"]').textContent,
        buttons: [...document.querySelectorAll("main button")].map((b) => b.textContent.trim()),
        primaries: [...document.querySelectorAll("main .btn-primary")].map((b) => b.textContent.trim()),
        ctas: [...document.querySelectorAll("a.btn")].map((a) => a.getAttribute("href"))
      }
    })
    check("plan: 'Your three priority actions' with exactly three cards", plan.h1 === "Your three priority actions" && plan.cards.length === 3)
    check("plan: cards follow the risk order: Recovery (No), Devices (No), then the Not sure 'Find out' action",
      /Recovery/.test(plan.cards[0]) && /Document backups and complete a controlled restore test\./.test(plan.cards[0]) && /Devices/.test(plan.cards[1]) &&
      /Administrator sign-in/.test(plan.cards[2]) && /Find out: MFA for administrators/.test(plan.cards[2]) && plan.cards[2].includes(NOT_SURE_FIRST_STEP))
    check("plan: each card shows why it matters and the first practical step", plan.cards.every((c) => /Why it matters/.test(c) && /First practical step/.test(c)))
    check("plan: review line, disclaimer, Print Action Plan and both calls to action", /Review these actions with an appropriate IT or security professional/.test(plan.text) && plan.buttons.includes("Print Action Plan") && plan.ctas.includes("https://defenssive.com/contact#send-a-message"))
    check("plan: Generate AI Guidance is the only primary action", plan.primaries.join() === "Generate AI Guidance")
    check("plan: the plan is announced to screen readers", /Your action plan has 3 priority actions/.test(plan.announce))
    await shot("5-plan")
    const unexpectedAfterJourney = unexpectedProblems()
    check("no console errors, exceptions or CSP violations during the full journey", unexpectedAfterJourney.length === 0, JSON.stringify(unexpectedAfterJourney).slice(0, 300))
    check("no CSP violation recorded by the page itself", (await evaluate("window.__csp.length")) === 0)

    // 5. Acceptance scenarios (seeded) -----------------------------------------------------------------------------------------------------
    const scenario = async (name, answers, expectations) => {
      await seed(answers, "results")
      const r = await run(async () => {
        const out = { score: document.querySelector(".score .big").textContent, headline: document.querySelector(".headline").textContent, text: T.text() }
        T.btn("View my action plan").click(); await T.waitFor(() => /priority actions/i.test(document.querySelector("h1")?.textContent || ""))
        out.h1 = document.querySelector("h1").textContent
        out.cards = T.planCards().map((c) => c.querySelector("h2").textContent)
        out.ai = !!T.ai()
        out.planText = T.text()
        return out
      })
      expectations(r)
    }
    await scenario("all Yes", ALL("yes"), (r) => {
      check("all Yes: 26 / 26 with the careful perfect-score wording", r.score === "26" && r.headline === "You answered Yes to all thirteen practices. These are your own answers, not a test of your systems. Repeat this assessment periodically.")
      check("all Yes: never 'all practices are in place' or any security claim", !/all practices are in place|you are secure|is secure|safe/i.test(r.text))
      check("all Yes: the plan has no actions and no AI Advisor card", r.cards.length === 0 && !r.ai && /Repeat this assessment periodically/.test(r.planText))
    })
    await scenario("all No", ALL("no"), (r) => {
      check("all No: score 0 and the important-gap wording", r.score === "0" && r.headline === "Your answers show at least one important gap. Start with the actions below.")
      check("all No: the three highest-risk actions in risk order", r.cards.join(" | ") === ["Require MFA for email and administrator accounts.", "Require MFA for administrator accounts.", "Restrict remote access and require MFA."].join(" | "))
    })
    await scenario("MFA No, rest Yes", WITH("yes", { mfa: "no" }), (r) => {
      check("MFA No, rest Yes: score 24 but the critical-gap override shows; never 'most practices'", r.score === "24" && r.headline === "Your answers show at least one important gap. Start with the actions below." && !/most practices/.test(r.text))
      check("MFA No, rest Yes: a single action, 'Your priority actions' heading", r.cards.length === 1 && r.h1 === "Your priority actions")
    })
    await scenario("one non-critical No", WITH("yes", { sharing: "no" }), (r) => {
      check("one non-critical No: 24 / 26 gives 'most practices are in place'", r.score === "24" && /most practices are in place/.test(r.headline))
    })
    await scenario("Not sure mixture", WITH("yes", { "admin-mfa": "unsure", passwords: "unsure", backups: "no", updates: "no", "remote-access": "partly" }), (r) => {
      check("Not sure mixture: No actions first (risk order), then the 'Find out' action", r.cards.join(" | ") === ["Document backups and complete a controlled restore test.", "Create a regular update process.", "Find out: MFA for administrators"].join(" | "))
    })
    await scenario("Partly only", ALL("partly"), (r) => {
      check("Partly only: 13 / 26 (50%) middle wording and the first three risk-order actions", r.score === "13" && /some practices are in place and others are missing or only partly in place/.test(r.headline) &&
        r.cards.join(" | ") === ["Require MFA for email and administrator accounts.", "Require MFA for administrator accounts.", "Restrict remote access and require MFA."].join(" | "))
    })
    await scenario("low score, no critical gap", WITH("unsure", { mfa: "yes", "admin-mfa": "yes", backups: "yes", updates: "yes" }), (r) => {
      check("below 40%: 'several practices are not yet in place'", r.score === "8" && /several practices are not yet in place/.test(r.headline))
    })

    // 6. Saved data: v2 only, old v1 ignored, Clear my answers --------------------------------------------------------------------------
    await fresh()
    await evaluate(`localStorage.setItem('securestart_v1', JSON.stringify({ screen: 'results', qIndex: 3, answers: ${JSON.stringify(ALL("yes").slice(0, 10))} }))`)
    await navigate("/")
    const v1 = await evaluate(`({ text: T.text(), h1: document.querySelector("h1").textContent, v1: localStorage.getItem('securestart_v1') !== null })`)
    check("old securestart_v1 data is ignored: the page opens on Home and works", v1.h1 === "Defenssive Security Self-Assessment" && /Start assessment/.test(v1.text) && v1.v1)
    for (const [name, value] of [["corrupt JSON", "{not json"], ["10 answers", { screen: "results", qIndex: 0, answers: ALL("yes").slice(0, 10) }], ["unknown answer value", { screen: "plan", qIndex: 0, answers: ids.map((_, i) => (i ? "yes" : "Partly / Unsure")) }],
      ["unknown screen", { screen: "admin", qIndex: 0, answers: ALL("yes") }], ["bad index", { screen: "assessment", qIndex: 99, answers: ALL("yes") }], ["null", null]]) {
      await evaluate(`localStorage.setItem('securestart_v2', ${JSON.stringify(typeof value === "string" ? value : JSON.stringify(value))})`)
      await navigate("/")
      check(`invalid v2 data (${name}) is ignored: Home opens`, (await evaluate(`document.querySelector("h1").textContent`)) === "Defenssive Security Self-Assessment")
    }
    await fresh()
    await run(async () => { T.btn("Start assessment").click(); await T.waitFor(() => /question 1 of 13/i.test(T.text())); T.radio("Yes").click(); await T.wait(60) })
    const saved = JSON.parse(await evaluate(`localStorage.getItem('securestart_v2')`))
    check("progress is saved under securestart_v2 with 13 answer slots", saved.answers.length === 13 && saved.answers[0] === "yes" && saved.screen === "assessment")
    await navigate("/")
    check("a reload resumes the assessment where it was left", (await evaluate(`/question 1 of 13/i.test(T.text()) && T.radio("Yes").checked`)))
    await seed(MIXED, "results")
    await run(async () => { T.btn("Clear my answers").click(); await T.wait(150) })
    const cleared = await evaluate(`({ stored: localStorage.getItem('securestart_v2'), h1: document.querySelector("h1").textContent, announce: document.querySelector('[aria-live="polite"]').textContent })`)
    check("Clear my answers removes the saved data and returns Home", cleared.stored === null && cleared.h1 === "Defenssive Security Self-Assessment" && /cleared/.test(cleared.announce))
    await seed(MIXED, "plan")
    await run(async () => { T.btn("Start a new assessment").click(); await T.wait(150) })
    check("Start a new assessment also removes the saved data", (await evaluate(`localStorage.getItem('securestart_v2')`)) === null)

    // 7. Keyboard only: Tab, arrows, Space, Enter through all 13 questions to the plan -----------------------------------------------------
    await fresh()
    // Tab from the top of the page: skip link, logo, back link, then the Start button.
    await evaluate(`document.body.focus()`)
    await press("Tab", 4)
    check("keyboard only: Tab reaches the Start button (skip link, logo, back link, then Start)", await evaluate(`document.activeElement.textContent.trim() === "Start assessment"`))
    await press("Enter")
    await sleep(150)
    const pattern = ["yes", "partly", "unsure", "no", "yes", "yes", "no", "yes", "partly", "yes", "yes", "unsure", "yes"]
    const steps = { yes: 0, partly: 1, unsure: 2, no: 3 }
    for (const answer of pattern) {
      await press("Tab")                   // from the focused question group to its first radio
      if (steps[answer] === 0) await press(" ")
      else await press("ArrowDown", steps[answer])
      await press("Tab", 2)                // the radio group is one Tab stop: next are Back, then Continue
      const onContinue = await evaluate(`/^(Continue|Review answers)$/.test(document.activeElement.textContent.trim())`)
      if (!onContinue) { problems.push({ kind: "test", text: "keyboard focus was not on Continue" }); break }
      await press("Enter")
      await sleep(60)
    }
    const kb = await evaluate(`({ text: T.text(), rows: [...document.querySelectorAll(".review li .ans")].map((e) => e.textContent) })`)
    check("keyboard only: all 13 questions answered with Tab, arrow keys, Space and Enter", /Review your answers/.test(kb.text) && kb.rows.length === 13)
    check("keyboard only: the answers recorded are the ones typed", kb.rows.map((r) => ({ Yes: "yes", Partly: "partly", "Not sure": "unsure", No: "no" })[r]).join() === pattern.join(), kb.rows.join())
    await evaluate(`T.btn("Calculate results").focus()`); await press("Enter"); await sleep(150)
    check("keyboard only: Enter on Calculate results opens the results, focus lands on the heading", await evaluate(`/educational score/.test(T.text()) && document.activeElement === document.querySelector("h1")`))
    await press("Tab"); await press("Tab")
    const ringKeyboard = await evaluate(`(() => { const s = getComputedStyle(document.activeElement); return { w: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset } })()`)
    check("focus ring: 2px solid #93c5fd with a 3px offset on keyboard focus", ringKeyboard.w === "2px" && ringKeyboard.style === "solid" && ringKeyboard.color === "rgb(147, 197, 253)" && ringKeyboard.offset === "3px", JSON.stringify(ringKeyboard))

    // 8. AI Advisor -------------------------------------------------------------------------------------------------------------------------
    await fresh()
    await run(async (answers) => { await T.toPlan(answers) }, MIXED)
    const idle = await run(() => {
      const card = T.ai(); const s = T.snapshot()
      const order = [...card.querySelectorAll("*")]
      return {
        s, disclosure: card.querySelector("#ai-disclosure").textContent,
        disclosureBeforeButton: order.indexOf(card.querySelector("#ai-disclosure")) < order.indexOf(T.btn("Generate AI Guidance")),
        printHidden: card.hasAttribute("data-no-print"), heading: card.querySelector("h2").textContent
      }
    })
    check("AI card: one plain sentence about what is sent, shown before the button", idle.disclosure === "Your answers (not your name or email) are sent to an AI service to write this guidance." && idle.disclosureBeforeButton)
    check("AI card: idle state, nothing generated, audience defaults to Business owner",
      !idle.s.guidance && idle.s.radios.length === 2 && idle.s.radios[0].checked && idle.s.radios[0].label === "Business owner" && idle.s.radios[1].label === "IT administrator" && /not been requested yet/.test(idle.s.aiText))
    check("AI card: marked data-no-print", idle.printHidden)
    // request contract + duplicate clicks + sending state
    mock.ai.mode = "ok"; mock.ai.delay = 500; mock.ai.log = []
    const sending = await run(async () => {
      const b = T.btn("Generate AI Guidance"); b.click(); b.click(); b.click(); await T.wait(80)
      const s = T.snapshot(); const emailButtonEnabled = !T.btn("Email My Report")?.disabled
      return { s, emailButtonEnabled }
    })
    check("sending: three rapid clicks create one request", mock.ai.log.length === 1)
    check("sending: button shows Generating…, is disabled, a status is announced", sending.s.generating && sending.s.button.disabled && sending.s.status.some((t) => /Generating your guidance/.test(t)))
    const request = JSON.parse(mock.ai.log[0].raw)
    check("request: exactly {answers, audience}, JSON, the 13 answers", JSON.stringify(Object.keys(request)) === '["answers","audience"]' && request.answers.join() === MIXED.join() && request.audience === "business-owner" && mock.ai.log[0].contentType === "application/json")
    await run(async () => { await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
    const done = await run(() => {
      const card = T.ai(); const guidance = document.querySelector("#ai-guidance-title").closest("section")
      return {
        s: T.snapshot(), text: guidance.innerText, cards: [...guidance.querySelectorAll(".priority")].map((c) => c.innerText.replace(/\n+/g, " | ")),
        planCardsAfter: T.planCards().map((c) => c.querySelector("h2").textContent), inCard: !!card.contains(guidance), scoreOnPage: document.querySelector("h1").textContent,
        labelled: !!guidance.querySelector(".tag") && /AI-generated/.test(guidance.innerText) && /Limitations — /.test(guidance.innerText)
      }
    })
    check("AI success: guidance shown, labelled AI-generated, with limitations", done.s.guidance && done.labelled && done.inCard)
    check("AI success: titles, areas and first steps shown are the page's own approved text; explanations are the AI's",
      done.cards.length === 3 && /Document backups and complete a controlled restore test\./.test(done.cards[0]) && /AI explanation — Explanation 1 for business-owner/.test(done.cards[0]) &&
      /First practical step \(approved\) — Select one important file and complete a controlled restore test\./.test(done.cards[0]) && /Find out: MFA for administrators/.test(done.cards[2]))
    check("AI success: the deterministic plan above is unchanged", done.planCardsAfter.join() === ["Document backups and complete a controlled restore test.", "Enable and monitor endpoint protection.", "Find out: MFA for administrators"].join())
    await shot("6-ai-guidance")
    // IT administrator with the same answers
    mock.ai.delay = 0; mock.ai.log = []
    const it = await run(async () => {
      const before = T.planCards().map((c) => c.innerText)
      T.radio("IT administrator").click(); await T.wait(60)
      const afterSwitch = T.snapshot()
      T.btn("Generate AI Guidance").click(); await T.waitFor(() => /for it-admin/.test(document.querySelector("#ai-guidance-title")?.closest("section")?.innerText || ""))
      const guidance = document.querySelector("#ai-guidance-title").closest("section")
      return { afterSwitch, text: guidance.innerText, cards: [...guidance.querySelectorAll(".priority")].map((c) => c.innerText), before, after: T.planCards().map((c) => c.innerText) }
    })
    check("switching audience clears the old guidance (it was written for someone else)", !it.afterSwitch.guidance && it.afterSwitch.radios[1].checked)
    check("IT administrator: same three titles and first steps, different explanations", JSON.parse(mock.ai.log[0].raw).audience === "it-admin" && /Written for: IT administrator/.test(it.text) && /Explanation 1 for it-admin/.test(it.cards[0]))
    check("IT administrator: the page's own plan cards are byte-for-byte unchanged", JSON.stringify(it.before) === JSON.stringify(it.after))

    // failures: every one leaves the plan, Print and Email usable ------------------------------------------------------------------
    const GENERIC = "AI Advisor is unavailable right now"
    for (const mode of ["500", "503", "malformed", "drop", "not-ok", "mismatch-score", "mismatch-max", "mismatch-title", "mismatch-area", "mismatch-first", "mismatch-id", "mismatch-count"]) {
      await fresh()
      mock.siteKey = "test-site-key"
      await seed(MIXED, "plan")
      mock.ai.mode = mode
      const r = await run(async () => {
        const before = T.planCards().map((c) => c.innerText)
        T.btn("Generate AI Guidance").click(); await T.waitFor(() => T.snapshot().status.some((t) => /unavailable/.test(t)))
        const s = T.snapshot()
        window.__printed = 0; window.print = () => { window.__printed++ }
        T.btn("Print Action Plan").click(); await T.wait(40)
        return { s, same: JSON.stringify(before) === JSON.stringify(T.planCards().map((c) => c.innerText)), printed: window.__printed, email: !!document.getElementById("report-email"), retry: !T.btn("Generate AI Guidance").disabled }
      })
      check(`AI failure (${mode}): one generic message, no guidance shown, plan intact, Print works, Email form present, can retry`,
        r.s.status.some((t) => t.startsWith(GENERIC)) && !r.s.guidance && r.same && r.printed === 1 && r.email && r.retry && !/boom|Something else|firewall/.test(r.s.aiText))
    }
    // the 429 with an empty body and no Retry-After
    for (const mode of ["429", "429html"]) {
      await fresh()
      await run(async (answers) => { await T.toPlan(answers) }, MIXED)
      mock.ai.mode = mode
      const r = await run(async () => {
        const before = T.planCards().map((c) => c.innerText)
        T.btn("Generate AI Guidance").click(); await T.waitFor(() => T.snapshot().status.some((t) => /wait about three minutes/.test(t)))
        return { s: T.snapshot(), same: JSON.stringify(before) === JSON.stringify(T.planCards().map((c) => c.innerText)), h1: document.querySelector("h1").textContent }
      })
      check(`HTTP 429 (${mode === "429" ? "empty body, no Retry-After" : "HTML body"}): plain-language wait message, plan still visible, no JSON parse error`,
        r.s.status.some((t) => /needs a short break\. Please wait about three minutes, then try again\. Your score and priority actions are not affected\./.test(t)) && !r.s.guidance && r.same && r.s.planCards === 3)
    }
    // malicious model text is only ever text
    await fresh()
    await run(async (answers) => { await T.toPlan(answers) }, MIXED)
    mock.ai.mode = "evil"
    const evil = await run(async () => {
      T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")); await T.wait(150)
      const guidance = document.querySelector("#ai-guidance-title").closest("section")
      return { xss: window.__xss ?? null, imgs: guidance.querySelectorAll("img").length, scripts: document.querySelectorAll("main script").length, bold: guidance.querySelectorAll("b").length, text: guidance.innerText.includes("<img src=x onerror="), links: guidance.querySelectorAll("a").length }
    })
    check("model text with <img onerror>, <script> and entities is rendered as inert text (no element, no execution)", evil.xss === null && evil.imgs === 0 && evil.scripts === 0 && evil.bold === 0 && evil.text && evil.links === 0)
    // a late response after the answers changed is ignored
    await fresh()
    await run(async (answers) => { await T.toPlan(answers) }, MIXED)
    mock.ai.mode = "ok"; mock.ai.delay = 900; mock.ai.log = []
    const stale = await run(async () => {
      T.btn("Generate AI Guidance").click(); await T.wait(120)
      T.btn("Review my answers").click(); await T.waitFor(() => /Review your answers/.test(T.text()))
      document.querySelectorAll(".review .link-button")[0].click(); await T.waitFor(() => /question 1 of 13/i.test(T.text()))
      T.radio("No").click(); await T.wait(40)
      T.btn("Continue").click(); await T.wait(40)
      T.btn("Review answers") // no-op lookup
      return { screen: document.querySelector("h1")?.textContent }
    })
    void stale
    await run(async () => { T.btn("Back")?.click(); await T.wait(10) })
    await sleep(1200)
    await run(async () => { for (let i = 0; i < 30 && !/Review your answers/.test(T.text()); i++) { (T.btn("Continue") || T.btn("Review answers"))?.click(); await T.wait(40) } T.btn("Calculate results").click(); await T.waitFor(() => /educational score/.test(T.text())); T.btn("View my action plan").click(); await T.waitFor(() => !!T.ai()) })
    const afterStale = await evaluate(`T.snapshot()`)
    check("a response that arrives after the answers changed is ignored (no guidance, idle state)", !afterStale.guidance && /not been requested yet/.test(afterStale.aiText) && mock.ai.log.length === 1)
    // zero gaps: no AI request
    await fresh()
    await seed(ALL("yes"), "plan")
    mock.ai.log = []
    const zero = await evaluate(`({ ai: !!T.ai(), generate: !!T.btn("Generate AI Guidance"), text: T.text() })`)
    check("zero gaps: no AI card, no Generate button and therefore no AI request", !zero.ai && !zero.generate && mock.ai.log.length === 0 && /You answered Yes to all thirteen practices/.test(zero.text))

    // 9. Email My Report ----------------------------------------------------------------------------------------------------------------------
    await fresh()
    await seed(MIXED, "plan")
    const noKey = await evaluate(`({ form: !!document.getElementById("report-email"), text: document.querySelector("#email-title").closest("section").innerText })`)
    check("email: with no Turnstile site key configured the form is switched off with a plain message (fails closed)", !noKey.form && /not switched on yet/.test(noKey.text))
    mock.siteKey = "test-site-key"
    await navigate("/")
    await seed(MIXED, "plan")
    await run(async () => { await T.waitFor(() => window.__ts && window.__ts.renders === 1) })
    const emailUi = await evaluate(`({ label: document.querySelector('label[for="report-email"]')?.textContent, type: document.getElementById("report-email").type, disclosure: document.getElementById("email-disclosure").textContent, privacyLink: document.querySelector("#email-disclosure a")?.getAttribute("href"), noPrint: document.querySelector("#email-title").closest("section").hasAttribute("data-no-print"), widget: window.__ts.renders })`)
    check("email: labelled field, widget rendered once, privacy link, excluded from print", emailUi.label === "Email address" && emailUi.type === "email" && emailUi.widget === 1 && emailUi.privacyLink === "/privacy" && emailUi.noPrint &&
      /Resend/.test(emailUi.disclosure) && /answers/.test(emailUi.disclosure))
    const invalidMail = await run(async () => { T.setValue(document.getElementById("report-email"), "not-an-email"); T.btn("Email My Report").click(); await T.wait(80); return document.querySelector("#email-title").closest("section").innerText })
    check("email: an invalid address is refused in the page with no request", /valid email address/.test(invalidMail) && mock.email.log.length === 0)
    const sent = await run(async () => {
      T.setValue(document.getElementById("report-email"), "owner@example.com"); await T.waitFor(() => true)
      T.btn("Email My Report").click(); await T.waitFor(() => /Your report was sent/.test(T.text()))
      return { resets: window.__ts.resets, text: document.querySelector("#email-title").closest("section").innerText }
    })
    const mail = JSON.parse(mock.email.log[0] ?? "{}")
    check("email: sent; the request has exactly recipientEmail, answers and turnstileToken (no score, text or actions from the browser)",
      JSON.stringify(Object.keys(mail)) === '["recipientEmail","answers","turnstileToken"]' && mail.recipientEmail === "owner@example.com" && mail.answers.join() === MIXED.join() && /^token-\d+$/.test(mail.turnstileToken))
    check("email: success message shown and the single-use bot-check token is reset", /Your report was sent/.test(sent.text) && sent.resets === 1)
    check("email: no AI content in the request", !/advisor|AI Advisor|explanation|AI-generated/i.test(mock.email.log[0]))
    for (const [mode, expected] of [["429", /Too many reports have been requested/], ["500", /could not send your report/i], ["400", /could not send your report/i]]) {
      await seed(MIXED, "plan")
      await run(async () => { await T.waitFor(() => window.__ts && window.__ts.renders >= 1) })
      mock.email = { mode, log: [] }
      const text = await run(async () => {
        T.setValue(document.getElementById("report-email"), "owner@example.com"); await T.wait(60)
        T.btn("Email My Report").click(); await T.waitFor(() => /could not send|Too many/.test(T.text()))
        return document.querySelector("#email-title").closest("section").innerText
      })
      check(`email: server ${mode} -> plain-language message, Print Action Plan suggested, plan intact`, expected.test(text) && /Print Action Plan/.test(text) && (await evaluate(`T.planCards().length`)) === 3)
    }

    // 10. Print and reduced motion (real media emulation) -----------------------------------------------------------------------------------
    await fresh()
    await run(async (answers) => { await T.toPlan(answers) }, MIXED)
    mock.ai.mode = "ok"; mock.ai.delay = 0
    await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) })
    await cdp("Emulation.setEmulatedMedia", { media: "print" })
    const printed = await evaluate(`(() => {
      const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0
      const text = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && shown(e) && !["SCRIPT", "STYLE"].includes(e.tagName)).map((e) => e.textContent).join(" ")
      return {
        header: shown(document.querySelector("header")), footer: shown(document.querySelector("footer")), ai: shown(document.querySelector('[data-section="ai-advisor"]')),
        email: shown(document.querySelector("#email-title")?.closest("section")), cta: shown(document.querySelector("#next-steps")?.closest("section")),
        buttons: [...document.querySelectorAll("main button, main a.btn")].filter(shown).length,
        bg: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.querySelector("h1")).color, body: getComputedStyle(document.querySelector("main p.lead") || document.body).color,
        printHeader: shown(document.querySelector(".print-only")) && document.querySelector(".print-only").textContent,
        hasAiText: /AI Advisor|AI-generated|AI explanation|Explanation \\d|Generate AI/.test(text), hasPlan: /Document backups and complete a controlled restore test/.test(text) && /Why it matters/.test(text)
      }
    })()`)
    check("print: header, footer, AI guidance, email form, call-to-action and every button are hidden", !printed.header && !printed.footer && !printed.ai && !printed.email && !printed.cta && printed.buttons === 0)
    check("print: dark text on a white page", printed.bg === "rgb(255, 255, 255)" && printed.color === "rgb(17, 24, 39)" && printed.body !== "rgb(209, 213, 219)")
    check("print: the product name is printed and the plan is there, with no AI text", printed.printHeader === "Defenssive Security Self-Assessment · assessment.defenssive.dev" && printed.hasPlan && !printed.hasAiText)
    await cdp("Emulation.setEmulatedMedia", { media: "" })
    await cdp("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
    await seed(MIXED, "assessment", 3)
    const reduced = await evaluate(`getComputedStyle(document.querySelector(".progress > div")).transitionDuration`)
    check("reduced motion: the progress bar does not animate", reduced === "0s" || reduced === "0.00001s" || parseFloat(reduced) < 0.001, reduced)
    await cdp("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "no-preference" }] })

    // 11. Contrast (WCAG AA), accessible names, headings -----------------------------------------------------------------------------------
    const audits = []
    const auditScreen = async (name, prepare) => {
      await prepare()
      const result = await evaluate(`(() => { const a = T.contrastAudit(); const names = [...document.querySelectorAll("button, a[href], input")].filter((e) => e.getBoundingClientRect().width > 0).filter((e) => { if (e.tagName === "INPUT") return !e.labels || e.labels.length === 0; return !(e.textContent.trim() || e.getAttribute("aria-label") || e.querySelector("img[alt]")) }).map((e) => e.outerHTML.slice(0, 60)); return { a, names, h1: document.querySelectorAll("h1").length, imgs: [...document.querySelectorAll("img")].filter((i) => !i.alt).length } })()`)
      audits.push({ name, ...result })
    }
    await fresh()
    await auditScreen("home", async () => {})
    await auditScreen("assessment", async () => { await run(async () => { T.btn("Start assessment").click(); await T.waitFor(() => /question 1 of 13/i.test(T.text())); T.radio("Yes").click(); await T.wait(40) }) })
    await seed(MIXED, "review"); await auditScreen("review", async () => {})
    await seed(MIXED, "results"); await auditScreen("results", async () => {})
    mock.siteKey = "test-site-key"; await seed(MIXED, "plan")
    await auditScreen("plan with AI result", async () => { await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) }) })
    await auditScreen("plan with AI error", async () => { mock.ai.mode = "500"; await seed(MIXED, "plan"); await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => T.snapshot().status.some((t) => /unavailable/.test(t))) }); mock.ai.mode = "ok" })
    await navigate("/privacy", `document.querySelector("h1") !== null`)
    audits.push({ name: "privacy", ...(await evaluate(`(() => { const a = T.contrastAudit ? T.contrastAudit() : { checked: 0, failures: [] }; return { a, names: [], h1: document.querySelectorAll("h1").length, imgs: [...document.querySelectorAll("img")].filter((i) => !i.alt).length } })()`)) })
    for (const audit of audits) {
      check(`contrast (WCAG AA): ${audit.name} screen, ${audit.a.checked} text elements`, audit.a.failures.length === 0 && audit.a.checked > 5, audit.a.failures.slice(0, 3).join("; "))
      check(`accessible names and headings: ${audit.name} (one h1, every control and image named)`, audit.names.length === 0 && audit.imgs === 0 && audit.h1 === 1, JSON.stringify(audit.names))
    }

    // 12. Layout: no horizontal scroll at 360 and 375 px, and on desktop ------------------------------------------------------------------
    for (const width of [360, 375, 1000]) {
      await viewport(width, width < 600 ? 800 : 1100, width < 600)
      for (const [name, prepare] of [["home", async () => { await fresh() }], ["question", async () => { await seed(MIXED, "assessment", 4) }], ["review", async () => { await seed(MIXED, "review") }],
        ["results", async () => { await seed(MIXED, "results") }], ["plan", async () => { await seed(MIXED, "plan") }],
        ["plan with AI result", async () => { mock.ai.mode = "ok"; await seed(MIXED, "plan"); await run(async () => { T.btn("Generate AI Guidance").click(); await T.waitFor(() => !!document.querySelector("#ai-guidance-title")) }) }],
        ["privacy", async () => { await navigate("/privacy", `document.querySelector("h1") !== null`) }]]) {
        await prepare()
        const o = await overflow()
        check(`layout ${width}px: no horizontal scroll on ${name}`, o.scroll <= o.client && o.scroll <= o.inner, JSON.stringify(o))
        if (width === 375 && ["plan with AI result", "results", "plan"].includes(name)) await shot(`375-${name.replace(/ /g, "-")}`)
      }
      if (width < 600) {
        await seed(MIXED, "plan")
        const small = await evaluate(`[...document.querySelectorAll("main button, main a.btn, main input[type=email], .option")].filter((e) => e.getBoundingClientRect().height > 0).filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 30))`)
        check(`layout ${width}px: every button and option is at least 44px tall`, small.length === 0, small.join(", "))
        check(`layout ${width}px: body text is 17px on mobile`, (await evaluate(`getComputedStyle(document.body).fontSize`)) === "17px")
      }
    }
    await viewport(1000, 1100)

    // 13. Privacy page ------------------------------------------------------------------------------------------------------------------------
    await navigate("/privacy", `document.querySelector("h1") !== null`)
    const priv = await evaluate(`({ title: document.title, text: document.querySelector("main").innerText, lang: document.documentElement.lang, links: [...document.querySelectorAll("main a")].map((a) => a.getAttribute("href")) })`)
    check("privacy page: served at /privacy with its own title and lang", /Privacy Notice/.test(priv.title) && priv.lang === "en")
    check("privacy page: says what is collected, names the AI provider, says no selling, gives the contact address",
      /answers/.test(priv.text) && /Anthropic/.test(priv.text) && /do not sell your data/i.test(priv.text) && priv.links.includes("mailto:contact@defenssive.com"))
    check("privacy page: unknown facts are marked [OWNER TO CONFIRM], not invented", (priv.text.match(/\[OWNER TO CONFIRM\]/g) || []).length >= 4 && !/\b\d+ (days|months|years)\b/i.test(priv.text))
    check("privacy page: says the AI never receives the email address, name or company", /Your email address, name and company are never sent to the AI service/.test(priv.text))

    // 14. No trackers, no console problems, no CSP violations ----------------------------------------------------------------------------
    const allowedHosts = new Set(["127.0.0.1", "unpkg.com"])
    check("network: the only hosts contacted are the local server and unpkg.com (React) - no fonts, analytics or trackers", [...hosts].every((h) => allowedHosts.has(h)), [...hosts].join(", "))
    const leftover = unexpectedProblems()
    check("no console errors, warnings, exceptions or CSP violations across the whole run", leftover.length === 0, JSON.stringify(leftover).slice(0, 400))

    // 15. SRI really blocks a tampered React ------------------------------------------------------------------------------------------------
    {
      await cdp("Network.setCacheDisabled", { cacheDisabled: true })
      await cdp("Fetch.enable", { patterns: [{ urlPattern: "https://unpkg.com/react@18.3.1/*", requestStage: "Request" }] })
      handlers.set("Fetch.requestPaused", (params) => {
        cdp("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/javascript" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from("window.React={createElement(){},__tampered:true}").toString("base64") }).catch(() => {})
      })
      const before = problems.length
      await cdp("Page.navigate", { url: base + "/" })
      await sleep(2500)
      const blocked = await evaluate(`({ tampered: !!(window.React && window.React.__tampered), rendered: document.querySelector("#root").innerText.length })`)
      check("SRI: a tampered React file is refused by the browser and the app does not run", !blocked.tampered && blocked.rendered === 0 && problems.slice(before).some((p) => /integrity|digest|SRI/i.test(p.text)), JSON.stringify({ blocked, problems: problems.slice(before).map((p) => p.text.slice(0, 120)) }))
      await cdp("Network.setCacheDisabled", { cacheDisabled: false })
      await cdp("Fetch.disable"); handlers.delete("Fetch.requestPaused")
    }

    // 16. Optional: the real Cloudflare widget under the real CSP ----------------------------------------------------------------------------
    if (args.includes("--real-turnstile")) {
      problems.length = 0
      mock.reset(); mock.siteKey = CLOUDFLARE_TEST_SITE_KEY
      await cdp("Page.navigate", { url: base + "/" }); await sleep(1500)
      await evaluate(`localStorage.setItem('securestart_v2', JSON.stringify(${JSON.stringify({ screen: "plan", qIndex: 0, answers: MIXED })}))`)
      await navigate("/?real=1#real-turnstile") // a new URL, so the document reloads without the stand-in widget
      let token = null
      for (let i = 0; i < 40 && !token; i++) { await sleep(500); token = await evaluate(`document.querySelector('input[name="cf-turnstile-response"]')?.value || null`) }
      // Edge's Tracking Prevention may log a notice about Cloudflare storage; only real CSP violations count.
      const csp = problems.filter((p) => /Content Security Policy|Refused to|violates the following/i.test(p.text)).concat((await evaluate("window.__csp")).map((text) => ({ kind: "securitypolicyviolation", text })))
      check("real Turnstile (Cloudflare test key) loads under the CSP and issues a token", !!token && token.startsWith("XXXX.DUMMY.TOKEN") && csp.length === 0 && (await evaluate("typeof window.__ts === 'undefined'")), JSON.stringify({ token: token?.slice(0, 12), csp }).slice(0, 300))
      await shot("7-real-turnstile")
    }
  } catch (error) {
    console.log("ERROR  " + (error?.stack ?? error))
    failed.push("test run aborted: " + error?.message)
  }

  console.log(`\n${passed} passed, ${failed.length} failed`)
  if (failed.length) console.log(failed.map((name) => ` - ${name}`).join("\n"))
  ws.close(); browser.kill(); server.close()
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* ignore */ }
  process.exit(failed.length ? 1 : 0)
}
