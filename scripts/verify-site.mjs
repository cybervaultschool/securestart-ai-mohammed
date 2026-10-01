// Fails the Netlify build (or a local run) if the deployed site, the source app and the
// email function drift apart. Run locally with: node scripts/verify-site.mjs
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import vm from "node:vm"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = "SecureStart AI.dc.html"
const SITE = "site/index.html"
const FUNCTION = "netlify/functions/send-report.mjs"
const AI_FUNCTION = "netlify/functions/ai-guidance.mjs"
const DEPLOY_ONLY_MARKER = "Training deployment: Day 6"

const failures = []
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` (${detail})`}`)
  if (!ok) failures.push(name)
}
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

for (const path of [SOURCE, SITE, FUNCTION, AI_FUNCTION, "netlify.toml"]) check(`${path} exists`, existsSync(join(root, path)))
if (failures.length) process.exit(1)

const source = read(SOURCE)
const site = read(SITE)
const fnSource = read(FUNCTION)

// 1. The deployed page must be the source app, plus at most the deploy-only footer line.
const siteLines = site.split("\n").filter((line) => !line.includes(DEPLOY_ONLY_MARKER))
const sourceLines = source.split("\n")
const firstDifference = siteLines.findIndex((line, index) => line !== sourceLines[index])
check(`${SITE} matches ${SOURCE} (apart from the deploy-only footer)`,
  siteLines.length === sourceLines.length && firstDifference === -1,
  `first difference near line ${firstDifference === -1 ? Math.min(siteLines.length, sourceLines.length) + 1 : firstDifference + 1}; ` +
  `edit ${SOURCE}, then copy it to ${SITE}`)

// 2. Both copies keep the email feature and never call an email provider from the browser.
for (const [name, text] of [[SOURCE, source], [SITE, site]]) {
  check(`${name} posts reports to /api/send-report`, text.includes("'/api/send-report'"))
  check(`${name} has the report email field`, text.includes('id="report-email"') && text.includes("Email My Report"))
  check(`${name} has no browser-side provider call or key`, !/api\.resend\.com|emailjs|RESEND_API_KEY|re_[A-Za-z0-9]{16,}|api\.anthropic\.com|ANTHROPIC_API_KEY|CLAUDE_MODEL|x-api-key/i.test(text))
  check(`${name} states that the report is sent to an email provider`, text.includes("securely sent to our email provider only for report delivery"))
}

// 3. The function's approved content must equal the app's own actions, so the server can
//    only ever send text the application itself produces.
const appActions = vm.runInNewContext(`(${source.match(/this\.actions = (\[[\s\S]*?\n {4}\])/)[1]})`)
  .map(({ area, title, why, first }) => ({ area, title, why, first }))
const serverActions = JSON.parse(fnSource.match(/const APPROVED_ACTIONS = (\[[\s\S]*?\n\])/)[1])
check("function allowlist equals the app's approved actions",
  appActions.length === 10 && JSON.stringify(appActions) === JSON.stringify(serverActions))

// 4. Route and rate limit must stay declared on the function.
const { config } = await import(pathToFileURL(join(root, FUNCTION)).href)
check("function route is /api/send-report", config?.path === "/api/send-report")
check("function rate limit is 3 requests / 60 s per ip + domain",
  config?.rateLimit?.windowLimit === 3 && config?.rateLimit?.windowSize === 60 &&
  JSON.stringify(config?.rateLimit?.aggregateBy) === JSON.stringify(["ip", "domain"]))

// 5. No leftover email-provider code, and Netlify still publishes the site folder.
check("no legacy email-provider code (Postmark / EmailJS)", ![source, site, fnSource].some((text) => /postmark|emailjs/i.test(text)))
check('netlify.toml publishes "site"', /publish\s*=\s*"site"/.test(read("netlify.toml")))

// 6. AI Advisor function: approved catalogue, route, rate limit, and a minimal footprint.
const aiSource = read(AI_FUNCTION)
const catalogue = JSON.parse(aiSource.match(/const APPROVED_CATALOGUE = (\[[\s\S]*?\n\])/)[1])
check("AI Advisor catalogue equals the app's approved actions",
  catalogue.length === 10 && JSON.stringify(catalogue.map(({ area, title, why, first }) => ({ area, title, why, first }))) === JSON.stringify(appActions))
check("AI Advisor control ids are ten unique kebab-case ids",
  new Set(catalogue.map((entry) => entry.id)).size === 10 && catalogue.every((entry) => /^[a-z]+(?:-[a-z]+)*$/.test(entry.id)))
const aiConfig = (await import(pathToFileURL(join(root, AI_FUNCTION)).href)).config
check("AI Advisor route is /api/ai-guidance", aiConfig?.path === "/api/ai-guidance")
check("AI Advisor rate limit is 3 requests / 5 min per ip + domain",
  aiConfig?.rateLimit?.windowLimit === 3 && aiConfig?.rateLimit?.windowSize === 300 &&
  JSON.stringify(aiConfig?.rateLimit?.aggregateBy) === JSON.stringify(["ip", "domain"]))
check("AI Advisor uses native fetch only (no import, SDK or beta header)", !/^\s*import\s|require\(|@anthropic-ai|anthropic-beta/m.test(aiSource))
check("AI Advisor reads no client identity (only content-length; no IP or forwarding headers)",
  [...aiSource.matchAll(/headers\.get\(\s*["']([^"']+)["']/g)].every((match) => match[1] === "content-length") &&
  !/x-forwarded|x-nf-|context\.ip/i.test(aiSource))

if (failures.length) {
  console.error(`\nverify-site: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nverify-site: all checks passed")
