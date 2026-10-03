// Build guard. Netlify runs this as the build command, so a deploy that breaks a safety property fails
// before it goes live. It needs no network and no dependencies.   Run locally: node scripts/verify-site.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const failures = []
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` (${detail})`}`)
  if (!ok) failures.push(name)
}
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const REQUIRED = [
  "site/index.html", "site/privacy.html", "site/app.js", "site/assessment.js", "site/styles.css",
  "site/favicon.ico", "site/favicon-32x32.png", "site/favicon-16x16.png", "site/apple-touch-icon.png",
  "site/assets/defenssive-logo-white.png", "site/assets/inter-latin.woff2",
  "netlify/functions/ai-guidance.mjs", "netlify/functions/send-report.mjs", "netlify/lib/send-report-core.mjs",
  "netlify.toml", "package.json"
]
for (const path of REQUIRED) check(`${path} exists`, existsSync(join(root, path)))
if (failures.length) process.exit(1)

const html = read("site/index.html")
const privacy = read("site/privacy.html")
const app = read("site/app.js")
const shared = read("site/assessment.js")
const css = read("site/styles.css")
const toml = read("netlify.toml")
const aiSource = read("netlify/functions/ai-guidance.mjs")
const reportCore = read("netlify/lib/send-report-core.mjs")
const reportFn = read("netlify/functions/send-report.mjs")

// 1. No leftover Claude Design runtime (it needs eval, which the CSP forbids).
check("the old Claude Design runtime and design system are gone",
  !existsSync(join(root, "site/support.js")) && !existsSync(join(root, "site/_ds")) && !existsSync(join(root, "SecureStart AI.dc.html")))

// 2. Page basics.
check('<html lang="en">', /<html lang="en">/.test(html) && /<html lang="en">/.test(privacy))
check("page title is 'Free Security Self-Assessment | Defenssive'", /<title>Free Security Self-Assessment \| Defenssive<\/title>/.test(html))
const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1] ?? ""
check("meta description is plain language and about 150 characters", description.length >= 120 && description.length <= 175, `${description.length} characters`)
check("Open Graph title and description", /property="og:title"/.test(html) && /property="og:description"/.test(html))
check("favicon links", /rel="icon"/.test(html) && /apple-touch-icon/.test(html))
check("viewport meta tag", /name="viewport"/.test(html))

// 3. Scripts: React only from unpkg, pinned, with SRI; one local module; nothing inline.
const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0])
const external = scriptTags.filter((tag) => /src="https?:/.test(tag))
check("exactly two external scripts: React and ReactDOM 18.3.1 from unpkg",
  external.length === 2 && external.every((tag) => /src="https:\/\/unpkg\.com\/react(-dom)?@18\.3\.1\/umd\/react(-dom)?\.production\.min\.js"/.test(tag)))
check("both React scripts keep their SRI hash and crossorigin attribute",
  external.every((tag) => /integrity="sha384-[A-Za-z0-9+/=]{64}"/.test(tag) && /crossorigin="anonymous"/.test(tag)))
check("React SRI hashes are the known ones",
  html.includes("sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z") &&
  html.includes("sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1"))
check("no inline script, no inline event handler, no style attribute (CSP has no 'unsafe-inline')",
  scriptTags.every((tag) => /src="/.test(tag)) && !/\son[a-z]+="/i.test(html + privacy) && !/\sstyle="/.test(html + privacy) && !/<style/i.test(html + privacy))
check("the Netlify HUD script is not part of the repository", !/netlify\/scripts\/hud/.test(html + privacy))
check("no analytics or tracker code anywhere in the site",
  ![html, privacy, app, css].some((text) => /google-analytics|googletagmanager|gtag\(|plausible|segment\.|hotjar|fbq\(|clarity\.ms|mixpanel|matomo/i.test(text)))
check("the only third-party origins in the page and app are unpkg and Cloudflare Turnstile",
  [...new Set([html, app].flatMap((text) => [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase())))]
    .every((host) => ["unpkg.com", "challenges.cloudflare.com", "defenssive.com", "assessment.defenssive.dev", "app.defenssive.dev", "www.w3.org", "claude.com"].includes(host)),
  [...new Set([html, app].flatMap((text) => [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase())))].join(", "))

// 4. Brand and links.
check("visible product name is Defenssive Security Self-Assessment everywhere", [html, privacy, app].every((text) => text.includes("Defenssive Security Self-Assessment")))
check("no SecureStart AI wording in the site or functions",
  ![html, privacy, app, shared, aiSource, reportCore, reportFn].some((text) => /securestart ai/i.test(text)))
check("header: logo links to defenssive.com and there is a Back to defenssive.com link",
  html.includes('class="brand" href="https://defenssive.com"') && html.includes("Back to defenssive.com"))
check("footer: Defenssive Cybersecurity LLC, defenssive.com, privacy notice, Terms",
  html.includes("Defenssive Cybersecurity LLC") && html.includes('href="/privacy"') && html.includes('href="https://app.defenssive.dev/terms"'))
check("both calls to action exist with the right links",
  app.includes('"https://defenssive.com/contact#send-a-message"') && app.includes('"Book a free 30-minute review"') &&
  /PRODUCT_URL = "https:\/\/defenssive\.com(\/#product)?"/.test(app) && app.includes("Own Microsoft 365? See our read-only security assessment product"))

// 5. Design tokens (exact values from defenssive.com) and accessibility CSS.
for (const token of ["--background: #0a0f1a", "--surface: #111827", "--foreground: #ffffff", "--muted-foreground: #d1d5db", "--soft: #9ca3af",
  "--primary: #3b82f6", "--border: #ffffff14", "--border-strong: #ffffff29", "--destructive: #e40014", "--success: #34d399"]) {
  check(`design token ${token}`, css.includes(token))
}
check("Inter is self-hosted (no Google Fonts request)", /@font-face[^}]*Inter[^}]*inter-latin\.woff2/s.test(css) && !/fonts\.(googleapis|gstatic)\.com/.test(html + css + privacy))
check("focus ring is 2px #93c5fd with a 3px offset", /outline:\s*2px solid var\(--focus\);\s*outline-offset:\s*3px/.test(css) && css.includes("--focus: #93c5fd"))
check("reduced-motion and print styles exist", css.includes("prefers-reduced-motion: reduce") && /@media print[\s\S]*background: #fff/.test(css))

// 6. App safety rules.
check("the app never inserts HTML or evaluates code",
  !/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|outerHTML/.test(app))
check("the app never calls Anthropic and never mentions a provider key",
  !/api\.anthropic\.com|ANTHROPIC|x-api-key|CLAUDE_MODEL|RESEND_API_KEY|api\.resend\.com|TURNSTILE_SECRET/i.test(html + app + shared))
check("saved answers use securestart_v2 and the old v1 key is never read", app.includes('"securestart_v2"') && !/(get|set|remove)Item\([^)]*securestart_v1/.test(app) && !/STORAGE_KEY = "securestart_v1"/.test(app))
check("the AI request carries only the answers and the audience",
  app.includes('fetch("/api/ai-guidance"') && app.includes("JSON.stringify({ answers, audience })"))
check("HTTP 429 from the AI endpoint is handled before any JSON parsing",
  app.includes("response.status === 429") && app.indexOf("response.status === 429") < app.indexOf("response.json().then"))
check("the email request carries only recipientEmail, answers and the Turnstile token",
  app.includes("JSON.stringify({ recipientEmail: input.value.trim(), answers, turnstileToken: token })"))
check("the AI response is accepted only if score, maxScore, titles, areas and first steps equal the page's own",
  ["json.score !== local.score", "json.maxScore !== MAX_SCORE", "given.title !== action.title", "given.area !== action.area", "given.firstStep !== action.first"].every((fragment) => app.includes(fragment)))
check("the AI one-sentence notice is shown before the button",
  app.includes("Your answers (not your name or email) are sent to an AI service to write this guidance.") &&
  app.indexOf("ai-disclosure") < app.indexOf('"Generate AI Guidance"'))
check("AI guidance, email and the call-to-action card are excluded from print", ['"data-section": "ai-advisor"', '"data-no-print": "true"'].every((fragment) => app.includes(fragment)) &&
  /"data-no-print": "true", "data-section": "ai-advisor"/.test(app))
check("Clear my answers is on the results screen", app.includes('"Clear my answers"') && app.includes("clearSaved"))
check("results are announced to screen readers (live region)", app.includes('"aria-live": "polite"') && app.includes("Your result:"))
check("the progress bar has an accessible label", app.includes('"aria-label": "Assessment progress"') && app.includes('role: "progressbar"'))

// 7. No hard-coded maximum score of 20, and the shared module has the specified shape.
const hard20 = Object.entries({ "site/app.js": app, "site/assessment.js": shared, "netlify/functions/ai-guidance.mjs": aiSource, "netlify/lib/send-report-core.mjs": reportCore })
  .filter(([, text]) => /(?<![\w.#-])20(?![\w%])/.test(text.replace(/\/\/.*$/gm, ""))).map(([name]) => name)
check("no hard-coded 20 in the app, shared module or functions", hard20.length === 0, hard20.join(", "))
const assessment = await import(pathToFileURL(join(root, "site/assessment.js")).href)
check("shared module: 13 questions, maximum score 26, four answer values",
  assessment.QUESTION_COUNT === 13 && assessment.MAX_SCORE === 26 && assessment.ANSWER_VALUES.join() === "yes,partly,unsure,no")
check("shared module: risk order lists every control once",
  new Set(assessment.RISK_ORDER).size === 13 && assessment.QUESTIONS.every((question) => assessment.RISK_ORDER.includes(question.id)))
check("both functions use the shared module (one source of truth)",
  aiSource.includes('from "../../site/assessment.js"') && reportCore.includes('from "../../site/assessment.js"'))

// 8. Functions: routes, limits, minimal footprint.
const ai = (await import(pathToFileURL(join(root, "netlify/functions/ai-guidance.mjs")).href)).config
check("AI route /api/ai-guidance, 3 requests / 180 s per ip + domain (Netlify ignores windows outside 10-180 s)",
  ai?.path === "/api/ai-guidance" && ai?.rateLimit?.windowLimit === 3 && ai?.rateLimit?.windowSize === 180 && JSON.stringify(ai?.rateLimit?.aggregateBy) === '["ip","domain"]')
const report = (await import(pathToFileURL(join(root, "netlify/functions/send-report.mjs")).href)).config
check("email route /api/send-report, 3 requests / 60 s per ip + domain at the edge",
  report?.path === "/api/send-report" && report?.rateLimit?.windowLimit === 3 && report?.rateLimit?.windowSize === 60 && JSON.stringify(report?.rateLimit?.aggregateBy) === '["ip","domain"]')
check("AI function: native fetch only (its one import is the shared module), no SDK, no beta header",
  [...aiSource.matchAll(/^\s*import\s.*from\s+"([^"]+)"/gm)].every((match) => match[1] === "../../site/assessment.js") && !/require\(|@anthropic-ai|anthropic-beta/.test(aiSource))
check("AI function reads no client identity", [...aiSource.matchAll(/headers\.get\(\s*["']([^"']+)["']/g)].every((match) => match[1] === "content-length") && !/x-forwarded|x-nf-|context\.ip/i.test(aiSource))
check("email function accepts exactly recipientEmail, answers and turnstileToken", /ALLOWED_KEYS = \["recipientEmail", "answers", "turnstileToken"\]/.test(reportCore))
check("email function: Turnstile, hourly per-IP and daily per-recipient limits, hashed keys",
  /siteverify/.test(reportCore) && /ip: \{ max: 3, windowMs: HOUR \}/.test(reportCore) && /recipient: \{ max: 2, windowMs: DAY \}/.test(reportCore) && /sha256\(/.test(reportCore))
check("email function never logs addresses, answers or tokens (console calls carry fixed text only)",
  [...(reportCore + reportFn).matchAll(/console\.\w+\(([^)]*)\)/g)].every((match) => /^"[^"]*"(, [a-z.]+status)?$/i.test(match[1].trim())))
check("email function has no tracking pixels or remote images", !/<img|src=|tracking|pixel/i.test(reportCore))
const lock = JSON.parse(read("package.json"))
check("the only dependency is a pinned @netlify/blobs", JSON.stringify(Object.keys(lock.dependencies ?? {})) === '["@netlify/blobs"]' && /^\d+\.\d+\.\d+$/.test(lock.dependencies["@netlify/blobs"]))

// 9. Netlify config: build command, privacy route and security headers.
check('netlify.toml publishes "site" and runs this guard', /publish\s*=\s*"site"/.test(toml) && /command\s*=\s*"node scripts\/verify-site\.mjs"/.test(toml))
check("/privacy is routed to privacy.html", /from = "\/privacy"\s+to = "\/privacy\.html"/.test(toml))
const header = (name) => toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? ""
const csp = header("Content-Security-Policy")
for (const directive of ["default-src 'self'", "script-src 'self' https://unpkg.com https://challenges.cloudflare.com", "style-src 'self'", "font-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "frame-src https://challenges.cloudflare.com", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) {
  check(`CSP has ${directive}`, csp.split("; ").includes(directive))
}
check("CSP has no 'unsafe-eval' and no 'unsafe-inline'", !/unsafe-eval|unsafe-inline/.test(csp))
check("X-Content-Type-Options: nosniff", header("X-Content-Type-Options") === "nosniff")
check("X-Frame-Options: DENY", header("X-Frame-Options") === "DENY")
check("Referrer-Policy: strict-origin-when-cross-origin", header("Referrer-Policy") === "strict-origin-when-cross-origin")
check("Permissions-Policy: camera=(), microphone=(), geolocation=()", header("Permissions-Policy") === "camera=(), microphone=(), geolocation=()")
check("Strict-Transport-Security: max-age=31536000; includeSubDomains", header("Strict-Transport-Security") === "max-age=31536000; includeSubDomains")

// 10. Privacy notice: every unknown fact stays flagged for the owner.
check("privacy notice: collects what, AI provider named, no selling, contact address",
  /Anthropic/.test(privacy) && /do not sell your data/i.test(privacy) && privacy.includes("contact@defenssive.com") && /never sent to the AI service/i.test(privacy))
check("privacy notice keeps unknown facts marked [OWNER TO CONFIRM] (no invented retention period)", (privacy.match(/\[OWNER TO CONFIRM\]/g) ?? []).length >= 4)

// 11. Nothing oversized or unexpected in the published folder.
const walk = (dir) => readdirSync(join(root, dir)).flatMap((name) => (statSync(join(root, dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]))
const published = walk("site")
check("published folder holds only expected files", published.every((file) => /\.(html|js|css|png|ico|woff2)$/.test(file)), published.filter((file) => !/\.(html|js|css|png|ico|woff2)$/.test(file)).join(", "))
// Turnstile secrets and site keys look alike (0x4AAAAAA...). Only the one public site key in its meta tag is allowed.
const htmlWithoutSiteKey = html.replace(/<meta name="turnstile-site-key" content="0x4AAAAAA[A-Za-z0-9_-]{10,}">/, "")
check("no secret-looking value in the repository's published or function code",
  ![htmlWithoutSiteKey, privacy, app, shared, css, aiSource, reportCore, reportFn].some((text) => /sk-ant-[A-Za-z0-9_-]{10,}|re_[A-Za-z0-9]{20,}|0x4AAAAAA[A-Za-z0-9_-]{10,}/.test(text)))

if (failures.length) {
  console.error(`\nverify-site: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nverify-site: all checks passed")
