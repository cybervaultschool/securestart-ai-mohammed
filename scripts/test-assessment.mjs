// Unit tests for site/assessment.js: scoring, risk-ordered action selection and results wording.
// Run: node scripts/test-assessment.mjs   (Node only, no dependencies)
import {
  ANSWER_VALUES, CRITICAL_IDS, MAX_SCORE, NOT_SURE_FIRST_STEP, QUESTIONS, QUESTION_COUNT, RISK_ORDER, assess, isAnswerArray
} from "../site/assessment.js"

let passed = 0
const failures = []
const check = (name, ok, detail = "") => {
  if (ok) passed++
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` (${detail})` : ""}`) }
}

const ids = QUESTIONS.map((question) => question.id)
// Builds an answer array: everything `base`, with named controls overridden.
const make = (base, overrides = {}) => ids.map((id) => overrides[id] ?? base)
const actionIds = (answers) => assess(answers).actions.map((action) => action.id)

// ---- the data itself ----
check("13 questions, in the approved order", QUESTION_COUNT === 13 && ids.join() ===
  "mfa,admin-mfa,admin-accounts,passwords,backups,updates,endpoint,encryption,awareness,incident-plan,remote-access,leavers,sharing")
check("maximum score is 26 (13 x 2)", MAX_SCORE === 26)
check("four answer values: yes, partly, unsure, no", ANSWER_VALUES.join() === "yes,partly,unsure,no")
check("every question has area, text, help and an approved action", QUESTIONS.every((q) =>
  q.area && q.text.endsWith("?") && q.help.endsWith(".") && q.action.title && q.action.why && q.action.first && q.topic))
check("each question is about one thing (single question mark, no 'and/or' lists of topics)", QUESTIONS.every((q) => (q.text.match(/\?/g) || []).length === 1))
check("risk order is the approved one", RISK_ORDER.join() === "mfa,admin-mfa,remote-access,backups,admin-accounts,updates,endpoint,passwords,leavers,sharing,encryption,awareness,incident-plan")
check("risk order lists every control exactly once", new Set(RISK_ORDER).size === 13 && RISK_ORDER.every((id) => ids.includes(id)))
check("critical controls are Q1 (mfa), Q2 (admin-mfa) and Q5 (backups)", CRITICAL_IDS.join() === "mfa,admin-mfa,backups")
check("new actions exist for Q2, Q12 and Q13 as specified",
  QUESTIONS[1].action.title === "Require MFA for administrator accounts." &&
  QUESTIONS[11].action.first === "List everyone who left in the last 12 months and check their accounts." &&
  QUESTIONS[12].action.first === "Find links shared with \"anyone\" and remove the ones you do not need.")

// ---- answer validation ----
check("a valid 13-answer array is accepted", isAnswerArray(make("yes")))
check("an old 10-answer array is rejected", !isAnswerArray(Array(10).fill("yes")))
check("a null answer is rejected", !isAnswerArray(make("yes").map((answer, index) => (index === 0 ? null : answer))))
check("the old 'Partly / Unsure' value is rejected", !isAnswerArray(make("yes", { mfa: "Partly / Unsure" })))
check("non-arrays are rejected", !isAnswerArray("yes") && !isAnswerArray(null) && !isAnswerArray({ length: 13 }))
check("assess() returns null for invalid input", assess(Array(10).fill("yes")) === null)

// ---- acceptance case: all Yes ----
const allYes = assess(make("yes"))
check("all Yes: score 26 / 26", allYes.score === 26 && allYes.maxScore === 26)
check("all Yes: careful perfect-score wording, exactly",
  allYes.headline === "You answered Yes to all thirteen practices. These are your own answers, not a test of your systems. Repeat this assessment periodically.")
check("all Yes: never says 'all practices are in place' or implies security", !/in place|secure|safe|protected/i.test(allYes.headline))
check("all Yes: no actions and no gaps", allYes.actions.length === 0 && allYes.gaps.length === 0 && allYes.allYes)

// ---- acceptance case: all No ----
const allNo = assess(make("no"))
check("all No: score 0", allNo.score === 0)
check("all No: critical-gap wording", allNo.criticalGap && allNo.headline === "Your answers show at least one important gap. Start with the actions below.")
check("all No: the first three risk-order actions", actionIds(make("no")).join() === "mfa,admin-mfa,remote-access")

// ---- acceptance case: MFA = No, everything else Yes ----
const mfaOnly = assess(make("yes", { mfa: "no" }))
check("MFA No only: score 24 (92%) still gets the critical-gap override",
  mfaOnly.score === 24 && mfaOnly.band === "high" && mfaOnly.criticalGap && !/most practices/i.test(mfaOnly.headline))
check("MFA No only: headline is the important-gap sentence", mfaOnly.headline === "Your answers show at least one important gap. Start with the actions below.")
for (const id of CRITICAL_IDS) {
  const r = assess(make("yes", { [id]: "no" }))
  check(`critical override fires when only ${id} is No`, r.criticalGap && !/most practices/i.test(r.headline))
}
for (const id of ids.filter((id) => !CRITICAL_IDS.includes(id))) {
  const r = assess(make("yes", { [id]: "no" }))
  check(`no critical override when only ${id} is No (24/26 is "most practices")`, !r.criticalGap && /most practices/.test(r.headline))
}
check("a critical control answered Partly or Not sure does not trigger the override",
  !assess(make("yes", { mfa: "partly", "admin-mfa": "unsure" })).criticalGap)

// ---- acceptance case: mixture with Not sure ----
const mixed = make("yes", { "admin-mfa": "unsure", backups: "no", updates: "no", "remote-access": "partly", passwords: "unsure" })
const mixedResult = assess(mixed)
check("mixed: No actions first (risk order), then Not sure", actionIds(mixed).join() === "backups,updates,admin-mfa")
check("mixed: the Not sure action is a 'Find out' action with the fixed first step",
  mixedResult.actions[2].title === "Find out: MFA for administrators" && mixedResult.actions[2].first === NOT_SURE_FIRST_STEP &&
  NOT_SURE_FIRST_STEP === "Ask your IT provider or check the settings, then answer this question again.")
check("mixed: score = 2*yes + partly", mixedResult.score === 2 * 8 + 1)
check("Not sure answers score 0 and are listed as gaps",
  assess(make("yes", { mfa: "unsure" })).score === 24 && assess(make("yes", { mfa: "unsure" })).gaps.length === 1)
check("Not sure before Partly: one Not sure and three Partly shows the Not sure first",
  actionIds(make("yes", { sharing: "unsure", mfa: "partly", "admin-mfa": "partly", backups: "partly" }))[0] === "sharing")

// ---- acceptance case: Partly only ----
const partly = assess(make("partly"))
check("all Partly: score 13, middle band wording",
  partly.score === 13 && partly.band === "middle" && !partly.criticalGap &&
  partly.headline === "Your answers indicate that some practices are in place and others are missing or only partly in place.")
check("all Partly: first three risk-order actions with ordinary titles",
  actionIds(make("partly")).join() === "mfa,admin-mfa,remote-access" && partly.actions.every((a) => !a.title.startsWith("Find out")))

// ---- band boundaries (percent of 26) ----
const noCritical = (score) => {
  // Put Yes answers on the critical controls first so the band wording (not the override) is tested.
  const order = ["mfa", "admin-mfa", "backups", ...ids.filter((id) => !CRITICAL_IDS.includes(id))]
  const answers = Object.fromEntries(ids.map((id) => [id, "unsure"]))
  let remaining = score
  for (const id of order) { if (remaining >= 2) { answers[id] = "yes"; remaining -= 2 } else if (remaining === 1) { answers[id] = "partly"; remaining -= 1 } }
  return ids.map((id) => answers[id])
}
for (const [score, band] of [[26, "high"], [20, "high"], [19, "middle"], [11, "middle"], [10, "low"], [0, "low"]]) {
  const r = assess(noCritical(score))
  check(`score ${score}/26 is the ${band} band`, r.score === score && r.band === band, `got ${r.score} ${r.band}`)
}
check("75% or more: 'most practices are in place'", /most practices are in place/.test(assess(noCritical(20)).headline))
check("below 40%: 'several are not yet in place'", /several practices are not yet in place/.test(assess(noCritical(10)).headline))

// ---- property test against an independent reference implementation ----
const rank = { no: 0, unsure: 1, partly: 2 }
const reference = (answers) => ids
  .map((id, index) => ({ id, level: answers[index] }))
  .filter(({ level }) => level !== "yes")
  .sort((a, b) => rank[a.level] - rank[b.level] || RISK_ORDER.indexOf(a.id) - RISK_ORDER.indexOf(b.id))
  .slice(0, 3)
let seed = 12345
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
let mismatches = 0
let badScore = 0
let badOverride = 0
for (let i = 0; i < 20000; i++) {
  const answers = ids.map(() => ANSWER_VALUES[Math.floor(random() * 4)])
  const r = assess(answers)
  const expected = reference(answers)
  if (r.actions.map((a) => `${a.id}:${a.level}`).join() !== expected.map((e) => `${e.id}:${e.level}`).join()) mismatches++
  if (r.score !== answers.reduce((s, a) => s + (a === "yes" ? 2 : a === "partly" ? 1 : 0), 0)) badScore++
  const critical = CRITICAL_IDS.some((id) => answers[ids.indexOf(id)] === "no")
  if (critical && /most practices/.test(r.headline)) badOverride++
  if (r.allYes !== answers.every((a) => a === "yes")) badOverride++
}
check("20,000 random answer sets: actions always follow the risk order (No, then Not sure, then Partly)", mismatches === 0, `${mismatches} mismatches`)
check("20,000 random answer sets: score is always 2 x Yes + Partly", badScore === 0)
check("20,000 random answer sets: 'most practices' never appears with a critical No", badOverride === 0)
check("at most three actions, always", Array.from({ length: 200 }, () => assess(ids.map(() => ANSWER_VALUES[Math.floor(random() * 4)])).actions.length).every((n) => n <= 3))

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
